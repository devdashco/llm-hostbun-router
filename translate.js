// translate.js — OpenAI ⇄ Anthropic, in-process, zero deps.
//
// WHY THIS EXISTS
// The gateway talks to api.anthropic.com natively (`/v1/messages`). Most of our apps talk OpenAI
// (`/v1/chat/completions`). Until now that gap was filled by the retired subprocess wrapper, which flattened
// the whole conversation into one "Human:/Assistant:" string, never emitted tool_call deltas, and
// replaced output images with "[Image: Content not supported]". This module replaces it properly:
// structured content blocks in, real tool_calls out, faithful SSE.
//
// SCOPE: pure functions only. No I/O, no globals. That is what makes it testable in isolation —
// see translate.test.js. server.js wires it in; nothing here knows about http.
//
// FIDELITY TRAPS these functions handle (each one silently corrupts output if you skip it):
//   1. Anthropic REQUIRES max_tokens. OpenAI lets you omit it.        → default it.
//   2. Anthropic has no "system" turn.                                → hoist to top-level `system`.
//   3. OpenAI emits one `role:"tool"` message per result; Anthropic
//      wants them BATCHED into a single user turn of tool_result blocks.
//   4. `input_json_delta` streams PARTIAL json — never valid mid-flight → forward verbatim, don't parse.
//   5. `thinking_delta` must NOT leak into OpenAI `content`.          → suppressed.
//   6. An assistant turn with only tool_use still needs finish_reason:"tool_calls".
//   7. cache_read/creation_input_tokens have no OpenAI home but we need them for cost accounting
//      → surfaced on `usage` anyway (extra fields; OpenAI clients ignore unknown keys).

"use strict";

const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_MAX_TOKENS = 4096;

// ── headers ───────────────────────────────────────────────────────────────
// Always synthesized, never trusted from the caller. A Max OAuth token (sk-ant-oat…) is only
// accepted by Anthropic when the oauth beta + a claude-cli user-agent are present; relying on the
// client to send them is why only real Claude Code worked before.
function anthropicHeaders(token, { extraBeta = "", userAgent = "claude-cli/1.0.0 (external, cli)" } = {}) {
  const betas = [OAUTH_BETA, ...String(extraBeta || "").split(",").map((s) => s.trim()).filter(Boolean)];
  return {
    authorization: `Bearer ${token}`,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": [...new Set(betas)].join(","),
    "user-agent": userAgent,
    "content-type": "application/json",
    accept: "application/json",
  };
}

// Does the caller carry its OWN breakpoint? Checked in the four places Anthropic accepts one, not
// by walking the whole body:
//   - a message, or one of its content blocks
//   - a system block
//   - a tool definition (or the OpenAI-shaped `function` inside it)
// It was `JSON.stringify(b).includes('"cache_control"')`, which cannot tell a key from a value: a
// message whose content is literally the word tripped it. A recursive key-walk fixes that and
// introduces the next false positive — a tool whose input_schema has a PROPERTY of that name is a
// JSON-schema field, not a directive, and `{type:"string"}` is indistinguishable from
// `{type:"ephemeral"}` by shape. Tripping this guard means we mark nothing, so every false positive
// sends a request out fully uncached. Enumerating the legal positions is the only reading that
// cannot be fooled by a caller's own vocabulary.
const ccOn = (o) => !!(o && typeof o === "object" && o.cache_control);
const ccInBlocks = (c) => Array.isArray(c) && c.some(ccOn);
function hasCacheControl(b) {
  if (!b || typeof b !== "object") return false;
  if (ccInBlocks(b.system)) return true;
  if (Array.isArray(b.tools) && b.tools.some((t) => ccOn(t) || ccOn(t && t.function))) return true;
  if (Array.isArray(b.messages) && b.messages.some((m) => ccOn(m) || ccInBlocks(m && m.content))) return true;
  return false;
}

