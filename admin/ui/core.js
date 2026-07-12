// Everything a page needs, nothing a page owns: the preact/htm binding, the API client, formatting
// helpers, the shared atoms, the chart, and the app context.
const { h, render, createContext } = preact;
const { useState, useEffect, useContext, useRef, useMemo, useCallback } = preactHooks;
const html = htm.bind(h);

/* ───────── helpers ───────── */
// api() calls this on any 401 so the shell can drop back to <Login/>. Set once, by app.js.
let onUnauth = () => {};
const setOnUnauth = (fn) => { onUnauth = fn; };
async function api(path, opts){
  // /api/* is the panel's own prefix. /admin/api/* still resolves to the same handler server-side,
  // because claudectl hardcodes it — but nothing in this UI should mention /admin any more.
  const r = await fetch('/api/'+path, Object.assign({credentials:'same-origin',headers:{'content-type':'application/json'}}, opts||{}));
  if(r.status===401){ onUnauth(); const e=new Error('unauthorized'); e.status=401; throw e; }
  const t = await r.text(); let j=null; try{j=JSON.parse(t);}catch{}
  if(!r.ok) throw new Error((j&&j.error)||('HTTP '+r.status));
  return j;
}
function toast(msg,bad){ const t=document.getElementById('toast'); t.textContent=msg; t.style.borderColor=bad?'var(--red)':'var(--grn)'; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2600); }
const clone = o => JSON.parse(JSON.stringify(o==null?{}:o));
const nfmt = n => { n=+n||0; if(n>=1e9)return (n/1e9).toFixed(2)+'B'; if(n>=1e6)return (n/1e6).toFixed(2)+'M'; if(n>=1e3)return (n/1e3).toFixed(1)+'k'; return ''+Math.round(n); };
const usd = n => { n=+n||0; if(n===0)return '$0'; if(n<0.01)return '<$0.01'; return '$'+n.toFixed(n<10?2:0); };
// One `ago`. Four pages used to carry their own, each with a different idea of what "never" looks
// like. `now` is a parameter because /accounts clocks relative to the server, not the browser.
const ago = (ts,now) => { if(!ts)return '—'; const s=((now||Date.now())-ts)/1000;
  if(s<60)return Math.max(0,Math.round(s))+'s'; if(s<3600)return Math.round(s/60)+'m';
  if(s<86400)return Math.round(s/3600)+'h'; return Math.round(s/86400)+'d'; };
const fmtMs = ms => { if(ms==null)return '—'; return ms>=1000?(ms/1000).toFixed(ms>=10000?0:1)+'s':Math.round(ms)+'ms'; };
const fmtTime = ts => new Date(ts).toISOString().replace('T',' ').slice(5,19);
const SLOW_MS = 30000;
// Legacy provider names still present in old call-log rows (wrappy/claude/anthropic → claudecode,
// cloud → crazyrouter) map onto the canonical pill so history renders the same as new traffic.
const providerCls = {local:'local',crazyrouter:'crazyrouter',claudecode:'claudecode',cloud:'crazyrouter',claude:'claudecode',anthropic:'claudecode',wrappy:'claudecode',blocked:'down',images:'images'};
// Chart colours are the same OKLCH tokens app.css declares; SVG fill takes oklch() directly. A
// series painted from a different palette than its pill is a series the eye cannot follow.
const OK = 'oklch(0.740 0.160 152)', WARN = 'oklch(0.800 0.140 78)', DANGER = 'oklch(0.645 0.205 25)';
const ACCENT = 'oklch(0.660 0.135 252)', ORANGE = 'oklch(0.730 0.160 52)', VIOLET = 'oklch(0.680 0.180 300)';
const GRID = 'oklch(0.278 0.006 285)', AXIS = 'oklch(0.560 0.010 285)';
const PALETTE = [ACCENT,OK,ORANGE,WARN,VIOLET,DANGER,'oklch(0.72 0.12 210)','oklch(0.80 0.15 100)','oklch(0.78 0.16 130)','oklch(0.68 0.19 350)'];
const PROVIDER_COLOR = {local:OK,crazyrouter:ACCENT,claudecode:ORANGE,anthropic:ORANGE,blocked:DANGER,images:VIOLET};
const seriesColor = (name,i) => PROVIDER_COLOR[name]||PALETTE[i%PALETTE.length];

