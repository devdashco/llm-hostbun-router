// translate.test.js — run: node translate.test.js
// Covers the 7 fidelity traps documented in translate.js. Zero deps, exits non-zero on failure.
"use strict";
const assert = require("assert");
const T = require("./translate");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };

console.log("request: OpenAI -> Anthropic");

t("trap#1 max_tokens is required by Anthropic; defaulted when absent", () => {
  assert.strictEqual(T.openaiToAnthropic({ messages: [] }).max_tokens, T.DEFAULT_MAX_TOKENS);
  assert.strictEqual(T.openaiToAnthropic({ max_tokens: 7, messages: [] }).max_tokens, 7);
  assert.strictEqual(T.openaiToAnthropic({ max_completion_tokens: 9, messages: [] }).max_tokens, 9);
});

t("trap#2 system messages hoist to top-level `system`, not a turn", () => {
  const a = T.openaiToAnthropic({ messages: [
    { role: "system", content: "be terse" }, { role: "system", content: "be kind" },
    { role: "user", content: "hi" }] });
  assert.strictEqual(a.system, "be terse\n\nbe kind");
  assert.strictEqual(a.messages.length, 1);
  assert.strictEqual(a.messages[0].role, "user");
});

t("trap#3 consecutive tool results BATCH into one user turn", () => {
  const a = T.openaiToAnthropic({ messages: [
    { role: "user", content: "go" },
    { role: "assistant", tool_calls: [
      { id: "c1", function: { name: "f", arguments: '{"x":1}' } },
      { id: "c2", function: { name: "g", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "r1" },
    { role: "tool", tool_call_id: "c2", content: "r2" }] });
  const last = a.messages[a.messages.length - 1];
  assert.strictEqual(last.role, "user");
  assert.strictEqual(last.content.length, 2, "both tool_results must share ONE user turn");
  assert.deepStrictEqual(last.content.map((c) => c.tool_use_id), ["c1", "c2"]);
  const asst = a.messages[1];
  assert.strictEqual(asst.content[0].type, "tool_use");
  assert.deepStrictEqual(asst.content[0].input, { x: 1 }, "arguments string must be parsed to input object");
});

t("tools + tool_choice map; tool_choice:none drops tools", () => {
  const tools = [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }];
  assert.deepStrictEqual(T.openaiToAnthropic({ messages: [], tools, tool_choice: "required" }).tool_choice, { type: "any" });
  assert.deepStrictEqual(T.openaiToAnthropic({ messages: [], tools, tool_choice: { function: { name: "f" } } }).tool_choice, { type: "tool", name: "f" });
  assert.strictEqual(T.openaiToAnthropic({ messages: [], tools, tool_choice: "none" }).tools, undefined);
  assert.strictEqual(T.openaiToAnthropic({ messages: [], tools })[
    "tools"][0].input_schema.type, "object");
});

t("data-URI image -> anthropic image block; remote URL dropped, not forwarded", () => {
  const a = T.openaiToAnthropic({ messages: [{ role: "user", content: [
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "image_url", image_url: { url: "https://example.com/x.png" } }] }] });
  const blocks = a.messages[0].content;
  assert.strictEqual(blocks.length, 2, "remote URL must be dropped (Anthropic rejects it)");
  assert.deepStrictEqual(blocks[1].source, { type: "base64", media_type: "image/png", data: "AAAA" });
});

t("unsupported OpenAI knobs are dropped silently, not 400'd", () => {
  const a = T.openaiToAnthropic({ messages: [], frequency_penalty: 1, presence_penalty: 1, n: 3, logit_bias: {} });
  for (const k of ["frequency_penalty", "presence_penalty", "n", "logit_bias"]) assert.ok(!(k in a), k);
});

console.log("response: Anthropic -> OpenAI");

t("text + stop_reason mapping", () => {
  const o = T.anthropicToOpenai({ content: [{ type: "text", text: "hey" }], stop_reason: "max_tokens", usage: { input_tokens: 3, output_tokens: 2 } });
  assert.strictEqual(o.choices[0].message.content, "hey");
  assert.strictEqual(o.choices[0].finish_reason, "length");
  assert.strictEqual(o.object, "chat.completion");
});

t("trap#6 tool_use with no text still yields finish_reason tool_calls", () => {
  const o = T.anthropicToOpenai({ content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }], stop_reason: "tool_use" });
  assert.strictEqual(o.choices[0].finish_reason, "tool_calls");
  assert.strictEqual(o.choices[0].message.content, null);
  assert.strictEqual(o.choices[0].message.tool_calls[0].function.arguments, '{"a":1}');
});

