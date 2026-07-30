// Image templates — a reference picture plus a style instruction, applied to an image-capable
// crazyrouter model (nano-banana and friends).
//
// This is the SECOND image path and it is deliberately not the first one. SD-Turbo's `template`
// (GET /v1/templates) is a prompt-slot randomizer running on our own GPU, billed in GPU seconds;
// a template HERE is a picture the model is told to stay consistent with, rendered upstream and
// billed per image. Same word, two upstreams, so the disambiguation is explicit: a `template` that
// names a template registered here is served from here, and ANY other value falls through to
// SD-Turbo untouched. Router templates win a name collision — they are the ones we can see.
//
// Everything a template needs lives on this box: the metadata is a key in /data/config.json and the
// reference image is a file on the same volume (`/data/image-templates/<slug>.<ext>`), fetched and
// stored ONCE at create time. A template that pointed at someone else's bucket would be a template
// that stops rendering the day that bucket moves — the bofrid `bobbo` template came in as a URL on
// the promopilot CMS and is now a file here, which is the whole point of moving it.
//
// COST: this path spends real money on crazyrouter, unlike every other route under /v1/images/*
// (SD-Turbo is ours and free). That is why it is the one image route behind the API-key gate — see
// authForTemplate(). Invariant 3, "never bill a guess", applies to images too.
const fs = require("node:fs");
const path = require("node:path");

const { CFG, CONFIG_FILE, persistConfig, IMAGE_MODEL_IDS } = require("./config");
const { sanitizeImageTemplate, IMAGE_TEMPLATE_MODELS } = require("./config-schema");
const { readJson, sendJson, proxy } = require("./http");
const { recordCall } = require("./db");
const { authenticate, extractProject, parseConsumer, uaAllowed } = require("./identity");

// Beside config.json on the same persistent volume: one thing to back up, one thing to lose.
const TPL_DIR = process.env.IMAGE_TEMPLATE_DIR || path.join(path.dirname(CONFIG_FILE), "image-templates");
// Templates shipped with the repo, restored when the store is empty (a fresh volume). See seed().
const SEED_DIR = path.join(__dirname, "..", "assets", "image-templates");
// A reference image is a photo, not a payload. 8 MB is far past any reference and small enough that
// a mistake cannot fill the volume.
const MAX_REF_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
const EXT_BY_MIME = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

// Sniff the type from the bytes, never from the caller's label. A `.heif` file that is really a
// JPEG is not hypothetical — the bofrid reference image is exactly that, stored under the wrong
// extension by whatever wrote it, and a data: URI built from its filename tells the model to decode
// a format it was never sent.
function sniffMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.length > 6 && buf.toString("latin1", 0, 3) === "GIF") return "image/gif";
  return "";
}

const templates = () => CFG.imageTemplates || (CFG.imageTemplates = {});
// Which crazyrouter token pays for a rendered template. Access to the image models is granted PER
// TOKEN — the router's main key is perfectly valid and still refuses `gemini-2.5-flash-image` — so
// this can be a different account without moving every text call onto that account's bill.
const imageKey = () => CFG.imageTemplateKey || CFG.crazyrouterKey;
// Look up by name. Returns null for anything not registered here, which is what makes an SD-Turbo
// template name fall through instead of erroring.
function templateFor(name) {
  const slug = String(name || "").trim().toLowerCase();
  if (!slug) return null;
  return templates()[slug] || null;
}

// ── the reference image on disk ───────────────────────────────────────────────
// Cached by (path, mtime, size): the file is static for the life of a template, and base64-encoding
// a megabyte on every generation is pure waste. Keyed on mtime so a replaced reference is picked up
// without a restart.
let refCache = { key: "", mime: "", b64: "" };
function readReference(tpl) {
  if (!tpl || !tpl.reference) return null;
  const file = path.join(TPL_DIR, tpl.reference);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  if (refCache.key === key) return { mime: refCache.mime, b64: refCache.b64 };
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  const mime = sniffMime(buf) || MIME_BY_EXT[path.extname(file).toLowerCase()] || "image/jpeg";
  refCache = { key, mime, b64: buf.toString("base64") };
  return { mime, b64: refCache.b64 };
}

