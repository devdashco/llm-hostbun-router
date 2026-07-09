import { html, useState, api, toast, Card, PageHead, useApp } from "../core.js";

/* ───────── SECRETS ───────── */
function Secrets(){
  const {state,reload}=useApp();
  const [v,setV]=useState({oblit:'',admin:''});
  async function setSecret(field,val){ if(!val){toast('enter a value',true);return;} try{ const r=await api('config',{method:'POST',body:JSON.stringify({[field]:val})}); reload(r.state); toast(field+' updated'); }catch(e){toast(e.message,true);} }
  async function disableGate(){ if(!confirm('Disable the gate? Gated models become open to anyone.'))return; try{ const r=await api('config',{method:'POST',body:JSON.stringify({oblitToken:''})}); reload(r.state); toast('gate disabled'); }catch(e){toast(e.message,true);} }
  async function changePw(){ if(v.admin.length<3){toast('min 3 chars',true);return;} if(!confirm('Change admin password? You may need to sign in again.'))return; try{ await api('config',{method:'POST',body:JSON.stringify({adminPassword:v.admin})}); setV({...v,admin:''}); toast('password changed — re-login if prompted'); }catch(e){toast(e.message,true);} }
  return html`
  <${PageHead} title="Secrets & gate"/>
  <div class="warn">Live, file-backed overrides (<code>${state.configFile}</code>). Leaving a field blank keeps the current value.</div>
  <${Card}>
    <h3>claudecode account tokens <span class="mut">(${(state.claudecodeAccountPool||[]).length} in pool)</span></h3>
    <small class="hint">Max account tokens live in <code>claudecodeAccountPool</code> inside the config file above — the only
    copy anywhere. They are never returned to this UI. Edit them on the volume, and back it up before touching the app.</small>
  </${Card}>
  <${Card}>
    <h3>Obliterated / uncensored gate <span class="mut">(token: ${state.oblitTokenSet?state.oblitTokenMasked:'(open — no gate)'})</span></h3>
    <p class="mut" style="font-size:13px;margin:0 0 8px">When set, requests to a gated model require <code>Authorization: Bearer &lt;token&gt;</code>. Empty = open.</p>
    <div class="flex"><input type="password" placeholder="new gate token" value=${v.oblit} onInput=${e=>setV({...v,oblit:e.target.value})}/><button class="sm" style="flex:0 0 auto" onClick=${()=>{setSecret('oblitToken',v.oblit);setV({...v,oblit:''});}}>Update</button><button class="danger sm" style="flex:0 0 auto" onClick=${disableGate}>Disable gate</button></div>
    <small class="hint">Gated upstream model ids are edited on the Routing page (Advanced → JSON enforcement).</small>
  </${Card}>
  <${Card}>
    <h3>Admin password <span class="mut">(current: ${state.adminPasswordMasked})</span></h3>
    <div class="flex"><input type="password" placeholder="new admin password (≥3 chars)" value=${v.admin} onInput=${e=>setV({...v,admin:e.target.value})}/><button class="sm danger" style="flex:0 0 auto" onClick=${changePw}>Change</button></div>
    <small class="hint">changing this signs you out of other sessions.</small>
  </${Card}>`;
}


export { Secrets };