// ── request: OpenAI → Anthropic ───────────────────────────────────────────
function contentPartsToAnthropic(parts) {
  const out = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    // `cache_control` rides along. Detecting a caller's own breakpoint makes us skip OUR marking
    // (their choice about where the stable prefix ends beats ours, and a 5th mark is a 400) — but
    // this rebuild used to drop the field, so "hands off" meant the request reached Anthropic with
    // NO breakpoint at all: strictly worse than if the caller had said nothing, and the exact 12x
    // this file exists to prevent. Verified: a 9 KB body with one caller mark translated to zero.
    if (p.type === "text" && typeof p.text === "string") {
      const blk = { type: "text", text: p.text };
      if (p.cache_control) blk.cache_control = p.cache_control;
      out.push(blk); continue;
    }
    if (p.type === "image_url" || p.type === "input_image") {
      const raw = (p.image_url && p.image_url.url) || p.image_url || p.image || "";
      const m = /^data:([^;]+);base64,(.*)$/.exec(String(raw));
      if (m) out.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      // Remote http(s) image URLs are NOT accepted by Anthropic on this beta. Dropping is the
      // honest failure: forwarding produces a confusing 400 from upstream instead.
    }
  }
  return out;
}

function toBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return contentPartsToAnthropic(content);
  return [];
}

// ── trap #8: nothing on the translated path was ever cached ───────────────
//
// Anthropic only caches a prefix you explicitly mark with `cache_control`. Real Claude Code hits
// native /v1/messages and marks its own, which is why pmac/pbox run at ~95% cache hits. Anything
// arriving as OpenAI /v1/chat/completions was translated by this file, which marked nothing — so
// every one of those requests paid full price for its whole prompt, every time.
//
// It stayed invisible until an agent loop showed up: autonoma re-sent a 227-message, 86k-token
// transcript for a 42-token reply, ~113 times per verdict, at 0% cache. 1.53B uncached input
// tokens in 7 days — ~150x the three dev boxes combined, and enough to drain the account pool.
//
// The prompt prefix Anthropic hashes is ordered tools → system → messages, and a breakpoint caches
// everything up to and including itself. So marking the TAIL of each section makes each section a
// prefix of the next, and the whole stable head of the request becomes one cache entry.
const MAX_BREAKPOINTS = 4;   // hard Anthropic limit; a 5th is a 400, not a warning
// Below its floor Anthropic silently declines to cache (2048 tokens on Haiku 4.5, 1024 on
// Sonnet/Opus). Marking a short prompt buys nothing and still bills a cache_write, so don't.
// ~4 bytes/token of JSON puts the floor near 8 KB; being conservative costs one uncached small
// request, being wrong the other way costs a write on every small request.
const MIN_CACHEABLE_BYTES = 8000;

function markCacheBreakpoints(out) {
  let left = MAX_BREAKPOINTS;
  const mark = (block) => {
    if (left <= 0 || !block || typeof block !== "object") return;
    block.cache_control = { type: "ephemeral" };
    left--;
  };

  if (Array.isArray(out.tools) && out.tools.length) mark(out.tools[out.tools.length - 1]);

  // `system` is built as a joined string above; Anthropic takes either that or a block array, and
  // only a block can carry cache_control. Convert only when we are actually marking it.
  if (typeof out.system === "string" && out.system) out.system = [{ type: "text", text: out.system }];
  if (Array.isArray(out.system) && out.system.length) mark(out.system[out.system.length - 1]);

  // A rolling breakpoint on the tail of the conversation. An agent loop appends a turn per step, so
  // THIS request's tail is the NEXT request's stable prefix — that is where the hit lands. Two of
  // them, a turn apart, so a step that appends more than one message still finds a valid entry.
  //
  // Only once there is real history: on a one-shot request the tail is never re-sent, so marking it
  // would bill a cache_write (1.25x) for a hit that never comes. tools+system still get marked —
  // those genuinely do repeat across unrelated requests.
  const msgs = Array.isArray(out.messages) ? out.messages : [];
  if (msgs.length >= 3) {
    for (let i = msgs.length - 1, found = 0; i >= 0 && found < 2; i -= 2) {
      const c = msgs[i] && msgs[i].content;
      if (Array.isArray(c) && c.length) { mark(c[c.length - 1]); found++; }
    }
  }
  return out;
}

