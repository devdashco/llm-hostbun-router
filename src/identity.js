// WHO is calling. A consumer is a person's machine (`dev`) or code we deployed (`app`), and its
// identity is a path: `<consumer>[:<job>]`. A valid API key outranks anything the caller says about
// itself; only the job half is ever taken on trust.
const crypto = require("node:crypto");
const { CFG, keyIndex } = require("./config");

function extractProject(req, bodyBuf) {
  let p = req.headers["x-project"] || req.headers["x-consumer"] || req.headers["x-project-id"] || "";
  if (!p && bodyBuf && bodyBuf.length) {
    try {
      const j = JSON.parse(bodyBuf.toString());
      p = j.project || (j.metadata && j.metadata.project) || j.user || "";
    } catch { /* not json */ }
  }
  return normalizeConsumerPath(String(p || "").trim().toLowerCase().slice(0, 64));
}

// Callers name themselves, and over months they named themselves inconsistently: the same box
// arrived as `pmac` (a curl script) and `pmac-claude` (its Claude Code), and an unconfigured Claude
// Code sends its own HOSTNAME (`macbook-pro-som-tillhor-william-claude`). Those are one machine with
// several clients — a consumer and its jobs — not several consumers.
//
// The alias map folds a legacy name onto its canonical `<consumer>:<job>` path at the door, so no
// caller has to change and the whole history keeps resolving. Aliases apply to the CONSUMER half
// only; a job the caller supplied always wins over the one the alias implies, because the caller
// knows which workload it is running and the map does not.
function normalizeConsumerPath(p) {
  if (!p) return p;
  const aliases = CFG.consumerAliases || {};
  const { consumer, job } = parseConsumer(p);
  const target = aliases[consumer];
  if (!target) return p;
  const t = parseConsumer(String(target).trim().toLowerCase());
  const finalJob = job || t.job;   // explicit job beats the alias's implied one
  return finalJob ? `${t.consumer}:${finalJob}` : t.consumer;
}

// A caller's identity is a path, not a flat name: `<consumer>[:<job>]`. `promopilot:generatetext`
// has always been two levels — the router just never read it that way, so `promopilot` looked like
// 4 calls when its three workloads had ~30k between them. Splitting on the FIRST colon only means a
// job may itself contain colons; the consumer never can.
function parseConsumer(project) {
  const s = String(project || "").trim().toLowerCase();
  if (!s) return { consumer: "", job: null };
  const i = s.indexOf(":");
  return i < 0 ? { consumer: s, job: null } : { consumer: s.slice(0, i), job: s.slice(i + 1) || null };
}

// Registry lookup, consumer-level. A job never needs registering.
function consumerEntry(project) {
  const { consumer } = parseConsumer(project);
  const reg = CFG.consumers || {};
  return consumer && Object.prototype.hasOwnProperty.call(reg, consumer) ? { name: consumer, ...reg[consumer] } : null;
}


// Wire format: sk-llm-<id>-<secret>.  `id` is a public, non-secret handle so a lookup is a map hit
// rather than a scan over every hash; `secret` is never stored, only its sha256. The consumer name
// is deliberately NOT in the key: it would leak who we are to anyone who sees a truncated key, and
// a name containing '-' (pmac-claude) makes the key unparseable.
const KEY_PREFIX = "sk-llm-";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function mintKey() {
  const id = crypto.randomBytes(4).toString("hex");        // 8 chars, public
  const secret = crypto.randomBytes(24).toString("base64url"); // 32 chars, shown once
  return { id, secret, raw: `${KEY_PREFIX}${id}-${secret}` };
}

// Read the key from either dialect: OpenAI clients send `Authorization: Bearer`, the Anthropic SDK
// sends `x-api-key`. Both reach us on native /v1/messages, so both must work.
function rawApiKey(req) {
  const a = req.headers["authorization"];
  if (a && /^bearer\s+/i.test(a)) {
    const t = a.replace(/^bearer\s+/i, "").trim();
    if (t.startsWith(KEY_PREFIX)) return t;
  }
  const x = req.headers["x-api-key"];
  if (x && String(x).startsWith(KEY_PREFIX)) return String(x).trim();
  return null;
}

// null           → no key presented
// {ok:false,…}   → a key was presented and is bad (unknown id, wrong secret, revoked, orphaned)
// {ok:true,…}    → authenticated; `consumer` is now asserted by us, not by the caller
function authenticate(req) {
  const raw = rawApiKey(req);
  if (!raw) return null;
  const rest = raw.slice(KEY_PREFIX.length);
  const dash = rest.indexOf("-");
  if (dash < 0) return { ok: false, why: "malformed key" };
  const id = rest.slice(0, dash), secret = rest.slice(dash + 1);
  const hit = keyIndex().get(id);
  if (!hit) return { ok: false, why: "unknown or revoked key" };
  const want = Buffer.from(hit.rec.hash, "hex");
  const got = Buffer.from(sha256(secret), "hex");
  // Length is fixed (sha256), so timingSafeEqual cannot throw here — but compare in constant time
  // regardless: a fast-fail on the first differing byte leaks the hash a byte at a time.
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, why: "bad key" };
  const e = (CFG.consumers || {})[hit.consumer];
  if (!e) return { ok: false, why: "key belongs to a deleted consumer" };
  hit.rec.lastUsed = Date.now(); KEY_USE_DIRTY = true;   // flushed to disk lazily, see below
  return { ok: true, consumer: hit.consumer, entry: e, keyId: id };
}

// lastUsed changes on every request. Persisting it inline would mean a disk write per inference, so
// it is flushed on a timer and is therefore approximate — never treat it as an audit trail.
let KEY_USE_DIRTY = false;
function startKeyUseFlush() {
  return setInterval(() => {
    if (!KEY_USE_DIRTY) return;
    KEY_USE_DIRTY = false;
    require("./config").persistConfig();
  }, 300000).unref();
}

module.exports = {
  extractProject, normalizeConsumerPath, parseConsumer, consumerEntry,
  sha256, mintKey, rawApiKey, authenticate, startKeyUseFlush,
};
