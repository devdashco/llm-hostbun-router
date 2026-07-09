import { html, h, useState, useEffect, useCallback, api, toast, nfmt, ago, Card, PageHead, useApp } from "../core.js";

/* ───────── CONSUMERS: the registry, and what each one costs ─────────
   A consumer is WHO calls. Two kinds, and they are not the same thing:
     dev — a person's machine (or a daemon on it). Has an owner: a human.
     app — code we deployed. Has NO owner.
   Identity is a path, `<consumer>:<job>`. Only the consumer is registered; jobs are free. */
const KindPill=({kind})=>{
  const m={dev:['#2a3350','#8fa8ff','dev'],app:['#2a3a2a','#8bc88b','app'],unregistered:['#3a2a2a','#e08c8c','unregistered']}[kind]||['#2a2a30','#a1a1aa',kind];
  return html`<span class="pill" style=${`background:${m[0]};color:${m[1]}`}>${m[2]}</span>`;
};
const USAGE_WINDOWS=[['1h','1h'],['24h','24h'],['7d','7d'],['30d','30d']];

function Consumers(){
  const {state,reload}=useApp();
  const [reg,setReg]=useState(null); const [u,setU]=useState(null); const [err,setErr]=useState('');
  const [win,setWin]=useState('24h'); const [busy,setBusy]=useState('');
  const [nn,setNn]=useState(''); const [nk,setNk]=useState('app'); const [no,setNo]=useState('');
  const [open,setOpen]=useState({}); const [issued,setIssued]=useState(null);
  const load=useCallback(async()=>{
    try{ const [a,b]=await Promise.all([api('consumers'),api('usage?win='+win)]); setReg(a); setU(b); setErr(''); }
    catch(e){ setErr(e.message||'load failed'); }
  },[win]);
  useEffect(()=>{ load(); },[load]);
  const mode=(reg&&reg.authMode)||'optional';
  const keyless=(reg&&reg.keyless)||[];
  // Issuing a key IS registering: for a brand-new consumer the same call creates it, so `kind`
  // (and an owner, if dev) must ride along. For an existing one the server ignores them.
  async function issueKey(name,kind,owner){
    setBusy(name);
    try{ const r=await api('consumers/keys',{method:'POST',body:JSON.stringify({name,kind,owner:kind==='dev'?owner:undefined})});
      setIssued(r); await load(); reload(); window.scrollTo({top:0,behavior:'smooth'});
    }catch(e){ toast(e.message,true); } finally{ setBusy(''); }
  }
  async function revokeKey(name,id){
    if(!confirm(`Revoke key ${id} for "${name}"? Any caller using it starts getting 401 immediately.`))return;
    setBusy(name);
    try{ await api('consumers/keys/revoke',{method:'POST',body:JSON.stringify({name,id})}); toast(`key ${id} revoked`); await load(); }
    catch(e){ toast(e.message,true); } finally{ setBusy(''); }
  }
  async function setMode(m){
    if(m==='required'&&keyless.length&&!confirm(`${keyless.length} registered consumer(s) hold NO key:\n\n${keyless.map(x=>'  '+x).join('\n')}\n\nIn "required" mode every one of them gets 401 on the next call. Issue their keys first.\n\nSwitch anyway?`))return;
    setBusy('mode');
    try{ await api('auth',{method:'POST',body:JSON.stringify({mode:m})});
      toast(m==='required'?'auth required — un-keyed callers now 401':`auth mode: ${m}`); await load(); reload();
    }catch(e){ toast(e.message,true); } finally{ setBusy(''); }
  }
  async function save(name,kind,owner,note){
    setBusy(name);
    try{ await api('consumers',{method:'POST',body:JSON.stringify({name,kind,owner:kind==='dev'?owner:undefined,note})});
      toast(`${name} registered as ${kind}`); await load(); reload();
    }catch(e){ toast(e.message,true); } finally{ setBusy(''); }
  }
  async function remove(name){
    if(!confirm(`Unregister "${name}"? If enforcement is on, its calls start failing with 403 unknown_consumer.`))return;
    setBusy(name);
    try{ await api('consumers',{method:'POST',body:JSON.stringify({name,remove:true})}); toast(`${name} unregistered`); await load(); reload(); }
    catch(e){ toast(e.message,true); } finally{ setBusy(''); }
  }
  async function enforce(on){
    const unreg=(reg&&reg.unregistered)||[];
    if(on&&unreg.length&&!confirm(`${unreg.length} consumer(s) in the log are NOT registered:\n\n${unreg.map(x=>'  '+x.name+' ('+x.calls+' calls)').join('\n')}\n\nTurning enforcement on makes every one of them fail with 403. Continue?`))return;
    setBusy('enforce');
    try{ await api('consumers/enforce',{method:'POST',body:JSON.stringify({enabled:on})});
      toast(on?'enforcing — unregistered consumers now 403':'enforcement off'); await load(); reload();
    }catch(e){ toast(e.message,true); } finally{ setBusy(''); }
  }
  async function add(){
    const n=nn.trim().toLowerCase();
    if(!n){toast('name required',true);return;}
    if(n.includes(':')){toast('a key belongs to the consumer, not the job — drop the ":" part',true);return;}
    if(nk==='dev'&&!no.trim()){toast('a dev is someone’s machine — owner required',true);return;}
    await issueKey(n,nk,no.trim()); setNn(''); setNo('');
  }
  const ago=ts=>{ if(!ts)return 'never'; const m=(Date.now()-ts)/60000; return m<1?'now':m<60?Math.round(m)+'m':m<1440?Math.round(m/60)+'h':Math.round(m/1440)+'d'; };
  const unreg=(reg&&reg.unregistered)||[], regd=(reg&&reg.registered)||[];
  const kindOf=k=>(u&&u.byKind.find(x=>x.key===k))||{calls:0,tokens:0};
  return html`
  <${PageHead} title="Consumers — who calls, and what it costs" onRefresh=${load}/>
  ${err?html`<${Card}><p class="down">${err}</p></${Card}>`:''}

  ${issued?html`<${Card} style="border-color:var(--grn)">
    <h3 style="margin:0 0 6px">🔑 Key issued for <span class="mono">${issued.consumer}</span></h3>
    <p class="hint" style="margin:0 0 10px"><b class="warnp">This is the only time it is shown.</b> Only its sha256 is stored. Put it in keyvault now.</p>
    <div class="msgbox mono" style="user-select:all;word-break:break-all;font-size:13px">${issued.key}</div>
    <div class="flex" style="gap:8px;margin-top:10px">
      <button onClick=${()=>{navigator.clipboard.writeText(issued.key);toast('key copied');}}>Copy</button>
      <button class="ghost" onClick=${()=>setIssued(null)}>I have stored it</button>
    </div>
    <small class="hint" style="display:block;margin-top:10px">Use it the way every OpenAI client already does:
      <code>Authorization: Bearer ${issued.key.slice(0,16)}…</code> — or <code>x-api-key</code> for the native Anthropic endpoint. No <code>X-Project</code> header needed; the key says who you are.</small>
  </${Card}>`:''}

  <${Card}>
    <div class="flex" style="justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">Authentication</h3>
      <div class="flex" style="gap:4px">
        ${[['off','off'],['optional','optional'],['required','required']].map(([v,l])=>html`
          <button class=${mode===v?'sm':'ghost sm'} disabled=${busy==='mode'} onClick=${()=>setMode(v)}>${l}</button>`)}
      </div>
    </div>
    <p class="hint" style="margin:8px 0 0">
      <code>off</code> — keys ignored; <code>X-Project</code> is the only identity.<br/>
      <code>optional</code> — a valid key wins and is trusted; no key falls back to the header. <b>Migration mode.</b> A key that is presented and is <i>bad</i> is always a 401.<br/>
      <code>required</code> — no valid key, no service. This is the mode where the self-asserted header stops being an identity and becomes a mere label.
    </p>
    ${mode!=='required'?html`<p class="warnp" style="margin:10px 0 0"><b>The inference endpoints are open.</b> Anyone who can reach <code>llm.hostbun.cc</code> can spend the Max subscriptions by naming a registered consumer. Only <code>required</code> closes that.</p>`:''}
    ${keyless.length?html`<p class="down" style="margin:10px 0 0"><b>⚠ ${keyless.length} registered consumer(s) hold no key</b> — ${keyless.join(', ')}. Switching to <code>required</code> 401s every one of them.</p>`:''}
  </${Card}>

  <${Card}>
    <div class="flex" style="justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">Name gate <small class="hint">— legacy, for un-keyed callers</small></h3>
      <button class=${reg&&reg.enforcing?'':'ghost'} disabled=${busy==='enforce'} onClick=${()=>enforce(!(reg&&reg.enforcing))}>
        ${reg&&reg.enforcing?'● Enforcing — unknown names 403':'○ Off — any name is accepted'}
      </button>
    </div>
    <p class="hint" style="margin:8px 0 0">Only applies to calls with <b>no key</b>. Refuses an unregistered consumer with <code>403 unknown_consumer</code>, so a typo can't quietly become a new consumer with its own bill. It is a spelling check, not a lock — it becomes redundant once auth is <code>required</code>.</p>
    ${unreg.length?html`<p class="down" style="margin:10px 0 0"><b>⚠ ${unreg.length} consumer(s) in the call log are not registered.</b> ${reg.enforcing?'They are being refused right now.':'Register them before turning the gate on, or their traffic dies the moment you do.'}</p>`:''}
  </${Card}>

  ${unreg.length?html`<${Card}>
    <h3>Unregistered <small class="hint">— seen in the log, not in the registry</small></h3>
    <div style="overflow:auto"><table>
      <tr><th>name</th><th>calls</th><th>tokens</th><th>jobs</th><th>register as</th></tr>
      ${unreg.map(x=>html`<tr key=${x.name}>
        <td class="mono"><b>${x.name}</b></td>
        <td class="mono">${nfmt(x.calls)}</td>
        <td class="mono mut">${nfmt(x.tokens)}</td>
        <td class="mono mut">${x.jobs||0}</td>
        <td><div class="flex" style="gap:6px">
          <button class="ghost sm" disabled=${busy===x.name} onClick=${()=>{ const o=prompt(`"${x.name}" is a developer machine. Who owns it? (person, e.g. philip)`); if(o&&o.trim()) save(x.name,'dev',o.trim(),''); }}>+ dev</button>
          <button class="ghost sm" disabled=${busy===x.name} onClick=${()=>save(x.name,'app','','')}>+ app</button>
        </div></td>
      </tr>`)}
    </table></div>
  </${Card}>`:''}

  <${Card}>
    <h3>Consumers <small class="hint">— ${regd.length}${reg&&reg.owners.length?', '+reg.owners.length+' owner(s)':''}</small></h3>
    <p class="hint" style="margin:4px 0 12px">Issuing a key is how you register: one step, and the consumer is created if it does not exist. Only the key's <b>sha256</b> is stored — the plaintext is shown once, never again.</p>
    <div style="overflow:auto"><table>
      <tr><th>consumer</th><th>kind</th><th>owner</th><th>keys</th><th>jobs</th><th>calls</th><th>tokens</th><th></th></tr>
      ${regd.length?regd.map(c=>html`<tr key=${c.name}>
        <td class="mono"><b>${c.name}</b>${c.note?html`<div class="hint" style="font-size:10px">${c.note}</div>`:''}</td>
        <td><${KindPill} kind=${c.kind}/></td>
        <td class="mono">${c.kind==='dev'?html`<span style="color:var(--acc)">${c.owner}</span>`:html`<span class="mut" title="an app is not a person">—</span>`}</td>
        <td style="min-width:150px">
          ${c.keys.filter(k=>!k.revoked).map(k=>html`<div class="flex" style="gap:6px;align-items:center;margin:1px 0">
            <span class="chip mono" title=${'issued '+(k.created?new Date(k.created).toISOString().slice(0,10):'?')+' · last used '+(k.lastUsed?ago(k.lastUsed):'never')}>${k.id}</span>
            <span class="mut" style="font-size:10px">${k.lastUsed?ago(k.lastUsed):'unused'}</span>
            <span class="x" title="revoke" onClick=${()=>revokeKey(c.name,k.id)}>✕</span>
          </div>`)}
          ${!c.activeKeys?html`<span class="down" style="font-size:11px">no key${mode==='required'?' — 401ing':''}</span>`:''}
        </td>
        <td class="mono mut">${c.jobs||0}</td>
        <td class="mono">${nfmt(c.calls)}</td>
        <td class="mono mut">${nfmt(c.tokens)}</td>
        <td><div class="flex" style="gap:6px">
          <button class="ghost sm" disabled=${busy===c.name} onClick=${()=>issueKey(c.name)}>+ key</button>
          <button class="ghost sm" disabled=${busy===c.name} onClick=${()=>remove(c.name)}>Delete</button>
        </div></td>
      </tr>`):html`<tr><td colspan="8" class="hint">No consumers yet. Issue a key below — that creates the first one.</td></tr>`}
    </table></div>
    <div class="row" style="margin-top:12px">
      <input style="flex:2" placeholder="consumer name (no ':') e.g. promopilot" value=${nn} onInput=${e=>setNn(e.target.value)} onKeyDown=${e=>e.key==='Enter'&&add()}/>
      <select style="flex:0 0 130px" value=${nk} onChange=${e=>setNk(e.target.value)}><option value="app">app</option><option value="dev">dev</option></select>
      <input style="flex:1" placeholder=${nk==='dev'?'owner (a person)':'apps have no owner'} disabled=${nk!=='dev'} value=${nk==='dev'?no:''} onInput=${e=>setNo(e.target.value)}/>
      <button style="flex:0 0 auto" disabled=${!!busy} onClick=${add}>Issue key</button>
    </div>
  </${Card}>

  <${Card}>
    <div class="flex" style="justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">Consumption</h3>
      <div class="flex" style="gap:4px">${USAGE_WINDOWS.map(([v,l])=>html`<button class=${win===v?'sm':'ghost sm'} onClick=${()=>setWin(v)}>${l}</button>`)}</div>
    </div>
    ${!u?html`<p class="hint">loading…</p>`:html`
    <div class="flex" style="gap:10px;flex-wrap:wrap;margin:12px 0">
      ${['dev','app','unregistered'].map(k=>html`<div class="card" style="flex:1;min-width:150px;margin:0">
        <div><${KindPill} kind=${k}/></div>
        <div class="mono" style="font-size:20px;margin-top:6px">${nfmt(kindOf(k).tokens)}<span class="mut" style="font-size:12px"> tok</span></div>
        <div class="mut mono" style="font-size:12px">${nfmt(kindOf(k).calls)} calls</div>
      </div>`)}
    </div>

    <h4 style="margin:16px 0 6px">By developer <small class="hint">— every machine a person owns, summed</small></h4>
    <div style="overflow:auto"><table>
      <tr><th>owner</th><th>calls</th><th>tokens</th><th>errors</th></tr>
      ${u.byOwner.length?u.byOwner.map(o=>html`<tr key=${o.key}>
        <td class="mono"><b>${o.key}</b></td><td class="mono">${nfmt(o.calls)}</td>
        <td class="mono">${nfmt(o.tokens)}</td><td class="mono ${o.errors?'down':'mut'}">${o.errors}</td>
      </tr>`):html`<tr><td colspan="4" class="hint">No dev traffic in this window — or no dev consumer has an owner yet.</td></tr>`}
    </table></div>

    <h4 style="margin:16px 0 6px">By consumer <small class="hint">— click a row to expand its jobs</small></h4>
    <div style="overflow:auto"><table>
      <tr><th>consumer</th><th>kind</th><th>owner</th><th>calls</th><th>tokens</th><th>errors</th></tr>
      ${u.byConsumer.map(c=>html`
        <tr key=${c.key} class=${c.jobs.length?'click':''} onClick=${()=>c.jobs.length&&setOpen(o=>({...o,[c.key]:!o[c.key]}))}>
          <td class="mono"><b>${c.jobs.length?html`<span class="mut">${open[c.key]?'▾':'▸'} </span>`:''}${c.key}</b>${c.jobs.length?html`<span class="mut" style="font-size:11px"> ${c.jobs.length} job${c.jobs.length>1?'s':''}</span>`:''}</td>
          <td><${KindPill} kind=${c.kind}/></td>
          <td class="mono mut">${c.owner||'—'}</td>
          <td class="mono">${nfmt(c.calls)}</td><td class="mono">${nfmt(c.tokens)}</td>
          <td class="mono ${c.errors?'down':'mut'}">${c.errors}</td>
        </tr>
        ${open[c.key]?c.jobs.map(j=>html`<tr key=${c.key+':'+j.key} style="background:var(--card2)">
          <td class="mono mut" style="padding-left:24px">↳ ${j.key}</td><td></td><td></td>
          <td class="mono mut">${nfmt(j.calls)}</td><td class="mono mut">${nfmt(j.tokens)}</td>
          <td class="mono ${j.errors?'down':'mut'}">${j.errors}</td>
        </tr>`):''}
      `)}
    </table></div>

    <h4 style="margin:16px 0 6px">By account, split by kind <small class="hint">— is an app starving your Claude Code?</small></h4>
    <div style="overflow:auto"><table>
      <tr><th>account</th><th>kind</th><th>calls</th><th>tokens</th></tr>
      ${u.byAccountKind.length?u.byAccountKind.map(r=>html`<tr key=${r.account+r.kind}>
        <td class="mono"><b>${r.account}</b></td><td><${KindPill} kind=${r.kind}/></td>
        <td class="mono">${nfmt(r.calls)}</td><td class="mono">${nfmt(r.tokens)}</td>
      </tr>`):html`<tr><td colspan="4" class="hint">No attributed traffic in this window.</td></tr>`}
    </table></div>`}
  </${Card}>`;
}
export { KindPill, USAGE_WINDOWS, Consumers };
