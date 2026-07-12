import { html, useState, useEffect, useCallback, api, toast, nfmt, ago, Chip, Card, CardHead, Tabs, PageHead, KindPill, useApp } from "../core.js";

/* ───────── CONSUMERS: the registry, and the gates around it ─────────
   A consumer is WHO calls. Two kinds: `dev` (a person's machine — has a human owner) and `app`
   (deployed code — no owner). Identity is a path `<consumer>:<job>`; only the consumer is registered,
   jobs are free. This page does ONE job: register consumers, issue/revoke their keys, and set the
   access gates. The numbers — who spends what — live on the Usage tab, not here. */
function Consumers(){
  const {state,reload,go}=useApp();
  const [reg,setReg]=useState(null); const [err,setErr]=useState(''); const [busy,setBusy]=useState('');
  const [nn,setNn]=useState(''); const [nk,setNk]=useState('app'); const [no,setNo]=useState('');
  const [issued,setIssued]=useState(null);
  const load=useCallback(async()=>{
    try{ setReg(await api('consumers')); setErr(''); }
    catch(e){ setErr(e.message||'load failed'); }
  },[]);
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
  const since=ts=>ts?ago(ts):'never';
  const unreg=(reg&&reg.unregistered)||[], regd=(reg&&reg.registered)||[];
  return html`
  <${PageHead} title="Consumers" desc="Register who may call the router and issue their keys. Spend lives on the Usage tab."
    onRefresh=${load}
    actions=${html`<button class="ghost sm" onClick=${()=>go('overview','usage')} title="per-consumer spend, cost and history">Usage →</button>`}/>
  ${err?html`<div class="alert bad">${err}</div>`:''}

  ${issued?html`<${Card} cls="ok">
    <${CardHead} title=${html`Key issued for <span class="mono">${issued.consumer}</span>`}
      hint="This is the only time it is shown. Only its sha256 is stored. Put it in keyvault now."/>
    <div class="msgbox mono" style="user-select:all;word-break:break-all;font-size:13px">${issued.key}</div>
    <div class="flex" style="margin-top:12px">
      <button onClick=${()=>{navigator.clipboard.writeText(issued.key);toast('key copied');}}>Copy</button>
      <button class="ghost" onClick=${()=>setIssued(null)}>I have stored it</button>
    </div>
    <small class="hint" style="display:block;margin-top:12px">Use it the way every OpenAI client already does:
      <code>Authorization: Bearer ${issued.key.slice(0,16)}…</code>, or <code>x-api-key</code> for the native Anthropic endpoint. No <code>X-Project</code> header needed; the key says who you are.</small>
  </${Card}>`:''}

  ${/* Register-first: the primary action leads the page. Issuing a key creates the consumer. */''}
  <${Card}>
    <${CardHead} title="Register a consumer"
      hint=${html`One step registers <b>and</b> issues the key. A <b>dev</b> is a person's machine (needs an owner); an <b>app</b> is deployed code (no owner). Only the sha256 is stored — the key is shown once.`}/>
    <div class="row">
      <input style="flex:2;min-width:180px" placeholder="consumer name (no ':') e.g. promopilot" value=${nn} onInput=${e=>setNn(e.target.value)} onKeyDown=${e=>e.key==='Enter'&&add()}/>
      <select style="flex:0 0 120px" value=${nk} onChange=${e=>setNk(e.target.value)}><option value="app">app</option><option value="dev">dev</option></select>
      <input style="flex:1;min-width:140px" placeholder=${nk==='dev'?'owner (a person)':'apps have no owner'} disabled=${nk!=='dev'} value=${nk==='dev'?no:''} onInput=${e=>setNo(e.target.value)}/>
      <button style="flex:0 0 auto" disabled=${!!busy} onClick=${add}>Issue key</button>
    </div>
  </${Card}>

  ${unreg.length?html`<${Card} cls="amb">
    <${CardHead} title=${`Seen but unregistered (${unreg.length})`} hint="These names are in the call log with no registry entry. Register them so a typo can't quietly bill as a new consumer."/>
    <div class="tablewrap"><table>
      <tr><th>name</th><th>calls</th><th>tokens</th><th>jobs</th><th>register as</th></tr>
      ${unreg.map(x=>html`<tr key=${x.name}>
        <td class="mono"><b>${x.name}</b></td>
        <td class="mono">${nfmt(x.calls)}</td>
        <td class="mono mut">${nfmt(x.tokens)}</td>
        <td class="mono mut">${x.jobs||0}</td>
        <td><div class="flex" style="gap:6px">
          <button class="ghost sm" disabled=${busy===x.name} onClick=${()=>{ const o=prompt(`"${x.name}" is a developer machine. Who owns it? (person, e.g. philip)`); if(o&&o.trim()) save(x.name,'dev',o.trim(),''); }}>as dev</button>
          <button class="ghost sm" disabled=${busy===x.name} onClick=${()=>save(x.name,'app','','')}>as app</button>
        </div></td>
      </tr>`)}
    </table></div>
  </${Card}>`:''}

  <${Card}>
    <${CardHead} title="Registry"
      hint=${html`${regd.length} consumer${regd.length===1?'':'s'}${reg&&reg.owners.length?`, ${reg.owners.length} owner(s)`:''}. Revoke a key with ✕; a consumer with no active key is flagged.`}/>
    <div class="tablewrap"><table>
      <tr><th>consumer</th><th>kind</th><th>owner</th><th>keys</th><th>jobs</th><th>calls</th><th>tokens</th><th></th></tr>
      ${regd.length?regd.map(c=>html`<tr key=${c.name}>
        <td class="mono"><b>${c.name}</b>${c.note?html`<div class="hint" style="font-size:10px">${c.note}</div>`:''}</td>
        <td><${KindPill} kind=${c.kind}/></td>
        <td class="mono">${c.kind==='dev'?html`<span style="color:var(--accent)">${c.owner}</span>`:html`<span class="mut" title="an app is not a person">—</span>`}</td>
        <td style="min-width:150px">
          ${c.keys.filter(k=>!k.revoked).map(k=>html`<div class="flex" style="gap:6px;align-items:center;margin:1px 0">
            <${Chip} title=${'issued '+(k.created?new Date(k.created).toISOString().slice(0,10):'?')+' · last used '+since(k.lastUsed)}>${k.id}<//>
            <span class="mut" style="font-size:10px">${k.lastUsed?since(k.lastUsed):'unused'}</span>
            <span class="x" title="revoke" onClick=${()=>revokeKey(c.name,k.id)}>✕</span>
          </div>`)}
          ${!c.activeKeys?html`<span class="down" style="font-size:11px">no key${mode==='required'?' — 401ing':''}</span>`:''}
        </td>
        <td class="mono mut">${c.jobs||0}</td>
        <td class="mono">${nfmt(c.calls)}</td>
        <td class="mono mut">${nfmt(c.tokens)}</td>
        <td style="width:1%"><div class="flex" style="gap:6px">
          <button class="ghost sm" disabled=${busy===c.name} onClick=${()=>issueKey(c.name)}>New key</button>
          <button class="quiet sm" disabled=${busy===c.name} onClick=${()=>remove(c.name)}>Delete</button>
        </div></td>
      </tr>`):html`<tr><td colspan="8" class="hint">No consumers yet. Register one above — that issues its first key.</td></tr>`}
    </table></div>
  </${Card}>

  ${/* Both gates live in one card: they are the same axis (who is allowed to call), just staged. */''}
  <${Card} cls=${mode!=='required'?'amb':''}>
    <${CardHead} title="Access control"
      hint="Two staged gates. Authentication is the lock (a key); the name gate is a spelling check for keyless callers, redundant once auth is required."
      actions=${html`<${Tabs} val=${mode} onChange=${setMode} disabled=${busy==='mode'} items=${[['off','off'],['optional','optional'],['required','required']]}/>`}/>
    <p class="hint" style="margin:0">
      <code>off</code> — keys ignored; <code>X-Project</code> is the only identity.<br/>
      <code>optional</code> — a valid key wins; no key falls back to the header. <b>Migration mode.</b> A key presented and <i>bad</i> is always a 401.<br/>
      <code>required</code> — no valid key, no service. The only mode where the self-asserted header stops being an identity.
    </p>
    ${mode!=='required'?html`<p class="warnp" style="margin:12px 0 0;font-size:13px"><b>The inference endpoints are open.</b> Anyone who can reach <code>llm.hostbun.cc</code> can spend the Max subscriptions by naming a registered consumer. Only <code>required</code> closes that.</p>`:''}
    ${keyless.length?html`<p class="down" style="margin:8px 0 0;font-size:13px"><b>${keyless.length} registered consumer(s) hold no key</b> — ${keyless.join(', ')}. Switching to <code>required</code> 401s every one of them.</p>`:''}
    <div class="spread" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
      <div><b style="font-size:13px">Name gate</b> <span class="hint">— refuse an unregistered consumer with <code>403 unknown_consumer</code> (keyless callers only).</span>
        ${unreg.length?html`<div class="down" style="font-size:12px;margin-top:4px"><b>${unreg.length} unregistered consumer(s) in the log.</b> ${reg&&reg.enforcing?'Refused now.':'Register them before enabling, or their traffic dies.'}</div>`:''}
      </div>
      <button class=${'toggle'+(reg&&reg.enforcing?' on':'')} style="flex:0 0 auto" disabled=${busy==='enforce'} onClick=${()=>enforce(!(reg&&reg.enforcing))}>${reg&&reg.enforcing?'● Enforcing':'Off'}</button>
    </div>
  </${Card}>`;
}
export { Consumers };