/* ───────── icons ───────── */
const ICON = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  list:'<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  chart:'<path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="8" rx="1"/><rect x="12" y="6" width="3" height="12" rx="1"/><rect x="17" y="13" width="3" height="5" rx="1"/>',
  route:'<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8 19h6.5a3.5 3.5 0 0 0 0-7h-4a3.5 3.5 0 0 1 0-7H16"/>',
  box:'<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5"/><path d="M12 12v10"/>',
  cloud:'<path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.6A3.5 3.5 0 0 0 6.5 19z"/>',
  key:'<circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4M18 5l2 2M15 6l2 2"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  lock:'<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
};
const Svg = ({n}) => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" dangerouslySetInnerHTML=${{__html:ICON[n]||''}}></svg>`;

const NAV = [
  {name:'Overview',slug:'overview',icon:'grid'},
  {name:'Calls',slug:'calls',icon:'list'},
  {name:'Routing',slug:'routing',icon:'route'},
  {name:'Identity',slug:'identity',icon:'users'},
  {name:'Settings',slug:'settings',icon:'lock'},
];
// Old page slugs live on as redirects: bookmarks and muscle memory predate the consolidation.
// Each maps to [new slug, tab within it].
const SLUG_ALIAS = {
  stats:['overview','usage'],
  consumers:['identity','consumers'], accounts:['identity','accounts'],
  models:['routing','models'],
  crazyrouter:['settings','crazyrouter'], secrets:['settings','secrets'],
};
const BASE='';   // the panel lives at the site root; there is no /admin path any more
const slugFor = n => (NAV.find(x=>x.name===n)||{}).slug||'overview';
const nameFor = s => (NAV.find(x=>x.slug===s)||{}).name||'Overview';

/* ───────── shared UI atoms ─────────
   Everything on this surface is one of five things: a badge, a stat, a section, a tab strip, or a
   table. A page that needs a sixth adds it here, so the vocabulary stays the same screen to screen. */
const Pill = ({cls,title,style,children}) => html`<span class="pill ${cls||''}" title=${title} style=${style}>${children}</span>`;
const Chip = ({cls,title,style,children}) => html`<span class="chip ${cls||''}" title=${title} style=${style}>${children}</span>`;
const Dot = ({color}) => html`<span class="dot" style=${`background:${color}`}></span>`;
const ProviderPill = ({provider}) => html`<${Pill} cls=${providerCls[provider]||''}>${provider||'?'}<//>`;
/* A JSON-enforcement refusal is a 4xx the caller provoked, not an outage. It reads amber, and the
   distinction is carried by colour + tooltip rather than an emoji the eye has to decode. */
const StatusPill = ({status,error}) => {
  const refusal = status>=400 && /^json_validation_failed/.test(error||'');
  if(refusal) return html`<${Pill} cls="warnp" title="JSON enforcement refusal — usually a prose answer, not a proxy fault">${status}<//>`;
  if(status>=400) return html`<${Pill} cls="down">${status}<//>`;
  return html`<${Pill} cls="up">${status||'—'}<//>`;
};
/* Identity is a path, `<consumer>[:<job>]`. One chip renders it everywhere: consumer carries the
   weight, the job rides muted after it — so `promopilot:generatetext` reads as promopilot's job,
   not as a different caller. Split on the FIRST colon only, same as the router. */
const ProjectChip = ({p}) => {
  if(!p) return html`<span class="mut" style="font-size:11px">(none)</span>`;
  const i=String(p).indexOf(':');
  if(i<0) return html`<${Chip} cls="tag">${p}<//>`;
  return html`<${Chip} cls="tag">${p.slice(0,i)}<span style="opacity:.55;font-weight:400">:${p.slice(i+1)}</span><//>`;
};
/* Consumer kind badge: dev (a person's machine) / app (deployed code) / unregistered (in the log,
   not in the registry). Shared because both the Consumers registry and the Usage breakdowns show it. */
