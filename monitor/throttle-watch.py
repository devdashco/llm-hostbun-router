#!/usr/bin/env python3
"""
throttle-watch — pages Philip (Telegram + email) when anything in the LLM router
fleet is being throttled or under resource pressure.

Runs on pbox (the GPU box) because two of the four signals are host-local
(nvidia-smi + docker) and cannot be read from a Coolify container. The other two
are polled from the router's cookie-gated control API.

Watched conditions
------------------
  router429   an app is back-pressured for drawing real upstream 429s
              (GET /api/state -> throttles[]; devs never appear there)
  ratelimit   a claudecode account's usage window is spent / OAuth-disabled, or
              a 5h/7d gauge is >= RL_PCT% (GET /api/accounts -> limits)
  gpu         pbox GPU memory >= GPU_PCT% of total
  container   a container is restart-looping, was OOM-killed, or the image model
              (sd-turbo) is running when it should be stopped

Delivery is edge-triggered: an alert fires when a condition first appears and a
short "cleared" note when it goes away. A condition that stays hot is re-sent
once every REMIND_MIN minutes so a standing problem is not forgotten. All
dedup state lives in STATE_FILE.

Zero dependencies — Python 3 stdlib only. Config comes from the environment
(see throttle-watch.env). Designed to be run every ~2 min by a systemd timer.
"""

import hashlib
import hmac
import json
import os
import re
import ssl
import subprocess
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone

# ── config ────────────────────────────────────────────────────────────────
ROUTER_URL   = os.environ.get("ROUTER_URL", "https://llm.hostbun.cc").rstrip("/")
ROUTER_PW    = os.environ.get("ROUTER_PW", "ddash")
TG_TOKEN     = os.environ.get("TG_TOKEN", "")
TG_CHAT      = os.environ.get("TG_CHAT", "")            # primary: Philip's DM
TG_FALLBACK  = os.environ.get("TG_FALLBACK_CHAT", "")  # e.g. the devdash channel
MAIL_FROM    = os.environ.get("MAIL_FROM", "auth@mejl.to")
MAIL_TO      = os.environ.get("MAIL_TO", "philip@bofrid.se")
AWS_KEY      = os.environ.get("AWS_ACCESS_KEY_ID", "")
AWS_SECRET   = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
AWS_REGION   = os.environ.get("AWS_REGION", "eu-west-1")
GPU_PCT      = float(os.environ.get("GPU_PCT", "90"))
RL_PCT       = float(os.environ.get("RL_PCT", "92"))
REMIND_MIN   = float(os.environ.get("REMIND_MIN", "60"))
IMAGE_RE     = re.compile(os.environ.get("IMAGE_CONTAINER_RE", r"sd-turbo|imagegen|diffus"), re.I)
STATE_FILE   = os.environ.get("STATE_FILE", os.path.expanduser("~/.llm-throttle-watch.state.json"))
TIMEOUT      = 20
_CTX = ssl.create_default_context()


def log(*a):
    print(datetime.now(timezone.utc).strftime("%H:%M:%S"), *a, flush=True)


def _clock(epoch):
    """Epoch seconds -> 'Mon 14:30 UTC', or the raw value if it isn't a timestamp."""
    try:
        return datetime.fromtimestamp(float(epoch), timezone.utc).strftime("%a %H:%M UTC")
    except (TypeError, ValueError):
        return str(epoch)


# ── router polling ────────────────────────────────────────────────────────
def _http(method, url, data=None, headers=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    if body is not None and "Content-Type" not in (headers or {}):
        req.add_header("Content-Type", "application/json")
    resp = urllib.request.urlopen(req, timeout=TIMEOUT, context=_CTX)
    return resp, resp.read()


def router_login():
    """POST /api/login -> the hb_admin cookie string, or None."""
    resp, _ = _http("POST", f"{ROUTER_URL}/api/login", {"password": ROUTER_PW})
    for k, v in resp.getheaders():
        if k.lower() == "set-cookie":
            return v.split(";", 1)[0]
    return None


def router_get(path, cookie):
    _, raw = _http("GET", f"{ROUTER_URL}{path}", headers={"Cookie": cookie})
    return json.loads(raw.decode())


def check_router(conds):
    try:
        cookie = router_login()
        if not cookie:
            conds["router-auth"] = "throttle-watch: router login returned no cookie"
            return
        state = router_get("/api/state", cookie)
    except Exception as e:
        conds["router-down"] = f"router control API unreachable: {type(e).__name__}: {e}"
        return

    # 1) router429 back-pressure — one condition per throttled app
    for t in state.get("throttles") or []:
        c = t.get("consumer", "?")
        conds[f"router429:{c}"] = (
            f"app '{c}' is throttled (+{t.get('ms', 0)}ms, level {t.get('level', 0)}) "
            f"— drawing real upstream 429s"
        )

    # 2) account rate-limit windows
    try:
        acc = router_get("/api/accounts", cookie)
    except Exception as e:
        conds["accounts-read"] = f"could not read /api/accounts: {type(e).__name__}: {e}"
        acc = {}
    for a in acc.get("accounts") or []:
        name = a.get("name", "?")
        lim = a.get("limits")
        if not lim:
            continue  # null = no reading, never treat as 0%
        status = str(lim.get("status") or "").lower()
        # u5/u7 are FRACTIONS (0.0-1.0); status 'allowed'/'allowed_warning' are healthy.
        p5 = (lim.get("u5") or 0) * 100.0
        p7 = (lim.get("u7") or 0) * 100.0
        # A real spend / dead login: anything that is not an "allowed*" reading.
        if status and not status.startswith("allowed") and status not in ("ok", "200"):
            conds[f"ratelimit:{name}"] = f"account '{name}' limit status={status} — 5h={p5:.0f}% 7d={p7:.0f}% (reset5={_clock(lim.get('reset5'))}, reset7={_clock(lim.get('reset7'))})"
        elif p5 >= RL_PCT or p7 >= RL_PCT:
            conds[f"ratelimit:{name}"] = f"account '{name}' usage window high: 5h={p5:.0f}% 7d={p7:.0f}% (reset5={_clock(lim.get('reset5'))}, reset7={_clock(lim.get('reset7'))})"


# ── pbox host checks ──────────────────────────────────────────────────────
def _sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=25).stdout.strip()


