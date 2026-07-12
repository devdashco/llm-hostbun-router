// The shell: nav, routing, login, and the page table. Every page the panel has is named here — a
// page that exists but is unreachable would be obvious in this one file.
import {
  html, render, useState, useEffect, useCallback,
  api, setOnUnauth, Svg, NAV, SLUG_ALIAS, BASE, nameFor, Tabs, useTab, Ctx,
} from "./core.js";
import { CallDrawer } from "./drawer.js";
import { Overview } from "./pages/overview.js";
import { Calls } from "./pages/calls.js";
import { Consumers } from "./pages/consumers.js";
import { Stats } from "./pages/stats.js";
import { Accounts } from "./pages/accounts.js";
import { Routing } from "./pages/routing.js";
import { Models } from "./pages/models.js";
import { Crazyrouter } from "./pages/crazyrouter.js";
import { Secrets } from "./pages/secrets.js";

/* A page made of former pages: one tab strip, then the chosen sub-page exactly as it was.
   Each sub-page keeps its own PageHead (title, refresh, its own controls). */
function Tabbed({def,items}){
  const [tab,setTab]=useTab(def);
  const cur=items.find(([v])=>v===tab)||items[0];
  const Sub=cur[2];
  return html`<div style="margin-bottom:16px"><${Tabs} val=${cur[0]} onChange=${setTab} items=${items.map(([v,l])=>[v,l])}/></div><${Sub} key=${cur[0]}/>`;
}
const OverviewPage = () => html`<${Tabbed} def="health"    items=${[['health','Health',Overview],['usage','Usage',Stats]]}/>`;
const RoutingPage  = () => html`<${Tabbed} def="rules"     items=${[['rules','Rules',Routing],['models','Models & test',Models]]}/>`;
const IdentityPage = () => html`<${Tabbed} def="consumers" items=${[['consumers','Consumers',Consumers],['accounts','Accounts',Accounts]]}/>`;
const SettingsPage = () => html`<${Tabbed} def="crazyrouter" items=${[['crazyrouter','Crazyrouter',Crazyrouter],['secrets','Secrets & gate',Secrets]]}/>`;

const PAGES = { overview: OverviewPage, calls: Calls, routing: RoutingPage, identity: IdentityPage, settings: SettingsPage };

/* Read the slug off the URL; an old slug 301s client-side onto its new page + tab. */
function resolveSlug(){
  let s=location.pathname.replace(BASE,'').replace(/^\/+/,'').split('/')[0]||'overview';
  if(SLUG_ALIAS[s]){ const [ns,t]=SLUG_ALIAS[s];
    try{ const u=new URL(location.href); u.pathname=BASE+'/'+ns; if(t)u.searchParams.set('t',t); history.replaceState({},'',u); }catch{}
    return ns; }
  return NAV.some(x=>x.slug===s)?s:'overview';
}

function Shell({slug,go,children}){
  const [sbOpen,setSbOpen]=useState(false);
  return html`<div class="shell">
    <aside class=${'sidebar'+(sbOpen?' open':'')}>
      <div class="sb-brand"><div class="logo">hb</div><div><div class="t">hostbun</div><div class="s">llm router · control panel</div></div></div>
      <nav class="nav">
        ${NAV.map(it=>it.sec?html`<div class="nav-sec">${it.sec}</div>`:html`
          <a class=${'nav-item'+(it.slug===slug?' on':'')} href=${BASE+'/'+it.slug} onClick=${e=>{e.preventDefault();go(it.slug);setSbOpen(false);}}>
            <${Svg} n=${it.icon}/><span>${it.name}</span>
          </a>`)}
      </nav>
      <div class="sb-foot"><button class="ghost sm" style="width:100%" onClick=${async()=>{ try{await api('logout',{method:'POST'});}catch{} location.reload(); }}>Sign out</button></div>
    </aside>
    ${sbOpen&&html`<div class="dov open" style="z-index:49" onClick=${()=>setSbOpen(false)}></div>`}
    <div class="main">
      ${/* Mobile only. On desktop the sidebar carries the brand and <PageHead/> carries the title,
           so a second bar repeating the page name is chrome with nothing to say. */''}
      <header class="topbar">
        <button class="ghost sm" onClick=${()=>setSbOpen(!sbOpen)} aria-label="menu">☰</button>
        <h3>${nameFor(slug)}</h3>
      </header>
      <div class="content">${children}</div>
    </div>
  </div>`;
}