const KindPill = ({kind}) => {
  const cls={dev:'tag info',app:'tag ok',unregistered:'tag bad'}[kind]||'tag';
  return html`<span class=${'pill '+cls}>${kind}</span>`;
};
const KV = ({n,children}) => html`<div class="kv"><div class="n">${n}</div><div class="v">${children}</div></div>`;
const Card = ({cls,children}) => html`<div class="card ${cls||''}">${children}</div>`;
/* Section header: title, one line of why-it-matters, and the actions that belong to it. */
const CardHead = ({title,hint,actions}) => html`<div class="card-hd">
  <div style="min-width:0"><h3>${title}</h3>${hint&&html`<small class="hint">${hint}</small>`}</div>
  ${actions&&html`<div class="acts">${actions}</div>`}
</div>`;
/* Per-call request params. Labelled, not pictographic: `cache↓ 12k` survives a screenshot, ⚡ 12k does not. */
const ParamBadges = ({r}) => {
  const b=[];
  if(r.effort) b.push(html`<${Chip} cls="warnp" title="reasoning effort">effort ${r.effort}<//>`);
  if(r.thinking_tokens>0) b.push(html`<${Chip} cls="crazyrouter" title="extended thinking budget (tokens)">think ${nfmt(r.thinking_tokens)}<//>`);
  else if(r.thinking_tokens===0) b.push(html`<${Chip} title="thinking explicitly disabled">think off<//>`);
  if(r.tool_count>0) b.push(html`<${Chip} title=${(r.tool_servers||'')+' · '+(r.tools_kb||0)+'KB of tool schema'}>tools ${r.tool_count}${r.mcp_tools>0?` (${r.mcp_tools} mcp)`:''}<//>`);
  if(r.cache_read>0) b.push(html`<${Chip} cls="up" title="prompt-cache read (tokens) — billed at 10%">cache↓ ${nfmt(r.cache_read)}<//>`);
  if(r.cache_write>0) b.push(html`<${Chip} title="prompt-cache write (tokens) — billed at 125%">cache↑ ${nfmt(r.cache_write)}<//>`);
  if(r.max_tokens>0) b.push(html`<${Chip} title="max_tokens">≤${nfmt(r.max_tokens)}<//>`);
  if(r.temperature!=null) b.push(html`<${Chip} title="temperature">t=${r.temperature}<//>`);
  if(r.stop_reason&&r.stop_reason!=='end_turn'&&r.stop_reason!=='stop') b.push(html`<${Chip} cls="warnp" title="stop reason">${r.stop_reason}<//>`);
  if(!b.length) return '';
  return html`<span class="flex" style="gap:4px;display:inline-flex;margin-left:6px">${b}</span>`;
};

/* Tri-state facet select: '' = any, '1' = yes, '0' = no. */
const TriSel = ({label,value,onChange,title}) => html`
  <select title=${title||label} value=${value} onChange=${e=>onChange(e.target.value)} style="flex:0 0 auto;width:auto">
    <option value="">${label}: any</option><option value="1">${label}: yes</option><option value="0">${label}: no</option>
  </select>`;

/* Dropdown seeded from /calls/facets — each option carries its row count. */
const FacetSel = ({label,items,value,onChange,extra}) => html`
  <select title=${label} value=${value} onChange=${e=>onChange(e.target.value)} style="flex:0 0 auto;width:auto;max-width:190px">
    <option value="">${label}: any</option>
    ${(extra||[]).map(([v,l])=>html`<option value=${v}>${l}</option>`)}
    ${(items||[]).map(f=>html`<option value=${f.v}>${f.v} (${nfmt(f.n)})</option>`)}
  </select>`;