def check_gpu(conds):
    try:
        out = _sh("nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits")
    except Exception:
        return
    for i, line in enumerate(l for l in out.splitlines() if l.strip()):
        try:
            used, total = (float(x) for x in line.split(","))
        except ValueError:
            continue
        pct = 100.0 * used / total if total else 0.0
        if pct >= GPU_PCT:
            conds[f"gpu:{i}"] = f"pbox GPU{i} memory {pct:.0f}% ({used:.0f}/{total:.0f} MiB) >= {GPU_PCT:.0f}%"


RC_FILE = os.environ.get("RESTART_COUNT_FILE", os.path.expanduser("~/monitor/.restartcounts.json"))
IGNORE_RE = re.compile(os.environ.get("CONTAINER_IGNORE_RE", ""), re.I) if os.environ.get("CONTAINER_IGNORE_RE") else None


def check_containers(conds):
    # Restart-loop detection by RestartCount GROWTH between samples — NOT the instantaneous
    # "Restarting" status, which flickers (Restarting->Up->Exited->Restarting) and made a single
    # crash-looping container page as a "new" condition every few minutes. A container is looping
    # iff its RestartCount rose since the last run; that is stable (re-reminds on REMIND_MIN, never
    # flaps) and self-clears the moment the container stops restarting. First sight = no alert
    # (we only page on fresh growth, so a chronic 2000-restart orphan doesn't spam on install).
    # RestartCount lives on `docker inspect`, NOT `docker ps --format` (that placeholder errors out).
    # Delimiter is '|' — Go templates emit a literal '\t', not a tab, so tab-splitting silently fails.
    try:
        rows = _sh(r"docker ps -aq | xargs -r docker inspect "
                   r"--format '{{.Name}}|{{.RestartCount}}|{{.State.Status}}'")
    except Exception:
        return
    try:
        with open(RC_FILE) as f:
            prev = json.load(f)
    except Exception:
        prev = {}
    cur = {}
    for line in rows.splitlines():
        parts = line.split("|")
        if len(parts) < 3:
            continue
        name, rc_s, status = parts[0].lstrip("/"), parts[1], parts[2]
        if IGNORE_RE and IGNORE_RE.search(name):
            continue
        try:
            rc = int(rc_s)
        except ValueError:
            rc = 0
        cur[name] = rc
        if name in prev and rc > prev[name]:
            conds[f"restart:{name}"] = f"container '{name}' is crash-looping: +{rc - prev[name]} restarts since last check (total {rc})"
        if IMAGE_RE.search(name) and status.startswith("Up"):
            conds[f"image-running:{name}"] = f"image model container '{name}' is RUNNING ({status}) — expected stopped"
    try:
        with open(RC_FILE, "w") as f:
            json.dump(cur, f)
    except Exception:
        pass
    # OOM kills in the LAST OOM_WINDOW_MIN minutes only — journald is timestamp-authoritative, so this
    # never re-fires on an ancient kill (dmesg|tail did, paging a stale event on every state reset).
    try:
        win = os.environ.get("OOM_WINDOW_MIN", "12")
        oom = _sh(f"journalctl -k --since '-{win}min' --no-pager 2>/dev/null | grep -i 'Out of memory: Killed process' | tail -1")
        if oom:
            conds["oom"] = f"recent OOM kill on pbox (<{win}m): {oom.split(']')[-1].strip()[:160]}"
    except Exception:
        pass


