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
const ago = ts => { if(!ts)return '—'; const s=(Date.now()-ts)/1000; if(s<60)return Math.round(s)+'s'; if(s<3600)return Math.round(s/60)+'m'; if(s<86400)return Math.round(s/3600)+'h'; return Math.round(s/86400)+'d'; };
const fmtMs = ms => { if(ms==null)return '—'; return ms>=1000?(ms/1000).toFixed(ms>=10000?0:1)+'s':Math.round(ms)+'ms'; };
const fmtTime = ts => new Date(ts).toISOString().replace('T',' ').slice(5,19);
const SLOW_MS = 30000;
// Legacy provider names still present in old call-log rows (wrappy/claude/anthropic → claudecode,
// cloud → crazyrouter) map onto the canonical pill so history renders the same as new traffic.
const providerCls = {local:'local',crazyrouter:'crazyrouter',claudecode:'claudecode',cloud:'crazyrouter',claude:'claudecode',anthropic:'claudecode',wrappy:'claudecode',blocked:'down',images:'images'};
const PALETTE = ['#3b82f6','#22c55e','#f97316','#f59e0b','#a855f7','#ef4444','#06b6d4','#eab308','#84cc16','#ec4899'];
const PROVIDER_COLOR = {local:'#22c55e',crazyrouter:'#3b82f6',claudecode:'#f97316',anthropic:'#f97316',blocked:'#ef4444',images:'#a855f7'};
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
};
const Svg = ({n}) => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" dangerouslySetInnerHTML=${{__html:ICON[n]||''}}></svg>`;

const NAV = [
  {sec:'Monitor'},
  {name:'Overview',slug:'overview',icon:'grid'},
  {name:'Calls',slug:'calls',icon:'list'},
  {name:'Consumers',slug:'consumers',icon:'chart'},
  {name:'Stats',slug:'stats',icon:'chart'},
  {name:'Accounts',slug:'accounts',icon:'key'},
  {sec:'Control'},
  {name:'Routing',slug:'routing',icon:'route'},
  {name:'Models & test',slug:'models',icon:'box'},
  {sec:'Cloud & keys'},
  {name:'Crazyrouter',slug:'crazyrouter',icon:'cloud'},
  {name:'Secrets',slug:'secrets',icon:'key'},
];
const BASE='';   // the panel lives at the site root; there is no /admin path any more
const slugFor = n => (NAV.find(x=>x.name===n)||{}).slug||'overview';
const nameFor = s => (NAV.find(x=>x.slug===s)||{}).name||'Overview';

