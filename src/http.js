// The wire: read a body, send a file, build upstream headers, stream a proxied response, and the
// JSON-enforcement retry loop.
//
// Two rules that cost a day each when broken:
//   • claudecode request headers are SYNTHESIZED, never inherited. A Max setup-token is rejected
//     without anthropic-beta: oauth-2025-04-20 + anthropic-version + a claude-cli UA.
//   • Native /v1/messages is forwarded byte-for-byte. Only OpenAI /v1/chat/completions on the
//     claudecode provider is translated; touching a native body loses tool/thinking fidelity and
//     breaks Claude Code's prompt cache.
const fs = require("node:fs");
const { Readable } = require("node:stream");
const TR = require("../translate");
const { CFG } = require("./config");
const { clip, recordCall, recordLimits, CONTENT_CAP } = require("./db");
const { accountFor, isGated, resolveRoute, note429, note2xx } = require("./routing");

// Hop-by-hop headers: meaningful to ONE connection, never forwarded. Dropped by the split; without
// them buildHeaders() throws ReferenceError and every proxied request 502s.
const HOP_REQ = new Set(["host", "connection", "content-length", "accept-encoding",
  "keep-alive", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const HOP_RES = new Set(["connection", "content-length", "content-encoding",
  "transfer-encoding", "keep-alive", "te", "trailer", "upgrade"]);
const {
  keyLabel, extractReqMeta, extractRequestContent, extractReqParams,
  normalizeUsage, extractResponseBody, shipError, applyLocalThinkingDefault, isChatCompletions,
} = require("./telemetry");

// ── optional context compression via the headroom-compress sidecar. OFF unless HEADROOM_URL is set.
// NEVER applied to claudecode: it rewrites the prompt, misses the prompt cache, and costs more than
// it saves. Hard-coded out of the default; adding it back via env is a mistake.
const HEADROOM_URL = (process.env.HEADROOM_URL || "").replace(/\/$/, "");
const HEADROOM_TOKEN = process.env.HEADROOM_TOKEN || "";
const HEADROOM_TIMEOUT_MS = parseInt(process.env.HEADROOM_TIMEOUT_MS || "4000", 10);
const HEADROOM_MIN_CHARS = parseInt(process.env.HEADROOM_MIN_CHARS || "2000", 10);
const HEADROOM_PROVIDERS = new Set(
  (process.env.HEADROOM_PROVIDERS || "local,crazyrouter").split(",").map((x) => x.trim()).filter(Boolean)
);

const readBody = (req) => new Promise((resolve) => {
  const c = [];
  req.on("data", (d) => c.push(d));
  req.on("end", () => resolve(Buffer.concat(c)));
  req.on("error", () => resolve(Buffer.concat(c)));
});

function sendFile(res, path, type, cors, cacheControl) {
  fs.readFile(path, (e, buf) => {
    if (e) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    const h = { "content-type": type };
    if (cors) h["access-control-allow-origin"] = "*";
    // The panel is an unversioned ES-module graph (/ui/app.js imports ./pages/*.js by relative path,
    // no hash). Without revalidation a browser can hold an OLD module next to a NEW one across a
    // redeploy — e.g. a cached overview.js importing a symbol the new accounts.js no longer exports —
    // and the whole SPA renders blank. `no-cache` forces a revalidation every load, so the graph is
    // always internally consistent.
    if (cacheControl) h["cache-control"] = cacheControl;
    res.writeHead(200, h);
    res.end(buf);
  });
}


function buildHeaders(req, { injectKey, authToken } = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_REQ.has(k.toLowerCase())) headers[k] = v;
  }
  if (injectKey) headers["authorization"] = `Bearer ${CFG.crazyrouterKey}`;
  else if (authToken) headers["authorization"] = `Bearer ${authToken}`;
  return headers;
}

// True if any message carries image (multimodal) content. OpenAI/Anthropic put images in an array
// `content` as parts like {type:"image_url"...} / {type:"image", source} / {type:"input_image"}.
function hasImageContent(messages) {
  for (const m of messages) {
    const c = m && m.content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (p && typeof p === "object" &&
          (String(p.type || "").includes("image") || p.image_url || p.image || p.source)) return true;
    }
  }
  return false;
}