t("trap#7 usage folds cache tokens into prompt_tokens AND keeps them for accounting", () => {
  const u = T.usageToOpenai({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 });
  assert.strictEqual(u.prompt_tokens, 130);
  assert.strictEqual(u.completion_tokens, 5);
  assert.strictEqual(u.total_tokens, 135);
  assert.strictEqual(u.cache_read_input_tokens, 100, "cost accounting needs this");
});

console.log("stream: Anthropic SSE -> OpenAI SSE");

const sse = (ev, obj) => `event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`;
const frames = (s) => s.split("\n\n").filter(Boolean).map((f) => f.replace(/^data: /, ""));

t("text stream: role chunk, content deltas, finish, [DONE]", () => {
  const tr = T.createSseTranslator({ id: "x", model: "m" });
  let out = "";
  out += tr.push(sse("message_start", { message: { usage: { input_tokens: 1 } } }));
  out += tr.push(sse("content_block_start", { index: 0, content_block: { type: "text" } }));
  out += tr.push(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "he" } }));
  out += tr.push(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "llo" } }));
  out += tr.push(sse("message_delta", { delta: { stop_reason: "end_turn" } }));
  out += tr.push(sse("message_stop", {}));
  const f = frames(out);
  assert.strictEqual(f[f.length - 1], "[DONE]");
  assert.strictEqual(JSON.parse(f[0]).choices[0].delta.role, "assistant");
  const text = f.slice(0, -1).map((x) => JSON.parse(x)).map((c) => (c.choices[0] || {}).delta?.content || "").join("");
  assert.strictEqual(text, "hello");
  assert.strictEqual(JSON.parse(f[f.length - 2]).choices[0].finish_reason, "stop");
});

t("trap#4 tool stream: id+name on first delta, partial JSON forwarded verbatim", () => {
  const tr = T.createSseTranslator({ id: "x", model: "m" });
  let out = "";
  out += tr.push(sse("message_start", { message: {} }));
  out += tr.push(sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: "t1", name: "get_weather" } }));
  out += tr.push(sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"ci' } }));
  out += tr.push(sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: 'ty":"NY"}' } }));
  out += tr.push(sse("message_delta", { delta: { stop_reason: "tool_use" } }));
  out += tr.push(sse("message_stop", {}));
  const chunks = frames(out).slice(0, -1).map((x) => JSON.parse(x));
  const start = chunks.find((c) => c.choices[0]?.delta?.tool_calls?.[0]?.id);
  assert.strictEqual(start.choices[0].delta.tool_calls[0].function.name, "get_weather");
  const args = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls || []).map((tc) => tc.function?.arguments || "").join("");
  assert.strictEqual(args, '{"city":"NY"}', "partial_json must reassemble exactly");
  assert.strictEqual(chunks[chunks.length - 1].choices[0].finish_reason, "tool_calls");
});

t("trap#5 thinking_delta never leaks into OpenAI content", () => {
  const tr = T.createSseTranslator();
  let out = "";
  out += tr.push(sse("message_start", { message: {} }));
  out += tr.push(sse("content_block_start", { index: 0, content_block: { type: "thinking" } }));
  out += tr.push(sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "secret reasoning" } }));
  out += tr.push(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "answer" } }));
  assert.ok(!out.includes("secret reasoning"), "thinking must be suppressed");
  assert.ok(out.includes("answer"));
});

t("split SSE frames across chunk boundaries still parse", () => {
  const tr = T.createSseTranslator();
  const whole = sse("message_start", { message: {} }) + sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } });
  let out = "";
  for (let i = 0; i < whole.length; i += 7) out += tr.push(whole.slice(i, i + 7));  // pathological 7-byte chunks
  assert.ok(out.includes('"content":"hi"'), "must buffer partial frames");
});

t("headers are synthesized, never inherited (oauth beta + version + UA)", () => {
  const h = T.anthropicHeaders("sk-ant-oat01-XYZ");
  assert.strictEqual(h.authorization, "Bearer sk-ant-oat01-XYZ");
  assert.strictEqual(h["anthropic-version"], T.ANTHROPIC_VERSION);
  assert.ok(h["anthropic-beta"].includes(T.OAUTH_BETA));
  assert.ok(/claude-cli/.test(h["user-agent"]));
  assert.ok(T.anthropicHeaders("t", { extraBeta: "foo,oauth-2025-04-20" })["anthropic-beta"].split(",").filter((x) => x === T.OAUTH_BETA).length === 1, "beta must dedupe");
});

