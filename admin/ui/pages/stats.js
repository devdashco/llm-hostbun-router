import { html, useState, useEffect, useCallback, api, nfmt, usd, ago, fmtMs, fmtTime, seriesColor, Chip, ProviderPill, KindPill, KV, Card, CardHead, Chart, Tabs, PageHead, useApp } from "../core.js";

/* ───────── STATS ───────── */
const WIN_ITEMS=[['15m','Last 15 min'],['1h','Last hour'],['6h','Last 6h'],['24h','Last 24h'],['7d','Last 7d'],['30d','Last 30d'],['all','All time']];
function Stats(){
  const {go,gotoCalls} = useApp();
  const [win,setWin]=useState('24h');
  const [s,setS]=useState(null);
  const [series,setSeries]=useState(null);
  const [metric,setMetric]=useState('tok'); const [by,setBy]=useState('provider');
  const [sort,setSort]=useState({key:'tok',dir:-1});
  const [open,setOpen]=useState({});   // consumer -> jobs expanded
  const [usage,setUsage]=useState(null);   // /usage: identity rollups (kind, developer, account×kind)
  const load=useCallback(async()=>{ try{ setS(await api('stats?window='+encodeURIComponent(win))); }catch(e){} },[win]);
  useEffect(()=>{load();},[load]);
  useEffect(()=>{ (async()=>{ try{ setSeries(await api('series?window='+encodeURIComponent(win)+'&by='+by)); }catch(e){} })(); },[win,by]);
  // The identity breakdown (dev/app, per developer, account×kind) comes from /usage, whose windows
  // are a subset — map the stats window onto the nearest one.
  useEffect(()=>{ const uw={'15m':'1h','1h':'1h','6h':'24h','24h':'24h','7d':'7d','30d':'30d','all':'30d'}[win]||'24h';
    (async()=>{ try{ setUsage(await api('usage?win='+uw)); }catch(e){} })(); },[win]);
  return html`
  <${PageHead} title="Usage" desc="Where the tokens went: by provider, project, client and model."
    onRefresh=${load}
    actions=${html`<${Tabs} val=${win} onChange=${setWin} items=${WIN_ITEMS.map(([v,l])=>[v,l.replace(/^Last /,'')])}/>`}/>
  ${!s?html`<div class="mut">loading…</div>`: s.dbReady===false?html`<div class="alert bad">The call DB is unavailable, so there is nothing to summarise.</div>`: html`
  ${(()=>{ const inT=s.windowPromptTokens||0,outT=s.windowCompletionTokens||0,tot=s.windowTokens||0; const avg=s.windowCalls>0?Math.round(tot/s.windowCalls):0; const lbl=(WIN_ITEMS.find(w=>w[0]===s.window)||[])[1]||s.window;
    const cr=s.windowCacheRead||0, cw=s.windowCacheWrite||0; const hit=(cr+inT)>0?Math.round(cr/(cr+inT)*100):0;
    return html`<div class="grid">
      <${KV} n=${'Tokens ('+lbl+')'}>${tot.toLocaleString()}<//>
      <${KV} n="In → Out">${nfmt(inT)} <span class="mut">→</span> ${nfmt(outT)}<//>
      <${KV} n="Cache hit" >${(cr||cw)?html`<span style="color:var(--ok)">${hit}%</span> <small class="hint" title="prompt-cache read / write tokens">↓${nfmt(cr)} ↑${nfmt(cw)}</small>`:html`<span class="mut">—</span>`}<//>
      <${KV} n="Avg / call">${avg.toLocaleString()}<//>
      <${KV} n="Est. cost">${usd(s.windowCost)} <small class="hint">crazyrouter</small><//>
      <${KV} n="Calls">${s.windowCalls.toLocaleString()}<//>
      <${KV} n="Errors">${(s.windowErrors||0)}${s.windowJsonFails?html` <small class="hint">(${s.windowJsonFails} refusal)</small>`:''}<//>
      <${KV} n="Total ever">${s.total.toLocaleString()}<//>
    </div>`; })()}
  <${Card}>
    <${CardHead} title="History"
      actions=${html`
        <${Tabs} val=${metric} onChange=${setMetric} items=${[['tok','Tokens'],['n','Calls'],['err','Errors']]}/>
        <${Tabs} val=${by} onChange=${setBy} items=${[['provider','provider'],['consumer','consumer'],['project','job'],['model','model']]}/>`}/>
    ${series?html`<${Chart} data=${series} metric=${metric} by=${by} H=${240}/>`:html`<span class="mut">loading…</span>`}
  </${Card}>
  <${Card}>
    <${CardHead} title="Share by provider" hint="What fraction of calls, and of tokens, each provider carried."/>
    ${(()=>{ const providers=s.byProvider||[]; const totN=providers.reduce((a,r)=>a+r.n,0)||1, totT=providers.reduce((a,r)=>a+r.tok,0)||1;
      return providers.length?providers.map((r,i)=>{ const c=seriesColor(r.provider,i),cp=r.n/totN*100,tp=r.tok/totT*100;
        return html`<div class="lblrow"><span class="nm"><span class="swatch" style="background:${c}"></span>${r.provider}</span>
          <span class="bar"><i style="width:${cp.toFixed(1)}%;background:${c}"></i></span>
          <span class="vv">${r.n} calls (${cp.toFixed(0)}%) · ${nfmt(r.tok)} tok (${tp.toFixed(0)}%)</span></div>`;
      }):html`<span class="mut">No traffic in this window.</span>`; })()}
  </${Card}>
  <${Card}>
    <${CardHead} title="By consumer" hint=${html`Jobs (<code>consumer:job</code>) roll up into their consumer — click ▸ to split them out. Click a row to see its calls. <code>(none)</code> means the caller sent no project.`}/>
    <div class="tablewrap">${ProjectTable({s,sort,setSort,gotoCalls,open,setOpen})}</div>
  </${Card}>
  <${Card}>
    <${CardHead} title="By client" hint=${html`Who is calling, by user-agent. <b>Thinkers</b> are calls that spent reasoning effort or extended thinking. Claude Code appears as <code>claude-cli/…</code>. Click a row to filter the call log.`}/>
    <div class="tablewrap"><table>
      <tr><th>client · user-agent</th><th>calls</th><th>tokens</th><th>thinkers</th><th>IPs</th><th>providers</th><th>last</th></tr>
      ${(s.byClient||[]).map(r=>html`<tr class="click" onClick=${()=>gotoCalls({q:r.ua})}>
        <td class="mono" style="font-size:12px">${r.ua}</td>
        <td class="mono">${r.n}</td><td class="mono">${(r.tok||0).toLocaleString()}</td>
        <td class="mono" style=${r.thinkers>0?'color:var(--warn);font-weight:600':'color:var(--fg-mut)'}>${r.thinkers||0}</td>
        <td class="mono">${r.ips}</td><td class="mut" style="font-size:11.5px">${String(r.providers||'').split(',').join(' ')}</td>
        <td class="mono mut" style="font-size:11px">${ago(r.last)}</td>
      </tr>`)}
    </table></div>
  </${Card}>
  <${Card}>
    <${CardHead} title="By model" hint="Estimated cost is crazyrouter only; claudecode is flat-rate."/>
    <div class="tablewrap"><table>
      <tr><th>requested model</th><th>provider</th><th>calls</th><th>tokens</th><th>in → out</th><th title="prompt-cache read tokens (hit rate)">cache↓</th><th>est $</th><th>avg</th></tr>
      ${(s.byModel||[]).map(r=>{ const hit=(r.cr+r.ptok)>0?Math.round(r.cr/(r.cr+r.ptok)*100):0;
        return html`<tr><td class="mono" style="font-size:12px">${r.req_model||'-'}</td><td><${ProviderPill} provider=${r.provider}/></td><td class="mono">${r.n}</td><td class="mono">${(r.tok||0).toLocaleString()}</td><td class="mono mut" style="font-size:12px">${nfmt(r.ptok)} → ${nfmt(r.ctok)}</td><td class="mono" style="font-size:12px">${r.cr>0?html`<span style="color:var(--ok)">${nfmt(r.cr)}</span> <span class="mut">${hit}%</span>`:html`<span class="mut">—</span>`}</td><td class="mono">${usd(r.usd)}</td><td class="mono">${fmtMs(r.avg_ms)}</td></tr>`;})}
    </table></div>
  </${Card}>
  ${/* Identity breakdowns (from /usage): who — by kind, by person, and whether an app is eating a
       subscription. The old "By provider" table here duplicated the share-bars above; gone. */''}
  <${Card}>
    <${CardHead} title="By kind" hint=${html`<b>dev</b> = people's machines · <b>app</b> = deployed code · <b>unregistered</b> = seen in the log, not in the registry. Registration lives on the <a href="/identity" onClick=${e=>{e.preventDefault();go('identity','consumers');}}>Consumers</a> tab.`}/>
    ${usage&&usage.dbReady!==false?html`<div class="grid">
      ${['dev','app','unregistered'].map(k=>{ const r=(usage.byKind||[]).find(x=>x.key===k)||{calls:0,tokens:0};
        return html`<div class="kv"><div class="n"><${KindPill} kind=${k}/></div>
          <div class="v">${nfmt(r.tokens)}<span class="mut" style="font-size:12px;font-weight:400"> tok</span></div>
          <div class="mut mono" style="font-size:11.5px;margin-top:2px">${nfmt(r.calls)} calls</div></div>`;
      })}
    </div>`:html`<span class="mut">loading…</span>`}
  </${Card}>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px">
    <${Card}><${CardHead} title="By developer" hint="Every machine a person owns, summed."/>
      <div class="tablewrap"><table><tr><th>owner</th><th>calls</th><th>tokens</th><th>err</th></tr>
        ${((usage&&usage.byOwner)||[]).length?usage.byOwner.map(o=>html`<tr key=${o.key}>
          <td class="mono"><b>${o.key}</b></td><td class="mono">${nfmt(o.calls)}</td>
          <td class="mono">${nfmt(o.tokens)}</td><td class="mono ${o.errors?'down':'mut'}">${o.errors}</td></tr>`)
          :html`<tr><td colspan="4" class="hint">No dev traffic, or no dev consumer has an owner yet.</td></tr>`}
      </table></div></${Card}>
    <${Card}><${CardHead} title="By account × kind" hint="Is an app starving your Claude Code?"/>
      <div class="tablewrap"><table><tr><th>account</th><th>kind</th><th>calls</th><th>tokens</th></tr>
        ${((usage&&usage.byAccountKind)||[]).length?usage.byAccountKind.map(r=>html`<tr key=${r.account+r.kind}>
          <td class="mono"><b>${r.account}</b></td><td><${KindPill} kind=${r.kind}/></td>
          <td class="mono">${nfmt(r.calls)}</td><td class="mono">${nfmt(r.tokens)}</td></tr>`)
          :html`<tr><td colspan="4" class="hint">No attributed claudecode traffic in this window.</td></tr>`}
      </table></div></${Card}>
  </div>
  `}`;
}
/* The identity convention is a path, `<consumer>[:<job>]`, and this table follows it: jobs fold
   into their consumer (the thing that is pinned, keyed and billed), with a caret to split them out.
   Without the fold one busy consumer reads as four unrelated rows — the exact misread that hid
   promopilot's 30k calls behind a 4-call row before jobs were parsed at all. */
