// Image templates — the SECOND image path: a reference picture plus a style instruction, rendered
// by an image-capable crazyrouter model. Boots the real server against two fake upstreams (one
// standing in for crazyrouter, one for SD-Turbo) so the assertions are about WHICH upstream a
// request reached and WHAT it carried when it got there.
//
//   node test/imagetemplates.test.mjs
//
// Every check below is a way this feature fails silently rather than loudly:
//
//   • the reference image is the whole point of a template, so a request that reaches the model
//     WITHOUT it still returns a perfectly good, perfectly off-brand picture — nothing errors.
//   • the two upstreams share one path and one field name (`template`). Get the fallthrough wrong
//     and SD-Turbo's own prompt templates (profile-woman-back, …) start being answered by a paid
//     cloud model, or ours stop being answered at all.
//   • this is the one route under /v1/images/* that spends money. Every other one is our GPU and is
//     deliberately anonymous. An unauthenticated paid route is invariant 3 ("never bill a guess")
//     failing in the direction nobody notices until the invoice.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort(), CRAZY = await freePort(), SDTURBO = await freePort();
let pass = 0, fail = 0;
const ok = (name) => { console.log(`  ok    ${name}`); pass++; };
const bad = (name, why) => { console.log(`  FAIL  ${name}\n        ${why}`); fail++; };
const check = (name, cond, why = "") => (cond ? ok(name) : bad(name, why));

// Two upstreams, so "which one answered" is an assertion and not an inference. Each records what it
// was sent; the crazyrouter stand-in answers in the shape an image-capable model really does — the
// OpenAI IMAGES envelope out of a chat/completions call, which is why the router forwards it as-is.
const seen = { crazy: [], sd: [] };
const stub = (bucket, body) => http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    let json = null; try { json = JSON.parse(b); } catch { /* not json */ }
    seen[bucket].push({ path: req.url, headers: req.headers, body: json, raw: b });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});
const crazyStub = stub("crazy", { created: 1, data: [{ url: "https://media.example/img.png", b64_json: "", revised_prompt: "" }] });
const sdStub = stub("sd", { created: 1, data: [{ b64_json: "AAAA", revised_prompt: "sd" }] });
await new Promise((r) => crazyStub.listen(CRAZY, r));
await new Promise((r) => sdStub.listen(SDTURBO, r));

// A real key, minted the way the server verifies one: the id is public, only sha256(secret) is
// stored. auth.mode is `required` — the mode prod actually runs — so the paid route is tested under
// the gate it ships behind, not a laxer one.
const KEY = "sk-llm-testkey1-s3cret";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "imgtpl-test-"));
const cfgPath = path.join(TMP, "config.json");
fs.writeFileSync(cfgPath, JSON.stringify({
  bases: { local: `http://127.0.0.1:${CRAZY}`, crazyrouter: `http://127.0.0.1:${CRAZY}`, claudecode: `http://127.0.0.1:${CRAZY}` },
  crazyrouterKey: "crazy-test-key", requireProject: false, requireRegisteredConsumer: false,
  auth: { mode: "required" }, logging: { enabled: false, content: false },
  consumers: { tester: { kind: "app", keys: [{ id: "testkey1", hash: sha256("s3cret"), created: 1 }] } },
  consumerAliases: {},
}));

const srv = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), CONFIG_FILE: cfgPath, PRICES_FILE: "/nonexistent.json",
    IMAGE_BASE: `http://127.0.0.1:${SDTURBO}`, IMAGE_TEMPLATE_DIR: path.join(TMP, "image-templates"),
    ADMIN_PASSWORD: "ddash", SESSION_INSECURE: "1", DATABASE_URL: "", ANTHROPIC_BASE: "http://127.0.0.1:1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));
process.on("exit", () => srv.kill());

const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100 && !/listening|Listening/.test(log); i++) await new Promise((r) => setTimeout(r, 50));
await new Promise((r) => setTimeout(r, 200));

const call = async (p, init = {}) => {
  const r = await fetch(BASE + p, init);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, text, json };
};
const keyed = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
  body: JSON.stringify(body),
});