// Run the request's `messages` through the headroom-compress sidecar before forwarding upstream.
// Returns { buf, stats }. On ANY problem it returns the original bytes and stats=null, so a slow or
// dead compressor never blocks inference. Only touches chat/messages bodies that carry a messages[].
async function headroomCompress(bodyBuf, model, provider) {
  if (!HEADROOM_URL || !bodyBuf || bodyBuf.length < HEADROOM_MIN_CHARS) return { buf: bodyBuf, stats: null };
  if (HEADROOM_PROVIDERS.size && provider && !HEADROOM_PROVIDERS.has(provider)) return { buf: bodyBuf, stats: null };
  // HARD GUARD — never compress cache-optimized / tool-using requests (Claude Code, agents).
  // Rewriting messages breaks the byte-identical cached prefix → a cache MISS costs ~12x
  // (cache_read 0.1x vs cache_write 1.25x), dwarfing any compression saving, and can corrupt
  // tool_use/tool_result pairing. The prompt cache is the better, lossless compression here.
  // This is deliberately independent of HEADROOM_PROVIDERS so a misconfig can't tax agentic traffic.
  const rawStr = bodyBuf.toString();
  if (rawStr.includes('"cache_control"') || rawStr.includes('"tools"')) return { buf: bodyBuf, stats: null };
  let obj;
  try { obj = JSON.parse(rawStr); } catch { return { buf: bodyBuf, stats: null }; }
  if (!Array.isArray(obj.messages) || !obj.messages.length) return { buf: bodyBuf, stats: null };
  // Skip multimodal/image requests: headroom can't shrink base64 (0 savings) and shipping a multi-MB
  // image to the sidecar and back just adds latency + bandwidth. The image passes through untouched.
  if (hasImageContent(obj.messages)) return { buf: bodyBuf, stats: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEADROOM_TIMEOUT_MS);
  try {
    const hdrs = { "content-type": "application/json" };
    if (HEADROOM_TOKEN) hdrs["authorization"] = `Bearer ${HEADROOM_TOKEN}`;
    const r = await fetch(HEADROOM_URL + "/compress", {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ messages: obj.messages, model: model || obj.model || undefined }),
      signal: ctrl.signal,
    });
    if (!r.ok) return { buf: bodyBuf, stats: null };
    const j = await r.json();
    if (!j || !Array.isArray(j.messages)) return { buf: bodyBuf, stats: null };
    obj.messages = j.messages;
    return { buf: Buffer.from(JSON.stringify(obj)), stats: j.stats || null };
  } catch { return { buf: bodyBuf, stats: null }; }
  finally { clearTimeout(timer); }
}


