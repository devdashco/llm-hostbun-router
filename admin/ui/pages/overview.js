import { html, h, useState, useEffect, useCallback, api, ago, nfmt, fmtMs, fmtTime, SLOW_MS,
         Pill, Chip, Dot, ProviderPill, StatusPill, KV, Card, CardHead, Chart, Tabs, PageHead, useApp,
         WARN, DANGER } from "../core.js";
import { Bar } from "./accounts.js";

/* ───────── OVERVIEW ───────── */
function Overview(){
  const {state,openCall} = useApp();
  const [health,setHealth]=useState(null);
  const [st1h,setSt1h]=useState(null);
  const [recent,setRecent]=useState(null);
  const [series,setSeries]=useState(null);
  const [ovWin,setOvWin]=useState('6h');
  const [ovMetric,setOvMetric]=useState('n');
  const [cfgOpen,setCfgOpen]=useState(false);
  const [pool,setPool]=useState(null);
  const load=useCallback(async()=>{
    try{ const [h,s]=await Promise.all([api('health'),api('stats?window=1h').catch(()=>null)]); setHealth(h); setSt1h(s); }catch(e){}
    try{ setRecent((await api('calls?limit=18')).rows||[]); }catch(e){}
    // The pool is the only thing on this page that can be silently, totally broken while every
    // provider probe says UP: api.anthropic.com is reachable, our subscription is just dry.
    try{ setPool(await api('accounts')); }catch(e){}
  },[]);
  useEffect(()=>{load();},[load]);
  useEffect(()=>{ (async()=>{ try{ setSeries(await api('series?window='+ovWin+'&by=provider')); }catch(e){} })(); },[ovWin]);
  const head=html`<${PageHead} title="Overview" desc="Provider health, the Claude Max pool, and the last hour of traffic." onRefresh=${load}/>`;
  if(!health) return html`${head}<div class="mut">loading…</div>`;
  const providerStat={}; ((st1h&&st1h.byProvider)||[]).forEach(r=>providerStat[r.provider]=r);
  const providers=[['local',state.bases.local,health.local],['claudecode',state.bases.claudecode,health.claudecode],['crazyrouter',state.bases.crazyrouter,health.crazyrouter]];
  const up=[health.local,health.claudecode,health.crazyrouter].filter(x=>x&&x.up).length;
  const fm=state.forceModel||{};
  return html`
  ${head}
  <${Issues} health=${health} st=${st1h} state=${state} pool=${pool}/>
  <div class="grid">
    <${KV} n="Providers up">${up<3?html`<span class="down">${up} / 3</span>`:up+' / 3'}<//>
    <${KV} n="Pool">${(()=>{
      const s=pool&&pool.summary;
      const n=(s&&s.accounts)||(state.claudecodeAccountPool||[]).length;
      return n?`${n} account${n===1?'':'s'}`:html`<span class="down">none</span>`;
    })()}<//>
    <${KV} n="Force model">${fm.enabled?html`<span class="warnp">${fm.provider}/${fm.model}</span>`:'off'}<//>
    <${KV} n="Cloud policy">${state.cloudPolicy||'open'}<//>
    <${KV} n="JSON enforce">${state.jsonEnforce?'ON':'OFF'}<//>
    <${KV} n="Config">${state.configPersisted?'file-backed':'env defaults'}<//>
  </div>
  <${Pool} d=${pool}/>
  <${Card}>
    <${CardHead} title="Activity" hint="When calls landed, stacked by provider."
      actions=${html`
        <${Tabs} val=${ovMetric} onChange=${setOvMetric} items=${[['n','Calls'],['tok','Tokens'],['err','Errors']]}/>
        <${Tabs} val=${ovWin} onChange=${setOvWin} items=${[['15m','15m'],['1h','1h'],['6h','6h'],['24h','24h']]}/>`}/>
    ${series?html`<${Chart} data=${series} metric=${ovMetric} by="provider" H=${200}/>`:html`<span class="mut">loading…</span>`}
  </${Card}>
  <${Card}>
    <${CardHead} title="Recent calls" hint="Newest first. Click a row to open the full request and reply."/>
    <div class="tablewrap"><table>
      <tr><th>when</th><th>project</th><th>model</th><th>provider</th><th>status</th><th>lat · tok</th><th>ip</th></tr>
      ${(recent||[]).length? (recent||[]).map(r=>html`
        <tr class="click" onClick=${()=>openCall(r.id)}>
          <td class="mono mut" style="font-size:12px;white-space:nowrap" title=${fmtTime(r.ts)}>${ago(r.ts)} ago</td>
          <td>${r.project?html`<${Chip} cls="tag">${r.project}<//>`:html`<span class="mut" style="font-size:11px">(none)</span>`}</td>
          <td class="mono" style="font-size:12px">${r.req_model||'-'}</td>
          <td><${ProviderPill} provider=${r.provider}/></td>
          <td><${StatusPill} status=${r.status} error=${r.error}/></td>
          <td class="mono" style="font-size:12px">${fmtMs(r.duration_ms)} · ${r.total_tokens??'—'}t</td>
          <td class="mono mut" style="font-size:11px;white-space:nowrap" title=${(r.ua||'')}>${r.ip||'—'}</td>
        </tr>`) : html`<tr><td colspan="7" class="hint">Nothing has called the router yet. The first request through <code>/v1</code> shows up here.</td></tr>`}
    </table></div>
  </${Card}>
  <${Card}>
    <${CardHead} title="Provider health" hint="A live probe of each upstream, next to what it actually served in the last hour."/>
    <div class="tablewrap"><table>
      <tr><th>Provider</th><th>Target</th><th>Probe</th><th>RTT</th><th>Models</th><th>Calls 1h</th><th>Avg</th><th>Err</th></tr>
      ${providers.map(([provider,base,r])=>{ const ls=providerStat[provider]||{}; const slow=ls.avg_ms>SLOW_MS, errd=ls.errors>0;
        return html`<tr>
          <td><${Pill} cls=${provider}>${provider}<//></td>
          <td class="mono mut" style="font-size:12px">${base}</td>
          <td>${r.up?html`<${Pill} cls="up">UP ${r.status}<//>`:html`<${Pill} cls="down">DOWN ${r.status||''}<//>`}</td>
          <td class="mono">${r.ms}ms</td><td class="mono">${r.count??'—'}</td>
          <td class="mono">${ls.n??'—'}</td>
          <td class="mono" style=${slow?'color:var(--warn);font-weight:600':''}>${fmtMs(ls.avg_ms)}</td>
          <td class="mono" style=${errd?'color:var(--danger);font-weight:600':''}>${ls.errors??'—'}</td>
        </tr>`;})}
    </table></div>
  </${Card}>
  <details class="adv" open=${cfgOpen}><summary onClick=${e=>{e.preventDefault();setCfgOpen(!cfgOpen);}}>Effective config (raw JSON)</summary>
    ${cfgOpen&&html`<pre style="margin-top:0">${JSON.stringify({forceModel:state.forceModel,modelRoutes:state.modelRoutes,projectRoutes:state.projectRoutes,projectGroups:state.projectGroups,cloudPolicy:state.cloudPolicy,cloudAllowlist:state.cloudAllowlist,defaultRoute:state.defaultRoute,localMap:state.localMap,gatedModels:state.gatedModels,bases:state.bases,jsonEnforce:state.jsonEnforce,configPersisted:state.configPersisted},null,2)}</pre>`}
  </details>`;
}
/* The claudecode pool, condensed: each subscription, its usage-window headroom, and who spends it.
   These are Claude Max logins — the pool serves whatever Claude Code serves. The bars are the usage
   windows (5h/7d), harvested off real traffic; a 429 means a window is spent (and resets), not that
   a model is unavailable. */