// ── the store seeds itself ───────────────────────────────────────────────────
// A fresh /data volume has no templates and no pictures. If seeding is silent about failing, the
// first symptom is a caller's template "not found" months later on a rebuilt box.
console.log("\nseeding:");
const list = await call("/v1/image-templates");
const slugs = (list.json && list.json.data || []).map((t) => t.slug);
check("an empty store seeds the repo's templates", slugs.includes("bobbo"), `got ${JSON.stringify(slugs)}`);
check("...with the CMS instruction text intact",
  /NO TEXT/i.test(((list.json.data || []).find((t) => t.slug === "bobbo") || {}).system_instruction || ""),
  "bobbo's instruction did not survive the import");
check("...and the site association the CMS held in a second table",
  ((list.json.data || []).find((t) => t.slug === "bobbo") || {}).sites?.includes("bofrid.se"),
  "bofrid.se is not associated with bobbo");

const bySite = await call("/v1/image-templates?site=bofrid.se");
check("a caller can ask by site instead of by slug", bySite.json && bySite.json.slug === "bobbo", bySite.text.slice(0, 120));
const noSite = await call("/v1/image-templates?site=nobody.example");
check("an unknown site is a 404, not a silent default", noSite.status === 404, `status ${noSite.status}`);

// The reference path carries no file extension BECAUSE server.js serves any extension out of the
// panel's static export. `/reference.jpg` would 404 from /srv/panel and never reach the handler.
const ref = await call("/v1/image-templates/bobbo/reference");
check("the reference image is served as an image", ref.status === 200 && /^image\//.test(ref.headers.get("content-type") || ""),
  `status ${ref.status} type ${ref.headers.get("content-type")}`);

// ── the paid route is gated; the free one is not ─────────────────────────────
console.log("\nthe cost gate:");
seen.crazy.length = 0; seen.sd.length = 0;
const anon = await call("/v1/images/generations", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ template: "bobbo", prompt: "a house" }),
});
check("a templated generation with no key is refused", anon.status === 401, `status ${anon.status}`);
check("...and nothing was sent upstream on our bill", seen.crazy.length === 0, `${seen.crazy.length} upstream call(s)`);

const sdAnon = await call("/v1/images/generations", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "a house", size: "1024x1024" }),
});
check("an untemplated generation stays open (our GPU, free)", sdAnon.status === 200, `status ${sdAnon.status}`);
check("...and reaches SD-Turbo, not the paid upstream", seen.sd.length === 1 && seen.crazy.length === 0,
  `sd=${seen.sd.length} crazy=${seen.crazy.length}`);

// ── what actually reaches the model ──────────────────────────────────────────
console.log("\nthe request the model sees:");
seen.crazy.length = 0; seen.sd.length = 0;
const gen = await call("/v1/images/generations", keyed({ model: "nano-banana", template: "bobbo", prompt: "handing over keys" }));
check("a keyed templated generation succeeds", gen.status === 200, `status ${gen.status} ${gen.text.slice(0, 160)}`);
check("...answered with the upstream's images envelope, unwrapped",
  !!(gen.json && gen.json.data && gen.json.data[0] && gen.json.data[0].url), gen.text.slice(0, 160));
const sent = seen.crazy[0] || { path: "", body: {}, headers: {} };
check("...sent to chat/completions, where a reference image can travel", sent.path === "/v1/chat/completions", `path ${sent.path}`);
check("...to the paid upstream only", seen.sd.length === 0, `sd got ${seen.sd.length}`);
check("...with OUR key injected, never the caller's",
  sent.headers.authorization === "Bearer crazy-test-key", `auth ${sent.headers.authorization}`);
const parts = (((sent.body || {}).messages || [])[0] || {}).content || [];
check("...carrying the reference image as a data: URI",
  parts.some((p) => p.type === "image_url" && /^data:image\/[a-z]+;base64,\S+/.test(p.image_url?.url || "")),
  JSON.stringify(parts.map((p) => p.type)));
const text = (parts.find((p) => p.type === "text") || {}).text || "";
check("...the template's instruction ahead of the caller's scene",
  /NO TEXT/i.test(text) && text.indexOf("handing over keys") > text.indexOf("NO TEXT"), JSON.stringify(text.slice(0, 120)));
check("...and the template's aspect ratio, which the chat shape has no field for",
  /Aspect ratio: 1:1/.test(text), JSON.stringify(text.slice(0, 200)));

