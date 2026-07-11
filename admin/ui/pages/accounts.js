import { html, render, h, useState, useEffect, useCallback, api, toast, nfmt, ago,
         Chip, Card, CardHead, KV, PageHead, useApp } from "../core.js";

/* ───────── Accounts: live per-account 5h/7d limits, harvested free off real traffic ───────── */
/* Project pins. One project → one account, forever; no header can override it. Rotating accounts
   blows the per-org prompt cache and makes "who spent this?" unanswerable. An unpinned project
   403s rather than billing a guess, so this table is the ONLY way a new app gets served. */
function Pins(){
  const {state,reload}=useApp();
  const pins=state.projectAccounts||state.consumerAccounts||{};
  const accounts=(state.claudecodeAccountPool||[]).map(a=>a.name);
  const [np,setNp]=useState(''); const [na,setNa]=useState(accounts[0]||''); const [busy,setBusy]=useState('');
  // Single-pin merge server-side. Never POST the whole projectAccounts map from here: `config`
  // assigns it wholesale, so one stale render would delete every other project's pin.
  async function setPin(project,account){
    setBusy(project);
    try{ await api('pins',{method:'POST',body:JSON.stringify({project,account})});
      toast(account?`${project} → ${account}`:`${project} unpinned`); reload();
    }catch(e){ toast(e.message,true); } finally{ setBusy(''); }
  }
  async function add(){ const p=np.trim().toLowerCase(); if(!p){toast('project slug required',true);return;} if(!na){toast('pick an account',true);return;} await setPin(p,na); setNp(''); }
  const names=Object.keys(pins).sort();
  return html`
  <${Card}>
    <${CardHead} title="Project pins" hint="Which subscription each app spends."/>
    <p class="hint" style="margin:0 0 14px">An <b>unpinned</b> project gets <code>403 no_account_for_project</code>. That is deliberate: the gateway never guesses whose Max plan to bill. ${state.defaultAccount?html`<b class="down">defaultAccount is set to "${state.defaultAccount}", so every unpinned or misspelled project silently bills it instead of 403'ing.</b>`:html`<code>defaultAccount</code> is empty, which is what keeps the 403 honest.`}</p>
    <div class="tablewrap"><table>
      <tr><th>project</th><th>account</th><th></th></tr>
      ${names.length?names.map(p=>html`<tr key=${p}>
        <td class="mono" style="font-weight:600">${p}</td>
        <td style="max-width:220px"><select disabled=${busy===p} value=${pins[p]} onChange=${e=>setPin(p,e.target.value)}>
          ${accounts.map(a=>html`<option value=${a} selected=${a===pins[p]}>${a}</option>`)}
        </select></td>
        <td style="width:1%"><button class="quiet sm" disabled=${busy===p} onClick=${()=>setPin(p,null)}>Unpin</button></td>
      </tr>`):html`<tr><td colspan="3" class="hint">No pins — every claudecode call is 403'ing.</td></tr>`}
    </table></div>
    <div class="row" style="margin-top:14px">
      <input style="flex:2;min-width:180px" placeholder="new project slug, e.g. promopilot" value=${np} onInput=${e=>setNp(e.target.value)} onKeyDown=${e=>e.key==='Enter'&&add()}/>
      <select style="flex:1;min-width:140px" value=${na} onChange=${e=>setNa(e.target.value)}>${accounts.map(a=>html`<option value=${a}>${a}</option>`)}</select>
      <button style="flex:0 0 auto" disabled=${!!busy} onClick=${add}>Pin</button>
    </div>
  </${Card}>`;
}

/* Headroom bar. `null` is not 0% — it means nothing has been harvested for this account, and
   drawing an empty bar there would read as "plenty left" when the truth is "we have no idea". */
const Bar=({v})=>{
  if(v==null) return html`<div class="hint" style="font-size:11px">no reading</div>`;
  const p=Math.max(0,Math.min(100,Math.round(v*100)));
  const c=p>=90?'var(--danger)':p>=70?'var(--warn)':'var(--ok)';
  return html`<div title=${p+'% used'}>
    <div class="bar"><i style=${`width:${p}%;background:${c}`}></i></div>
    <div class="mono" style=${`font-size:11px;color:${c};margin-top:3px`}>${p}%</div>
  </div>`;
};

/* One row per pool account — including the ones that have never served a call. The old view read
   acct_limits directly, which is keyed by Anthropic org-id, so an account with no traffic simply
   did not exist as far as the panel was concerned.

   These are Claude Max subscriptions, so the pool serves whatever Claude Code serves — every model.
   There is no "which models does this account serve" column: a 429 is a subscription usage window
   (rolling 5h + weekly), not a capability, and reading it as one only ever misled. The bars below
   are that usage window. */
function Accounts(){
  const [d,setD]=useState(null); const [now,setNow]=useState(Date.now()); const [err,setErr]=useState('');
  // A live reading overlaid on top of the harvested row, keyed by account. Set by refreshLimits(),
  // which pings each subscription once and reads its real `anthropic-ratelimit-unified-*` headers.
  const [fresh,setFresh]=useState({}); const [busy,setBusy]=useState('');
  const load=useCallback(async()=>{ try{ const r=await api('accounts'); setD(r); setNow(r.now||Date.now()); setErr(''); }catch(e){ setErr(e.message||'load failed'); } },[]);
  useEffect(()=>{ load(); const t=setInterval(load,15000); return ()=>clearInterval(t); },[load]);
  // Ping ONE account (or the whole pool) for its live window. Not fired on mount — only on click —
  // so the page never spends tokens just by being opened.
  async function refreshLimits(name){
    setBusy(name||'all');
    try{
      const r=await api('claudecode/limits',{method:'POST',body:JSON.stringify(name?{account:name}:{all:true})});
      const list=name?[r]:(r.accounts||[]);
      const m={...fresh}; list.forEach(x=>{ m[x.account]=x; }); setFresh(m);
      const nr=list.filter(x=>!x.reading).length;
      toast(`live limits: ${list.length-nr}/${list.length} read`+(nr?` · ${nr} no reading`:''), nr>0&&nr===list.length);
      load();
    }catch(e){ toast(e.message,true); } finally{ setBusy(''); }
  }
  const rel=ts=>{ if(!ts)return '—'; const ms=ts*1000-now; if(ms<=0)return 'now'; const h=ms/3600000; return h>=1?Math.round(h)+'h':Math.max(1,Math.round(ms/60000))+'m'; };
  const since=ts=>ts?ago(ts,now)+' ago':'never';
  const accts=(d&&d.accounts)||[];
  const s=(d&&d.summary)||{};
  return html`
  <${PageHead} title="Accounts" desc="The Claude Max pool: how much usage-window headroom is left, and which project spends which subscription." onRefresh=${load}/>

  ${d&&d.orphanPins&&d.orphanPins.length?html`<div class="alert bad">
    <b class="down">${d.orphanPins.length} pin(s) name an account that is not in the pool</b>
    <div class="mut" style="margin-top:5px">Those projects <code>403</code> on every call: ${d.orphanPins.map(o=>html`<code>${o.project} → ${o.account}</code> `)}</div>
  </div>`:''}

  <div class="grid">
    <${KV} n="Pool">${s.accounts??'…'} account${s.accounts===1?'':'s'}<//>
    <${KV} n="Model catalog">${d?`${d.advertisedModels} ids`:'…'}<//>
  </div>

  <${Pins}/>

  <${Card}>
    <${CardHead} title="Pool" hint="Every subscription, its usage-window headroom, and who spends it."
      actions=${html`<button class="ghost sm" disabled=${!!busy} onClick=${()=>refreshLimits(null)} title="ping each subscription once and read its live 5h/7d usage window">${busy==='all'?'Refreshing…':'↻ Refresh limits (live)'}</button>`}/>
    <p class="hint" style="margin:0 0 6px">The <b>5h</b>/<b>7d</b> bars are the Claude Max usage windows. Without a refresh they are <b class="warnp">harvested off real traffic and read as a floor</b> — an idle account (or one Anthropic just refunded) keeps its last reading until it serves a call. Hit <b>Refresh limits (live)</b> to ping each subscription once and pull the real window right now; a <span style="color:var(--ok)">● live</span> tag marks a row that has a fresh reading.</p>
    ${err?html`<p class="down">${err}</p>`:''}
    ${!d?html`<p class="hint">loading…</p>`:''}
    <div class="tablewrap" style="margin-top:12px"><table>
      <tr><th>account</th><th>pinned projects</th><th>5h used</th><th>7d used</th><th>7d resets</th>
        <th title="all-time calls / tokens through this account">usage</th><th>last 24h</th><th></th></tr>
      ${accts.map(a=>{
        const fr=fresh[a.name];
        const l=(fr&&fr.reading)?{...fr.reading,status:fr.reading.unified,ts:fr.checkedAt}:a.limits;
        const live=!!(fr&&fr.reading);
        const liveNo=!!(fr&&!fr.reading);
        return html`<tr key=${a.name} class=${live?'live-row':''}>
          <td class="mono"><b>${a.name}</b>${a.org?html`<div class="hint" style="font-size:10px" title=${a.org}>${a.org.slice(0,12)}…</div>`:html`<div class="hint" style="font-size:10px">org unknown</div>`}
            ${live?html`<div class="hint" style="font-size:9.5px;color:var(--ok)">● live · ${since(fr.checkedAt)}</div>`:''}
            ${liveNo?html`<div class="hint" style=${'font-size:9.5px;color:'+(fr.status===403?'var(--danger)':'var(--warn)')} title=${fr.errMsg||fr.error||'the account answered but sent no rate-limit headers — usually a 429'}>${fr.status===403?'✕ OAuth disabled':`live: no reading${fr.status?` (${fr.status})`:''}`}${fr.error?` (${fr.error})`:''}</div>`:''}</td>
          <td>${a.projects.length?a.projects.map(pr=>html`<${Chip} cls="tag ok">${pr}<//> `):html`<span class="mut" style="font-size:11px">— unused</span>`}</td>
          <td style="min-width:70px"><${Bar} v=${l&&l.u5}/>${l?html`<div class="hint" style="font-size:10px">${live?'live':since(l.ts)}</div>`:''}</td>
          <td style="min-width:70px"><${Bar} v=${l&&l.u7}/>${l&&(l.s5==='allowed_warning'||l.s7==='allowed_warning')?html`<div class="warnp" style="font-size:10px">warning</div>`:''}</td>
          <td class="mono" style="font-size:12px">${l?rel(l.reset7):'—'}</td>
          <td class="mono" style="font-size:12px;white-space:nowrap">${nfmt(a.usage.calls)} calls<br/>
            <span class="mut">${nfmt(a.usage.tokens)} tok</span>
            ${a.usage.rateLimited>0?html`<br/><span class="down" style="font-size:11px" title="429s served to callers — with no fallback, each one is a failed request">${nfmt(a.usage.rateLimited)}× 429</span>`:''}</td>
          <td class="mono" style="font-size:12px;white-space:nowrap">${a.usage.calls24h?html`${nfmt(a.usage.calls24h)} calls<br/><span class="mut">${nfmt(a.usage.tokens24h)} tok</span>`:html`<span class="mut">idle</span>`}
            <div class="hint" style="font-size:10px">${since(a.usage.lastTs)}</div></td>
          <td style="width:1%"><button class="ghost sm" disabled=${!!busy} title="refresh this account's live window" onClick=${()=>refreshLimits(a.name)}>${busy===a.name?'…':'↻'}</button></td>
        </tr>`;
      })}
      ${d&&!accts.length?html`<tr><td colspan="8" class="hint">The account pool is empty — <code>claudecodeAccountPool</code> in <code>/data/config.json</code> holds the tokens.</td></tr>`:''}
    </table></div>
  </${Card}>`;
}

export { Pins, Bar, Accounts };