async function proxy(req, res, base, opts = {}) {
  const { bodyBuf, injectKey, authToken, rewriteModel, model, provider, project } = opts;
  let target = base + req.url;
  const ip = opts.ip || req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const t0 = Date.now();
  let stream = false;
  let headers = buildHeaders(req, { injectKey, authToken });
  let body = bodyBuf;

  // Does this call need OpenAI→Anthropic translation? Only when an OpenAI-shaped request is being
  // served by the claudecode provider. A native /v1/messages caller (Claude Code) is forwarded
  // byte-for-byte — translating it would only lose fidelity and bust its prompt cache.
  const wantsTranslate = !!opts.translate;

  if (bodyBuf && bodyBuf.length) {
    try {
      const j = JSON.parse(bodyBuf.toString());
      stream = !!j.stream;
      if (rewriteModel && j && j.model) j.model = rewriteModel;
      if (provider === "local" && isChatCompletions(req.url)) applyLocalThinkingDefault(j);
      if (wantsTranslate) {
        const a = TR.openaiToAnthropic(j);
        body = Buffer.from(JSON.stringify(a));
        target = base + "/v1/messages";                     // OpenAI path does not exist upstream
      } else {
        body = Buffer.from(JSON.stringify(j));
      }
      headers["content-type"] = "application/json";
    } catch { /* not JSON — leave body as-is */ }
  }

  // The claudecode provider ALWAYS gets synthesized auth headers. A Max setup-token is rejected by
  // Anthropic without `anthropic-beta: oauth-2025-04-20` + a claude-cli UA; trusting the caller to
  // supply them is exactly why only real Claude Code ever worked on this path.
  if (provider === "claudecode" && authToken) {
    headers = {
      ...TR.anthropicHeaders(authToken, { extraBeta: req.headers["anthropic-beta"] || "" }),
      accept: stream ? "text/event-stream" : "application/json",
    };
  }

  // Common fields for the call-log row. claudecode chats are saved in full (uncapped).
  const fullContent = (provider === "claudecode");
  const base_rec = {
    ts: t0, ip, ua: req.headers["user-agent"] || "", method: req.method, path: (req.url || "").split("?")[0],
    reqModel: model || null, provider: provider || "local", sentModel: rewriteModel || model || null,
    keyLabel: opts.account ? `claudecode:${opts.account}` : keyLabel({ provider: provider || "local", target: opts.target }), stream, full: fullContent,
    reqContent: extractRequestContent(bodyBuf, fullContent), project: project || null,
    ...extractReqParams(bodyBuf),
    ...extractReqMeta(bodyBuf),
  };
  let curTarget = target, curProvider = provider;
  let curInit = { method: req.method, headers, redirect: "follow" };
  if (!["GET", "HEAD"].includes(req.method) && body && body.length) curInit.body = body;
  let up = null, threw = false, fetchErr = null;
  try { up = await fetch(curTarget, curInit); }
  catch (e) { threw = true; fetchErr = e; }

  // NOTE: there is no failover. Not to another account, not to another provider. A 429 means the
  // project's pinned account is out of quota and the caller is told so; a 5xx means the upstream
  // failed and the caller is told so. Silently re-answering with a different model on someone
  // else's bill is what the old wrapper→crazyrouter path did, and it hid both cost and truth.
  if (provider === "claudecode" && !threw && up && up.status === 429 && opts.account) {
    recordLimits(up.headers, base_rec.project, base_rec.sentModel || base_rec.reqModel, opts.account);
    console.warn(`[account] 429 on ${opts.account} (project=${base_rec.project || "-"}) — no auto-switch, returning 429 to caller`);
  }

  if (threw) {
    console.error(`[err] fetch-failed provider=${curProvider || "?"} model=${model || "-"} ${curTarget}: ${fetchErr.message}`);
    shipError(`upstream fetch failed: ${fetchErr.message}`, { model: model || "-", provider: curProvider || "?", ip, target: curTarget });
    recordCall({ ...base_rec, status: 502, ms: Date.now() - t0, error: "upstream fetch failed: " + fetchErr.message });
    res.writeHead(502, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "upstream fetch failed: " + fetchErr.message } }));
  }
  if (up.status >= 400) {
    console.error(`[err] upstream=${up.status} provider=${curProvider || "?"} model=${model || "-"} ${curTarget}`);
    up.clone().text().then((t) => shipError(`upstream ${up.status} ${req.method} ${req.url}`, { model: model || "-", provider: curProvider || "?", ip, status: up.status, body: t })).catch(() => {});
  }
  // Image provider: upstream errors arrive as bare text; convert to OpenAI JSON error envelope.
  if (curProvider === "images" && up.status >= 400) {
    const errText = await up.text().catch(() => "");
    const msg = errText.trim() || `image generation failed (${up.status})`;
    res.writeHead(up.status, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: msg, type: "upstream_error", param: null } }));
  }
  // Free rate-limit harvest: snapshot this account's live 5h/7d headroom off the response headers
  // (no probe, zero tokens). Fires for any Anthropic-native reply; a no-op for other providers.
  recordLimits(up.headers, base_rec.project, base_rec.sentModel || base_rec.reqModel, opts.account);
  // App back-pressure: a real 429 arms a per-project throttle (devs are exempt inside note429); any
  // success clears it. server.js reads throttleDelay() before dispatch to pace a project that is
  // hammering a dry account. The 429 itself still reaches the caller — this only slows what's next.
  if (up.status === 429) note429(base_rec.project);
  else if (up.status < 400) note2xx(base_rec.project);
  const isStream = (up.headers.get("content-type") || "").includes("text/event-stream");
  // Only chat/responses/completions calls carry content worth recording; for those we tee the
  // body (capped) to pull tokens + reply. /v1/models etc. are skipped to keep the log signal high.
  // Image generation is billed in GPU time, not tokens, so it carries no `usage` — but an unlogged
  // call is an unattributable one, and `imagegen` went 100% invisible in the call log until 2026-07-09.
  const recordThis = CFG.logging.enabled && req.method === "POST" && /\/(chat\/completions|responses|completions|messages|chat|images\/(generations|edits|variations))$/.test(base_rec.path);

  // ── translated responses (OpenAI caller, claudecode provider) ──
  // The upstream spoke Anthropic; the caller expects OpenAI. Rewrite the body, and DON'T forward
  // upstream's content-length (the translated body is a different size).
  if (wantsTranslate && up.body && up.status < 400) {
    if (isStream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const tr = TR.createSseTranslator({ model: base_rec.sentModel || base_rec.reqModel || "", includeUsage: true });
      const raw = [];
      for await (const chunk of Readable.fromWeb(up.body)) {
        const s = Buffer.from(chunk).toString();
        if (recordThis) raw.push(s);
        const out = tr.push(s);
        if (out) res.write(out);
      }
      res.end();
      if (recordThis) {
        const u = tr.usage ? TR.usageToOpenai(tr.usage) : null;
        recordCall({ ...base_rec, status: up.status, ms: Date.now() - t0,
          usage: u && { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens },
          respContent: raw.join("").slice(0, 20000), stopReason: null, error: null });
      }
      return;
    }
    const buf = Buffer.from(await up.arrayBuffer());
    let out;
    try {
      out = TR.anthropicToOpenai(JSON.parse(buf.toString()), { model: base_rec.sentModel || base_rec.reqModel || "" });
    } catch (e) {
      console.error(`[translate] bad upstream body: ${e.message}`);
      res.writeHead(502, { "content-type": "application/json" });
      recordCall({ ...base_rec, status: 502, ms: Date.now() - t0, error: "translate failed: " + e.message });
      return res.end(JSON.stringify({ error: { message: "translate failed: " + e.message, type: "bad_upstream" } }));
    }
    const outBuf = Buffer.from(JSON.stringify(out));
    res.writeHead(up.status, { "content-type": "application/json" });
    if (recordThis) {
      recordCall({ ...base_rec, status: up.status, ms: Date.now() - t0, usage: out.usage,
        respContent: clip(out.choices?.[0]?.message?.content || ""), stopReason: out.choices?.[0]?.finish_reason || null, error: null });
    }
    return res.end(outBuf);
  }

  const rh = {};
  up.headers.forEach((v, k) => { if (!HOP_RES.has(k.toLowerCase())) rh[k] = v; });
  res.writeHead(up.status, rh);
  if (up.body && !up.bodyUsed) {
    const r = Readable.fromWeb(up.body);
    if (recordThis) {
      // An image reply is multi-MB of base64 with no `usage` and nothing worth reading back. Buffer
      // none of it (cap 0) — the row is worth having, the payload is not.
      const isImage = provider === "images";
      const chunks = []; let size = 0;
      const cap = isImage ? 0 : (base_rec.full ? Infinity : CONTENT_CAP + 8192); // local-dev keeps the full streamed reply
      r.on("data", (d) => { if (size < cap) { chunks.push(Buffer.from(d)); size += d.length; } });
      const done = () => {
        const ex = isImage ? { usage: null, content: null, stopReason: null }
                           : extractResponseBody(Buffer.concat(chunks), isStream);
        recordCall({ ...base_rec, status: up.status, ms: Date.now() - t0, usage: ex.usage, respContent: ex.content,
          stopReason: ex.stopReason, error: up.status >= 400 ? `upstream ${up.status}` : null });
      };
      r.on("end", done); r.on("error", done);
    }
    r.pipe(res);
  } else {
    if (recordThis) recordCall({ ...base_rec, status: up.status, ms: Date.now() - t0, error: up.status >= 400 ? `upstream ${up.status}` : null });
    res.end();
  }
}