/* ───────── login ───────── */
function Login({onOk}){
  const [pw,setPw]=useState(''); const [err,setErr]=useState('');
  async function submit(){ setErr(''); try{ await api('login',{method:'POST',body:JSON.stringify({password:pw})}); onOk(); }catch(e){ setErr(e.message); } }
  return html`<div class="login">
    <div class="sb-brand"><div class="logo">hb</div></div>
    <h1>llm.hostbun.cc</h1>
    <p class="hint">Control panel for the router. Every model call we make goes through it.</p>
    <div class="card">
      <label for="pw" style="margin-top:0">Password</label>
      <input id="pw" type="password" placeholder="••••••" autofocus value=${pw} onInput=${e=>setPw(e.target.value)} onKeyDown=${e=>e.key==='Enter'&&submit()}/>
      <div style="height:12px"></div>
      <button style="width:100%" onClick=${submit}>Sign in</button>
      ${err&&html`<p class="down" style="margin:12px 0 0;font-size:13px">${err}</p>`}
    </div>
  </div>`;
}

/* ───────── root ───────── */
function App(){
  const [authed,setAuthed]=useState(null); // null=checking
  const [state,setState]=useState(null);
  // slug + the ?t= tab travel together: the page is keyed on both, so any navigation that changes
  // either remounts the page and it re-reads the URL. That is what makes a legacy-slug redirect
  // between two tabs of the SAME page (e.g. /crazyrouter → /secrets) actually switch tabs.
  const readTab=()=>{ try{ return new URL(location.href).searchParams.get('t')||''; }catch{ return ''; } };
  const [slug,setSlug]=useState(resolveSlug);
  const [tabKey,setTabKey]=useState(readTab);
  const [callId,setCallId]=useState(null);
  const boot=useCallback(async()=>{ try{ const s=await api('state'); setState(s); setAuthed(true); }catch(e){ setAuthed(false); } },[]);
  useEffect(()=>{ setOnUnauth(()=>setAuthed(false)); boot(); },[boot]);
  useEffect(()=>{ const h=()=>{ setSlug(resolveSlug()); setTabKey(readTab()); }; window.addEventListener('popstate',h); return ()=>window.removeEventListener('popstate',h); },[]);
  // go(slug[, tab]) — tab lands in ?t= before the page mounts, so useTab reads it on first render.
  const go=useCallback((s,t)=>{ history.pushState({},'',BASE+'/'+s+(t?'?t='+t:'')); setSlug(s); setTabKey(t||''); document.title='hostbun · '+nameFor(s); },[]);
  useEffect(()=>{ document.title='hostbun · '+nameFor(slug); },[slug]);
  const reload=useCallback(s=>{ if(s)setState(s); else boot(); },[boot]);

  if(authed===null) return html`<div class="mut" style="padding:40px;text-align:center">…</div>`;
  if(!authed) return html`<${Login} onOk=${boot}/>`;
  if(!state) return html`<div class="mut" style="padding:40px;text-align:center">loading…</div>`;
  const Page=PAGES[slug]||Overview;
  // gotoCalls: drill into the call log with a filter (project= or q=). Navigate FIRST — go() pushes a
  // clean /calls URL — then stamp the params on it, before preact renders and Calls reads them on mount.
  const gotoCalls=(params)=>{ go('calls'); try{ const u=new URL(location.href); Object.entries(params||{}).forEach(([k,v])=>{ if(v) u.searchParams.set(k,v); }); history.replaceState({},'',u); }catch{} };
  const ctx={ state, reload, go, openCall:setCallId, gotoCalls };
  return html`<${Ctx.Provider} value=${ctx}>
    <${Shell} slug=${slug} go=${go}><${Page} key=${slug+':'+tabKey}/></${Shell}>
    <${CallDrawer} id=${callId} onClose=${()=>setCallId(null)}/>
  </${Ctx.Provider}>`;
}

render(html`<${App}/>`, document.getElementById("root"));