function openaiToAnthropic(body, opts) {
  const b = body && typeof body === "object" ? body : {};
  const systems = [];
  const messages = [];
  let pendingToolResults = [];   // trap #3: batch consecutive tool results into ONE user turn

  const flushToolResults = () => {
    if (pendingToolResults.length) {
      messages.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of Array.isArray(b.messages) ? b.messages : []) {
    if (!m || typeof m !== "object") continue;
    const role = m.role;

    if (role === "system" || role === "developer") {          // trap #2
      const t = typeof m.content === "string" ? m.content
        : toBlocks(m.content).filter((x) => x.type === "text").map((x) => x.text).join("\n");
      if (t) systems.push(t);
      continue;
    }

    if (role === "tool") {                                     // trap #3
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: m.tool_call_id || m.id || "",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
      continue;
    }

    flushToolResults();

    if (role === "assistant") {
      const blocks = toBlocks(m.content);
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        let input = {};
        try { input = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch { input = {}; }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function && tc.function.name, input });
      }
      if (blocks.length) messages.push({ role: "assistant", content: blocks });
      continue;
    }

    if (role === "user") {
      const blocks = toBlocks(m.content);
      if (blocks.length) messages.push({ role: "user", content: blocks });
    }
  }
  flushToolResults();

  const out = {
    model: b.model,
    max_tokens: b.max_tokens ?? b.max_completion_tokens ?? DEFAULT_MAX_TOKENS,   // trap #1
    messages,
  };
  if (systems.length) out.system = systems.join("\n\n");
  if (b.stream) out.stream = true;
  if (typeof b.temperature === "number") out.temperature = b.temperature;
  if (typeof b.top_p === "number") out.top_p = b.top_p;
  if (b.stop != null) out.stop_sequences = Array.isArray(b.stop) ? b.stop : [b.stop];

  const tools = Array.isArray(b.tools) ? b.tools.filter((t) => t && t.function) : [];
  const choice = b.tool_choice;
  if (tools.length && choice !== "none") {
    out.tools = tools.map((t) => {
      const def = {
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || { type: "object", properties: {} },
      };
      // Same reason as the content blocks: a caller marking the tail of its tool list is marking
      // the largest stable prefix there is, and dropping it silently un-caches the whole request.
      const cc = t.cache_control || t.function.cache_control;
      if (cc) def.cache_control = cc;
      return def;
    });
    if (choice === "auto") out.tool_choice = { type: "auto" };
    else if (choice === "required") out.tool_choice = { type: "any" };
    else if (choice && choice.function && choice.function.name) out.tool_choice = { type: "tool", name: choice.function.name };
  }
  // Deliberately dropped (Anthropic has no equivalent): frequency_penalty, presence_penalty,
  // logit_bias, n. Silently — 400-ing on them would break callers for a parameter that never
  // mattered here.

  // Cache last, on the finished payload. Skipped when the caller already placed its own
  // cache_control anywhere in the request — an explicit breakpoint is a deliberate choice about
  // where the stable prefix ends, and ours would both override it and risk a 5th breakpoint.
  const cache = !opts || opts.cache !== false;
  if (cache && !hasCacheControl(b)
      && JSON.stringify(out).length >= MIN_CACHEABLE_BYTES) {
    markCacheBreakpoints(out);
  }
  return out;
}