function foldConsumers(rows){
  const map=new Map();
  for(const r of rows){
    const p=r.project||'(none)'; const i=p.indexOf(':');
    const consumer=i<0?p:p.slice(0,i);
    let g=map.get(consumer);
    if(!g){ g={project:consumer,n:0,tok:0,ptok:0,ctok:0,cr:0,cw:0,usd:0,errors:0,last:0,msSum:0,prov:new Set(),jobs:[],self:null}; map.set(consumer,g); }
    g.n+=r.n||0; g.tok+=r.tok||0; g.ptok+=r.ptok||0; g.ctok+=r.ctok||0; g.cr+=r.cr||0; g.cw+=r.cw||0;
    g.usd+=r.usd||0; g.errors+=r.errors||0; g.last=Math.max(g.last,r.last||0); g.msSum+=(r.avg_ms||0)*(r.n||0);
    String(r.providers||'').split(',').filter(Boolean).forEach(x=>g.prov.add(x));
    if(i<0) g.self=r; else g.jobs.push(r);
  }
  return [...map.values()].map(g=>({...g, avg_ms:g.n?g.msSum/g.n:null, providers:[...g.prov].join(','),
    // a usage limit is configured per path; the consumer row wears its own (base-path) limit only
    limit:g.self&&g.self.limit, limitPct:g.self&&g.self.limitPct,
    jobs:g.jobs.sort((a,b)=>(b.tok||0)-(a.tok||0))}));
}
function LimitBadge({r}){
  if(!(r.limit&&r.limitPct!=null)) return '';
  const sp=r.limit.slowPct||95; const col=r.limitPct>=100?'var(--danger)':r.limitPct>=sp?'var(--warn)':'var(--ok)';
  const cap=r.limit.tokens>0?nfmt(r.limit.tokens)+' tok':r.limit.calls>0?r.limit.calls+' calls':'';
  return html` <${Chip} title=${r.limitPct+'% of '+cap+'/'+r.limit.window+' · at 100%: '+r.limit.hard} style=${`color:${col};border-color:${col}`}>${r.limitPct}% ${r.limit.hard}<//>`;
}
function ProjectTable({s,sort,setSort,gotoCalls,open,setOpen}){
  const rows=foldConsumers(s.byProject||[]); const maxT=Math.max(1,...rows.map(r=>r.tok||0));
  const k=sort.key,d=sort.dir;
  rows.sort((a,b)=>{ let x,y;
    if(k==='project'){return d*String(a.project||'').localeCompare(String(b.project||''));}
    if(k==='io'){x=a.ptok||0;y=b.ptok||0;} else if(k==='errors'){x=a.n?a.errors/a.n:0;y=b.n?b.errors/b.n:0;} else {x=a[k]||0;y=b[k]||0;}
    return d*((x>y?1:x<y?-1:0));
  });
  const cols=[['project','consumer'],['n','calls'],['tok','tokens'],['io','in → out'],['cr','cache↓'],['usd','est $'],['avg_ms','avg'],['errors','err%'],[null,'providers'],['last','last seen'],[null,'share']];
  const onSort=key=>{ if(!key)return; setSort(sort.key===key?{key,dir:-sort.dir}:{key,dir:(key==='project'?1:-1)}); };
  const cells=(r,share)=>{ const errPct=r.n>0?(r.errors/r.n*100):0;
    return html`
      <td class="mono">${r.n}</td><td class="mono">${(r.tok||0).toLocaleString()}</td>
      <td class="mono mut" style="font-size:12px">${nfmt(r.ptok)} → ${nfmt(r.ctok)}</td>
      <td class="mono" style="font-size:12px">${r.cr>0?html`<span style="color:var(--ok)" title=${'cache read '+(r.cr||0).toLocaleString()+' · write '+(r.cw||0).toLocaleString()+' tokens'}>${nfmt(r.cr)}</span>`:html`<span class="mut">—</span>`}</td>
      <td class="mono">${usd(r.usd)}</td><td class="mono">${fmtMs(r.avg_ms)}</td>
      <td class="mono" style=${r.errors>0?'color:var(--red);font-weight:700':'color:var(--mut)'}>${errPct.toFixed(errPct&&errPct<10?1:0)}%</td>
      <td style="font-size:11px">${String(r.providers||'').split(',').join(' ')}</td>
      <td class="mono mut" style="font-size:11px">${ago(r.last)}</td>
      <td>${share==null?'':html`<span class="bar"><i style="width:${share.toFixed(1)}%;background:var(--acc)"></i></span>`}</td>`;
  };
  return html`<table>
    <tr>${cols.map(([key,lbl])=>html`<th class=${key?'sortable '+(key===k?'on':''):''} onClick=${()=>onSort(key)}>${lbl}${key===k?(d<0?' ▾':' ▴'):''}</th>`)}</tr>
    ${rows.map(r=>{ const share=r.tok/maxT*100; const isOpen=!!open[r.project];
      const expandable=r.jobs.length>0;
      const toggle=e=>{ e.stopPropagation(); setOpen(o=>({...o,[r.project]:!o[r.project]})); };
      return html`
      <tr class="click" onClick=${()=>gotoCalls({project:(r.project&&r.project!=='(none)')?r.project:''})}>
        <td class="mono" style="font-size:12px;white-space:nowrap">
          ${expandable?html`<span onClick=${toggle} title=${(isOpen?'hide':'show')+' '+r.jobs.length+' job'+(r.jobs.length>1?'s':'')} style="cursor:pointer;display:inline-block;width:16px;color:var(--fg-sub)">${isOpen?'▾':'▸'}</span>`:html`<span style="display:inline-block;width:16px"></span>`}
          <b>${r.project||'(none)'}</b>${expandable?html` <span class="mut" style="font-size:10.5px">${r.jobs.length} job${r.jobs.length>1?'s':''}</span>`:''}<${LimitBadge} r=${r}/>
        </td>
        ${cells(r,share)}
      </tr>
      ${isOpen?r.jobs.map(j=>html`
        <tr class="click" style="background:oklch(0.5 0.01 285 / .06)" onClick=${()=>gotoCalls({project:j.project})}>
          <td class="mono mut" style="font-size:11.5px;padding-left:34px;white-space:nowrap">└ ${String(j.project).slice(r.project.length+1)}<${LimitBadge} r=${j}/></td>
          ${cells(j,null)}
        </tr>`):''}
      ${isOpen&&r.self&&r.jobs.length?html`
        <tr class="click" style="background:oklch(0.5 0.01 285 / .06)" onClick=${()=>gotoCalls({project:r.self.project+':'})}>
          <td class="mono mut" style="font-size:11.5px;padding-left:34px">└ (no job)</td>
          ${cells({...r.self,cr:r.self.cr||0,cw:r.self.cw||0},null)}
        </tr>`:''}
    `; })}
  </table>`;
}


export { WIN_ITEMS, Stats, ProjectTable };