// ── trap #8: prompt caching on the translated path ────────────────────────
// A long agent loop re-sends its whole transcript every step. Without a breakpoint Anthropic
// caches none of it — that is 1.53B uncached input tokens in a week from one caller.
const bigText = (n) => "x".repeat(n);
const loopBody = (turns) => {
  const messages = [
    { role: "system", content: "# Generation Reviewer\n" + bigText(4000) },
    { role: "user", content: "review this run" },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "t" + i, function: { name: "bash", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: "t" + i, content: bigText(2000) });
  }
  return { model: "claude-haiku-4-5", messages, tools: [{ function: { name: "bash", description: "", parameters: {} } }] };
};
const marks = (o) => JSON.stringify(o).split('"cache_control"').length - 1;

t("a long translated conversation gets cache breakpoints", () => {
  const a = T.openaiToAnthropic(loopBody(6));
  assert.ok(marks(a) > 0, "the whole reason this exists: an agent loop must be cacheable");
  assert.ok(marks(a) <= 4, "Anthropic 400s on a 5th breakpoint");
  assert.deepStrictEqual(a.tools[a.tools.length - 1].cache_control, { type: "ephemeral" }, "tools are the first prefix section");
  assert.ok(Array.isArray(a.system), "system must become blocks to carry cache_control");
  assert.deepStrictEqual(a.system[a.system.length - 1].cache_control, { type: "ephemeral" }, "system is the second prefix section");
});

t("the message breakpoint rolls with the tail of the conversation", () => {
  const a = T.openaiToAnthropic(loopBody(6));
  const tailMarked = a.messages.filter((m) => Array.isArray(m.content) && m.content.some((c) => c.cache_control));
  assert.strictEqual(tailMarked.length, 2, "two rolling breakpoints, a turn apart");
  // They must be at the END of the conversation — a breakpoint at the head caches nothing new.
  const idx = a.messages.map((m, i) => (Array.isArray(m.content) && m.content.some((c) => c.cache_control) ? i : -1)).filter((i) => i >= 0);
  assert.ok(Math.max(...idx) === a.messages.length - 1, "the newest turn must carry one");
});

t("a caller's own cache_control is never overridden — and SURVIVES", () => {
  const body = loopBody(6);
  body.messages[1] = { role: "user", content: [{ type: "text", text: bigText(9000), cache_control: { type: "ephemeral" } }] };
  const a = T.openaiToAnthropic(body);
  assert.strictEqual(a.tools[a.tools.length - 1].cache_control, undefined, "an explicit breakpoint is a deliberate choice — hands off");
  // The half that was missing, and it is the half that costs money. Asserting only that WE did not
  // mark the tools passed for the wrong reason: the block rebuild dropped the caller's field too, so
  // the request went to Anthropic with ZERO breakpoints — strictly worse than saying nothing, and
  // the 12x this file exists to prevent. A check that cannot tell "we respected it" from "it is
  // gone" is not a check.
  const marks = JSON.stringify(a).split('"cache_control"').length - 1;
  assert.strictEqual(marks, 1, "the caller's ONE breakpoint reaches Anthropic — no more, and no fewer");
  const carried = a.messages.find((m) => Array.isArray(m.content) && m.content.some((c) => c.cache_control));
  assert.ok(carried, "...on the block the caller put it on, not moved elsewhere");
});

t("a caller's cache_control on a TOOL definition survives too", () => {
  // The largest stable prefix in an agent request is the tool list, so this is where a caller that
  // knows what it is doing marks. It was dropped by the tools .map(), same as the content blocks.
  const body = loopBody(4);
  body.tools[body.tools.length - 1].cache_control = { type: "ephemeral" };
  const a = T.openaiToAnthropic(body);
  assert.deepStrictEqual(a.tools[a.tools.length - 1].cache_control, { type: "ephemeral" },
    "the tool-list breakpoint reaches Anthropic");
  assert.strictEqual(JSON.stringify(a).split('"cache_control"').length - 1, 1,
    "...and ours stay off — one deliberate mark, not five");
});