// Accept a reference image as a URL, a data: URI, or bare base64, and land it as a file. Returns
// the stored filename. Throws with a caller-readable message — the admin route turns it into a 400.
async function storeReference(slug, src) {
  let buf = null, mime = "";
  const s = String(src || "").trim();
  if (!s) throw new Error("referenceImage is empty");
  if (/^https?:\/\//i.test(s)) {
    const r = await fetch(s, { signal: AbortSignal.timeout(20000) }).catch((e) => { throw new Error(`fetching ${s} failed: ${e.message}`); });
    if (!r.ok) throw new Error(`fetching ${s} failed: HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
    mime = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  } else {
    const m = s.match(/^data:([a-z0-9.+/-]+);base64,(.*)$/is);
    const b64 = m ? m[2] : s;
    mime = m ? m[1].toLowerCase() : "";
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new Error("referenceImage must be an http(s) URL, a data: URI, or base64");
    buf = Buffer.from(b64.replace(/\s+/g, ""), "base64");
  }
  if (!buf || !buf.length) throw new Error("referenceImage decoded to nothing");
  if (buf.length > MAX_REF_BYTES) throw new Error(`referenceImage is ${Math.round(buf.length / 1024)} KB, over the ${MAX_REF_BYTES / 1024 / 1024} MB cap`);
  // The bytes decide the type; the header/extension is only a fallback for a format we cannot sniff.
  const real = sniffMime(buf) || (EXT_BY_MIME[mime] ? mime : "");
  if (!real) throw new Error("referenceImage is not a JPEG/PNG/WebP/GIF");
  const file = `${slug}${EXT_BY_MIME[real]}`;
  fs.mkdirSync(TPL_DIR, { recursive: true });
  // Drop any earlier reference for this slug first: a template that changes jpg → png would
  // otherwise leave the old file behind and the store would grow one orphan per edit.
  for (const ext of Object.values(EXT_BY_MIME)) {
    if (ext !== EXT_BY_MIME[real]) { try { fs.unlinkSync(path.join(TPL_DIR, `${slug}${ext}`)); } catch { /* absent */ } }
  }
  fs.writeFileSync(path.join(TPL_DIR, file), buf);
  return file;
}

// ── seeding ──────────────────────────────────────────────────────────────────
// Restore the repo's templates when the store is EMPTY, never per-template. Re-seeding a single
// missing slug would resurrect a template someone deliberately deleted, every boot, forever.
function seedImageTemplates() {
  if (Object.keys(templates()).length) return 0;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(SEED_DIR, "seed.json"), "utf8")); }
  catch { return 0; }
  let n = 0;
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    const tpl = sanitizeImageTemplate(entry);
    if (!tpl) continue;
    if (entry.file) {
      try {
        fs.mkdirSync(TPL_DIR, { recursive: true });
        const src = path.join(SEED_DIR, path.basename(entry.file));
        const dest = `${tpl.slug}${path.extname(entry.file).toLowerCase()}`;
        fs.copyFileSync(src, path.join(TPL_DIR, dest));
        tpl.reference = dest;
      } catch (e) { console.error(`[imgtpl] seed ${tpl.slug}: reference copy failed: ${e.message}`); }
    }
    if (!tpl.systemInstruction && !tpl.reference) continue;
    tpl.created = tpl.updated = Date.now();
    templates()[tpl.slug] = tpl;
    n++;
  }
  if (n) { persistConfig(); console.log(`[imgtpl] seeded ${n} template(s) into ${TPL_DIR}`); }
  return n;
}

// ── the public read surface ──────────────────────────────────────────────────
// What a template IS, minus anything an anonymous reader should not have. The instruction is the
// interesting half and is not a secret — it is prompt text we wrote — but the reference image is
// served as its own request so a list stays a list.
const publicView = (t) => ({
  slug: t.slug, name: t.name, description: t.description || "",
  model: t.model || (CFG.imageTemplateModels || IMAGE_TEMPLATE_MODELS)[0],
  aspect_ratio: t.aspectRatio || "",
  system_instruction: t.systemInstruction || "",
  reference_image: t.reference ? `/v1/image-templates/${t.slug}/reference` : null,
  sites: t.sites || [],
  updated: t.updated || 0,
});

// Which template dresses a given site. Exact hostname match — a subdomain is a different site until
// somebody says otherwise, and guessing "support.bofrid.se → bofrid.se" would silently brand a
// support article with the wrong character.
function templateForSite(domain) {
  const d = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!d) return null;
  return Object.values(templates()).find((t) => (t.sites || []).includes(d)) || null;
}

// GET /v1/image-templates            → every template
// GET /v1/image-templates?site=x.se  → the one that dresses that site (404 when none does)
function listPublic(res, site) {
  if (site) {
    const t = templateForSite(site);
    if (!t) return sendJson(res, 404, { error: `no image template is registered for site '${site}'` });
    return sendJson(res, 200, publicView(t));
  }
  const data = Object.values(templates()).map(publicView).sort((a, b) => a.slug.localeCompare(b.slug));
  return sendJson(res, 200, {
    object: "list", data,
    models: CFG.imageTemplateModels || IMAGE_TEMPLATE_MODELS,
    usage: "POST /v1/images/generations {\"model\":\"nano-banana\",\"template\":\"<slug>\",\"prompt\":\"…\"}",
  });
}

// Serve the reference bytes. Extension-LESS by necessity: server.js serves any GET path carrying a
// file extension out of the panel's static export, so `/…/reference.jpg` would 404 out of /srv/panel
// before it ever reached this handler.
function serveReference(res, slug) {
  const tpl = templateFor(slug);
  const ref = tpl && readReference(tpl);
  if (!ref) return sendJson(res, 404, { error: `no reference image for template '${slug}'` });
  res.writeHead(200, { "content-type": ref.mime, "cache-control": "public, max-age=300" });
  return res.end(Buffer.from(ref.b64, "base64"));
}

// ── generation ───────────────────────────────────────────────────────────────
// The prompt the model actually sees: our instruction first (it is the standing rule), then the
// aspect hint, then the caller's scene. Order matters — the instruction has to be read as the frame
// the scene is drawn inside, not as an afterthought appended to it.
function composePrompt(tpl, prompt) {
  return [
    tpl.systemInstruction || "",
    // The upstream chat endpoint takes no size field, so the ratio is carried as text. It is a
    // request, not a guarantee: the model picks the canvas. Ceiling accepted — the alternative is a
    // second upstream shape for one field.
    tpl.aspectRatio ? `Aspect ratio: ${tpl.aspectRatio}.` : "",
    String(prompt || "").trim(),
  ].filter(Boolean).join("\n\n");
}

// Build the crazyrouter chat-completions body. The reference image rides as the first content part
// and the composed prompt as the second — the order every multimodal model documents.
function chatBody(tpl, model, prompt) {
  const content = [];
  const ref = readReference(tpl);
  if (ref) content.push({ type: "image_url", image_url: { url: `data:${ref.mime};base64,${ref.b64}` } });
  content.push({ type: "text", text: composePrompt(tpl, prompt) });
  return { model, messages: [{ role: "user", content }] };
}

// A refusal on this route is worth a row for the same reason the text paths record theirs: it is
// the ONE image path behind a key, so a burst of 401s is someone probing the paid door and a burst
// of 403s is a locked key being used from the wrong client. Without a row both read as "no
// image-template traffic", which is the same silence the image-error branch used to produce.
// `provider: "blocked"` is the value server.js already uses for a call that never reached upstream.
function recordRefusal(req, ip, status, why, project, model) {
  recordCall({
    ts: Date.now(), ip: ip || null, ua: req.headers["user-agent"] || "", method: "POST",
    path: "/v1/images/generations", reqModel: model || null, sentModel: null, provider: "blocked",
    keyLabel: "—", status, ms: 0, error: why, project: project || null,
  });
}

// This route spends money, so it authenticates like inference does — even though every other route
// under /v1/images/* is anonymous (SD-Turbo is our own GPU and free). Returns the attributed project
// on success, or null after having ALREADY answered 401.
function authForTemplate(req, res, docsUrl, ip) {
  const mode = (CFG.auth && CFG.auth.mode) || "optional";
  if (mode === "off") return extractProject(req, Buffer.alloc(0)) || "";
  const auth = authenticate(req);
  if (!auth || !auth.ok) {
    const why = auth ? auth.why : "no API key";
    // The name the caller ASSERTED, not an identity — same as keyFail() in server.js. It is the
    // only handle on who was probing, and it is exactly why the row must not be trusted as billing.
    recordRefusal(req, ip, 401, why, parseConsumer(extractProject(req, Buffer.alloc(0))).consumer, null);
    sendJson(res, 401, { error: {
      type: "invalid_api_key", code: "invalid_api_key",
      message: `${why}. Templated image generation runs on a paid upstream, so it needs an API key: send it as \`Authorization: Bearer sk-llm-…\`. Untemplated /v1/images/generations still goes to our own GPU and stays open.`,
      docs: `${docsUrl}#/images`,
    } }, { "www-authenticate": `Bearer realm="llm.hostbun.cc"` });
    return null;
  }
  // The same client lock the text paths enforce (see uaAllowed in identity.js). This route is where
  // it matters MOST and was the one place it was missing: everything else a locked developer key can
  // reach is a flat subscription or our own GPU, and this one bills crazyrouter per token. A key
  // locked to `claude-cli/` that still buys images is a lock in name only.
  if (!uaAllowed(auth.entry, req.headers["user-agent"])) {
    const ua = String(req.headers["user-agent"] || "(none)").slice(0, 80);
    console.error(`[err] 403 ua not allowed for ${auth.consumer} ua="${ua}" path=images`);
    recordRefusal(req, ip, 403, "client_not_allowed_for_key", auth.consumer, null);
    sendJson(res, 403, { error: {
      type: "permission_error", code: "client_not_allowed_for_key",
      message: `this key belongs to \`${auth.consumer}\`, which only accepts calls from ${(auth.entry.allowUa || []).map((p) => `\`${p}…\``).join(" or ")} — yours says \`${ua}\`. Templated image generation is paid, so it must be billed to the caller that actually ran it.`,
      docs: `${docsUrl}#/identity?id=one-key-per-consumer`,
    } });
    return null;
  }
  const job = String(req.headers["x-job"] || "").trim().toLowerCase() || parseConsumer(extractProject(req, Buffer.alloc(0))).job;
  return job ? `${auth.consumer}:${job}` : auth.consumer;
}

