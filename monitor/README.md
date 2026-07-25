# monitor/ — throttle & pressure watcher

`throttle-watch.py` pages Philip (**Telegram + email**) when anything in the LLM router
fleet is throttled or under resource pressure. Zero deps (Python 3 stdlib only).

## Why it runs on pbox, not Coolify

Two of the four signals are host-local to the GPU box (`nvidia-smi`, `docker`) and cannot be
read from inside a Coolify container. So this is a **system systemd timer on pbox**, not a
Coolify scheduled task — a deliberate exception to the control-plane-cron policy, justified by
the host introspection it needs. The other two signals are polled from the router's cookie-gated
control API over the internet.

## What it watches

| id | fires when |
|---|---|
| `router429:<app>` | an app is back-pressured for drawing real upstream 429s (`GET /api/state` → `throttles[]`; devs never appear) |
| `ratelimit:<account>` | a claudecode account's usage window is spent / OAuth-disabled, or its 5h/7d gauge ≥ `RL_PCT`% (`GET /api/accounts` → `limits`) |
| `pool-headroom` | ≤ `POOL_MIN` logins can still serve — the whole pool is about to go dark, which is what 403s every app |
| `cachemiss:<project>` | a project's 1h cache-hit ratio fell below `CACHE_MIN_PCT`, on prompts big enough to be cacheable (`GET /api/stats?window=1h`) |
| `burn:<project>` | a project is spending > `BURN_1H` **billable** (uncached) tokens/hour |
| `gpu:<n>` | pbox GPU memory ≥ `GPU_PCT`% of total |
| `restart:<c>` / `image-running:<c>` / `oom` | a container is restart-looping, the image model (sd-turbo) is running when it should be stopped, or a kernel OOM kill happened in the last `OOM_WINDOW_MIN` min |

## Delivery

**Edge-triggered.** An alert fires when a condition first appears, a short *cleared* note when it
goes away, and a *reminder* re-send every `REMIND_MIN` minutes while it stays hot. Dedup state is
in `STATE_FILE`. Telegram now targets the **devdash channel directly**: the DM (`7803034119`) returned
`HTTP 400` on every run since install because Philip never pressed **Start** on `@ddbofridemailBot`, so
every page was already arriving via the fallback — the "primary" was dead weight that logged an error
each run. Point `TG_CHAT` back at the DM once that Start is pressed. Email is SES and is currently
**off** (no `AWS_ACCESS_KEY_ID` in the env), so Telegram is the only live channel. SES is SigV4 over
the stdlib, the same pattern as `archive/s3.js`.

## Deploy / operate (on pbox)

```
# code + config live in /home/philip/monitor/ ; env is chmod 600, NOT in git.
systemctl list-timers throttle-watch.timer       # next/last run
journalctl -u throttle-watch.service -n 20 -o cat # recent output
sudo systemctl start throttle-watch.service       # run once now
```

To change config, edit `/home/philip/monitor/throttle-watch.env` (see `throttle-watch.env.example`).
To update the script: edit here, `scp` to `pbox:/home/philip/monitor/throttle-watch.py`.
Units: `/etc/systemd/system/throttle-watch.{service,timer}` (runs as `philip`, every 2 min).