/* ───────── stacked-bar time chart ───────── */
const METRIC_LABEL = {tok:'tokens',n:'calls',err:'errors'};
function buildChart(d, metric, opts){
  const pts=d.points||[], series=d.series||[]; const H=opts.H||240;
  const bm=d.bucketMs, bl=bm>=86400000?(bm/86400000+'d'):bm>=3600000?(bm/3600000+'h'):(bm/60000+'min');
  const hint=`— ${METRIC_LABEL[metric]} per ${bl} bucket${opts.by?', '+opts.by:''}`;
  if(!pts.length) return {svg:'<span class="mut">no data in window</span>',hint,legend:[]};
  const W=Math.max(560,pts.length*16+60), padL=52, padB=22, padT=10, plotH=H-padB-padT, plotW=W-padL-10;
  const field=metric==='tok'?'tok':'n';
  const stackVal=(p,name)=>metric==='err'?(name==='__err'?p.totalErr:0):(p[field][name]||0);
  const useSeries=metric==='err'?['__err']:series;
  const totals=pts.map(p=>useSeries.reduce((a,nm)=>a+stackVal(p,nm),0));
  const maxV=Math.max(1,...totals);
  const bw=Math.max(4,Math.min(26,(plotW/pts.length)-3));
  const x=i=>padL+i*(plotW/pts.length)+(plotW/pts.length-bw)/2;
  let g=''; for(let i=0;i<=4;i++){const yy=padT+plotH-(i/4*plotH);const vv=maxV*i/4;g+=`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W-10}" y2="${yy.toFixed(1)}" stroke="${GRID}"/><text x="${padL-6}" y="${(yy+3).toFixed(1)}" fill="${AXIS}" font-size="10" text-anchor="end">${nfmt(vv)}</text>`;}
  let bars='';
  pts.forEach((p,i)=>{ let yacc=padT+plotH;
    useSeries.forEach((nm)=>{ const v=stackVal(p,nm); if(v<=0)return; const hh=v/maxV*plotH; yacc-=hh;
      const c=metric==='err'?DANGER:seriesColor(nm,series.indexOf(nm));
      bars+=`<rect x="${x(i).toFixed(1)}" y="${yacc.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${c}" rx="2"><title>${fmtTime(p.t)}\n${nm==='__err'?'errors':nm}: ${v.toLocaleString()}</title></rect>`;
    });
  });
  let xl=''; const step=Math.max(1,Math.ceil(pts.length/6));
  pts.forEach((p,i)=>{ if(i%step)return; const t=new Date(p.t); const lab=bm<3600000?t.toISOString().slice(11,16):t.toISOString().slice(5,16).replace('T',' '); xl+=`<text x="${(x(i)+bw/2).toFixed(1)}" y="${H-6}" fill="${AXIS}" font-size="10" text-anchor="middle">${lab}</text>`; });
  const svg=`<svg width="${W}" height="${H}" style="max-width:none">${g}${bars}${xl}</svg>`;
  const legend=metric==='err'?[{name:'errors',color:DANGER}]:series.map((nm,i)=>({name:nm,color:seriesColor(nm,i)}));
  return {svg,hint,legend};
}
const Chart = ({data,metric,by,H}) => {
  const {svg,hint,legend}=useMemo(()=>buildChart(data,metric,{by,H}),[data,metric,by,H]);
  return html`<div>
    <div style="overflow-x:auto" dangerouslySetInnerHTML=${{__html:svg}}></div>
    <div class="flex" style="gap:12px;flex-wrap:wrap;margin-top:8px;font-size:12px">
      ${legend.map(l=>html`<span><span class="swatch" style="background:${l.color}"></span>${l.name}</span>`)}
    </div>
    <div class="mut" style="font-size:12px;margin-top:2px">${hint}</div>
  </div>`;
};
/* One tab strip. It replaced `.seg`, `.wintabs`, and three hand-rolled button rows that each
   spelled "selected" differently — one of them by turning the active tab into a primary button. */
const Tabs = ({items,val,onChange,disabled}) => html`<div class="tabs">
  ${items.map(([v,l])=>html`<button class=${v===val?'on':''} disabled=${disabled} onClick=${()=>onChange(v)}>${l}</button>`)}
</div>`;
const Seg = Tabs;   // legacy name

/* Tab-within-a-page state, mirrored to ?t= so a tab survives reload and can be linked to. Only ever
   read on mount: the app shell keys each page by slug+tab, so any navigation that changes ?t=
   (including a legacy-slug redirect between two tabs of the SAME page) remounts and re-reads. */
const useTab = (def) => {
  const [tab,setTabState]=useState(()=>{ try{ return new URL(location.href).searchParams.get('t')||def; }catch{ return def; } });
  const setTab=v=>{ try{ const u=new URL(location.href); u.searchParams.set('t',v); history.replaceState({},'',u); }catch{} setTabState(v); };
  return [tab,setTab];
};

/* ───────── app context ───────── */
const Ctx = createContext(null);
const useApp = () => useContext(Ctx);


/* ───────── shared page header ─────────
   The one place a page names itself. The old sticky topbar printed the same title a second time. */
const PageHead = ({title,desc,onRefresh,actions}) => html`<div class="pagehead">
  <div style="min-width:0"><h2>${title}</h2>${desc&&html`<p class="desc">${desc}</p>`}</div>
  ${(actions||onRefresh)&&html`<div class="acts">
    ${actions}
    ${onRefresh&&html`<button class="ghost sm" onClick=${onRefresh}>Refresh</button>`}
  </div>`}
</div>`;

export {
  h, render, createContext, html,
  useState, useEffect, useContext, useRef, useMemo, useCallback,
  api, toast, setOnUnauth,
  clone, nfmt, usd, ago, fmtMs, fmtTime, SLOW_MS,
  providerCls, PALETTE, PROVIDER_COLOR, seriesColor, OK, WARN, DANGER, ACCENT, ORANGE, VIOLET,
  ICON, Svg, NAV, SLUG_ALIAS, BASE, slugFor, nameFor,
  Pill, Chip, Dot, ProviderPill, StatusPill, ProjectChip, KindPill, KV, Card, CardHead, ParamBadges, TriSel, FacetSel,
  METRIC_LABEL, buildChart, Chart, Tabs, Seg, useTab, PageHead,
  Ctx, useApp,
};
