import { html, useState, useEffect, api, toast, clone, providerCls, Pill, Chip, ProviderPill, Card, CardHead, PageHead, useApp } from "../core.js";

/* ───────── ROUTING ───────── */
const PROJ_MODELS=[
  {provider:'claudecode',model:'claude-sonnet-4-6'},{provider:'claudecode',model:'claude-opus-4-8'},{provider:'claudecode',model:'claude-haiku-4-5-20251001'},
  {provider:'crazyrouter',model:'gemini-2.5-flash-lite'},{provider:'crazyrouter',model:'gemini-2.5-flash'},{provider:'crazyrouter',model:'gemini-2.5-pro'},
  {provider:'local',model:'gemma-4-e4b-it-obliterated'},{provider:'local',model:'google/gemma-4-26b-a4b'},
];
const BLOCK_VAL='__block__';
const valToRule=v=>{ if(!v)return null; if(v===BLOCK_VAL)return{block:true}; const [provider,...rest]=v.split('|'); return{provider,model:rest.join('|')}; };
const ruleToVal=cur=>(cur&&!cur.block)?`${cur.provider}|${cur.model}`:(cur&&cur.block?BLOCK_VAL:'');
function RulePill({cur}){ if(cur&&cur.block)return html`<${Pill} cls="down">blocked<//>`; if(cur)return html`<${ProviderPill} provider=${cur.provider}/>`; return html`<${Pill} cls="neutral" title="normal routing applies">auto<//>`; }
/* opts = live catalog [{provider,model}], grouped into <optgroup> by provider.
   Falls back to the static PROJ_MODELS seed when the catalog hasn't loaded yet. */
function RuleSelect({cur,onChange,opts}){
  const list=(opts&&opts.length)?opts:PROJ_MODELS;
  const sel=ruleToVal(cur); const extra=(cur&&!cur.block&&!list.some(p=>p.provider===cur.provider&&p.model===cur.model));
  const byProv={}; list.forEach(p=>{ (byProv[p.provider]||(byProv[p.provider]=[])).push(p.model); });
  return html`<select value=${sel} onChange=${e=>onChange(valToRule(e.target.value))} style="flex:1">
    <option value="">auto — normal routing</option>
    <option value=${BLOCK_VAL}>block — reject, 0 tokens</option>
    ${extra&&html`<option value=${sel}>${cur.provider}: ${cur.model||"(keep caller's)"}</option>`}
    ${Object.keys(byProv).map(prov=>html`<optgroup label=${prov}>
      ${byProv[prov].map(m=>html`<option value=${`${prov}|${m}`}>${m}</option>`)}
    </optgroup>`)}
  </select>`;
}
/* Allowlist editor. Independent of the pin: the pin rewrites, the allowlist only refuses.
   Empty = no restriction (never "nothing allowed"). Edits the same rule object the pin lives in. */
/* Allowlist picker — click chips to enable providers/models. No free text.
   `catalog` is {provider:[modelId,…]}. Empty selection = no restriction. Any
   already-allowed id missing from the catalog still shows (checked) so a stale
   pick is visible and removable, never silently dropped. */