// POST /v1/images/generations, when `template` names one of ours.
async function generate(req, res, { tpl, body, ip, docsUrl }) {
  const project = authForTemplate(req, res, docsUrl, ip);
  if (project === null) return;

  const allowed = CFG.imageTemplateModels || IMAGE_TEMPLATE_MODELS;
  const asked = String(body.model || "").trim().toLowerCase();
  // An SD-Turbo id here means the caller reached for the default image model and a template in the
  // same breath. SD-Turbo cannot see a reference image at all, so honour the template, not the id.
  const model = asked && !IMAGE_MODEL_IDS.includes(asked) ? asked : (tpl.model || allowed[0]);
  // Refuse an id we do not know to be an image model. Without this, `{"template":"bobbo",
  // "model":"claude-opus-5"}` reaches crazyrouter as a chat request, bills per token, and answers an
  // images endpoint with a chat completion — the caller's parser sees `data: undefined` and blames us.
  if (!allowed.includes(model)) {
    recordRefusal(req, ip, 400, "model_not_image_capable", project, model);
    return sendJson(res, 400, { error: {
      type: "invalid_request_error", code: "model_not_image_capable",
      message: `'${model}' is not one of the image models this router will render a template with`,
      models: allowed,
    } });
  }
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    recordRefusal(req, ip, 400, "prompt_required", project, model);
    return sendJson(res, 400, { error: {
      type: "invalid_request_error", code: "prompt_required",
      message: `template '${tpl.slug}' describes a style, not a scene — send \`prompt\` with what to draw`,
    } });
  }
  if (tpl.reference && !readReference(tpl)) {
    // The metadata says there is a reference and the volume disagrees. Rendering anyway would quietly
    // drop the one thing a template is for and return a plausible off-style image.
    recordRefusal(req, ip, 500, "reference_image_missing", project, model);
    return sendJson(res, 500, { error: {
      type: "server_error", code: "reference_image_missing",
      message: `template '${tpl.slug}' names reference image '${tpl.reference}', which is not on disk`,
    } });
  }

  const chat = chatBody(tpl, model, prompt);
  console.log(`[imgtpl] ${new Date().toISOString()} ip=${ip} template=${tpl.slug} model=${model} project=${project || "-"}`);
  // An image-capable model answers chat/completions with `{data:[{url,b64_json}]}` — already the
  // OpenAI images shape — so the upstream response is forwarded verbatim, no rewrap.
  return proxy(req, res, CFG.bases.crazyrouter, {
    bodyBuf: Buffer.from(JSON.stringify(chat)),
    targetPath: "/v1/chat/completions",
    authToken: imageKey(), provider: "crazyrouter", model, project, ip,
  });
}

