import { html, h, useState, useEffect, useCallback, api, toast, ago, Pill, KV, Card, PageHead, useApp } from "../core.js";

/* ───────── MODELS & TEST ───────── */
/* The Claude catalog, and whether it is fiction.
   `advertised` is what /v1/models hands callers. `source:anthropic` means we reconciled it against
   api.anthropic.com; `seed` means that call has never succeeded and we are serving the hardcoded
   floor. Probing is separate and costs a max_tokens:1 ping per model — the catalog says what the
   org can SEE, the probe says what the subscription will actually SERVE, and they disagree. */
function ClaudeCatalog(){
  const {state}=useApp();
  const [cat,setCat]=useState(null); const [busy,setBusy]=useState(false);
  const [probe,setProbe]=useState(null); const [probing,setProbing]=useState(false);
  const accounts=(state.claudecodeAccountPool||[]).map(a=>a.name);
  const [acct,setAcct]=useState(accounts[0]||'');
  const load=useCallback(async()=>{ try{ setCat(await api('claudecode/models')); }catch(e){ toast(e.message,true); } },[]);
  useEffect(()=>{load();},[load]);
  async function refresh(){ setBusy(true); try{ setCat(await api('claudecode/models',{method:'POST'})); toast('catalog refreshed from Anthropic'); }catch(e){ toast(e.message,true); } finally{ setBusy(false); } }
  async function runProbe(){ if(!acct){toast('no accounts',true);return;} setProbing(true); setProbe(null);
    try{ const r=await api('claudecode/probe',{method:'POST',body:JSON.stringify({account:acct})}); setProbe(r);
      toast(`${r.usable.length}/${r.results.length} models usable on ${r.account}`, r.usable.length===0);
    }catch(e){ toast(e.message,true); } finally{ setProbing(false); } }
  const ago=ts=>{ if(!ts)return 'never'; const m=(Date.now()-ts)/60000; return m<1?'just now':m<60?Math.round(m)+'m ago':Math.round(m/60)+'h ago'; };
  const byId=new Map((probe?probe.results:[]).map(r=>[r.id,r]));
  return html`
  <${Card}>
    <h3>Claude catalog <small class="hint">— read from api.anthropic.com, not from config</small></h3>
    <div class="row" style="margin:8px 0">
      <div style="flex:1">
        <${KV} n="advertised on /v1/models">${cat?cat.advertised.length:'…'} ids<//>
      </div>
      <div style="flex:1">
        <${KV} n="source">${cat?html`<${Pill} cls=${cat.source==='anthropic'?'up':'warnp'}>${cat.source}<//>`:'…'}<//>
      </div>
      <div style="flex:1"><${KV} n="last checked">${cat?ago(cat.checkedAt):'…'} ${cat&&cat.sweptAccounts&&cat.sweptAccounts.length?html`<span class="hint">swept ${cat.sweptAccounts.length} account${cat.sweptAccounts.length===1?'':'s'}</span>`:''}<//></div>
    </div>
    ${cat&&cat.source!=='anthropic'&&html`<p class="down" style="margin:0 0 8px">Serving the hardcoded seed — Anthropic's catalog has not been read successfully${cat.error?': '+cat.error:''}. Ids still route; the list may just be stale.</p>`}
    ${cat&&cat.failedAccounts&&cat.failedAccounts.length>0&&html`<p class="warnp" style="margin:0 0 8px">Could not read the catalog on ${cat.failedAccounts.map(f=>f.account+' ('+f.error+')').join(', ')} — any model only those accounts can see is missing from this list.</p>`}
    <p class="hint" style="margin:0 0 8px">The catalog is <b>per-account</b>: this is the <b>union</b> across every account, so an id here may 404 on the account your project is pinned to. Probe to find out.</p>
    <div class="row">
      <button class="ghost sm" disabled=${busy} onClick=${refresh}>${busy?'refreshing…':'↻ Refresh from Anthropic'}</button>
      <span style="flex:1"></span>
      <select style="flex:0 0 auto" value=${acct} onChange=${e=>setAcct(e.target.value)}>${accounts.map(a=>html`<option value=${a}>${a}</option>`)}</select>
      <button class="ghost sm" disabled=${probing} onClick=${runProbe}>${probing?'probing…':'Probe which actually answer'}</button>
    </div>
    ${probe&&probe.usable.length===0&&html`<p class="down" style="margin:10px 0 0"><b>${probe.account} serves nothing.</b> Every advertised model returned an error — the subscription is exhausted, not the routing.</p>`}
    <div class="mono" style="max-height:340px;overflow:auto;margin-top:10px">
      ${cat?cat.advertised.map(id=>{ const p=byId.get(id); const m=(cat.models||[]).find(x=>x.id===id);
        const na=(m&&m.accounts)?m.accounts.length:0, tot=(cat.sweptAccounts||[]).length;
        return html`<div class="flex" key=${id} style="gap:8px;padding:3px 0;align-items:center">
          <span style="flex:0 0 auto">${p?html`<${Pill} cls=${p.ok?'up':'down'}>${p.ok?'200':(p.status||'ERR')}<//>`:html`<span class="pill mut" style="opacity:.45">·</span>`}</span>
          <span>${id}</span>
          <span class="mut">${m&&m.display_name?'· '+m.display_name:''}</span>
          ${m&&tot>0&&na<tot?html`<span class="pill warnp" title=${'only on: '+m.accounts.join(', ')}>${na}/${tot} accts</span>`:''}
          ${!m&&(cat.aliases||[]).includes(id)?html`<span class="pill mut" title="Anthropic serves this id but does not list it in /v1/models">alias</span>`:''}
          ${!m&&!(cat.aliases||[]).includes(id)&&cat.source==='anthropic'?html`<span class="pill mut" title="in the code seed, not in Anthropic's catalog">seed only</span>`:''}
          ${p&&!p.ok&&p.error?html`<span class="mut hint">${p.error}</span>`:''}
        </div>`; }):html`<span class="mut">loading…</span>`}
    </div>
    ${probe&&html`<p class="hint" style="margin:8px 0 0">Probed ${probe.account} · ${probe.usable.length}/${probe.results.length} usable. A <code>429</code> here is Anthropic refusing the model on that subscription — no amount of routing config fixes it.</p>`}
  </${Card}>`;
}

function Models(){
  const [models,setModels]=useState(null);
  const [filter,setFilter]=useState('');
  const [tm,setTm]=useState(''); const [tp,setTp]=useState('In one short sentence, what model are you?');
  const [out,setOut]=useState(null);
  useEffect(()=>{ (async()=>{ try{ setModels(await api('models')); }catch(e){} })(); },[]);
  async function runTest(){ const model=tm.trim(); if(!model){toast('enter a model',true);return;} setOut('running…');
    try{ const r=await api('test',{method:'POST',body:JSON.stringify({model,prompt:tp})}); setOut(`provider=${r.provider} sent=${r.sentModel} status=${r.status} ${r.ms}ms\n`+(r.content!=null?('\n'+r.content):('\n[no content]\n'+(r.error||r.raw||'')))); }
    catch(e){ setOut('error: '+e.message); } }
  const all=models?[...models.local,...models.claudecode,...models.crazyrouter]:[];
  const sec=(title,cls,arr)=>{ const items=(arr||[]).filter(m=>!filter||m.id.toLowerCase().includes(filter.toLowerCase())); if(!items.length)return '';
    return html`<div style="margin:10px 0 4px"><${Pill} cls=${cls}>${title}<//> <span class="mut">${items.length}</span></div>${items.map(m=>html`<div style="padding:3px 0">${m.id} <span class="mut">· ${m.owned_by||''}</span></div>`)}`; };
  return html`
  <${PageHead} title="Models & test"/>
  <${ClaudeCatalog}/>
  <${Card}>
    <h3>Test a model <small class="hint">— runs a real chat completion through current routing</small></h3>
    <div class="row">
      <input list="modellist" style="flex:2" placeholder="model e.g. local / claude-sonnet-4-6 / gemini-2.5-pro" value=${tm} onInput=${e=>setTm(e.target.value)}/>
      <button style="flex:0 0 auto" onClick=${runTest}>Run</button>
    </div>
    <datalist id="modellist">${all.map(m=>html`<option value=${m.id}></option>`)}</datalist>
    <input placeholder="prompt" value=${tp} onInput=${e=>setTp(e.target.value)} style="margin-top:8px"/>
    ${out!=null&&html`<pre>${out}</pre>`}
  </${Card}>
  <${Card}>
    <h3>Available models ${models?html`<span class="mut">(local ${models.local.length} · claudecode ${models.claudecode.length} · crazyrouter ${models.crazyrouter.length})</span>`:''}</h3>
    <input placeholder="filter…" value=${filter} onInput=${e=>setFilter(e.target.value)} style="margin-bottom:8px"/>
    <div class="mono" style="max-height:420px;overflow:auto">${models?html`${sec('local','local',models.local)}${sec('claudecode','claudecode',models.claudecode)}${sec('crazyrouter','crazyrouter',models.crazyrouter)}`:html`<span class="mut">loading…</span>`}</div>
  </${Card}>`;
}


export { ClaudeCatalog, Models };