function Pool({d}){
  const {go}=useApp();
  if(!d) return '';
  const accts=d.accounts||[];
  if(!accts.length) return '';
  const bad=(d.orphanPins||[]).length;
  const now=d.now||Date.now();
  // The reset clock: within a day → "Wed 14:30", further out → "Jul 16 09:00".
  const resetAt=sec=>{ if(!sec) return ''; const dt=new Date(sec*1000); const ms=sec*1000-now; if(ms<=0) return 'now';
    const t=dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const day=dt.toLocaleDateString([], ms<86400000?{weekday:'short'}:{month:'short',day:'numeric'});
    return `${day} ${t}`; };
  return html`<${Card} cls=${bad?'bad':''}>
    <${CardHead} title="Claude Max pool" hint=${`${accts.length} subscription${accts.length===1?'':'s'}, ${d.advertisedModels} model ids`}
      actions=${html`<button class="ghost sm" onClick=${()=>go('identity','accounts')}>Accounts</button>`}/>
    <div class="tablewrap"><table>
      <tr><th>account</th><th>projects</th><th>5h · resets</th><th>7d · resets</th><th>24h</th></tr>
      ${accts.map(a=>html`<tr key=${a.name} class="click" onClick=${()=>go('identity','accounts')}>
        <td class="mono" style="font-size:12.5px;font-weight:600">${a.name}</td>
        <td style="font-size:11.5px" class="mut">${a.projects.length?a.projects.join(', '):'— unused'}</td>
        <td style="min-width:78px"><${Bar} v=${a.limits&&a.limits.u5}/>${a.limits&&a.limits.reset5?html`<div class="hint" style="font-size:9.5px" title=${'5h window resets '+new Date(a.limits.reset5*1000).toLocaleString()}>↺ ${resetAt(a.limits.reset5)}</div>`:''}</td>
        <td style="min-width:78px"><${Bar} v=${a.limits&&a.limits.u7}/>${a.limits&&a.limits.reset7?html`<div class="hint" style="font-size:9.5px" title=${'7d window resets '+new Date(a.limits.reset7*1000).toLocaleString()}>↺ ${resetAt(a.limits.reset7)}</div>`:''}</td>
        <td class="mono mut" style="font-size:12px;white-space:nowrap">${a.usage.calls24h?nfmt(a.usage.calls24h)+' calls':'idle'}</td>
      </tr>`)}
    </table></div>
    <small class="hint" style="display:block;margin-top:12px">The 5h/7d bars are the Claude Max usage windows, harvested off real traffic and read as a <b>floor</b>: a 429 sends no rate-limit headers, so a spent window keeps its last reading. Open <b>Accounts</b> to pull a live reading. All models are available on the subscriptions.</small>
  </${Card}>`;
}

