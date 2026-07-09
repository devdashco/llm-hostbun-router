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

console.log(`\n${pass} passed${process.exitCode ? ", SOME FAILED" : ", all green"}`);
