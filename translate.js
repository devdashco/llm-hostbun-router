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

// ── request: OpenAI → Anthropic ───────────────────────────────────────────
function contentPartsToAnthropic(parts) {
  const out = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") { out.push({ type: "text", text: p.text }); continue; }
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

function openaiToAnthropic(body) {
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
    out.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
    if (choice === "auto") out.tool_choice = { type: "auto" };
    else if (choice === "required") out.tool_choice = { type: "any" };
    else if (choice && choice.function && choice.function.name) out.tool_choice = { type: "tool", name: choice.function.name };
  }
  // Deliberately dropped (Anthropic has no equivalent): frequency_penalty, presence_penalty,
  // logit_bias, n. Silently — 400-ing on them would break callers for a parameter that never
  // mattered here.
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