// ── response: Anthropic → OpenAI (non-streaming) ──────────────────────────
const STOP_MAP = { end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool_calls" };

function usageToOpenai(u) {
  const usage = u || {};
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const input = (usage.input_tokens || 0) + cacheRead + cacheWrite;
  const output = usage.output_tokens || 0;
  return {                                                     // trap #7
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

function anthropicToOpenai(resp, { id, created, model } = {}) {
  const r = resp && typeof resp === "object" ? resp : {};
  const blocks = Array.isArray(r.content) ? r.content : [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  const toolCalls = blocks.filter((b) => b.type === "tool_use").map((b, i) => ({
    index: i, id: b.id, type: "function",
    function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
  }));

  const message = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  // trap #6: tool_use with no text must still report finish_reason "tool_calls"
  const finish = STOP_MAP[r.stop_reason] || (toolCalls.length ? "tool_calls" : "stop");

  return {
    id: id || r.id || "chatcmpl",
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: model || r.model || "",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usageToOpenai(r.usage),
  };
}

// ── stream: Anthropic SSE → OpenAI SSE ────────────────────────────────────
// A state machine, because the two protocols disagree on where identity lives. Anthropic announces
// a tool call once (content_block_start) then streams its arguments as partial JSON; OpenAI expects
// {id,name} on the first delta and argument fragments after. We map content_block index → tool index.
function createSseTranslator({ id = "chatcmpl", model = "", includeUsage = false } = {}) {
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model };
  const blockKind = new Map();      // anthropic content_block index → "text" | "tool_use"
  const blockToolIdx = new Map();   // anthropic content_block index → openai tool_calls index
  let nextToolIdx = 0;
  let finish = null;
  let usage = null;
  let rolePushed = false;

  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

  // Feed one parsed Anthropic SSE event; get back 0..n OpenAI SSE frames.
  function event(type, data) {
    const out = [];
    switch (type) {
      case "message_start": {
        if (data && data.message && data.message.usage) usage = data.message.usage;
        if (!rolePushed) { rolePushed = true; out.push(chunk({ role: "assistant", content: "" })); }
        break;
      }
      case "content_block_start": {
        const cb = data.content_block || {};
        blockKind.set(data.index, cb.type);
        if (cb.type === "tool_use") {
          const ti = nextToolIdx++;
          blockToolIdx.set(data.index, ti);
          out.push(chunk({ tool_calls: [{ index: ti, id: cb.id, type: "function", function: { name: cb.name, arguments: "" } }] }));
        }
        break;
      }
      case "content_block_delta": {
        const d = data.delta || {};
        if (d.type === "text_delta") out.push(chunk({ content: d.text }));
        else if (d.type === "input_json_delta") {           // trap #4: forward verbatim
          const ti = blockToolIdx.get(data.index);
          if (ti != null) out.push(chunk({ tool_calls: [{ index: ti, function: { arguments: d.partial_json || "" } }] }));
        }
        // trap #5: thinking_delta / signature_delta → suppressed on the OpenAI surface.
        break;
      }
      case "message_delta": {
        if (data.delta && data.delta.stop_reason) {
          finish = STOP_MAP[data.delta.stop_reason] || (nextToolIdx ? "tool_calls" : "stop");
        }
        if (data.usage) usage = { ...(usage || {}), ...data.usage };
        break;
      }
      case "message_stop": {
        out.push(chunk({}, finish || (nextToolIdx ? "tool_calls" : "stop")));
        if (includeUsage && usage) {
          out.push(`data: ${JSON.stringify({ ...base, choices: [], usage: usageToOpenai(usage) })}\n\n`);
        }
        out.push("data: [DONE]\n\n");
        break;
      }
      default: break;   // ping, error, content_block_stop → nothing to emit
    }
    return out.join("");
  }

  // Byte-stream front end: buffer raw SSE text, emit translated SSE text.
  let buf = "";
  function push(textChunk) {
    buf += textChunk;
    let out = "";
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let ev = null, dataLine = null;
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
      }
      if (!ev || !dataLine) continue;
      let parsed;
      try { parsed = JSON.parse(dataLine); } catch { continue; }
      out += event(ev, parsed);
    }
    return out;
  }

  return { push, event, get usage() { return usage; } };
}

module.exports = {
  ANTHROPIC_VERSION, OAUTH_BETA, DEFAULT_MAX_TOKENS,
  anthropicHeaders, openaiToAnthropic, anthropicToOpenai, usageToOpenai, createSseTranslator,
};
