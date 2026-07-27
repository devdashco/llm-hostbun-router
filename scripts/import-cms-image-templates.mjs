// One-time import: the `sanity.image_templates` rows (reference picture + style instruction) out of
// the ecosystem CMS Supabase and into this repo, as assets/image-templates/{seed.json,<slug>.<ext>}.
//
// Run it again to re-sync from the CMS; it overwrites the assets and prints what changed. Nothing at
// runtime reads the CMS — that is the point of the import. The router serves the copy in
// /data/image-templates, seeded from the assets committed here.
//
//   SUPABASE_CMS_URL=… SUPABASE_CMS_SERVICE_ROLE_KEY=… node scripts/import-cms-image-templates.mjs
//
// `sites` is derived from BOTH places the CMS records the association: the template's own `site_ids`
// column and the `sites.default_image_template_id` pointer aimed back at it. Reading one of the two
// is how bofrid.se would have gone missing — its association lives only in the second.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "image-templates");
const URL_BASE = (process.env.SUPABASE_CMS_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_CMS_SERVICE_ROLE_KEY || "";
if (!URL_BASE || !KEY) { console.error("SUPABASE_CMS_URL and SUPABASE_CMS_SERVICE_ROLE_KEY are required"); process.exit(1); }

const rest = async (p) => {
  const r = await fetch(`${URL_BASE}/rest/v1/${p}`, {
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "accept-profile": "sanity" },
  });
  if (!r.ok) throw new Error(`GET ${p} → HTTP ${r.status}`);
  return r.json();
};

const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
// The stored extension lies: the bobbo reference is named .heif and is a JPEG. Sniff the bytes.
function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("latin1", 0, 3) === "GIF") return "image/gif";
  return "";
}

// Shrink a reference to what a style anchor actually needs. This is not housekeeping: the reference
// is base64'd into EVERY generation request, so the CMS's 4.7 MB / 2048² PNG would ship 6.3 MB
// upstream per image. 1280px and JPEG q88 is visually identical for this purpose. Transparency is
// preserved (one template is an isolated object on alpha), and a missing ImageMagick is a warning,
// not a failure — the import still produces a working, merely larger, asset.
const MAX_SIDE = 1280, MAX_BYTES = 400 * 1024;
function shrink(file, mime) {
  const before = fs.statSync(file).size;
  const [w, h] = (() => {
    try { return execFileSync("identify", ["-format", "%w %h", file], { encoding: "utf8" }).trim().split(" ").map(Number); }
    catch { return [0, 0]; }
  })();
  if (!w) { console.error("  (imagemagick not available — reference stored as downloaded)"); return file; }
  const hasAlpha = mime === "image/png" &&
    execFileSync("identify", ["-format", "%A", file], { encoding: "utf8" }).trim().toLowerCase() === "true";
  const oversize = Math.max(w, h) > MAX_SIDE || before > MAX_BYTES;
  if (!oversize) return file;
  // Alpha stays PNG (JPEG would flatten it onto black); everything else becomes a JPEG.
  const out = hasAlpha ? file : file.replace(/\.[a-z]+$/i, ".jpg");
  const tmp = out + ".tmp";
  execFileSync("convert", [file, "-resize", `${MAX_SIDE}x${MAX_SIDE}>`, ...(hasAlpha ? [] : ["-quality", "88"]), tmp]);
  // A re-encode can come out BIGGER (an already-tight JPEG a hair over the side cap). Keep whichever
  // is smaller rather than trusting that "shrink" shrank.
  if (fs.statSync(tmp).size >= before) { fs.unlinkSync(tmp); return file; }
  fs.renameSync(tmp, out);
  if (out !== file) fs.unlinkSync(file);
  console.log(`  shrunk ${path.basename(file)} ${Math.round(before / 1024)}KB → ${path.basename(out)} ${Math.round(fs.statSync(out).size / 1024)}KB`);
  return out;
}

const [templates, sites] = await Promise.all([
  rest("image_templates?select=*"),
  rest("sites?select=domain,default_image_template_id"),
]);

const byTemplateId = new Map();
for (const s of sites) {
  if (!s.default_image_template_id) continue;
  const list = byTemplateId.get(s.default_image_template_id) || [];
  list.push(s.domain);
  byTemplateId.set(s.default_image_template_id, list);
}

fs.mkdirSync(OUT, { recursive: true });
const seed = [];
for (const t of templates) {
  const slug = String(t.slug || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) { console.error(`skip: unusable slug ${JSON.stringify(t.slug)}`); continue; }
  let file = "";
  if (t.reference_image_url) {
    const r = await fetch(t.reference_image_url);
    if (!r.ok) { console.error(`skip reference for ${slug}: HTTP ${r.status}`); }
    else {
      const buf = Buffer.from(await r.arrayBuffer());
      const mime = sniff(buf);
      if (!mime) console.error(`skip reference for ${slug}: not an image we can serve`);
      else {
        file = `${slug}${EXT[mime]}`;
        fs.writeFileSync(path.join(OUT, file), buf);
        file = path.basename(shrink(path.join(OUT, file), mime));
      }
    }
  }
  // `site_ids` is stored with and without a scheme ("https://uthyra.se" vs "bostadsmerit.se").
  // Normalize to a bare hostname so a lookup by domain matches either spelling.
  const own = (t.site_ids || []).map((s) => String(s).replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase());
  const pointed = (byTemplateId.get(t.id) || []).map((d) => String(d).toLowerCase());
  seed.push({
    slug,
    name: String(t.name || slug).trim(),
    description: String(t.description || "").trim(),
    systemInstruction: String(t.system_instruction || "").trim(),
    aspectRatio: String(t.aspect_ratio || "").trim(),
    sites: [...new Set([...own, ...pointed])].sort(),
    ...(file ? { file } : {}),
  });
  console.log(`${slug.padEnd(24)} ref=${file || "-"} sites=${new Set([...own, ...pointed]).size}`);
}
seed.sort((a, b) => a.slug.localeCompare(b.slug));
fs.writeFileSync(path.join(OUT, "seed.json"), JSON.stringify(seed, null, 2) + "\n");
console.log(`\nwrote ${seed.length} template(s) → ${path.relative(process.cwd(), OUT)}`);