// True when the request asks the model to emit JSON (OpenAI `response_format`).

const wantsJsonFormat = (o) => {
  const rf = o && o.response_format;
  if (!rf) return false;
  const t = typeof rf === "string" ? rf : rf.type;
  return t === "json_object" || t === "json_schema";
};

function stripFences(s) {
  const m = String(s).trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : String(s).trim();
}

function validateJsonContent(content) {
  if (content == null || content === "") return { ok: false, error: "empty response content" };
  try { JSON.parse(content); return { ok: true, repaired: false }; }
  catch (e1) {
    const stripped = stripFences(content);
    if (stripped !== content) {
      try { JSON.parse(stripped); return { ok: true, repaired: true, value: stripped }; }
      catch { /* still bad — fall through to the retry path */ }
    }
    return { ok: false, error: e1.message };
  }
}

function jsonInstruction(rf) {
  let s = "Respond with ONLY a single valid JSON value — no markdown code fences, no commentary, nothing before or after the JSON.";
  const schema = rf && typeof rf === "object" && rf.type === "json_schema" && rf.json_schema && rf.json_schema.schema;
  if (schema) s += " It must conform to this JSON Schema: " + JSON.stringify(schema);
  return s;
}
function injectJsonInstruction(messages, rf) {
  const instr = jsonInstruction(rf);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && typeof messages[i].content === "string") {
      messages[i] = { ...messages[i], content: messages[i].content + "\n\n" + instr };
      return;
    }
  }
  messages.push({ role: "user", content: instr });
}

