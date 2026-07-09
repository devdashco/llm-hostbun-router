import { html, useState, useEffect, api, toast, clone, providerCls, Pill, ProviderPill, Card, PageHead, useApp } from "../core.js";

/* ───────── ROUTING ───────── */
const PROJ_MODELS=[
  {provider:'claudecode',model:'claude-sonnet-4-6'},{provider:'claudecode',model:'claude-opus-4-8'},{provider:'claudecode',model:'claude-haiku-4-5-20251001'},
  {provider:'crazyrouter',model:'gemini-2.5-flash-lite'},{provider:'crazyrouter',model:'gemini-2.5-flash'},{provider:'crazyrouter',model:'gemini-2.5-pro'},
  {provider:'local',model:'gemma-4-e4b-it-obliterated'},{provider:'local',model:'google/gemma-4-26b-a4b'},
];
const BLOCK_VAL='__block__';
const valToRule=v=>{ if(!v)return null; if(v===BLOCK_VAL)return{block:true}; const [provider,...rest]=v.split('|'); return{provider,model:rest.join('|')}; };
const ruleToVal=cur=>(cur&&!cur.block)?`${cur.provider}|${cur.model}`:(cur&&cur.block?BLOCK_VAL:'');
function RulePill({cur}){ if(cur&&cur.block)return html`<${Pill} cls="down">🚫 blocked<//>`; if(cur)return html`<${ProviderPill} provider=${cur.provider}/>`; return html`<span class="pill mut" style="opacity:.5">auto</span>`; }
function RuleSelect({cur,onChange}){
  const sel=ruleToVal(cur); const extra=(cur&&!cur.block&&!PROJ_MODELS.some(p=>p.provider===cur.provider&&p.model===cur.model));
  return html`<select value=${sel} onChange=${e=>onChange(valToRule(e.target.value))} style="flex:1">
    <option value="">— auto (normal routing) —</option>
    <option value=${BLOCK_VAL}>🚫 block — reject (0 tokens)</option>
    ${extra&&html`<option value=${sel}>${cur.provider}: ${cur.model||"(keep caller's)"}</option>`}
    ${PROJ_MODELS.map(p=>{const v=`${p.provider}|${p.model}`; return html`<option value=${v}>${p.provider}: ${p.model}</option>`;})}
  </select>`;
}
/* Allowlist editor. Independent of the pin: the pin rewrites, the allowlist only refuses.
   Empty = no restriction (never "nothing allowed"). Edits the same rule object the pin lives in. */