// ── refusals that keep a paid upstream from being reached by accident ────────
console.log("\nrefusals:");
seen.crazy.length = 0;
const textModel = await call("/v1/images/generations", keyed({ model: "claude-opus-5", template: "bobbo", prompt: "x" }));
check("a text model on a templated image request is refused", textModel.status === 400, `status ${textModel.status}`);
check("...before it costs anything", seen.crazy.length === 0, `${seen.crazy.length} upstream call(s)`);
const noPrompt = await call("/v1/images/generations", keyed({ template: "bobbo" }));
check("a template with no prompt is refused (a style is not a scene)", noPrompt.status === 400, `status ${noPrompt.status}`);

// SD-Turbo has its own `template` vocabulary on the same field and the same path. An unknown name
// must fall through untouched, or every SD template becomes "not found" the day this shipped.
seen.crazy.length = 0; seen.sd.length = 0;
const sdTpl = await call("/v1/images/generations", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ template: "profile-woman-back", prompt: "x" }),
});
check("an SD-Turbo template name still reaches SD-Turbo", sdTpl.status === 200 && seen.sd.length === 1, `status ${sdTpl.status} sd=${seen.sd.length}`);
check("...verbatim, with its template field intact", (seen.sd[0]?.body || {}).template === "profile-woman-back", JSON.stringify(seen.sd[0]?.body));
check("...and never reaches the paid upstream", seen.crazy.length === 0, `crazy=${seen.crazy.length}`);

// ── creating a template ──────────────────────────────────────────────────────
console.log("\ncreate / edit / delete:");
const login = await fetch(`${BASE}/api/login`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "ddash" }),
});
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const admin = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
// A 1×1 PNG. Small enough to inline, real enough that the byte sniffer has to agree it is a PNG.
const PNG1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const made = await admin("/api/image-templates", {
  slug: "unittest", name: "Unit Test", systemInstruction: "always a red square", aspectRatio: "4:3",
  referenceImage: `data:image/png;base64,${PNG1x1}`,
});
check("a template can be created with an inline reference image", made.status === 200, JSON.stringify(made.json).slice(0, 160));
const madeRef = await call("/v1/image-templates/unittest/reference");
check("...and the picture is stored on the volume, not the request", madeRef.status === 200 && madeRef.headers.get("content-type") === "image/png",
  `status ${madeRef.status} type ${madeRef.headers.get("content-type")}`);

// Editing must MERGE: a panel that never had the bytes would otherwise blank the picture on every
// instruction edit — the same hazard POST config has with key hashes.
const edited = await admin("/api/image-templates", { slug: "unittest", systemInstruction: "always a blue square" });
check("an edit without a picture keeps the stored one", edited.status === 200 && edited.json.template.reference_image,
  JSON.stringify(edited.json).slice(0, 160));

const empty = await admin("/api/image-templates", { slug: "sayings-nothing" });
check("a template with neither instruction nor picture is refused", empty.status === 400, JSON.stringify(empty.json));
const badSlug = await admin("/api/image-templates", { slug: "../../etc/passwd", systemInstruction: "x" });
check("a slug that would escape the store is refused", badSlug.status === 400, JSON.stringify(badSlug.json));

const gone = await admin("/api/image-templates/remove", { slug: "unittest" });
check("a template can be deleted", gone.status === 200, JSON.stringify(gone.json));
check("...and its picture goes with it", !fs.existsSync(path.join(TMP, "image-templates", "unittest.png")), "the file is still on disk");
const goneRef = await call("/v1/image-templates/unittest/reference");
check("...leaving nothing to serve", goneRef.status === 404, `status ${goneRef.status}`);

// A deleted template must NOT come back on the next boot — seeding restores the repo set only when
// the store is EMPTY, precisely so a deliberate deletion sticks.
const stored = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
check("the store persisted to disk", Object.keys(stored.imageTemplates || {}).includes("bobbo"), Object.keys(stored.imageTemplates || {}).join(","));
check("...without the deleted one", !Object.keys(stored.imageTemplates || {}).includes("unittest"), "unittest survived the delete");

srv.kill();
crazyStub.close(); sdStub.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("\n--- server log ---\n" + log.slice(-3000)); process.exit(1); }
process.exit(0);