function AllowCell({cur,catalog,onChange}){
  const [open,setOpen]=useState(false);
  const ap=(cur&&cur.allowProviders)||[], am=(cur&&cur.allowModels)||[];
  const blocked=cur&&cur.block;
  const emit=patch=>{ const next={...(cur||{}),...patch};
    ['allowProviders','allowModels'].forEach(k=>{ if(!next[k]||!next[k].length) delete next[k]; });
    onChange((next.provider||next.block||next.allowProviders||next.allowModels)?next:null); };
  const toggleP=p=>emit({allowProviders:ap.includes(p)?ap.filter(x=>x!==p):[...ap,p]});
  const toggleM=m=>emit({allowModels:am.includes(m)?am.filter(x=>x!==m):[...am,m]});
  const summary=blocked?'—':(!ap.length&&!am.length)?'any':[ap.length&&`${ap.length} provider${ap.length>1?'s':''}`,am.length&&`${am.length} model${am.length>1?'s':''}`].filter(Boolean).join(' · ');
  if(blocked) return html`<span class="hint">blocked — nothing runs</span>`;
  const provs=['claudecode','crazyrouter','local'];
  const known=new Set(provs.flatMap(p=>(catalog[p]||[])));
  const extras=am.filter(m=>!known.has(m)); // allowed but not in the live catalog
  return html`<div>
    <button class="ghost sm" onClick=${()=>setOpen(!open)}>${open?'▾':'▸'} ${summary}</button>
    ${open&&html`<div style="margin-top:8px;padding:12px;border:1px solid var(--border);border-radius:var(--r);min-width:260px;background:var(--sunken)">
      <div class="lbl" style="font:11px var(--mono);color:var(--fg-mut);margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em">Providers</div>
      <div class="pick-wrap">${provs.map(p=>html`<span class="pick ${ap.includes(p)?'on':''} ${providerCls[p]||''}" onClick=${()=>toggleP(p)}>${p}</span>`)}</div>
      ${provs.map(prov=>{ const ms=(catalog[prov]||[]); if(!ms.length)return null; return html`<div class="pick-grp">
        <div class="lbl">${prov} models</div>
        <div class="pick-wrap">${ms.map(m=>html`<span class="pick ${am.includes(m)?'on':''}" onClick=${()=>toggleM(m)}>${m}</span>`)}</div>
      </div>`; })}
      ${extras.length&&html`<div class="pick-grp"><div class="lbl">other (not in catalog)</div>
        <div class="pick-wrap">${extras.map(m=>html`<span class="pick on" title="click to remove" onClick=${()=>toggleM(m)}>${m}</span>`)}</div></div>`}
      <small class="hint" style="display:block;margin-top:10px">Nothing selected = no restriction. A call that resolves outside the picked set is rejected, never rewritten.</small>
    </div>`}
  </div>`;
}
const LIM_WINDOWS=['1h','6h','24h','7d','30d'];
const LIM_HARD=[['block','block (429)'],['slow','slow only'],['warn','warn only']];
function Routing(){
  const {state,reload} = useApp();
  const [d,setD]=useState(()=>seed(state));
  const [known,setKnown]=useState([]);
  const [resolveOut,setResolveOut]=useState(null);
  const [resIn,setResIn]=useState(''); const [resProj,setResProj]=useState('');
  const [na,setNa]=useState({alias:'',target:''}), [nr,setNr]=useState({in:'',provider:'claudecode',model:''}), [ng,setNg]=useState({name:'',prefix:''}), [nl,setNl]=useState('');
  useEffect(()=>{ setD(seed(state)); },[state]);
  useEffect(()=>{ (async()=>{ try{ const s=await api('stats?window=all'); setKnown((s.byProject||[]).map(r=>r.project).filter(Boolean)); }catch(e){} })(); },[]);
  function seed(s){ return { bases:clone(s.bases), claudePrefix:s.claudePrefix, jsonEnforce:!!s.jsonEnforce, jsonMaxRetries:s.jsonMaxRetries,
    gatedModels:(s.gatedModels||[]).slice(), localMap:clone(s.localMap), modelRoutes:clone(s.modelRoutes), projectRoutes:clone(s.projectRoutes),
    projectGroups:clone(s.projectGroups||[]), projectLimits:clone(s.projectLimits), projectLimitDefault:clone(s.projectLimitDefault||{window:'24h',tokens:0,calls:0,warnPct:80,slowPct:95,slowMs:1500,hard:'block'}),
    forceModel:clone(s.forceModel), cloudPolicy:s.cloudPolicy||'open', cloudAllowlist:(s.cloudAllowlist||[]).slice(),
    defaultRoute:clone(s.defaultRoute) }; }
  const set=(k,v)=>setD(x=>({...x,[k]:v}));
  const matchGroup=pkey=>{ const p=String(pkey||'').toLowerCase(); for(const g of d.projectGroups||[]) for(const pre of g.prefixes||[]) if(p===pre||p.startsWith(pre)) return g; return null; };
  // Every REGISTERED consumer, plus anything the log has seen, plus anything already ruled. Seen
  // names are collapsed to the consumer (before the ':') — a rule resolves at consumer level, so
  // listing one row per job invited a pin on `promopilot:generatetext` that covers nothing else.
  const registered=Object.keys(state.consumers||{});
  const projNames=[...new Set([...registered,...known.map(p=>String(p).split(':')[0]),...Object.keys(d.projectRoutes||{})]
    .filter(p=>p&&p!=='(none)'))].sort();
  const seenSet=new Set(known.map(p=>String(p).split(':')[0]));
  // Live per-provider catalog — the source for every model picker below (pin + allowlist).
  // claudecode: the reconciled Anthropic catalog. local: caller-facing aliases. crazyrouter:
  // the billing allowlist plus the static seed. Deduped, so a picker never lists nonsense.
  const uniq=a=>[...new Set(a.filter(Boolean))].sort();
  const catalog={
    claudecode: uniq([...(state.claudecodeModels||[]), ...PROJ_MODELS.filter(p=>p.provider==='claudecode').map(p=>p.model)]),
    crazyrouter: uniq([...(state.cloudAllowlist||[]), ...PROJ_MODELS.filter(p=>p.provider==='crazyrouter').map(p=>p.model)]),
    local: uniq([...Object.keys(state.localMap||{}), ...PROJ_MODELS.filter(p=>p.provider==='local').map(p=>p.model)]),
  };
  const catalogOpts=['claudecode','crazyrouter','local'].flatMap(p=>catalog[p].map(model=>({provider:p,model})));

  async function save(){
    const patch={ bases:d.bases, localMap:d.localMap, modelRoutes:d.modelRoutes, projectRoutes:d.projectRoutes, projectGroups:d.projectGroups,
      forceModel:{enabled:d.forceModel.enabled,provider:d.forceModel.provider||'claudecode',model:(d.forceModel.model||'').trim()},
      cloudPolicy:d.cloudPolicy, cloudAllowlist:d.cloudAllowlist, defaultRoute:{provider:d.defaultRoute.provider||'none',model:(d.defaultRoute.model||'').trim()},
      claudePrefix:(d.claudePrefix||'').trim()||'claude', jsonEnforce:d.jsonEnforce, jsonMaxRetries:parseInt(d.jsonMaxRetries||2,10),
      gatedModels:d.gatedModels };
    if(patch.forceModel.enabled && !patch.forceModel.model){toast('force model is on but no model id set',true);return;}
    try{ const r=await api('config',{method:'POST',body:JSON.stringify(patch)}); reload(r.state); toast('saved'+(r.persisted?' & persisted':' (NOT persisted!)'),!r.persisted); }catch(e){toast(e.message,true);}
  }
  async function saveLimits(){
    const projectLimits={}; Object.entries(d.projectLimits||{}).forEach(([k,v])=>{ if(k.trim())projectLimits[k.trim().toLowerCase()]=v; });
    try{ const r=await api('config',{method:'POST',body:JSON.stringify({projectLimits,projectLimitDefault:d.projectLimitDefault})}); reload(r.state); toast('usage limits saved'+(r.persisted?' & persisted':' (NOT persisted!)'),!r.persisted); }catch(e){toast(e.message,true);}
  }
  async function doResolve(){ setResolveOut('…'); try{ const r=await api('resolve',{method:'POST',body:JSON.stringify({model:resIn.trim(),project:resProj.trim()})});
    setResolveOut((r.blocked?`❌ BLOCKED — ${r.why}\n`:`✅ ${r.input||'(empty)'}${r.project?'  [project='+r.project+']':''}  →  provider=${r.provider}  model=${r.sentModel}${r.gated?'  🔒gated':''}\n`)+`reason: ${r.reason}\nupstream: ${r.base}`);
  }catch(e){ setResolveOut('error: '+e.message); } }
  async function resetCfg(){ if(!confirm('Reset all routing/secrets to env defaults? This deletes the saved config file.'))return; try{ const r=await api('reset',{method:'POST'}); reload(r.state); toast('reset to env defaults'); }catch(e){toast(e.message,true);} }

  const stg=state.knownLocalIds||{};
  return html`
  <${PageHead} title="Routing" desc="Where a request goes, and what it is allowed to reach. A per-project rule beats its group, and a group beats the defaults."/>
  <${Card} cls="acc">
    <${CardHead} title="Per-project model"
      hint=${html`<b>Model</b> pins the request and rewrites it. <b>Allowed</b> only restricts, and refuses on a mismatch — it never substitutes. A rule also covers that consumer's jobs (<span class="mono">name:job</span>).`}/>
    <div class="tablewrap"><table><tr><th style="width:32%">Project</th><th style="width:40%">Model (pin)</th><th>Allowed (providers / models)</th></tr>
      ${projNames.length?projNames.map(k=>{ const cur=d.projectRoutes[k]; const grp=(cur&&(cur.provider||cur.block))?null:matchGroup(k);
        const pill=(cur&&(cur.provider||cur.block))?html`<${RulePill} cur=${cur}/>`:(grp?html`<span class="pill ${grp.block?'down':(providerCls[grp.provider]||'')}" title=${'from group '+grp.name}>${grp.block?'blocked':grp.provider} · grp</span>`:html`<${RulePill} cur=${null}/>`);
        const setRule=rule=>{ const pr=clone(d.projectRoutes); if(!rule)delete pr[k]; else pr[k]=rule; set('projectRoutes',pr); };
        return html`<tr><td class="mono">${k}
            ${!state.consumers?.[k]&&html` <${Chip} cls="down" title="seen in the call log but not in the consumer registry">unregistered<//>`}
            ${!seenSet.has(k)&&html` <${Chip} title="registered, no traffic yet">idle<//>`}</td>
          <td><div class="flex"><span style="flex:0 0 104px">${pill}</span>
          ${/* keep any allowlist when the pin changes — they are separate axes of the same rule */''}
          <${RuleSelect} cur=${(cur&&(cur.provider||cur.block))?cur:null} opts=${catalogOpts} onChange=${rule=>{
            const keep=cur?{...(cur.allowProviders?{allowProviders:cur.allowProviders}:{}),...(cur.allowModels?{allowModels:cur.allowModels}:{})}:{};
            const next=rule?{...rule,...(rule.block?{}:keep)}:(Object.keys(keep).length?keep:null); setRule(next); }}/></div></td>
          <td><${AllowCell} cur=${cur} catalog=${catalog} onChange=${setRule}/></td></tr>`;
      }):html`<tr><td colspan="3" class="hint">No projects seen yet. They appear once an app calls the router with a key or an <code>X-Project</code> header.</td></tr>`}
    </table></div>
  </${Card}>

  <${Card} cls="acc">
    <${CardHead} title="Project groups" hint="Bundle projects by name prefix and route or block them together. A per-project model above overrides its group."/>
    <div class="tablewrap"><table><tr><th style="width:22%">Group</th><th style="width:34%">Prefixes</th><th>Model / action</th><th style="width:40px"></th></tr>
      ${(d.projectGroups||[]).length?(d.projectGroups||[]).map((g,i)=>html`<tr>
        <td class="mono">${g.name}</td>
        <td><input class="mono" style="width:100%" value=${(g.prefixes||[]).join(', ')} onChange=${e=>{ const gs=clone(d.projectGroups); gs[i].prefixes=e.target.value.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean); set('projectGroups',gs); }}/></td>
        <td><div class="flex"><span style="flex:0 0 104px"><${RulePill} cur=${g.block?{block:true}:(g.provider?{provider:g.provider,model:g.model}:null)}/></span>
          <${RuleSelect} cur=${g.block?{block:true}:(g.provider?{provider:g.provider,model:g.model}:null)} opts=${catalogOpts} onChange=${rule=>{ const gs=clone(d.projectGroups); const {name,prefixes}=gs[i]; gs[i]=rule?Object.assign({name,prefixes},rule):{name,prefixes,block:false,provider:'',model:''}; set('projectGroups',gs); }}/></div></td>
        <td><span class="x" onClick=${()=>{ const gs=clone(d.projectGroups); gs.splice(i,1); set('projectGroups',gs); }}>✕</span></td>
      </tr>`):html`<tr><td colspan="4" class="hint">No groups yet. Add one below.</td></tr>`}
    </table></div>
    <div class="row" style="margin-top:12px">
      <input placeholder="group name (e.g. seoul)" style="flex:1;min-width:150px" value=${ng.name} onInput=${e=>setNg({...ng,name:e.target.value})}/>
      <input placeholder="prefixes, comma-sep (e.g. seoul:)" style="flex:2;min-width:180px" value=${ng.prefix} onInput=${e=>setNg({...ng,prefix:e.target.value})}/>
      <button class="ghost" style="flex:0 0 auto" onClick=${()=>{ const name=ng.name.trim(); const prefixes=ng.prefix.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean); if(!name){toast('group name required',true);return;} if(!prefixes.length){toast('at least one prefix required',true);return;} if((d.projectGroups||[]).some(g=>g.name.toLowerCase()===name.toLowerCase())){toast('group name already exists',true);return;} set('projectGroups',[...(d.projectGroups||[]),{name,prefixes,block:true}]); setNg({name:'',prefix:''}); toast('added (unsaved) — defaults to block; pick a model, then Save routing'); }}>Add group</button>
    </div>
  </${Card}>

  <${Card} cls="amb">
    <${CardHead} title="Usage limits"
      hint=${html`Cap tokens or calls per project over a rolling window: <b style="color:var(--warn)">warn</b>, then <b style="color:var(--warn)">slow</b>, then <b style="color:var(--danger)">block</b>. Zero means no cap.`}
      actions=${html`<button class="ghost sm" onClick=${saveLimits}>Save usage limits</button>`}/>
    <div class="tablewrap"><table>
      <tr><th style="min-width:150px">Project</th><th>Window</th><th>Token cap</th><th>Call cap</th><th>Warn%</th><th>Slow%</th><th>Slow ms</th><th>At 100%</th><th style="width:40px"></th></tr>
      ${LimRow({name:'default',l:d.projectLimitDefault,isDef:true,onChg:v=>set('projectLimitDefault',v)})}
      ${Object.keys(d.projectLimits||{}).sort().map(k=>LimRow({name:k,l:d.projectLimits[k],isDef:false,
        onChg:v=>{ const pl=clone(d.projectLimits); pl[k]=v; set('projectLimits',pl); },
        onRm:()=>{ const pl=clone(d.projectLimits); delete pl[k]; set('projectLimits',pl); }}))}
    </table></div>
    <div class="row" style="margin-top:12px">
      <input placeholder="project slug (exact, e.g. fb-bot)" style="flex:1;min-width:200px" value=${nl} onInput=${e=>setNl(e.target.value)}/>
      <button class="ghost" style="flex:0 0 auto" onClick=${()=>{ const name=nl.trim().toLowerCase(); if(!name){toast('enter a project slug',true);return;} if((d.projectLimits||{})[name]){toast('that project already has a row',true);return;} const pl=clone(d.projectLimits); pl[name]={window:'24h',tokens:0,calls:0,warnPct:80,slowPct:95,slowMs:1500,hard:'block'}; set('projectLimits',pl); setNl(''); }}>Add project limit</button>
    </div>
  </${Card}>

  <${Card} cls=${d.forceModel.enabled?'amb':''}>
    <${CardHead} title="Force model" hint="Override every request and ignore what the caller asked for."/>
    <div class="row">
      <label class="flex" style="flex:0 0 auto"><input type="checkbox" checked=${!!d.forceModel.enabled} onChange=${e=>set('forceModel',{...d.forceModel,enabled:e.target.checked})}/> force enabled</label>
      <select style="flex:0 0 140px" value=${d.forceModel.provider||'claudecode'} onChange=${e=>set('forceModel',{...d.forceModel,provider:e.target.value})}><option>claudecode</option><option>local</option><option>crazyrouter</option></select>
      <input style="flex:2;min-width:200px" placeholder="model id sent to that provider" value=${d.forceModel.model||''} onInput=${e=>set('forceModel',{...d.forceModel,model:e.target.value})}/>
    </div>
  </${Card}>

  <${Card}>
    <${CardHead} title="No fallback" hint="By design, not by omission."/>
    <p class="hint" style="margin:0">A 429 means the project's pinned account is out of quota; a 5xx means the upstream failed.
    Both reach the caller unchanged. The gateway never re-answers on a different account or provider:
    doing so blows the per-org prompt cache (~12× cost) and hides who spent what. Re-pin the project instead.</p>
  </${Card}>

  <div style="margin:0 0 24px"><button onClick=${save}>Save routing</button></div>

  <details class="adv"><summary>Advanced routing and config</summary>
    <${Card}>
      <${CardHead} title="Resolve / trace" hint="See where a model id goes, without calling it."/>
      <div class="row">
        <input style="flex:2;min-width:200px" placeholder="model name e.g. deepseek-v3" value=${resIn} onInput=${e=>setResIn(e.target.value)}/>
        <input style="flex:1;min-width:140px" placeholder="project (optional)" value=${resProj} onInput=${e=>setResProj(e.target.value)}/>
        <button class="ghost" style="flex:0 0 auto" onClick=${doResolve}>Trace</button>
      </div>
      ${resolveOut!=null&&html`<pre>${resolveOut}</pre>`}
    </${Card}>
    <${Card}>
      <${CardHead} title="Model overrides" hint="Force a specific incoming model id to any provider and model."/>
      <div class="tablewrap"><table><tr><th>Incoming model</th><th>→ provider</th><th>→ sent model</th><th></th></tr>
        ${Object.entries(d.modelRoutes||{}).map(([k,v])=>html`<tr><td class="mono">${k}</td><td><${ProviderPill} provider=${v.provider}/></td><td class="mono">${v.model||'(unchanged)'}</td><td style="width:34px"><span class="x" onClick=${()=>{ const mr=clone(d.modelRoutes); delete mr[k]; set('modelRoutes',mr); }}>✕</span></td></tr>`)}
      </table></div>
      <div class="row" style="margin-top:12px">
        <input placeholder="incoming e.g. deepseek-v3" style="min-width:180px" value=${nr.in} onInput=${e=>setNr({...nr,in:e.target.value})}/>
        <select style="flex:0 0 130px" value=${nr.provider} onChange=${e=>setNr({...nr,provider:e.target.value})}><option>claudecode</option><option>local</option><option>crazyrouter</option></select>
        <input placeholder="sent model id" style="min-width:180px" value=${nr.model} onInput=${e=>setNr({...nr,model:e.target.value})}/>
        <button class="ghost sm" style="flex:0 0 auto" onClick=${()=>{ const k=nr.in.trim().toLowerCase(); if(!k){toast('incoming model required',true);return;} const mr=clone(d.modelRoutes); mr[k]={provider:nr.provider,model:nr.model.trim()}; set('modelRoutes',mr); setNr({in:'',provider:nr.provider,model:''}); }}>Add</button>
      </div>
    </${Card}>
    <${Card}>
      <${CardHead} title="Crazyrouter policy" hint="The only provider that bills per token."/>
      <div class="row" style="gap:18px">
        ${['open','allowlist','off'].map(v=>html`<label class="flex" style="flex:0 0 auto"><input type="radio" name="cp" checked=${d.cloudPolicy===v} onChange=${()=>set('cloudPolicy',v)}/> ${v==='open'?'open (forward anything)':v==='allowlist'?'allowlist only':'off (block crazyrouter)'}</label>`)}
      </div>
      <label>Crazyrouter allowlist <small class="hint">comma-separated model ids</small></label>
      <input placeholder="gemini-2.5-flash-lite, gpt-5.5, …" value=${(d.cloudAllowlist||[]).join(', ')} onInput=${e=>set('cloudAllowlist',e.target.value.split(',').map(x=>x.trim()).filter(Boolean))}/>
      <label>Default route <small class="hint">for unknown, empty or blocked models. Provider <code>none</code> rejects with 400.</small></label>
      <div class="row">
        <select style="flex:0 0 140px" value=${d.defaultRoute.provider||'none'} onChange=${e=>set('defaultRoute',{...d.defaultRoute,provider:e.target.value})}><option>none</option><option>claudecode</option><option>local</option><option>crazyrouter</option></select>
        <input placeholder="default model id (when provider ≠ none)" style="min-width:200px" value=${d.defaultRoute.model||''} onInput=${e=>set('defaultRoute',{...d.defaultRoute,model:e.target.value})}/>
      </div>
    </${Card}>
    <${Card}>
      <${CardHead} title="Local model aliases" hint=${html`Caller <code>model</code> → the exact id sent to the local llama.cpp server.`}/>
      <div class="tablewrap"><table><tr><th>Alias</th><th>→ Upstream id</th><th>gated?</th><th></th></tr>
        ${Object.entries(d.localMap||{}).map(([a,tg])=>html`<tr><td class="mono">${a}</td><td class="mono">${tg}</td><td>${(d.gatedModels||[]).includes(tg)?html`<${Pill} cls="warnp">gated<//>`:''}</td><td style="width:34px"><span class="x" onClick=${()=>{ const lm=clone(d.localMap); delete lm[a]; set('localMap',lm); }}>✕</span></td></tr>`)}
      </table></div>
      <div class="row" style="margin-top:12px">
        <input placeholder="alias e.g. local" style="min-width:160px" value=${na.alias} onInput=${e=>setNa({...na,alias:e.target.value})}/>
        <input placeholder="upstream id e.g. gemma-4-e4b-it-obliterated" style="min-width:220px" value=${na.target} onInput=${e=>setNa({...na,target:e.target.value})}/>
        <button class="ghost sm" style="flex:0 0 auto" onClick=${()=>{ const a=na.alias.trim().toLowerCase(),tg=na.target.trim(); if(!a||!tg){toast('alias and target required',true);return;} const lm=clone(d.localMap); lm[a]=tg; set('localMap',lm); setNa({alias:'',target:''}); }}>Add</button>
      </div>
      <small class="hint" style="display:block;margin-top:10px">Known local ids: e4b <code>${stg.e4b}</code> · gemma <code>${stg.gemma}</code> · obliterated <code>${stg.obliterated}</code></small>
    </${Card}>
    <${Card}>
      <${CardHead} title="Provider base URLs"/>
      <label style="margin-top:0">local provider (llama.cpp @ pbox GPU)</label><input value=${d.bases.local} onInput=${e=>set('bases',{...d.bases,local:e.target.value})}/>
      <label>crazyrouter provider</label><input value=${d.bases.crazyrouter} onInput=${e=>set('bases',{...d.bases,crazyrouter:e.target.value})}/>
      <label>claudecode provider <small class="hint">the real Anthropic API; the account token is injected per project</small></label><input value=${d.bases.claudecode} onInput=${e=>set('bases',{...d.bases,claudecode:e.target.value})}/>
      <label>claudecode prefix <small class="hint">models starting with this route to claudecode (default <code>claude</code>)</small></label><input value=${d.claudePrefix||''} onInput=${e=>set('claudePrefix',e.target.value)}/>
    </${Card}>
    <${Card}>
      <${CardHead} title="Structured / JSON output enforcement"/>
      <div class="row">
        <label class="flex" style="flex:0 0 auto"><input type="checkbox" checked=${!!d.jsonEnforce} onChange=${e=>set('jsonEnforce',e.target.checked)}/> enabled</label>
        <div style="flex:0 0 auto"><label style="margin:0 0 4px">max retries</label><input type="number" min="0" max="5" style="width:90px" value=${d.jsonMaxRetries} onInput=${e=>set('jsonMaxRetries',e.target.value)}/></div>
      </div>
      <label>Gated upstream model ids <small class="hint">these require the obliterated gate token</small></label>
      <input value=${(d.gatedModels||[]).join(', ')} onInput=${e=>set('gatedModels',e.target.value.split(',').map(x=>x.trim()).filter(Boolean))}/>
    </${Card}>
    <button class="danger" onClick=${resetCfg}>Reset to env defaults</button>
  </details>`;
}
function LimRow({name,l,isDef,onChg,onRm}){
  const g=(f,v)=>onChg({...l,[f]:v});
  const num=(f,w)=>html`<input type="number" min="0" style="width:${w}" value=${l[f]??0} onInput=${e=>g(f,+e.target.value||0)}/>`;
  return html`<tr>
    ${isDef?html`<td><b>Default</b><div class="hint" style="font-size:11px">all attributed projects</div></td>`:html`<td class="mono">${name}</td>`}
    <td><select value=${l.window||'24h'} onChange=${e=>g('window',e.target.value)}>${LIM_WINDOWS.map(w=>html`<option>${w}</option>`)}</select></td>
    <td>${num('tokens','100px')}</td><td>${num('calls','78px')}</td>
    <td><input type="number" min="0" max="100" style="width:50px" value=${l.warnPct??80} onInput=${e=>g('warnPct',+e.target.value||0)}/></td>
    <td><input type="number" min="0" max="100" style="width:50px" value=${l.slowPct??95} onInput=${e=>g('slowPct',+e.target.value||0)}/></td>
    <td>${num('slowMs','62px')}</td>
    <td><select value=${l.hard||'block'} onChange=${e=>g('hard',e.target.value)}>${LIM_HARD.map(([v,lb])=>html`<option value=${v}>${lb}</option>`)}</select></td>
    <td>${isDef?'':html`<span class="x" onClick=${onRm}>✕</span>`}</td>
  </tr>`;
}


export { PROJ_MODELS, BLOCK_VAL, valToRule, ruleToVal, RulePill, RuleSelect, AllowCell, LIM_WINDOWS, LIM_HARD, Routing, LimRow };