function AllowCell({cur,models,onChange}){
  const [open,setOpen]=useState(false);
  const ap=(cur&&cur.allowProviders)||[], am=(cur&&cur.allowModels)||[];
  const blocked=cur&&cur.block;
  const emit=patch=>{ const next={...(cur||{}),...patch};
    ['allowProviders','allowModels'].forEach(k=>{ if(!next[k]||!next[k].length) delete next[k]; });
    onChange((next.provider||next.block||next.allowProviders||next.allowModels)?next:null); };
  const toggleP=p=>emit({allowProviders:ap.includes(p)?ap.filter(x=>x!==p):[...ap,p]});
  const summary=blocked?'—':(!ap.length&&!am.length)?'any':[ap.length&&`${ap.length} provider${ap.length>1?'s':''}`,am.length&&`${am.length} model${am.length>1?'s':''}`].filter(Boolean).join(' · ');
  if(blocked) return html`<span class="hint">blocked — nothing runs</span>`;
  return html`<div>
    <button class="ghost" style="font-size:12px" onClick=${()=>setOpen(!open)}>${open?'▾':'▸'} ${summary}</button>
    ${open&&html`<div style="margin-top:6px;padding:8px;border:1px solid var(--bd,#333);border-radius:6px;min-width:220px">
      <div style="display:flex;gap:14px;flex-wrap:wrap">
        ${['claudecode','crazyrouter','local'].map(p=>html`<label style="font-size:12px;display:inline-flex;gap:5px;align-items:center;white-space:nowrap">
          <input type="checkbox" style="width:auto;margin:0;flex:0 0 auto" checked=${ap.includes(p)} onChange=${()=>toggleP(p)}/>${p}</label>`)}
      </div>
      <input class="mono" style="width:100%;margin-top:8px;font-size:12px;box-sizing:border-box" placeholder="allowed model ids, comma-sep — empty = any"
        value=${am.join(', ')} onChange=${e=>emit({allowModels:e.target.value.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)})}
        list="allow-models"/>
      <datalist id="allow-models">${models.map(m=>html`<option value=${m}/>`)}</datalist>
      <small class="hint">Empty = no restriction. A call that resolves outside the list is rejected, never rewritten.</small>
    </div>`}
  </div>`;
}
const LIM_WINDOWS=['1h','6h','24h','7d','30d'];
const LIM_HARD=[['block','🚫 block 429'],['slow','🐢 slow only'],['warn','⚠ warn only']];
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
  const allModels=[...new Set([...(state.claudecodeModels||[]),...Object.values(state.localMap||{}),...(state.gatedModels||[]),
    ...PROJ_MODELS.map(p=>p.model)])].sort();

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
  <${PageHead} title="Routing & flow control"/>
  <${Card} cls="acc">
    <h3 style="font-size:16px">🎯 Per-project model <small class="hint">— <b>Model</b> pins (rewrites). <b>Allowed</b> restricts (rejects). <b>Auto</b> = normal routing, <b>🚫 Block</b> = reject all. A rule also covers that consumer's jobs (<span class="mono">name:job</span>). Beats groups + everything below.</small></h3>
    <table><tr><th style="width:32%">Project</th><th style="width:40%">Model (pin)</th><th>Allowed (providers / models)</th></tr>
      ${projNames.length?projNames.map(k=>{ const cur=d.projectRoutes[k]; const grp=(cur&&(cur.provider||cur.block))?null:matchGroup(k);
        const pill=(cur&&(cur.provider||cur.block))?html`<${RulePill} cur=${cur}/>`:(grp?html`<span class="pill ${grp.block?'down':(providerCls[grp.provider]||'')}" title=${'from group '+grp.name}>${grp.block?'🚫':grp.provider} ·grp</span>`:html`<${RulePill} cur=${null}/>`);
        const setRule=rule=>{ const pr=clone(d.projectRoutes); if(!rule)delete pr[k]; else pr[k]=rule; set('projectRoutes',pr); };
        return html`<tr><td class="mono">${k}
            ${!state.consumers?.[k]&&html` <span class="chip" title="seen in the call log but not in the consumer registry">unregistered</span>`}
            ${!seenSet.has(k)&&html` <span class="chip mut" title="registered, no traffic yet">idle</span>`}</td>
          <td><div class="flex"><span style="flex:0 0 96px">${pill}</span>
          ${/* keep any allowlist when the pin changes — they are separate axes of the same rule */''}
          <${RuleSelect} cur=${(cur&&(cur.provider||cur.block))?cur:null} onChange=${rule=>{
            const keep=cur?{...(cur.allowProviders?{allowProviders:cur.allowProviders}:{}),...(cur.allowModels?{allowModels:cur.allowModels}:{})}:{};
            const next=rule?{...rule,...(rule.block?{}:keep)}:(Object.keys(keep).length?keep:null); setRule(next); }}/></div></td>
          <td><${AllowCell} cur=${cur} models=${allModels} onChange=${setRule}/></td></tr>`;
      }):html`<tr><td colspan="3" class="mut">no projects seen yet — they appear once apps send an X-Project header</td></tr>`}
    </table>
  </${Card}>

  <${Card} cls="acc">
    <h3 style="font-size:16px">👥 Project groups <small class="hint">— bundle projects by name prefix and route/<b>block</b> together. A per-project model above overrides its group.</small></h3>
    <table><tr><th style="width:22%">Group</th><th style="width:34%">Prefixes</th><th>Model / action</th><th style="width:40px"></th></tr>
      ${(d.projectGroups||[]).length?(d.projectGroups||[]).map((g,i)=>html`<tr>
        <td class="mono">${g.name}</td>
        <td><input class="mono" style="width:100%" value=${(g.prefixes||[]).join(', ')} onChange=${e=>{ const gs=clone(d.projectGroups); gs[i].prefixes=e.target.value.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean); set('projectGroups',gs); }}/></td>
        <td><div class="flex"><span style="flex:0 0 96px"><${RulePill} cur=${g.block?{block:true}:(g.provider?{provider:g.provider,model:g.model}:null)}/></span>
          <${RuleSelect} cur=${g.block?{block:true}:(g.provider?{provider:g.provider,model:g.model}:null)} onChange=${rule=>{ const gs=clone(d.projectGroups); const {name,prefixes}=gs[i]; gs[i]=rule?Object.assign({name,prefixes},rule):{name,prefixes,block:false,provider:'',model:''}; set('projectGroups',gs); }}/></div></td>
        <td><button class="ghost" onClick=${()=>{ const gs=clone(d.projectGroups); gs.splice(i,1); set('projectGroups',gs); }}>✕</button></td>
      </tr>`):html`<tr><td colspan="4" class="mut">no groups — add one below</td></tr>`}
    </table>
    <div class="row" style="margin-top:8px">
      <input placeholder="group name (e.g. seoul)" style="flex:1" value=${ng.name} onInput=${e=>setNg({...ng,name:e.target.value})}/>
      <input placeholder="prefixes, comma-sep (e.g. seoul:)" style="flex:2" value=${ng.prefix} onInput=${e=>setNg({...ng,prefix:e.target.value})}/>
      <button style="flex:0 0 auto" onClick=${()=>{ const name=ng.name.trim(); const prefixes=ng.prefix.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean); if(!name){toast('group name required',true);return;} if(!prefixes.length){toast('at least one prefix required',true);return;} if((d.projectGroups||[]).some(g=>g.name.toLowerCase()===name.toLowerCase())){toast('group name already exists',true);return;} set('projectGroups',[...(d.projectGroups||[]),{name,prefixes,block:true}]); setNg({name:'',prefix:''}); toast('added (unsaved) — defaults to 🚫 block; pick a model then Save'); }}>+ add group</button>
    </div>
  </${Card}>

  <${Card} cls="amb">
    <h3 style="font-size:16px">📊 Usage limits <small class="hint">— cap tokens/calls per project over a rolling window: <b style="color:var(--amb)">warn</b> → <b style="color:var(--amb)">slow</b> → <b style="color:var(--red)">block</b>. 0 = no cap.</small></h3>
    <div style="overflow:auto"><table>
      <tr><th style="min-width:150px">Project</th><th>Window</th><th>Token cap</th><th>Call cap</th><th>Warn%</th><th>Slow%</th><th>Slow ms</th><th>At 100%</th><th style="width:40px"></th></tr>
      ${LimRow({name:'★ default',l:d.projectLimitDefault,isDef:true,onChg:v=>set('projectLimitDefault',v)})}
      ${Object.keys(d.projectLimits||{}).sort().map(k=>LimRow({name:k,l:d.projectLimits[k],isDef:false,
        onChg:v=>{ const pl=clone(d.projectLimits); pl[k]=v; set('projectLimits',pl); },
        onRm:()=>{ const pl=clone(d.projectLimits); delete pl[k]; set('projectLimits',pl); }}))}
    </table></div>
    <div class="row" style="margin-top:8px;align-items:center">
      <input placeholder="project slug (exact, e.g. fb-bot)" style="flex:1" value=${nl} onInput=${e=>setNl(e.target.value)}/>
      <button style="flex:0 0 auto" onClick=${()=>{ const name=nl.trim().toLowerCase(); if(!name){toast('enter a project slug',true);return;} if((d.projectLimits||{})[name]){toast('that project already has a row',true);return;} const pl=clone(d.projectLimits); pl[name]={window:'24h',tokens:0,calls:0,warnPct:80,slowPct:95,slowMs:1500,hard:'block'}; set('projectLimits',pl); setNl(''); }}>+ add project limit</button>
      <span style="flex:1"></span>
      <button style="flex:0 0 auto" onClick=${saveLimits}>Save usage limits</button>
    </div>
  </${Card}>

  <${Card} cls="amb">
    <h3 style="color:var(--amb)">⏻ Force model <small class="hint">— override EVERY request, ignore what the caller asks for</small></h3>
    <div class="row">
      <label class="flex" style="flex:0 0 auto"><input type="checkbox" checked=${!!d.forceModel.enabled} onChange=${e=>set('forceModel',{...d.forceModel,enabled:e.target.checked})} style="width:auto;margin-right:8px"/> force enabled</label>
      <select style="flex:0 0 140px" value=${d.forceModel.provider||'claudecode'} onChange=${e=>set('forceModel',{...d.forceModel,provider:e.target.value})}><option>claudecode</option><option>local</option><option>crazyrouter</option></select>
      <input style="flex:2" placeholder="model id sent to that provider" value=${d.forceModel.model||''} onInput=${e=>set('forceModel',{...d.forceModel,model:e.target.value})}/>
    </div>
  </${Card}>

  <${Card}>
    <h3>🚫 No fallback <small class="hint">— by design, not by omission</small></h3>
    <small class="hint">A 429 means the project's pinned account is out of quota; a 5xx means the upstream failed.
    Both reach the caller unchanged. The gateway never re-answers on a different account or provider —
    doing so blows the per-org prompt cache (~12× cost) and hides who spent what. Re-pin the project instead.</small>
  </${Card}>

  <div style="margin:14px 0 4px"><button onClick=${save}>Save routing</button></div>

  <details class="adv"><summary>Advanced routing &amp; config</summary>
    <${Card}>
      <h3>🔎 Resolve / trace <small class="hint">— see where a model goes, without calling it</small></h3>
      <div class="row">
        <input style="flex:2" placeholder="model name e.g. deepseek-v3" value=${resIn} onInput=${e=>setResIn(e.target.value)}/>
        <input style="flex:1" placeholder="project (optional)" value=${resProj} onInput=${e=>setResProj(e.target.value)}/>
        <button class="ghost" style="flex:0 0 auto" onClick=${doResolve}>Trace</button>
      </div>
      ${resolveOut!=null&&html`<pre>${resolveOut}</pre>`}
    </${Card}>
    <${Card}>
      <h3>↪ Model overrides <small class="hint">— force a specific incoming model to ANY provider + model</small></h3>
      <table><tr><th>Incoming model</th><th>→ provider</th><th>→ sent model</th><th></th></tr>
        ${Object.entries(d.modelRoutes||{}).map(([k,v])=>html`<tr><td class="mono">${k}</td><td><${ProviderPill} provider=${v.provider}/></td><td class="mono">${v.model||'(unchanged)'}</td><td style="width:34px"><span class="x" onClick=${()=>{ const mr=clone(d.modelRoutes); delete mr[k]; set('modelRoutes',mr); }}>✕</span></td></tr>`)}
      </table>
      <div class="row" style="margin-top:8px">
        <input placeholder="incoming e.g. deepseek-v3" value=${nr.in} onInput=${e=>setNr({...nr,in:e.target.value})}/>
        <select style="flex:0 0 130px" value=${nr.provider} onChange=${e=>setNr({...nr,provider:e.target.value})}><option>claudecode</option><option>local</option><option>crazyrouter</option></select>
        <input placeholder="sent model id" value=${nr.model} onInput=${e=>setNr({...nr,model:e.target.value})}/>
        <button class="ghost sm" style="flex:0 0 auto" onClick=${()=>{ const k=nr.in.trim().toLowerCase(); if(!k){toast('incoming model required',true);return;} const mr=clone(d.modelRoutes); mr[k]={provider:nr.provider,model:nr.model.trim()}; set('modelRoutes',mr); setNr({in:'',provider:nr.provider,model:''}); }}>+ Add</button>
      </div>
    </${Card}>
    <${Card}>
      <h3>☁ Crazyrouter policy</h3>
      <div class="row" style="gap:18px">
        ${['open','allowlist','off'].map(v=>html`<label class="flex" style="flex:0 0 auto"><input type="radio" name="cp" checked=${d.cloudPolicy===v} onChange=${()=>set('cloudPolicy',v)} style="width:auto;margin-right:6px"/> ${v==='open'?'open (forward anything)':v==='allowlist'?'allowlist only':'off (block crazyrouter)'}</label>`)}
      </div>
      <label>crazyrouter allowlist <small class="hint">(comma-separated model ids)</small></label>
      <input placeholder="gemini-2.5-flash-lite, gpt-5.5, …" value=${(d.cloudAllowlist||[]).join(', ')} onInput=${e=>set('cloudAllowlist',e.target.value.split(',').map(x=>x.trim()).filter(Boolean))}/>
      <h3 style="margin-top:14px">Default route <small class="hint">— for unknown/empty/blocked models. provider <code>none</code> = reject 400.</small></h3>
      <div class="row">
        <select style="flex:0 0 140px" value=${d.defaultRoute.provider||'none'} onChange=${e=>set('defaultRoute',{...d.defaultRoute,provider:e.target.value})}><option>none</option><option>claudecode</option><option>local</option><option>crazyrouter</option></select>
        <input placeholder="default model id (when provider ≠ none)" value=${d.defaultRoute.model||''} onInput=${e=>set('defaultRoute',{...d.defaultRoute,model:e.target.value})}/>
      </div>
    </${Card}>
    <${Card}>
      <h3>Local model aliases <small class="hint">— caller <code>model</code> → exact id sent to the local llama.cpp server</small></h3>
      <table><tr><th>Alias</th><th>→ Upstream id</th><th>gated?</th><th></th></tr>
        ${Object.entries(d.localMap||{}).map(([a,tg])=>html`<tr><td class="mono">${a}</td><td class="mono">${tg}</td><td>${(d.gatedModels||[]).includes(tg)?html`<${Pill} cls="warnp">🔒<//>`:''}</td><td style="width:34px"><span class="x" onClick=${()=>{ const lm=clone(d.localMap); delete lm[a]; set('localMap',lm); }}>✕</span></td></tr>`)}
      </table>
      <div class="row" style="margin-top:8px">
        <input placeholder="alias e.g. local" value=${na.alias} onInput=${e=>setNa({...na,alias:e.target.value})}/>
        <input placeholder="upstream id e.g. gemma-4-e4b-it-obliterated" value=${na.target} onInput=${e=>setNa({...na,target:e.target.value})}/>
        <button class="ghost sm" style="flex:0 0 auto" onClick=${()=>{ const a=na.alias.trim().toLowerCase(),tg=na.target.trim(); if(!a||!tg){toast('alias and target required',true);return;} const lm=clone(d.localMap); lm[a]=tg; set('localMap',lm); setNa({alias:'',target:''}); }}>+ Add</button>
      </div>
      <small class="hint">Known local ids: e4b <code>${stg.e4b}</code> · gemma <code>${stg.gemma}</code> · obliterated <code>${stg.obliterated}</code></small>
    </${Card}>
    <${Card}>
      <h3>Provider base URLs</h3>
      <label>local provider (llama.cpp @ pbox GPU)</label><input value=${d.bases.local} onInput=${e=>set('bases',{...d.bases,local:e.target.value})}/>
      <label>crazyrouter provider</label><input value=${d.bases.crazyrouter} onInput=${e=>set('bases',{...d.bases,crazyrouter:e.target.value})}/>
      <label>claudecode provider (real Anthropic API — account token injected per project)</label><input value=${d.bases.claudecode} onInput=${e=>set('bases',{...d.bases,claudecode:e.target.value})}/>
      <label>claudecode prefix <small class="hint">— models starting with this route to claudecode (default <code>claude</code>)</small></label><input value=${d.claudePrefix||''} onInput=${e=>set('claudePrefix',e.target.value)}/>
    </${Card}>
    <${Card}>
      <h3>Structured / JSON output enforcement</h3>
      <div class="row">
        <label class="flex" style="flex:0 0 auto"><input type="checkbox" checked=${!!d.jsonEnforce} onChange=${e=>set('jsonEnforce',e.target.checked)} style="width:auto;margin-right:8px"/> enabled</label>
        <div style="flex:0 0 auto"><label style="margin:0">max retries</label><input type="number" min="0" max="5" style="width:90px" value=${d.jsonMaxRetries} onInput=${e=>set('jsonMaxRetries',e.target.value)}/></div>
      </div>
      <label>Gated upstream model ids <small class="hint">— require the obliterated gate token</small></label>
      <input value=${(d.gatedModels||[]).join(', ')} onInput=${e=>set('gatedModels',e.target.value.split(',').map(x=>x.trim()).filter(Boolean))}/>
    </${Card}>
    <button class="danger" onClick=${resetCfg}>Reset to env defaults</button>
  </details>`;
}
function LimRow({name,l,isDef,onChg,onRm}){
  const g=(f,v)=>onChg({...l,[f]:v});
  const num=(f,w)=>html`<input type="number" min="0" style="width:${w}" value=${l[f]??0} onInput=${e=>g(f,+e.target.value||0)}/>`;
  return html`<tr>
    ${isDef?html`<td><b>★ default</b><div class="hint">all attributed projects</div></td>`:html`<td class="mono">${name}</td>`}
    <td><select value=${l.window||'24h'} onChange=${e=>g('window',e.target.value)}>${LIM_WINDOWS.map(w=>html`<option>${w}</option>`)}</select></td>
    <td>${num('tokens','100px')}</td><td>${num('calls','78px')}</td>
    <td><input type="number" min="0" max="100" style="width:50px" value=${l.warnPct??80} onInput=${e=>g('warnPct',+e.target.value||0)}/></td>
    <td><input type="number" min="0" max="100" style="width:50px" value=${l.slowPct??95} onInput=${e=>g('slowPct',+e.target.value||0)}/></td>
    <td>${num('slowMs','62px')}</td>
    <td><select value=${l.hard||'block'} onChange=${e=>g('hard',e.target.value)}>${LIM_HARD.map(([v,lb])=>html`<option value=${v}>${lb}</option>`)}</select></td>
    <td>${isDef?'':html`<button class="ghost" onClick=${onRm}>✕</button>`}</td>
  </tr>`;
}


export { PROJ_MODELS, BLOCK_VAL, valToRule, ruleToVal, RulePill, RuleSelect, AllowCell, LIM_WINDOWS, LIM_HARD, Routing, LimRow };
