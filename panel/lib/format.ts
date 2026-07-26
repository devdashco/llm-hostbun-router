// Formatting + colour helpers — ported verbatim from admin/ui/core.js so numbers, times, and series
// colours render identically to the old panel.

export const SLOW_MS = 30000;

export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o == null ? {} : o));

export const nfmt = (n: number | string): string => {
  const v = +n || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return "" + Math.round(v);
};

// null/undefined is UNKNOWN, and renders as "—" like fmtMs below. `+n || 0` turned it into 0, and
// 0 here reads as "this cost nothing" — the same coercion that had the premium-burn banner
// announcing "~$0.00 list" for the one model we could not price (6132786 fixed that at the source,
// in listCostUsd). No caller passes null today: usd() is only fed `usd`/`windowCost`, which come
// from costUsd() and are a real 0 for the flat-rate providers. This is here so the next person who
// renders the NULLABLE `list_usd` through it gets "—" instead of a silent $0.
export const usd = (n: number | string | null | undefined): string => {
  if (n == null) return "—";
  const v = +n || 0;
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  return "$" + v.toFixed(v < 10 ? 2 : 0);
};

// `now` is a parameter because Accounts clocks relative to the server, not the browser.
export const ago = (ts: number, now?: number): string => {
  if (!ts) return "—";
  const s = ((now || Date.now()) - ts) / 1000;
  if (s < 60) return Math.max(0, Math.round(s)) + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
};

export const fmtMs = (ms: number | null | undefined): string => {
  if (ms == null) return "—";
  return ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + "s" : Math.round(ms) + "ms";
};

export const fmtTime = (ts: number): string =>
  new Date(ts).toISOString().replace("T", " ").slice(5, 19);

// Legacy provider names in old call-log rows map onto the canonical identity.
export const providerCls: Record<string, string> = {
  local: "local",
  crazyrouter: "crazyrouter",
  claudecode: "claudecode",
  cloud: "crazyrouter",
  claude: "claudecode",
  anthropic: "claudecode",
  wrappy: "claudecode",
  blocked: "down",
  images: "images",
};

// Chart colours — the same OKLCH tokens globals.css declares; SVG fill takes oklch() directly.
export const OK = "oklch(0.740 0.160 152)";
export const WARN = "oklch(0.800 0.140 78)";
export const DANGER = "oklch(0.645 0.205 25)";
export const ACCENT = "oklch(0.660 0.135 252)";
export const ORANGE = "oklch(0.730 0.160 52)";
export const VIOLET = "oklch(0.680 0.180 300)";
export const GRID = "oklch(0.278 0.006 285)";
export const AXIS = "oklch(0.560 0.010 285)";

export const PALETTE = [
  ACCENT, OK, ORANGE, WARN, VIOLET, DANGER,
  "oklch(0.72 0.12 210)", "oklch(0.80 0.15 100)", "oklch(0.78 0.16 130)", "oklch(0.68 0.19 350)",
];

export const PROVIDER_COLOR: Record<string, string> = {
  local: OK, crazyrouter: ACCENT, claudecode: ORANGE, anthropic: ORANGE, blocked: DANGER, images: VIOLET,
};

export const seriesColor = (name: string, i: number): string =>
  PROVIDER_COLOR[name] || PALETTE[i % PALETTE.length];
