import { html, h, useState, useEffect, useCallback, api, ago, fmtMs, fmtTime, SLOW_MS, Pill, ProviderPill, StatusPill, KV, Card, Chart, Seg, PageHead, useApp } from "../core.js";

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
  const load=useCallback(async()=>{
    try{ const [h,s]=await Promise.all([api('health'),api('stats?window=1h').catch(()=>null)]); setHealth(h); setSt1h(s); }catch(e){}
    try{ setRecent((await api('calls?limit=18')).rows||[]); }catch(e){}
  },[]);
  useEffect(()=>{load();},[load]);
  useEffect(()=>{ (async()=>{ try{ setSeries(await api('series?window='+ovWin+'&by=provider')); }catch(e){} })(); },[ovWin]);
  if(!health) return html`<${PageHead} title="Overview" onRefresh=${load}/><div class="mut">loading…</div>`;
  const providerStat={}; ((st1h&&st1h.byProvider)||[]).forEach(r=>providerStat[r.provider]=r);
  const providers=[['local',state.bases.local,health.local],['claudecode',state.bases.claudecode,health.claudecode],['crazyrouter',state.bases.crazyrouter,health.crazyrouter]];
  const up=[health.local,health.claudecode,health.crazyrouter].filter(x=>x&&x.up).length;
  const fm=state.forceModel||{};
  return html`
  <${PageHead} title="Overview" onRefresh=${load}/>
  <${Issues} health=${health} st=${st1h} state=${state}/>
  <${Card}>
    <div class="flex" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">Activity <small class="hint">— when, by provider</small></h3>
      <div class="flex" style="gap:6px;flex-wrap:wrap">
        <${Seg} val=${ovMetric} onChange=${setOvMetric} items=${[['n','Calls'],['tok','Tokens'],['err','Errors']]}/>
        <${Seg} val=${ovWin} onChange=${setOvWin} items=${[['15m','15m'],['1h','1h'],['6h','6h'],['24h','24h']]}/>
      </div>
    </div>
    <div style="margin-top:12px">${series?html`<${Chart} data=${series} metric=${ovMetric} by="provider" H=${200}/>`:html`<span class="mut">loading…</span>`}</div>
  </${Card}>
  <${Card}>
    <div class="flex" style="justify-content:space-between"><h3 style="margin:0">Recent calls <small class="hint">— newest first · click to open</small></h3><button class="ghost sm" onClick=${()=>load()}>↻</button></div>
    <div style="overflow:auto"><table>
      <tr><th>when</th><th>project</th><th>model</th><th>provider</th><th>status</th><th>lat · tok</th><th>ip</th></tr>
      ${(recent||[]).length? (recent||[]).map(r=>html`
        <tr class="click" onClick=${()=>openCall(r.id)}>
          <td class="mono mut" style="font-size:12px;white-space:nowrap" title=${fmtTime(r.ts)}>${ago(r.ts)} ago</td>
          <td style="font-size:12px">${r.project?html`<span class="chip" style="color:#8bc88b">${r.project}</span>`:html`<span class="mut" style="font-size:11px">(none)</span>`}</td>
          <td class="mono" style="font-size:12px">${r.req_model||'-'}</td>
          <td><${ProviderPill} provider=${r.provider}/></td>
          <td><${StatusPill} status=${r.status} error=${r.error}/></td>
          <td class="mono" style="font-size:12px">${fmtMs(r.duration_ms)} · ${r.total_tokens??'—'}t</td>
          <td class="mono mut" style="font-size:11px;white-space:nowrap" title=${(r.ua||'')}>${r.ip||'—'}</td>
        </tr>`) : html`<tr><td colspan="7" class="mut">no calls logged yet</td></tr>`}
    </table></div>
  </${Card}>
  <div class="grid">
    <${KV} n="Providers up">${up<3?html`<span class="down">${up} / 3</span>`:up+' / 3'}<//>
    <${KV} n="Force model">${fm.enabled?html`<span class="warnp">${fm.provider}/${fm.model}</span>`:'off'}<//>
    <${KV} n="Accounts">${(()=>{const n=(state.claudecodeAccountPool||[]).length; return n?n+' pinned pool':html`<span class="down">none</span>`;})()}<//>
    <${KV} n="Cloud policy">${state.cloudPolicy||'open'}<//>
    <${KV} n="JSON enforce">${state.jsonEnforce?'ON':'OFF'}<//>
    <${KV} n="Config">${state.configPersisted?'file-backed':'env defaults'}<//>
  </div>
  <${Card}>
    <h3>Provider health <small class="hint">— live probe + last-hour traffic</small></h3>
    <div style="overflow:auto"><table>
      <tr><th>Provider</th><th>Target</th><th>Probe</th><th>RTT</th><th>Models</th><th>Calls 1h</th><th>Avg</th><th>Err</th></tr>
      ${providers.map(([provider,base,r])=>{ const ls=providerStat[provider]||{}; const slow=ls.avg_ms>SLOW_MS, errd=ls.errors>0;
        return html`<tr>
          <td><${Pill} cls=${provider}>${provider}<//></td>
          <td class="mono" style="font-size:12px">${base}</td>
          <td>${r.up?html`<${Pill} cls="up">UP ${r.status}<//>`:html`<${Pill} cls="down">DOWN ${r.status||''}<//>`}</td>
          <td class="mono">${r.ms}ms</td><td>${r.count??'—'}</td>
          <td class="mono">${ls.n??'—'}</td>
          <td class="mono" style=${slow?'color:var(--amb);font-weight:700':''}>${fmtMs(ls.avg_ms)}</td>
          <td class="mono" style=${errd?'color:var(--red);font-weight:700':''}>${ls.errors??'—'}</td>
        </tr>`;})}
    </table></div>
  </${Card}>
  <details class="adv" open=${cfgOpen}><summary onClick=${e=>{e.preventDefault();setCfgOpen(!cfgOpen);}}>Effective config (raw JSON)</summary>
    ${cfgOpen&&html`<pre>${JSON.stringify({forceModel:state.forceModel,modelRoutes:state.modelRoutes,projectRoutes:state.projectRoutes,projectGroups:state.projectGroups,cloudPolicy:state.cloudPolicy,cloudAllowlist:state.cloudAllowlist,defaultRoute:state.defaultRoute,localMap:state.localMap,gatedModels:state.gatedModels,bases:state.bases,jsonEnforce:state.jsonEnforce,configPersisted:state.configPersisted},null,2)}</pre>`}
  </details>`;
}
function Issues({health,st,state}){
  const probs=[];
  ['local','claudecode','crazyrouter'].forEach(l=>{ const r=health[l]; if(r&&!r.up) probs.push(['down',`Provider ${l} is DOWN (status ${r.status||'—'}). Traffic to it will fail.`]); });
  if(st&&st.byProvider){
    st.byProvider.forEach(r=>{ if(r.avg_ms>SLOW_MS) probs.push(['slow',`Provider ${r.provider} is slow — avg ${fmtMs(r.avg_ms)} over the last hour (${r.n} calls).`]); });
    if(st.windowJsonFails>0) probs.push(['refusal',`${st.windowJsonFails} JSON-enforce failure(s) in the last hour — usually a prose refusal, surfaced as 422. Not a proxy bug.`]);
    const otherErr=st.windowErrors-(st.windowJsonFails||0); const rate=st.windowCalls>0?otherErr/st.windowCalls:0;
    if(rate>0.05 && st.windowCalls>=20) probs.push(['err',`Non-refusal error rate ${(rate*100).toFixed(0)}% over the last hour (${otherErr}/${st.windowCalls}).`]);
  }
  if(state.forceModel&&state.forceModel.enabled) probs.push(['force',`Force-model is ON → every request rewritten to ${state.forceModel.provider}/${state.forceModel.model}.`]);
  const ic={down:'⛔',slow:'🐢',refusal:'🙅',err:'⚠️',force:'⏻'};
  if(!probs.length) return html`<div class="banner ok"><b style="color:var(--grn)">✓ All healthy</b> <span class="mut">— providers up, no slow providers or elevated errors in the last hour.</span></div>`;
  return html`<div class="banner bad"><b style="color:var(--amb)">${probs.length} thing${probs.length>1?'s':''} to look at</b>
    <ul style="margin:8px 0 0;padding-left:20px;list-style:none">${probs.map(([k,m])=>html`<li style="margin:5px 0">${ic[k]||'•'} ${m}</li>`)}</ul></div>`;
}


export { Overview, Issues };