/* The one thing this page exists to answer: is anything wrong right now, and what. Colour carries the
   severity; the sentence carries the consequence. Order is worst-first, decided here, not by the eye. */
const SEV={down:DANGER,dry:DANGER,err:DANGER,slow:WARN,refusal:WARN,force:WARN};
function Issues({health,st,state,pool}){
  const probs=[];
  ['local','claudecode','crazyrouter'].forEach(l=>{ const r=health[l]; if(r&&!r.up) probs.push(['down',`Provider ${l} is DOWN (status ${r.status||'—'}). Traffic to it will fail.`]); });
  if(pool&&pool.summary){
    if((pool.orphanPins||[]).length) probs.push(['err',`${pool.orphanPins.length} project pin(s) name an account that is not in the pool — those calls 403.`]);
  }
  if(st&&st.byProvider){
    st.byProvider.forEach(r=>{ if(r.avg_ms>SLOW_MS) probs.push(['slow',`Provider ${r.provider} is slow — avg ${fmtMs(r.avg_ms)} over the last hour (${r.n} calls).`]); });
    if(st.windowJsonFails>0) probs.push(['refusal',`${st.windowJsonFails} JSON-enforce failure(s) in the last hour — usually a prose refusal, surfaced as 422. Not a proxy bug.`]);
    const otherErr=st.windowErrors-(st.windowJsonFails||0); const rate=st.windowCalls>0?otherErr/st.windowCalls:0;
    if(rate>0.05 && st.windowCalls>=20) probs.push(['err',`Non-refusal error rate ${(rate*100).toFixed(0)}% over the last hour (${otherErr}/${st.windowCalls}).`]);
  }
  if(state.forceModel&&state.forceModel.enabled) probs.push(['force',`Force-model is ON → every request rewritten to ${state.forceModel.provider}/${state.forceModel.model}.`]);
  if(!probs.length) return html`<div class="alert ok"><b style="color:var(--ok)">All healthy</b> <span class="mut">— providers up, no slow providers or elevated errors in the last hour.</span></div>`;
  const worst=probs.some(([k])=>SEV[k]===DANGER);
  return html`<div class=${'alert '+(worst?'bad':'warn')}>
    <b style=${`color:${worst?'var(--danger)':'var(--warn)'}`}>${probs.length} thing${probs.length>1?'s':''} to look at</b>
    <ul>${probs.map(([k,m])=>html`<li><${Dot} color=${SEV[k]||'var(--fg-sub)'}/><span>${m}</span></li>`)}</ul>
  </div>`;
}


export { Overview, Issues, Pool };
