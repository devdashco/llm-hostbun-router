import { html, useState, useEffect, useRef, useCallback, api, toast, clone, nfmt, fmtTime, ProviderPill, StatusPill, Card, ParamBadges, TriSel, FacetSel, PageHead, useApp } from "../core.js";

/* ───────── CALLS ───────── */
const CALL_WINDOWS=[['','any time'],['15m','last 15 min'],['1h','last hour'],['6h','last 6h'],['24h','last 24h'],['7d','last 7d'],['30d','last 30d']];
const WIN_MS={'15m':9e5,'1h':36e5,'6h':216e5,'24h':864e5,'7d':6048e5,'30d':2592e6};
const EMPTY_FILTERS={q:'',model:'',project:'',provider:'',status:'',key:'',effort:'',client:'',stop:'',
  stream:'',thinking:'',tools:'',cached:'',minTok:'',minMs:'',win:''};

function Calls(){
  const {state,openCall,reload} = useApp();
  const [rows,setRows]=useState([]); const [total,setTotal]=useState(0); const [dbReady,setDbReady]=useState(true);
  const [pageSize,setPageSize]=useState(200); const [offset,setOffset]=useState(0);
  const [f,setF]=useState({...EMPTY_FILTERS});
  const [facets,setFacets]=useState({});
  const [live,setLive]=useState(false); const [fresh,setFresh]=useState({}); // id -> true, decays
  const [lg,setLg]=useState(()=>clone(state.logging));
  const [exporting,setExporting]=useState(false);
  useEffect(()=>{ setLg(clone(state.logging)); },[state.logging]);
  useEffect(()=>{ api('calls/facets').then(setFacets).catch(()=>{}); },[]);
  // Filters -> query string. `win` is client-side sugar over the server's absolute `since`.
  const qs=useCallback(()=>{
    const p=new URLSearchParams();
    Object.entries(f).forEach(([k,v])=>{ if(k!=='win'&&v&&String(v).trim())p.set(k,String(v).trim()); });
    if(f.win&&WIN_MS[f.win]) p.set('since',String(Date.now()-WIN_MS[f.win]));
    return p;
  },[f]);
  // load a page. off = row offset into the (filtered) result set.
  const load=useCallback(async(off=0)=>{
    const p=qs(); p.set('limit',String(pageSize)); p.set('offset',String(off));
    try{ const d=await api('calls?'+p.toString()); setRows(d.rows||[]); setTotal(d.total||0); setDbReady(d.dbReady!==false); setOffset(off); }catch(e){}
  },[qs,pageSize]);
  useEffect(()=>{ // seed project / q filter from URL on mount (set by Stats drilldowns)
    const sp=new URLSearchParams(window.location.search); const pr=sp.get('project'), qq=sp.get('q');
    if(pr||qq){ setF(x=>({...x,project:pr||'',q:qq||''})); }
  },[]);
  useEffect(()=>{ load(0); },[load]); // reload page 0 when filters / pageSize change
  // Live tail. Only ever runs on page 0 — prepending onto a scrolled-back page would corrupt
  // the offset arithmetic. Asks for rows newer than the newest one held, so the poll stays cheap
  // and returns nothing at all when the router is idle. The cursor lives in a ref, not in the
  // effect's deps: keying off `rows` would tear down and rebuild the interval on every new row.
  const topRef=useRef(0);
  useEffect(()=>{ topRef.current = rows.length?rows[0].id:0; },[rows]);
  useEffect(()=>{
    if(!live||offset!==0) return;
    let dead=false;
    const tick=async()=>{
      if(!topRef.current){ load(0); return; }
      const p=qs(); p.set('afterId',String(topRef.current)); p.set('limit','200');
      try{
        const d=await api('calls?'+p.toString()); if(dead) return;
        const nu=d.rows||[]; if(!nu.length) return;
        // A full page of new rows means more arrived than we asked for, and `ORDER BY id DESC`
        // handed us the newest 200 — prepending them would skip the gap below, permanently.
        if(nu.length>=200){ load(0); return; }
        setRows(r=>[...nu,...r].slice(0,pageSize));
        setTotal(t=>t+nu.length);
        const mark={}; nu.forEach(r=>mark[r.id]=true); setFresh(x=>({...x,...mark}));
        setTimeout(()=>{ if(!dead) setFresh(x=>{ const y={...x}; nu.forEach(r=>delete y[r.id]); return y; }); },4000);
      }catch(e){}
    };
    const iv=setInterval(tick,2500);
    return()=>{ dead=true; clearInterval(iv); };
  },[live,offset,qs,pageSize,load]);
  const upd=(k,v)=>setF(x=>({...x,[k]:v}));
  const activeCount=Object.entries(f).filter(([k,v])=>v&&String(v).trim()).length;
  const A=total?offset+1:0, B=Math.min(offset+rows.length,total), lastOff=Math.max(0,(Math.ceil(total/pageSize)-1)*pageSize);
  const canPrev=offset>0, canNext=offset+pageSize<total;
  async function saveLogging(){ try{ const r=await api('config',{method:'POST',body:JSON.stringify({logging:{enabled:lg.enabled,content:lg.content,retain:parseInt(lg.retain||50000,10)}})}); reload(r.state); toast('logging settings saved'); }catch(e){toast(e.message,true);} }
  async function clearCalls(){ if(!confirm('Delete ALL logged calls? This cannot be undone.'))return; try{ await api('calls/clear',{method:'POST'}); toast('call log cleared'); load(0); }catch(e){toast(e.message,true);} }
  // Export EVERY row (full prompt+reply content) by paging the id-cursor export endpoint, then download as JSON.
  async function exportAll(){
    if(exporting)return; setExporting(true); toast('exporting… paging full call log');
    try{ let after=0, all=[], guard=0;
      for(;;){ const d=await api('export?after='+after+'&limit=1000'); const rs=d.rows||[]; all.push(...rs);
        if(rs.length<1000)break; after=d.maxId; if(++guard>5000)break; }
      const blob=new Blob([JSON.stringify(all,null,2)],{type:'application/json'});
      const u=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=u; a.download='llm-hostbun-calls-full.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(u),1000);
      toast('exported '+all.length.toLocaleString()+' calls (full content)');
    }catch(e){ toast(e.message,true); } finally{ setExporting(false); }
  }
  return html`
  <${PageHead} title="Call log"/>
  <${Card}>
    <div class="row">
      <input placeholder="search model / ip / ua / prompt / reply…" style="flex:3" value=${f.q} onInput=${e=>upd('q',e.target.value)} onKeyDown=${e=>e.key==='Enter'&&load(0)}/>
      <select style="flex:0 0 130px" value=${f.provider} onChange=${e=>upd('provider',e.target.value)}><option value="">any provider</option><option>local</option><option>crazyrouter</option><option>claudecode</option><option>blocked</option></select>
      <select style="flex:0 0 110px" value=${f.status} onChange=${e=>upd('status',e.target.value)}><option value="">any status</option><option value="ok">ok (&lt;400)</option><option value="error">error (≥400)</option></select>
      <select style="flex:0 0 auto;width:auto" value=${f.win} onChange=${e=>upd('win',e.target.value)}>${CALL_WINDOWS.map(([v,l])=>html`<option value=${v}>${l}</option>`)}</select>
      <button class=${live?'sm':'ghost sm'} style="flex:0 0 auto" title="poll every 2.5s and prepend new calls (page 1 only)" onClick=${()=>setLive(x=>!x)}>${live?'● LIVE':'○ Live'}</button>
      <button class="ghost sm" style="flex:0 0 auto" onClick=${()=>load(0)}>↻ Load</button>
    </div>
    <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:6px">
      <${FacetSel} label="project" items=${facets.projects} value=${f.project} onChange=${v=>upd('project',v)} extra=${[['(none)','project: (none)']]}/>
      <${FacetSel} label="model" items=${facets.models} value=${f.model} onChange=${v=>upd('model',v)}/>
      <${FacetSel} label="account" items=${facets.keys} value=${f.key} onChange=${v=>upd('key',v)}/>
      <${FacetSel} label="effort" items=${facets.efforts} value=${f.effort} onChange=${v=>upd('effort',v)} extra=${[['(none)','effort: (none)']]}/>
      <${FacetSel} label="client" items=${facets.clients} value=${f.client} onChange=${v=>upd('client',v)}/>
      <${FacetSel} label="stop" items=${facets.stops} value=${f.stop} onChange=${v=>upd('stop',v)}/>
      <${TriSel} label="stream" value=${f.stream} onChange=${v=>upd('stream',v)}/>
      <${TriSel} label="thinking" value=${f.thinking} onChange=${v=>upd('thinking',v)} title="thinking_tokens > 0"/>
      <${TriSel} label="tools" value=${f.tools} onChange=${v=>upd('tools',v)} title="tool_count > 0"/>
      <${TriSel} label="cached" value=${f.cached} onChange=${v=>upd('cached',v)} title="cache_read > 0 — prompt cache hit"/>
      <input placeholder="min tok" style="flex:0 0 90px" value=${f.minTok} onInput=${e=>upd('minTok',e.target.value)} onKeyDown=${e=>e.key==='Enter'&&load(0)}/>
      <input placeholder="min ms" style="flex:0 0 90px" value=${f.minMs} onInput=${e=>upd('minMs',e.target.value)} onKeyDown=${e=>e.key==='Enter'&&load(0)}/>
      ${activeCount?html`<button class="ghost sm" style="flex:0 0 auto" onClick=${()=>setF({...EMPTY_FILTERS})}>✕ clear ${activeCount} filter${activeCount>1?'s':''}</button>`:''}
    </div>
    <div class="flex" style="justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:10px">
      <small class="hint">${dbReady?html`showing <b>${A.toLocaleString()}–${B.toLocaleString()}</b> of <b>${total.toLocaleString()}</b> matching <span class="mut">· DB keeps the newest ${(state.logging&&state.logging.retain||50000).toLocaleString()} rows (older archived to NAS)</span>`:'call DB unavailable'}</small>
      <div class="flex" style="gap:6px;flex-wrap:wrap">
        <select value=${pageSize} onChange=${e=>setPageSize(+e.target.value)} style="width:auto" title="rows per page"><option value="100">100 / page</option><option value="200">200 / page</option><option value="500">500 / page</option></select>
        <button class="ghost sm" disabled=${!canPrev} onClick=${()=>load(0)}>« First</button>
        <button class="ghost sm" disabled=${!canPrev} onClick=${()=>load(Math.max(0,offset-pageSize))}>‹ Prev</button>
        <button class="ghost sm" disabled=${!canNext} onClick=${()=>load(offset+pageSize)}>Next ›</button>
        <button class="ghost sm" disabled=${!canNext} onClick=${()=>load(lastOff)}>Last »</button>
        <button class="ghost sm" disabled=${exporting} onClick=${exportAll} title="download every row with full prompt+reply as JSON">${exporting?'exporting…':'⬇ Export ALL'}</button>
      </div>
    </div>
  </${Card}>
  <${Card}><div style="overflow:auto"><table>
    <tr><th>time</th><th>project</th><th>model → sent</th><th>provider</th><th>key</th><th>effort</th><th>status</th><th>ms</th>
      <th title="prompt → completion tokens">in → out</th><th title="cache read / write tokens">cache</th><th title="tool schemas loaded">tools</th><th>ip / ua</th></tr>
    ${rows.map(r=>html`<tr class="click" onClick=${()=>openCall(r.id)} style=${fresh[r.id]?'background:rgba(90,200,140,.12)':''}>
      <td class="mono" style="font-size:12px;white-space:nowrap">${fmtTime(r.ts)}</td>
      <td style="font-size:12px">${r.project?html`<span class="pill" style="background:#2a3a2a;color:#8bc88b">${r.project}</span>`:html`<span class="mut" style="font-size:11px">(none)</span>`}</td>
      <td class="mono" style="font-size:12px">${r.req_model||'-'}${r.sent_model&&r.sent_model!==r.req_model?html` <span class="mut">→ ${r.sent_model}</span>`:''}${r.stream?html` <span class="mut">≈stream</span>`:''}<${ParamBadges} r=${r}/></td>
      <td><${ProviderPill} provider=${r.provider}/></td>
      <td class="mono" style="font-size:12px">${r.key_label||''}</td>
      <td class="mono" style="font-size:12px">${r.effort?html`<span style="color:var(--amb)">${r.effort}</span>`:html`<span class="mut">—</span>`}${r.thinking_tokens>0?html`<br/><span class="mut" style="font-size:11px">💭 ${nfmt(r.thinking_tokens)}</span>`:''}</td>
      <td><${StatusPill} status=${r.status} error=${r.error}/></td>
      <td class="mono">${r.duration_ms??'—'}</td>
      <td class="mono" style="font-size:12px;white-space:nowrap">${r.prompt_tokens!=null||r.completion_tokens!=null
          ?html`${nfmt(r.prompt_tokens||0)} <span class="mut">→</span> ${nfmt(r.completion_tokens||0)}`
          :html`<span class="mut">—</span>`}</td>
      <td class="mono" style="font-size:12px;white-space:nowrap">${(r.cache_read>0||r.cache_write>0)
          ?html`<span style="color:var(--grn)">${nfmt(r.cache_read||0)}</span> <span class="mut">/ ${nfmt(r.cache_write||0)}</span>`
          :html`<span class="mut">—</span>`}</td>
      <td class="mono" style="font-size:12px">${r.tool_count>0?html`${r.tool_count}${r.tools_kb>0?html`<span class="mut"> · ${r.tools_kb}KB</span>`:''}`:html`<span class="mut">—</span>`}</td>
      <td class="mut mono" style="font-size:11px">${r.ip||''}<br/>${(r.ua||'').slice(0,32)}</td>
    </tr>`)}
  </table></div></${Card}>
  <${Card}>
    <h3>Logging settings</h3>
    <div class="row">
      <label class="flex" style="flex:0 0 auto"><input type="checkbox" checked=${!!lg.enabled} onChange=${e=>setLg({...lg,enabled:e.target.checked})} style="width:auto;margin-right:8px"/> log calls</label>
      <label class="flex" style="flex:0 0 auto"><input type="checkbox" checked=${!!lg.content} onChange=${e=>setLg({...lg,content:e.target.checked})} style="width:auto;margin-right:8px"/> store prompt + reply content</label>
      <div style="flex:0 0 auto"><label style="margin:0">retain rows</label><input type="number" min="100" step="1000" value=${lg.retain||50000} onInput=${e=>setLg({...lg,retain:e.target.value})} style="width:130px"/></div>
    </div>
    <small class="hint">${state.loggingDbReady?'DB ready — calls.db on the /data persistent volume':'⚠ call DB unavailable — logging is off'}</small>
    <div style="margin-top:10px"><button onClick=${saveLogging}>Save logging settings</button><button class="danger" style="margin-left:8px" onClick=${clearCalls}>Clear log</button></div>
  </${Card}>`;
}


export { CALL_WINDOWS, WIN_MS, EMPTY_FILTERS, Calls };
