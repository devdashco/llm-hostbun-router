// Structured-output enforcement: when a caller asks for JSON (`response_format`), make sure it
// actually gets JSON — retrying once with an explicit instruction rather than handing back prose
// the caller will crash on.
//
// Split out of http.js on 2026-07-26, which had grown to 536 lines and was over the 500 budget
// (readJson and the image-error recordCall both landed there this session). This is the one block
// in that file with its own subject: everything else is the wire — read a body, build headers,
// stream a proxied response. The dependency runs ONE way, jsonenforce → http, and must keep doing
// so: http.js does not import this module, so requiring `proxy` and `buildHeaders` back out of it
// cannot cycle. server.js imports jsonEnforce/wantsJsonFormat from here now, not from http.
const TR = require("../translate");
const { CFG } = require("./config");
const { recordCall, recordLimits } = require("./db");
const { noteAcctCooldown, clearAcctCooldown } = require("./routing");
const { buildHeaders, HOP_RES, upstreamReason } = require("./http");
const { keyLabel, extractReqAll, applyLocalThinkingDefault, shipError } = require("./telemetry");

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

// Does any message already say "json"? Content can be a string or an array of multimodal parts, and
// a caller asking for JSON usually says so — so this is normally true and nothing is injected.
function mentionsJson(messages) {
  const hit = (s) => typeof s === "string" && /json/i.test(s);
  return messages.some((m) => hit(m && m.content)
    || (Array.isArray(m && m.content) && m.content.some((p) => hit(p && p.text))));
}

// `json_object` mode on the OpenAI-compatible providers REQUIRES the literal token "json" somewhere
// in the messages — a rule OpenAI wrote and groq inherited. Without it the upstream refuses the
// request outright: `'messages' must contain the word 'json' in some form` (400, measured on all
// five groq models 2026-08-04). The router forwards `response_format` untouched, so every
// json_object call to a free lane failed before this — and it failed as an upstream 400 that reads
// like a routing bug rather than a two-word prompt requirement.
//
// The fix is to append the SAME instruction claudecode gets, which contains the word — but unlike
// claudecode, `response_format` STAYS. That distinction is the whole point: on claudecode there is
// no such field on the wire so prose is all there is, whereas here the upstream compiles a real
// constraint and the instruction is only there to satisfy the gate in front of it. Downgrading one
// to the other is the mistake this file already made once on the local lane.
//
// Only for `json_object`: `json_schema` carries the schema itself and needs no keyword (verified —
// gpt-oss answered a schema request whose prompt never said "json"). And only when the messages
// don't already say it, so a prompt that mentions JSON is left byte-identical and keeps its cache.
//
// `local` is EXCLUDED, and not as an oversight. llama.cpp has no keyword gate — it compiles the
// grammar directly — so the sentence would buy nothing there, and it is not free: the server picks a
// slot by longest-common-prefix similarity against what it already has resident (`selected slot by
// LCP similarity` in its own log). Appending a sentence to the last user turn perturbs the prefix
// that reuse keys on. So the rule is "the OpenAI-compatible relays need the token, our own GPU does
// not", which is a property of the upstream rather than a list of provider names to keep updated.
const JSON_KEYWORD_EXEMPT = new Set(["local", "claudecode"]);   // claudecode is handled above
const needsJsonKeyword = (rf, provider) => {
  if (JSON_KEYWORD_EXEMPT.has(provider)) return false;
  const t = typeof rf === "string" ? rf : rf && rf.type;
  return t === "json_object";
};

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
    project: project || null,
    // One parse, as in proxy(). jsonEnforce runs on the same bodies and paid the same 3x tax.
    ...extractReqAll(bodyBuf, false),
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
  // claudecode has no `response_format` on the wire — strip it and steer with a plain instruction.
  // The local lane KEEPS it: llama.cpp compiles both `json_object` and `json_schema` into a GBNF
  // grammar and honours them. This used to strip `json_object` there too, which downgraded a hard
  // grammar guarantee to a prose plea — measured 2026-07-31 on gemma-4-26b with a prompt asking
  // for prose, llama.cpp answered `{"description": …}` and the stripped path answered a bare JSON
  // *string*. Both parse, so nothing errored; a caller expecting an object got a string.
  if (provider === "claudecode") {
    delete reqObj.response_format;
    injectJsonInstruction(messages, rf);
  } else if (needsJsonKeyword(rf, provider) && !mentionsJson(messages)) {
    // See needsJsonKeyword above: satisfies the upstream's keyword gate WITHOUT touching
    // response_format, so the real constraint still applies.
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
    if (curProvider === "claudecode" && account) {         // steer the NEXT auto-pick (never a retry — invariant #2)
      if (up.status === 429) noteAcctCooldown(account, Number(up.headers.get("retry-after")) || 0);
      else if (up.status < 400) clearAcctCooldown(account);
    }
    if (up.status >= 400) {                                // upstream error — surfaced, never masked
      console.error(`[err] upstream=${up.status} provider=${curProvider} model=${model || "-"} ${target} (json-enforce)`);
      shipError(`upstream ${up.status} ${req.method} ${req.url} (json-enforce)`, { model: model || "-", provider: curProvider, ip, status: up.status, body: text });
      // The reason, not just the status. This path has the whole body in `text` already, and it was
      // recording a bare `upstream 429` — indistinguishable from `upstream 529` (overloaded) or a
      // spent weekly window, which need opposite responses. proxy() learned this a few commits ago
      // and this one did not: the json-enforce path is where redbut and global-ci actually run, so
      // it is the path most of those rows come from.
      recordCall({ ...logRec, status: up.status, ms: Date.now() - t0, respContent: text,
        error: `upstream ${up.status}${upstreamReason(text) ? `: ${upstreamReason(text)}` : ""}` });
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

module.exports = { jsonEnforce, wantsJsonFormat };