/* ───────── shared UI atoms ───────── */
const Pill = ({cls,children}) => html`<span class="pill ${cls||''}">${children}</span>`;
const ProviderPill = ({provider}) => html`<${Pill} cls=${providerCls[provider]||''}>${provider||'?'}<//>`;
const StatusPill = ({status,error}) => {
  const refusal = status>=400 && /^json_validation_failed/.test(error||'');
  if(refusal) return html`<${Pill} cls="warnp">🙅 ${status}<//>`;
  if(status>=400) return html`<${Pill} cls="down">${status}<//>`;
  return html`<${Pill} cls="up">${status||'—'}<//>`;
};
const KV = ({n,children}) => html`<div class="kv"><div class="n">${n}</div><div class="v">${children}</div></div>`;
const Card = ({cls,children}) => html`<div class="card ${cls||''}">${children}</div>`;
// Reasoning params surfaced per call: 🧠 effort (low/med/high), 💭 extended-thinking budget (or "off").
const ParamBadges = ({r}) => {
  const b=[];
  if(r.effort) b.push(html`<span class="chip" title="reasoning effort" style="border-color:var(--amb);color:var(--amb)">🧠 ${r.effort}</span>`);
  if(r.thinking_tokens>0) b.push(html`<span class="chip" title="extended thinking budget (tokens)" style="border-color:var(--acc);color:var(--acc)">💭 ${nfmt(r.thinking_tokens)}</span>`);
  else if(r.thinking_tokens===0) b.push(html`<span class="chip" title="thinking explicitly disabled">💭 off</span>`);
  if(r.tool_count>0) b.push(html`<span class="chip" title=${(r.tool_servers||'')+' · '+(r.tools_kb||0)+'KB of tool schema'}>🔧 ${r.tool_count}${r.mcp_tools>0?html`<span class="mut"> (${r.mcp_tools} mcp)</span>`:''}</span>`);
  if(r.cache_read>0) b.push(html`<span class="chip" title="prompt-cache read (tokens) — billed at 10%" style="border-color:var(--grn);color:var(--grn)">⚡ ${nfmt(r.cache_read)}</span>`);
  if(r.cache_write>0) b.push(html`<span class="chip" title="prompt-cache write (tokens) — billed at 125%">✎ ${nfmt(r.cache_write)}</span>`);
  if(r.max_tokens>0) b.push(html`<span class="chip mut" title="max_tokens">≤${nfmt(r.max_tokens)}</span>`);
  if(r.temperature!=null) b.push(html`<span class="chip mut" title="temperature">t=${r.temperature}</span>`);
  if(r.stop_reason&&r.stop_reason!=='end_turn'&&r.stop_reason!=='stop') b.push(html`<span class="chip" title="stop reason" style="border-color:var(--amb);color:var(--amb)">⏹ ${r.stop_reason}</span>`);
  if(!b.length) return '';
  return html`<span> ${b}</span>`;
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
  let g=''; for(let i=0;i<=4;i++){const yy=padT+plotH-(i/4*plotH);const vv=maxV*i/4;g+=`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W-10}" y2="${yy.toFixed(1)}" stroke="#26262b"/><text x="${padL-6}" y="${(yy+3).toFixed(1)}" fill="#a1a1aa" font-size="10" text-anchor="end">${nfmt(vv)}</text>`;}
  let bars='';
  pts.forEach((p,i)=>{ let yacc=padT+plotH;
    useSeries.forEach((nm)=>{ const v=stackVal(p,nm); if(v<=0)return; const hh=v/maxV*plotH; yacc-=hh;
      const c=metric==='err'?'#ef4444':seriesColor(nm,series.indexOf(nm));
      bars+=`<rect x="${x(i).toFixed(1)}" y="${yacc.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${c}" rx="1"><title>${fmtTime(p.t)}\n${nm==='__err'?'errors':nm}: ${v.toLocaleString()}</title></rect>`;
    });
  });
  let xl=''; const step=Math.max(1,Math.ceil(pts.length/6));
  pts.forEach((p,i)=>{ if(i%step)return; const t=new Date(p.t); const lab=bm<3600000?t.toISOString().slice(11,16):t.toISOString().slice(5,16).replace('T',' '); xl+=`<text x="${(x(i)+bw/2).toFixed(1)}" y="${H-6}" fill="#a1a1aa" font-size="10" text-anchor="middle">${lab}</text>`; });
  const svg=`<svg width="${W}" height="${H}" style="max-width:none">${g}${bars}${xl}</svg>`;
  const legend=metric==='err'?[{name:'errors',color:'#ef4444'}]:series.map((nm,i)=>({name:nm,color:seriesColor(nm,i)}));
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
const Seg = ({items,val,onChange}) => html`<div class="seg">
  ${items.map(([v,l])=>html`<button class=${v===val?'on':''} onClick=${()=>onChange(v)}>${l}</button>`)}
</div>`;

/* ───────── app context ───────── */
const Ctx = createContext(null);
const useApp = () => useContext(Ctx);


/* ───────── shared page header ───────── */
const PageHead = ({title,onRefresh}) => html`<div class="flex" style="justify-content:space-between;margin-bottom:6px"><h2>${title}</h2>${onRefresh&&html`<button class="ghost sm" onClick=${onRefresh}>↻ Refresh</button>`}</div>`;

export {
  h, render, createContext, html,
  useState, useEffect, useContext, useRef, useMemo, useCallback,
  api, toast, setOnUnauth,
  clone, nfmt, usd, ago, fmtMs, fmtTime, SLOW_MS,
  providerCls, PALETTE, PROVIDER_COLOR, seriesColor,
  ICON, Svg, NAV, BASE, slugFor, nameFor,
  Pill, ProviderPill, StatusPill, KV, Card, ParamBadges, TriSel, FacetSel,
  METRIC_LABEL, buildChart, Chart, Seg, PageHead,
  Ctx, useApp,
};
