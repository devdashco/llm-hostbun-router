"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHead } from "@/components/panel/primitives";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";

// A reference picture + a standing style instruction, rendered by an image-capable model on
// crazyrouter. It lives under Providers because that is the upstream it spends against — the same
// reason the crazyrouter key does. SD-Turbo's own prompt templates are a different thing on the same
// field name and are not editable here; see src/imagetemplates.js.

type Tpl = {
  slug: string;
  name: string;
  description: string;
  model: string;
  aspect_ratio: string;
  system_instruction: string;
  reference_image: string | null;
  sites: string[];
  updated: number;
};

const BLANK: Tpl = {
  slug: "", name: "", description: "", model: "", aspect_ratio: "1:1",
  system_instruction: "", reference_image: null, sites: [], updated: 0,
};

// A file input hands us bytes; the API takes a data: URI. Doing it here keeps the upload a plain
// JSON POST, so there is no multipart parser in a zero-dependency router.
const fileToDataUrl = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ""));
    r.onerror = () => rej(new Error("could not read that file"));
    r.readAsDataURL(f);
  });

export function ImageTemplates() {
  const [state, setState] = useState<any>("loading");
  const [edit, setEdit] = useState<Tpl | null>(null);
  const [pic, setPic] = useState<string>("");        // a newly picked reference, as a data: URI
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<string>("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      setState(await api("image-templates"));
    } catch {
      setState(null);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!edit) return;
    if (!edit.slug.trim()) return notify("a slug is required", true);
    setBusy(true);
    try {
      await api("image-templates", {
        method: "POST",
        body: JSON.stringify({
          slug: edit.slug.trim().toLowerCase(),
          name: edit.name,
          description: edit.description,
          systemInstruction: edit.system_instruction,
          model: edit.model,
          aspectRatio: edit.aspect_ratio,
          sites: edit.sites,
          // Omitted when nothing new was picked — the server then KEEPS the stored picture. Sending
          // an empty string here would blank it on every instruction edit.
          ...(pic ? { referenceImage: pic } : {}),
        }),
      });
      notify(`saved ${edit.slug}`);
      setEdit(null);
      setPic("");
      setPreview("");
      load();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function remove(slug: string) {
    if (!confirm(`Delete template "${slug}" and its reference picture?`)) return;
    try {
      await api("image-templates/remove", { method: "POST", body: JSON.stringify({ slug }) });
      notify(`deleted ${slug}`);
      if (edit?.slug === slug) setEdit(null);
      load();
    } catch (e: any) {
      notify(e.message, true);
    }
  }

  // Renders for real, on our crazyrouter key. Costs money per click — worth it, because "is this
  // template right" is otherwise a question you can only answer from another system.
  async function render() {
    if (!edit || !prompt.trim()) return notify("describe a scene first", true);
    setBusy(true);
    setPreview("");
    try {
      const r: any = await api("image-templates/render", {
        method: "POST",
        body: JSON.stringify({ slug: edit.slug, prompt, model: edit.model }),
      });
      setPreview(r.url);
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") return <p className="text-body text-muted-foreground">loading…</p>;
  if (!state) return <p className="text-body text-destructive">could not load image templates</p>;

  const list: Tpl[] = state.templates || [];
  const models: string[] = state.models || [];

  return (
    <>
      <PageHead
        title="Image templates"
        desc="A reference picture plus a standing style instruction, rendered by an image model on crazyrouter. Callers name one on POST /v1/images/generations; that route needs an API key, because unlike SD-Turbo it costs money per picture."
        actions={
          <Button onClick={() => { setEdit({ ...BLANK }); setPic(""); setPreview(""); }}>New template</Button>
        }
      />

      <div className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
        {list.map((t) => (
          <Card key={t.slug}>
            <CardHeader>
              <CardTitle className="font-mono">{t.slug}</CardTitle>
              <CardDescription>{t.description || t.name}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {t.reference_image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={t.reference_image}
                  alt={`${t.slug} reference`}
                  className="aspect-square w-full rounded-md border border-border object-cover"
                />
              )}
              <div className="text-meta text-muted-foreground">
                {t.model || models[0]} · {t.aspect_ratio || "—"}
                {t.sites.length > 0 && ` · ${t.sites.length} site${t.sites.length === 1 ? "" : "s"}`}
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => { setEdit(t); setPic(""); setPreview(""); }}>
                  Edit
                </Button>
                <Button variant="ghost" onClick={() => remove(t.slug)}>
                  Delete
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {list.length === 0 && (
          <p className="text-body text-muted-foreground">no templates yet</p>
        )}
      </div>

      {edit && (
        <Card>
          <CardHeader>
            <CardTitle>{edit.updated ? `Edit ${edit.slug}` : "New template"}</CardTitle>
            <CardDescription>
              The picture is fetched once and stored on the router&apos;s volume, so a template never
              depends on someone else&apos;s bucket staying up.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-slug">Slug</Label>
                <Input
                  id="tpl-slug"
                  value={edit.slug}
                  disabled={!!edit.updated}
                  onChange={(e) => setEdit({ ...edit, slug: e.target.value })}
                  placeholder="bobbo"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-name">Name</Label>
                <Input id="tpl-name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-ratio">Aspect ratio</Label>
                <Input
                  id="tpl-ratio"
                  value={edit.aspect_ratio}
                  onChange={(e) => setEdit({ ...edit, aspect_ratio: e.target.value })}
                  placeholder="1:1"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-model">Model</Label>
                <Input
                  id="tpl-model"
                  value={edit.model}
                  onChange={(e) => setEdit({ ...edit, model: e.target.value })}
                  placeholder={models[0] || "nano-banana"}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tpl-sites">Sites (comma separated)</Label>
              <Input
                id="tpl-sites"
                value={edit.sites.join(", ")}
                onChange={(e) => setEdit({ ...edit, sites: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                placeholder="bofrid.se"
              />
              <p className="text-meta text-muted-foreground">
                What <code>GET /v1/image-templates?site=…</code> answers with, so a caller never needs a
                second system to know which template dresses which site.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tpl-instr">Style instruction</Label>
              <textarea
                id="tpl-instr"
                rows={6}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-body shadow-xs outline-none focus-visible:border-ring"
                value={edit.system_instruction}
                onChange={(e) => setEdit({ ...edit, system_instruction: e.target.value })}
                placeholder="Follow the reference character and style. NO TEXT IN THE IMAGE."
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tpl-ref">Reference picture</Label>
              <Input
                id="tpl-ref"
                type="file"
                accept="image/*"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    setPic(await fileToDataUrl(f));
                  } catch (err: any) {
                    notify(err.message, true);
                  }
                }}
              />
              {(pic || edit.reference_image) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={pic || edit.reference_image || ""}
                  alt="reference"
                  className="mt-2 size-32 rounded-md border border-border object-cover"
                />
              )}
              <p className="text-meta text-muted-foreground">
                Leave empty when editing and the stored picture is kept.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={save} disabled={busy}>
                {busy ? "saving…" : "Save"}
              </Button>
              <Button variant="ghost" onClick={() => { setEdit(null); setPic(""); setPreview(""); }}>
                Cancel
              </Button>
            </div>

            {!!edit.updated && (
              <div className="space-y-1.5 border-t border-border pt-4">
                <Label htmlFor="tpl-test">Try it — this renders for real and costs a picture</Label>
                <div className="flex flex-wrap gap-2">
                  <Input
                    id="tpl-test"
                    className="min-w-60 flex-1"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="handing over the keys to a new tenant"
                  />
                  <Button variant="secondary" onClick={render} disabled={busy}>
                    {busy ? "rendering…" : "Render"}
                  </Button>
                </div>
                {preview && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="rendered preview" className="mt-2 w-full max-w-96 rounded-md border border-border" />
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