# ── delivery ──────────────────────────────────────────────────────────────
def tg_send(text):
    if not TG_TOKEN or not TG_CHAT:
        log("telegram: not configured, skipping")
        return False
    for chat in [TG_CHAT, TG_FALLBACK]:
        if not chat:
            continue
        try:
            data = urllib.parse.urlencode({"chat_id": chat, "text": text, "disable_web_page_preview": "true"}).encode()
            req = urllib.request.Request(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", data=data)
            resp = urllib.request.urlopen(req, timeout=TIMEOUT, context=_CTX)
            j = json.loads(resp.read().decode())
            if j.get("ok"):
                if chat != TG_CHAT:
                    log(f"telegram: delivered via fallback chat {chat}")
                return True
        except Exception as e:
            log(f"telegram: chat {chat} failed: {e}")
    return False


def _sigv4(service, region, host, amz_target, payload, action_headers=None):
    """Minimal SigV4 POST signer (SES query API). Returns (headers, body)."""
    t = datetime.now(timezone.utc)
    amzdate = t.strftime("%Y%m%dT%H%M%SZ")
    datestamp = t.strftime("%Y%m%d")
    body = payload.encode()
    payload_hash = hashlib.sha256(body).hexdigest()
    canonical_headers = f"content-type:application/x-www-form-urlencoded\nhost:{host}\nx-amz-date:{amzdate}\n"
    signed_headers = "content-type;host;x-amz-date"
    canonical_request = f"POST\n/\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    scope = f"{datestamp}/{region}/{service}/aws4_request"
    to_sign = f"AWS4-HMAC-SHA256\n{amzdate}\n{scope}\n{hashlib.sha256(canonical_request.encode()).hexdigest()}"

    def _hmac(k, m):
        return hmac.new(k, m.encode(), hashlib.sha256).digest()

    kd = _hmac(("AWS4" + AWS_SECRET).encode(), datestamp)
    kr = _hmac(kd, region)
    ks = _hmac(kr, service)
    signing = _hmac(ks, "aws4_request")
    sig = hmac.new(signing, to_sign.encode(), hashlib.sha256).hexdigest()
    auth = (f"AWS4-HMAC-SHA256 Credential={AWS_KEY}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={sig}")
    return {"Content-Type": "application/x-www-form-urlencoded", "X-Amz-Date": amzdate,
            "Authorization": auth}, body


def email_send(subject, text):
    if not AWS_KEY or not AWS_SECRET:
        log("email: no AWS creds, skipping")
        return False
    host = f"email.{AWS_REGION}.amazonaws.com"
    params = {
        "Action": "SendEmail",
        "Source": MAIL_FROM,
        "Destination.ToAddresses.member.1": MAIL_TO,
        "Message.Subject.Data": subject,
        "Message.Body.Text.Data": text,
    }
    payload = urllib.parse.urlencode(params)
    try:
        headers, body = _sigv4("ses", AWS_REGION, host, None, payload)
        req = urllib.request.Request(f"https://{host}/", data=body, headers=headers)
        urllib.request.urlopen(req, timeout=TIMEOUT, context=_CTX).read()
        return True
    except urllib.error.HTTPError as e:
        log(f"email: SES HTTP {e.code}: {e.read().decode(errors='replace')[:200]}")
    except Exception as e:
        log(f"email: {type(e).__name__}: {e}")
    return False


# ── state / edge-trigger ──────────────────────────────────────────────────
def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(s):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.replace(tmp, STATE_FILE)


def main():
    conds = {}
    check_router(conds)
    check_gpu(conds)
    check_containers(conds)

    now = time.time()
    prev = load_state()  # {condid: {"since": ts, "last_alert": ts, "msg": str}}
    nxt = {}
    fresh, remind, cleared = [], [], []

    for cid, msg in conds.items():
        p = prev.get(cid)
        if not p:
            nxt[cid] = {"since": now, "last_alert": now, "msg": msg}
            fresh.append(msg)
        else:
            due = (now - p.get("last_alert", 0)) >= REMIND_MIN * 60
            nxt[cid] = {"since": p.get("since", now), "last_alert": now if due else p.get("last_alert", now), "msg": msg}
            if due:
                mins = int((now - p.get("since", now)) / 60)
                remind.append(f"{msg}  (ongoing {mins}m)")

    for cid, p in prev.items():
        if cid not in conds:
            cleared.append(p.get("msg", cid))

    save_state(nxt)

    if not (fresh or remind or cleared):
        log(f"ok — {len(conds)} active condition(s), nothing to page")
        return

    lines = []
    if fresh:
        lines.append("🔴 NEW:\n" + "\n".join(f"  • {m}" for m in fresh))
    if remind:
        lines.append("🟠 ONGOING:\n" + "\n".join(f"  • {m}" for m in remind))
    if cleared:
        lines.append("🟢 CLEARED:\n" + "\n".join(f"  • {m}" for m in cleared))
    body = "llm-hostbun-router throttle/pressure watch\n\n" + "\n\n".join(lines)
    n_new = len(fresh) + len(remind)
    subject = (f"[llm-router] {len(fresh)} new / {len(remind)} ongoing throttle alert(s)"
               if n_new else f"[llm-router] {len(cleared)} condition(s) cleared")

    tg_ok = tg_send(body)
    mail_ok = email_send(subject, body)
    log(f"paged: new={len(fresh)} ongoing={len(remind)} cleared={len(cleared)} telegram={tg_ok} email={mail_ok}")


if __name__ == "__main__":
    main()