function finishJson(res, wantStream, parsed, rawText) {
  if (!wantStream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(rawText);
  }
  const choice = (parsed.choices && parsed.choices[0]) || {};
  const content = (choice.message && choice.message.content) || "";
  const meta = { id: parsed.id || "chatcmpl-json", created: parsed.created || Math.floor(Date.now() / 1000), model: parsed.model || "" };
  const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ ...meta, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish_reason || null }] })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(chunk({ role: "assistant", content }, null));
  res.write(chunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

async function jsonEnforce(req, res, route) {
  const { base, injectKey, authToken, rewriteModel, model, provider, ip, bodyBuf, project, account } = route;
  const maxRetries = CFG.jsonMaxRetries;
  const reqObj = JSON.parse(bodyBuf.toString());           // caller already verified this parses
  const wantStream = !!reqObj.stream;
  const t0 = Date.now();
  const logRec = {
    ts: t0, ip, ua: req.headers["user-agent"] || "", method: req.method, path: (req.url || "").split("?")[0],
    reqModel: model || null, provider, sentModel: rewriteModel || model || null,
    // Same attribution as the proxy path: without the account name the row cannot be billed to
    // a subscription, and the per-account spend view silently under-counts json-enforced calls.
    keyLabel: account ? `claudecode:${account}` : keyLabel({ provider, target: route.target }), stream: wantStream,
    reqContent: extractRequestContent(bodyBuf), project: project || null,
    ...extractReqParams(bodyBuf),
    ...extractReqMeta(bodyBuf),
  };
  const logJson = (status, parsed, error) => recordCall({ ...logRec, status, ms: Date.now() - t0,
    usage: parsed && parsed.usage, error,
    respContent: parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
      ? parsed.choices[0].message.content : null });
  reqObj.stream = false;                                   // must see the whole body to validate
  if (rewriteModel) reqObj.model = rewriteModel;
  if (provider === "local") applyLocalThinkingDefault(reqObj);
  const messages = Array.isArray(reqObj.messages) ? reqObj.messages.slice() : [];
  const rf = reqObj.response_format;
  const rfType = typeof rf === "string" ? rf : (rf && rf.type);
  // Neither claudecode nor the local json_object mode honours `response_format` natively → strip it
  // and steer with a plain instruction instead.
  if (provider === "claudecode" || (provider === "local" && rfType === "json_object")) {
    delete reqObj.response_format;
    injectJsonInstruction(messages, rf);
  }
  let headers = buildHeaders(req, { injectKey, authToken });
  headers["content-type"] = "application/json";
  headers["accept"] = "application/json";
  let target = base + req.url;
  const curProvider = provider;
  // No failover. If the upstream fails, the caller is told. See proxy() for why.

  // One upstream round-trip. On claudecode we translate OpenAI→Anthropic on the way out and
  // Anthropic→OpenAI on the way back, so everything below this line only ever sees OpenAI shape.
  const translating = curProvider === "claudecode";
  async function callUpstream() {
    const url = translating ? base + "/v1/messages" : target;
    const hdrs = translating
      ? { ...TR.anthropicHeaders(authToken), accept: "application/json" }
      : headers;
    const payload = translating ? TR.openaiToAnthropic(reqObj) : reqObj;
    const up = await fetch(url, { method: "POST", headers: hdrs, redirect: "follow", body: Buffer.from(JSON.stringify(payload)) });
    let text = await up.text();
    if (translating && up.status < 400) {
      try { text = JSON.stringify(TR.anthropicToOpenai(JSON.parse(text), { model: reqObj.model })); }
      catch (e) { console.error(`[translate] json-enforce bad upstream body: ${e.message}`); }
    }
    return { up, text };
  }

  let lastErr = "", lastRaw = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    reqObj.messages = messages;
    let up, text;
    try { ({ up, text } = await callUpstream()); }
    catch (e) {
      console.error(`[err] json-enforce fetch-failed provider=${curProvider} model=${model || "-"} ${target}: ${e.message}`);
      shipError(`json-enforce upstream fetch failed: ${e.message}`, { model: model || "-", provider: curProvider, ip, target });
      recordCall({ ...logRec, status: 502, ms: Date.now() - t0, error: "upstream fetch failed: " + e.message });
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "upstream fetch failed: " + e.message } }));
    }
    if (curProvider === "claudecode") recordLimits(up.headers, logRec.project, logRec.sentModel || logRec.reqModel, account);
    if (up.status >= 400) {                                // upstream error — surfaced, never masked
      console.error(`[err] upstream=${up.status} provider=${curProvider} model=${model || "-"} ${target} (json-enforce)`);
      shipError(`upstream ${up.status} ${req.method} ${req.url} (json-enforce)`, { model: model || "-", provider: curProvider, ip, status: up.status, body: text });
      recordCall({ ...logRec, status: up.status, ms: Date.now() - t0, error: `upstream ${up.status}`, respContent: text });
      const rh = {}; up.headers.forEach((v, k) => { if (!HOP_RES.has(k.toLowerCase())) rh[k] = v; });
      res.writeHead(up.status, rh);
      return res.end(text);
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* upstream sent a non-JSON envelope */ }
    const msg = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message;
    if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length && (msg.content == null || msg.content === "")) {
      logJson(up.status, parsed, null);
      return finishJson(res, wantStream, parsed, text);
    }
    const content = msg && typeof msg.content === "string" ? msg.content : null;
    const v = validateJsonContent(content);
    if (v.ok) {
      if (v.repaired) { msg.content = v.value; logJson(up.status, parsed, null); return finishJson(res, wantStream, parsed, JSON.stringify(parsed)); }
      logJson(up.status, parsed, null);
      return finishJson(res, wantStream, parsed, text);
    }
    lastErr = v.error; lastRaw = content == null ? "" : content;
    console.error(`[err] json-invalid provider=${provider} model=${model || "-"} attempt=${attempt + 1}/${maxRetries + 1}: ${v.error}`);
    if (attempt < maxRetries) {
      // Neutral, non-accusatory wording: claude-haiku reads "your reply failed / do it again" as a
      // prompt-injection attempt and refuses harder. Just restate the format requirement plainly.
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({ role: "user", content: `Please reformat that as a single valid JSON value only — no markdown code fences and no text before or after the JSON.` });
    }
  }
  shipError(`json enforcement failed after ${maxRetries + 1} attempts`, { model: model || "-", provider, ip, error: lastErr });
  recordCall({ ...logRec, status: 422, ms: Date.now() - t0, error: `json_validation_failed: ${lastErr}`, respContent: lastRaw });
  res.writeHead(422, { "content-type": "application/json" });
  res.end(JSON.stringify({
    error: {
      message: `Model did not return valid JSON after ${maxRetries + 1} attempts despite response_format enforcement. Last parse error: ${lastErr}`,
      type: "invalid_response_error", code: "json_validation_failed",
    },
    last_content: lastRaw.slice(0, 4000),
  }));
}


function sendJson(res, status, obj, extraHeaders) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(extraHeaders || {}) });
  res.end(JSON.stringify(obj));
}

const mask = (s) => { const t = String(s || ""); return !t ? "" : t.length <= 6 ? "••••" : "••••" + t.slice(-4); };

module.exports = {
  readBody, sendFile, sendJson, mask, buildHeaders, proxy, jsonEnforce, wantsJsonFormat,
  hasImageContent, headroomCompress, HEADROOM_URL,
};
