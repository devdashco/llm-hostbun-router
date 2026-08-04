// Admission control for the upstreams that are ONE piece of hardware.
//
// Cloud upstreams are deliberately NOT gated. `claudecode` (api.anthropic.com) and `crazyrouter`
// run their own concurrency, and their 429 is a real signal this router surfaces rather than
// absorbs (invariant 2). Queueing them here would add latency to calls that are legitimately
// parallel and turn a truthful "you are out of quota" into a silent wait.
//
// The two that ARE gated share one GPU, so a burst does not make them faster — it makes them wrong:
//
//   • `images` — one diffusers pipeline behind sync FastAPI handlers. Concurrent calls swapped each
//     other's LoRA adapters mid-render and raised from inside CUDA: 94x200, 47x500 and 145x502 in a
//     single hour, measured 2026-07-27 on /v1/images/generations. The upstream fix (a GPU_LOCK) is
//     committed in devdashco/sd-turbo-service and undeployed — nobody here has ssh to that box — so
//     limit 1 is the half we control. Serialising at this end fixes the same bug.
//
//   • `local` — llama.cpp, n_parallel 4 (`GET /props` → total_slots, which is the authority; the
//     server runs `-np 4 -c 65536` since the mmproj vision weights joined it on the same card).
//     It was 2 until 2026-08-02, when the checkpoint changed from gemma-4-26B-QAT to Qwen3.5-9B and
//     the weights went 13.6 GB -> 5.6 GB, paying for three times the slots inside the same card.
//     THIS NUMBER SHOULD TRACK THE SERVER — but for the CLOCK below, not to prevent an error.
//     ⛔ `503 no available server` is NOT what slot exhaustion looks like. Measured 2026-08-04
//     DIRECTLY against pbox with the router bypassed: 24 requests 12 wide at a 4-slot server →
//     24 x 200. llama.cpp QUEUES past its slots. That string is what it answers while the model
//     is not loaded, so a 503 storm means the SERVER IS RESTARTING, never that this number is
//     too high. Overshooting costs waiting, not failures.
//
//     ⚠ That distinction is the whole lesson of the 24 h to 2026-08-04: 11,116 x 200 against
//     4,416 x 503 on this provider (28% of every free-lane call, across bluebut AND
//     agentic-marketplace, 904 of them falling through to the paid lane). It was read here first
//     as gate drift — this did say 6 against a 4-slot server — and that was WRONG. Every one of
//     those 503s was pbox's llama.cpp being killed by its own memory cgroup: LLAMA_MEM 8g against
//     a real ~8.8 GB working set, 7 kernel OOM kills and 27 restarts in 18 h, each restart 503ing
//     until the model reloads. The kill is invisible from here AND from docker (`ExitCode=0`,
//     `OOMKilled=false` — the kernel kills the process, not the container) and llama.cpp's own log
//     jumps from slot timings straight to its boot banner; `dmesg -T | grep llama-server` is the
//     only honest source. Raised to 16g the same day: a 60-request 12-concurrent probe went from
//     50x503 + 6x502 + 4x200 to 60/60 200. CHECK THE BOX BEFORE YOU TOUCH THIS NUMBER.
//     It queues past that itself and never crashes, so this is not about crashing. It is about the
//     clock: llama.cpp's queue wait runs INSIDE our UPSTREAM_HEADER_TIMEOUT_MS, which starts at
//     fetch() and only stops when headers arrive. Send 100 and the ones at the back burn their
//     whole 120s budget waiting for a slot and 504 — for work the model would have done. Waiting
//     HERE instead means each request starts its header budget when it actually reaches the model,
//     so 100 requests drain one after another and all of them get answered.
//
// Limits are env, not CFG: they describe the hardware on the other end, which does not change from
// the panel. `GATE_<PROVIDER>` overrides any of them; 0 (or junk) means ungated.
const DEFAULTS = { local: 4, images: 1 };
const QUEUE_MAX = Math.max(1, Number(process.env.GATE_QUEUE_MAX) || 100);
const WAIT_MS = Math.max(1000, Number(process.env.GATE_WAIT_MS) || 300_000);