t("a short prompt is left uncached (below Anthropic's floor, a write buys nothing)", () => {
  const a = T.openaiToAnthropic({ model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.strictEqual(marks(a), 0);
  assert.strictEqual(typeof a.system, "undefined");
});

t("a one-shot large prompt marks tools/system but not the tail it will never re-send", () => {
  const a = T.openaiToAnthropic({
    model: "m",
    messages: [{ role: "system", content: bigText(9000) }, { role: "user", content: "go" }],
  });
  assert.ok(Array.isArray(a.system) && a.system[0].cache_control, "system repeats across requests — mark it");
  assert.ok(!a.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.cache_control)), "a 2-message body has no history to roll over");
});

t("caching never changes what is actually being asked", () => {
  const body = loopBody(6);
  const plain = T.openaiToAnthropic(body, { cache: false });
  const cached = T.openaiToAnthropic(body);
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "cache_control" ? undefined : v)));
  // system is blocks-vs-string by design; compare its text, everything else must be identical.
  assert.strictEqual(strip(cached).system.map((s) => s.text).join("\n\n"), plain.system);
  const c = strip(cached), p = { ...plain };
  delete c.system; delete p.system;
  assert.deepStrictEqual(c, p, "a breakpoint is metadata — model, messages and tools must be untouched");
});

// Malformed tool `arguments` become {} rather than failing the request. Pinned because it is the
// substitute-a-plausible-default shape this codebase keeps producing (an unpriced model costing $0,
// an unknown window becoming 24h): the caller's broken JSON reaches the model as "no arguments"
// instead of an error, and the model then runs the tool on nothing and answers confidently.
//
// It is nonetheless the RIGHT trade-off here, which is why this pins rather than changes it:
// translate.js is pure and has no way to report, the alternative is failing an inference on a
// caller's formatting, and Anthropic rejects a genuinely invalid block itself. Asserted so that
// changing it is a decision someone makes, not something that drifts.
t("malformed tool arguments degrade to {} — deliberate, not accidental", () => {
  const a = T.openaiToAnthropic({ messages: [
    { role: "user", content: "go" },
    { role: "assistant", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{not json" } }] }] });
  const use = a.messages[1].content.find((b) => b.type === "tool_use");
  assert.deepStrictEqual(use.input, {}, "unparseable arguments must not throw and must not be forwarded raw");
  assert.strictEqual(use.name, "f", "the tool NAME still reaches the model — only its arguments were lost");
  assert.strictEqual(use.id, "c1", "and the id, so the result can still be paired back");
});

// Absent `arguments` is the ordinary no-arg tool call and must be indistinguishable from `{}`.
t("a tool call with no arguments field is an empty input, not a failure", () => {
  const a = T.openaiToAnthropic({ messages: [
    { role: "user", content: "go" },
    { role: "assistant", tool_calls: [{ id: "c2", function: { name: "g" } }] }] });
  assert.deepStrictEqual(a.messages[1].content.find((b) => b.type === "tool_use").input, {});
});

// The shape that makes the cache numbers look broken when they are not: a small system prompt and
// ONE enormous user message (skyvern sends page text and screenshots this way — measured at 1,854
// bytes of system against 3.78 MB of user content). The whole body is far over MIN_CACHEABLE_BYTES,
// so marking runs; but with 2 messages it is under the 3-message floor, so only the system tail is
// marked, and that prefix is under Anthropic's minimum cacheable size — ignored silently, giving
// zero cache READS and zero cache WRITES. Prod read 0.0% on the translated path for exactly this
// reason and it looked like trap #8 regressing. Pinned so the next reader gets the shape, not a hunt.
{
  const body = { model: "claude-haiku-4-5", messages: [
    { role: "system", content: "you are a tester" },
    { role: "user", content: "x".repeat(60000) },
  ] };
  const out = T.openaiToAnthropic(body);
  const marks = JSON.stringify(out).split("cache_control").length - 1;
  assert.strictEqual(marks, 1, "small system + one huge user message gets exactly one mark");
  assert.ok(JSON.stringify(out.system).includes("cache_control"), "...and it is on the system, not the message");
  assert.ok(!JSON.stringify(out.messages).includes("cache_control"),
    "a 2-message conversation gets no tail mark — the tail is what changes every call");
}

console.log(`\n${pass} passed${process.exitCode ? ", SOME FAILED" : ", all green"}`);