// ── the control-plane routes (behind the panel cookie, dispatched from admin.js) ──
function listAdmin(res) {
  return sendJson(res, 200, {
    templates: Object.values(templates()).map(publicView).sort((a, b) => a.slug.localeCompare(b.slug)),
    models: CFG.imageTemplateModels || IMAGE_TEMPLATE_MODELS,
    dir: TPL_DIR,
  });
}

// Create or edit one template. MERGES: a save that omits `referenceImage` keeps the stored picture,
// so editing the instruction from a panel that never had the bytes cannot blank it (same hazard as
// POST config wiping key hashes).
async function saveTemplate(req, res, ip) {
  const p = await readJson(req, res);
  if (!p) return;
  const prev = templateFor(p.slug);
  const tpl = sanitizeImageTemplate({ ...(prev || {}), ...p });
  if (!tpl) return sendJson(res, 400, { error: "slug must be lowercase a-z0-9- (max 64), and the template needs a name" });
  if (p.referenceImage || p.reference_image) {
    try { tpl.reference = await storeReference(tpl.slug, p.referenceImage || p.reference_image); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  } else if (prev) {
    tpl.reference = prev.reference || "";
  }
  // A template with neither an instruction nor a picture says nothing — it would render exactly the
  // caller's prompt and pretend a style was applied.
  if (!tpl.systemInstruction && !tpl.reference)
    return sendJson(res, 400, { error: "a template needs systemInstruction, referenceImage, or both" });
  tpl.created = (prev && prev.created) || Date.now();
  tpl.updated = Date.now();
  templates()[tpl.slug] = tpl;
  const persisted = persistConfig();
  console.log(`[imgtpl] saved ${tpl.slug} ref=${tpl.reference || "-"} ip=${ip} persisted=${persisted}`);
  return sendJson(res, 200, { ok: true, persisted, template: publicView(tpl) });
}

// Render one template from the panel, so "did this template come out right" is answerable where the
// template is edited. It spends the same money the public route does — the difference is who is
// asking (the admin cookie, not an API key), which is why it is a separate route and not a flag on
// the public one. Kept OUT of proxy(): there is no caller request to forward, only a form submit.
async function renderTemplate(req, res, ip) {
  const p = await readJson(req, res);
  if (!p) return;
  const tpl = templateFor(p.slug);
  if (!tpl) return sendJson(res, 400, { error: `no template '${p.slug}'` });
  const prompt = String(p.prompt || "").trim();
  if (!prompt) return sendJson(res, 400, { error: "prompt required — a template is a style, not a scene" });
  const allowed = CFG.imageTemplateModels || IMAGE_TEMPLATE_MODELS;
  const model = allowed.includes(String(p.model || "").toLowerCase()) ? String(p.model).toLowerCase() : (tpl.model || allowed[0]);
  console.log(`[imgtpl] render ${tpl.slug} model=${model} ip=${ip} (panel)`);
  // This route bypasses proxy(), so nothing writes the call-log row for it — and it spends the same
  // crazyrouter money the public route does, per token. Unlogged, a panel preview loop is invisible
  // in /api/stats and unfindable when the bill moves. `panel:image-template-render` is not a
  // registered consumer and is not meant to be: the row says WHERE the spend came from, and an
  // operator-triggered render genuinely belongs to no caller.
  const t0 = Date.now();
  const record = (status, extra) => recordCall({
    ts: t0, ip, ua: req.headers["user-agent"] || "", method: "POST", path: "/api/image-templates/render",
    reqModel: model, sentModel: model, provider: "crazyrouter", keyLabel: "imageTemplateKey",
    status, ms: Date.now() - t0, project: `panel:image-template-render`, ...extra,
  });
  try {
    const r = await fetch(`${CFG.bases.crazyrouter}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${imageKey()}` },
      body: JSON.stringify(chatBody(tpl, model, prompt)),
      signal: AbortSignal.timeout(180000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      record(502, { error: `upstream ${r.status}` });
      return sendJson(res, 502, { error: `upstream ${r.status}`, upstream: j });
    }
    const url = j && j.data && j.data[0] && (j.data[0].url || (j.data[0].b64_json ? `data:image/png;base64,${j.data[0].b64_json}` : ""));
    // No image in a 200 means the id is not actually an image model — say that, rather than handing
    // the panel an empty <img> and letting it read as "the template is broken".
    if (!url) {
      // A 200 from upstream: this one BILLED and produced nothing usable, which is the branch most
      // worth having a row for.
      record(502, { error: `'${model}' answered without an image`, usage: (j && j.usage) || {} });
      return sendJson(res, 502, { error: `'${model}' answered without an image — is it an image model?`, upstream: j });
    }
    record(200, { usage: (j && j.usage) || {} });
    return sendJson(res, 200, { ok: true, model, url });
  } catch (e) {
    record(502, { error: `render failed: ${e.message}` });
    return sendJson(res, 502, { error: `render failed: ${e.message}` });
  }
}

async function removeTemplate(req, res, ip) {
  const p = await readJson(req, res);
  if (!p) return;
  const tpl = templateFor(p.slug);
  if (!tpl) return sendJson(res, 400, { error: `no template '${p.slug}'`, templates: Object.keys(templates()) });
  if (tpl.reference) { try { fs.unlinkSync(path.join(TPL_DIR, tpl.reference)); } catch { /* already gone */ } }
  delete templates()[tpl.slug];
  const persisted = persistConfig();
  console.log(`[imgtpl] removed ${tpl.slug} ip=${ip} persisted=${persisted}`);
  return sendJson(res, 200, { ok: true, persisted, templates: Object.keys(templates()) });
}

module.exports = {
  TPL_DIR, templateFor, templateForSite, seedImageTemplates, listPublic, serveReference, generate,
  listAdmin, saveTemplate, removeTemplate, renderTemplate, storeReference, readReference, composePrompt, chatBody,
};