const limitFor = (p) => {
  const env = process.env[`GATE_${String(p || "").toUpperCase()}`];
  const n = env == null || env === "" ? DEFAULTS[p] : Number(env);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

const gates = new Map();
function gateFor(provider) {
  const limit = limitFor(provider);
  if (!limit) return null;
  let g = gates.get(provider);
  if (!g) gates.set(provider, (g = { active: 0, q: [], peakQueued: 0, refused: 0 }));
  g.limit = limit;                                  // re-read every call so the env is not baked in
  return g;
}
// Seed the known gates so a snapshot reports them before any traffic — "images: not in this object"
// and "images: unlimited" must not look alike on a health page.
for (const p of Object.keys(DEFAULTS)) gateFor(p);

// Hand free slots to whoever is waiting. Callers that hung up or timed out while queued are already
// settled and are skipped — their slot was never taken, so there is nothing to give back.
function pump(g) {
  while (g.q.length && g.active < g.limit) {
    const w = g.q.shift();
    if (w.settled) continue;
    g.active++;                                     // taken on the waiter's behalf, before it wakes
    w.grant();
  }
}

// Resolves "ok" (slot held), "gone" (caller hung up — nothing to answer), "timeout", or "full".
function admit(g, res) {
  if (g.active < g.limit) { g.active++; return Promise.resolve("ok"); }
  if (g.q.length >= QUEUE_MAX) { g.refused++; return Promise.resolve("full"); }
  return new Promise((resolve) => {
    const w = { settled: false };
    const settle = (verdict) => {
      if (w.settled) return;
      w.settled = true;
      clearTimeout(timer);
      res.off("close", onClose);
      resolve(verdict);
    };
    // A caller that gives up (Cloudflare abandons at 100s) must leave the queue. Rendering a
    // picture for a socket that is already gone spends the GPU on nobody, and it spends it AHEAD of
    // the callers still waiting.
    const onClose = () => settle("gone");
    const timer = setTimeout(() => settle("timeout"), WAIT_MS);
    timer.unref();
    w.grant = () => settle("ok");
    res.on("close", onClose);
    g.q.push(w);
    if (g.q.length > g.peakQueued) g.peakQueued = g.q.length;
  });
}

// Run `work` with at most `limit` of this provider's requests in flight. Ungated providers call
// straight through, so nothing about their path changes.
async function run(provider, req, res, work) {
  const g = gateFor(provider);
  if (!g) return work();
  // A read is never GPU work. /local/v1/models and /local/props proxy to the same base as a
  // generation does, and queueing a model list behind two 20s completions would cost real
  // usability to protect a card that was never going to be asked to do anything.
  if (req.method === "GET" || req.method === "HEAD") return work();

  if (g.active >= g.limit) {
    console.log(`[gate] ${provider} busy ${g.active}/${g.limit} — queued (depth ${g.q.length + 1})`);
  }
  const verdict = await admit(g, res);
  if (verdict === "gone") return;                   // socket already closed; there is nobody to tell

  if (verdict !== "ok") {
    const msg = verdict === "full"
      ? `${provider} is busy and its queue is full (${QUEUE_MAX} waiting)`
      : `timed out after ${WAIT_MS}ms waiting for a free ${provider} slot`;
    console.warn(`[gate] ${provider} ${verdict} — refusing (active=${g.active} queued=${g.q.length})`);
    // 503 + Retry-After, not 500: this is "come back", and an OpenAI client retries it. It is also
    // deliberately not a substitution — refusing is the only honest answer (invariant 2).
    if (!res.headersSent) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "30" });
      res.end(JSON.stringify({ error: { type: "overloaded_error", code: `${provider}_busy`, message: msg } }));
    }
    return;
  }

  // The slot is held until the RESPONSE is over, and that is later than `work` resolving: proxy()
  // returns the moment it has wired `r.pipe(res)`, with the whole streamed body still to come. A
  // release on the work's return would hand the GPU to the next caller mid-render — i.e. rebuild
  // the exact bug this file exists to prevent. `res` "close" is the one event that fires on every
  // ending there is: finished, errored, or client hung up.
  let released = false;
  const release = () => { if (released) return; released = true; g.active--; pump(g); };
  if (res.writableEnded || res.destroyed) { release(); return; }   // "close" has already fired
  res.once("close", release);
  try { return await work(); }
  catch (e) { release(); throw e; }                 // nothing answered the caller: free the slot now
}

const snapshot = () => Object.fromEntries([...gates].map(([p, g]) =>
  [p, { limit: g.limit, active: g.active, queued: g.q.length, peakQueued: g.peakQueued, refused: g.refused }]));

module.exports = { run, snapshot, limitFor, QUEUE_MAX, WAIT_MS };
