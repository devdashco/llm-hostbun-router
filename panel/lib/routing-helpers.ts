// Routing rule encoding, ported from admin/ui/pages/routing.js. A rule is {provider,model} (a pin),
// {block:true} (reject), or null (auto). The <Select> encodes it as `provider|model`, '' = auto,
// '__block__' = block.
export const BLOCK_VAL = "__block__";

export interface Rule {
  provider?: string;
  model?: string;
  block?: boolean;
  allowProviders?: string[];
  allowModels?: string[];
}

// The OFFLINE FALLBACK only. The Rules page now unions /api/models over this (live claudecode +
// crazyrouter catalogs), so a frontier id Anthropic or crazyrouter shipped this morning is already
// pickable without editing this file — which is the whole reason the list below kept going stale.
// Keep it short and current anyway: it is what the picker shows when the catalog fetch fails.
export const PROJ_MODELS: { provider: string; model: string }[] = [
  { provider: "claudecode", model: "claude-opus-5" },
  { provider: "claudecode", model: "claude-sonnet-5" },
  { provider: "claudecode", model: "claude-fable-5" },
  { provider: "claudecode", model: "claude-sonnet-4-6" },
  { provider: "claudecode", model: "claude-haiku-4-5" },
  { provider: "crazyrouter", model: "gemini-2.5-flash-lite" },
  { provider: "crazyrouter", model: "gemini-3.1-flash-lite" },
  { provider: "crazyrouter", model: "glm-5.2" },
  // The local presets are what llama.cpp on pbox actually answers to. They were
  // `gemma-4-e4b-it-obliterated` and `google/gemma-4-26b-a4b` until 2026-08-02 — two ids with no
  // backend, offered in a dropdown. A pin's `model` is a LITERAL string sent upstream and the
  // server does not validate it against any catalog, so picking one wrote a dead id straight into
  // that project's rule. Update these the same day the checkpoint changes.
  { provider: "local", model: "qwen3.5-9b" },
  { provider: "local", model: "qwen3.5-2b" },   // ww's 3070, not pbox's 4090 — see CFG.localBases
];

export const valToRule = (v: string): Rule | null => {
  if (!v) return null;
  if (v === BLOCK_VAL) return { block: true };
  const [provider, ...rest] = v.split("|");
  return { provider, model: rest.join("|") };
};

export const ruleToVal = (cur: Rule | null): string =>
  cur && !cur.block ? `${cur.provider}|${cur.model}` : cur && cur.block ? BLOCK_VAL : "";

export const LIM_WINDOWS = ["1h", "6h", "24h", "7d", "30d"];
export const LIM_HARD: [string, string][] = [
  ["block", "block (429)"],
  ["slow", "slow only"],
  ["warn", "warn only"],
];
