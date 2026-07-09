import { html, render, h, useState, useEffect, useCallback, api, toast, nfmt, ago, Card, PageHead, useApp } from "../core.js";

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
    <h3>Project pins <small class="hint">— which subscription each app spends</small></h3>
    <p class="hint" style="margin:4px 0 12px">An <b>unpinned</b> project gets <code>403 no_account_for_project</code>. That is deliberate: the gateway never guesses whose Max plan to bill. ${state.defaultAccount?html`<b class="down">defaultAccount is set to "${state.defaultAccount}" — every unpinned or misspelled project silently bills it instead of 403'ing.</b>`:html`<code>defaultAccount</code> is empty, which is what keeps the 403 honest.`}</p>
    <div style="overflow:auto"><table>
      <tr><th>project</th><th>account</th><th></th></tr>
      ${names.length?names.map(p=>html`<tr key=${p}>
        <td class="mono"><b>${p}</b></td>
        <td><select disabled=${busy===p} value=${pins[p]} onChange=${e=>setPin(p,e.target.value)}>
          ${accounts.map(a=>html`<option value=${a} selected=${a===pins[p]}>${a}</option>`)}
        </select></td>
        <td><button class="ghost sm" disabled=${busy===p} onClick=${()=>setPin(p,null)}>Unpin</button></td>
      </tr>`):html`<tr><td colspan="3" class="hint">No pins — every claudecode call is 403'ing.</td></tr>`}
    </table></div>
    <div class="row" style="margin-top:12px">
      <input style="flex:2" placeholder="new project slug, e.g. promopilot" value=${np} onInput=${e=>setNp(e.target.value)} onKeyDown=${e=>e.key==='Enter'&&add()}/>
      <select style="flex:1" value=${na} onChange=${e=>setNa(e.target.value)}>${accounts.map(a=>html`<option value=${a}>${a}</option>`)}</select>
      <button style="flex:0 0 auto" disabled=${!!busy} onClick=${add}>Pin</button>
    </div>
  </${Card}>`;
}

/* Headroom bar. `null` is not 0% — it means nothing has been harvested for this account, and
   drawing an empty bar there would read as "plenty left" when the truth is "we have no idea". */
const Bar=({v})=>{
  if(v==null) return html`<div class="hint" style="font-size:11px">no reading</div>`;
  const p=Math.max(0,Math.min(100,Math.round(v*100)));
  const c=p>=90?'var(--red)':p>=70?'var(--amb)':'var(--grn)';
  return html`<div title=${p+'% used'}>
    <div style="height:6px;border-radius:3px;background:var(--card2);overflow:hidden">
      <div style=${`height:100%;width:${p}%;background:${c}`}></div>
    </div>
    <div class="mono" style="font-size:11px;color:${c};margin-top:2px">${p}%</div>
  </div>`;
};

/* One row per pool account — including the ones that have never served a call. The old view read
   acct_limits directly, which is keyed by Anthropic org-id, so an account with no traffic simply
   did not exist as far as the panel was concerned. */
function Accounts(){
  const {go}=useApp();
  const [d,setD]=useState(null); const [now,setNow]=useState(Date.now()); const [err,setErr]=useState('');
  const [probing,setProbing]=useState(''); const [probes,setProbes]=useState({});
  const load=useCallback(async()=>{ try{ const r=await api('accounts'); setD(r); setNow(r.now||Date.now()); setErr(''); }catch(e){ setErr(e.message||'load failed'); } },[]);
  useEffect(()=>{ load(); const t=setInterval(load,15000); return ()=>clearInterval(t); },[load]);
  const rel=ts=>{ if(!ts)return '—'; const ms=ts*1000-now; if(ms<=0)return 'now'; const h=ms/3600000; return h>=1?Math.round(h)+'h':Math.max(1,Math.round(ms/60000))+'m'; };
  const ago=ts=>{ if(!ts)return 'never'; const m=(now-ts)/60000; return m<1?'just now':m<60?Math.round(m)+'m ago':m<1440?Math.round(m/60)+'h ago':Math.round(m/1440)+'d ago'; };
  async function probe(name){
    setProbing(name||'all');
    try{
      const r=await api('claudecode/probe',{method:'POST',body:JSON.stringify(name?{account:name}:{all:true})});
      const list=name?[r]:(r.accounts||[]);
      const m={...probes}; list.forEach(x=>m[x.account]=x); setProbes(m);
      const dry=list.filter(x=>!x.usable.length).length;
      toast(`probed ${list.length} account(s) — ${dry} serving nothing`);
      load();
    }catch(e){ toast(e.message,true); } finally{ setProbing(''); }
  }
  const accts=(d&&d.accounts)||[];
  return html`
  <${PageHead} title="Accounts, pins & limits" onRefresh=${load}/>
  <${Pins}/>
  ${d&&d.orphanPins&&d.orphanPins.length?html`<${Card}>
    <p class="down" style="margin:0"><b>⚠ ${d.orphanPins.length} pin(s) name an account that is not in the pool</b> — every call from ${d.orphanPins.map(o=>o.project).join(', ')} 403s.
    ${d.orphanPins.map(o=>html` <code class="mono">${o.project} → ${o.account}</code>`)}</p>
  </${Card}>`:''}
  <${Card}>
    <div class="flex" style="justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">Pool <small class="hint">— ${accts.length} account(s), ${d?d.advertisedModels:'…'} advertised models</small></h3>
      <button class="ghost sm" disabled=${!!probing} onClick=${()=>probe(null)} title="ping every advertised model on every account (max_tokens:1 each)">${probing==='all'?'probing…':'⚡ Probe all accounts'}</button>
    </div>
    <p class="hint" style="margin:8px 0 0">The <b>5h</b>/<b>7d</b> bars are harvested free off the rate-limit headers of real traffic — zero probe tokens.
    <b class="warnp">Read them as a floor, not a verdict.</b> A <code>429</code> carries no <code>anthropic-ratelimit-*</code> headers, so an exhausted account teaches the table nothing and keeps its last good reading — often <code>0% · allowed</code>, harvested off a cheap model that still answers.
    <b>Probe</b> is the only honest column: it pings every advertised model. A <code>404</code> means the id does not exist; a <code>429</code> means it exists and the subscription is dry.</p>
    ${err?html`<p class="down">${err}</p>`:''}
    ${!d?html`<p class="hint">loading…</p>`:''}
    <div style="overflow:auto;margin-top:12px"><table>
      <tr><th>account</th><th>pinned projects</th><th>5h used</th><th>7d used</th><th>status</th><th>7d resets</th>
        <th title="all-time calls / tokens through this account">usage</th><th>last 24h</th><th>probe</th><th></th></tr>
      ${accts.map(a=>{
        const l=a.limits, p=probes[a.name]||a.probe;
        const dry=p&&p.usable&&!p.usable.length;
        return html`<tr key=${a.name}>
          <td class="mono"><b>${a.name}</b>${a.org?html`<div class="hint" style="font-size:10px" title=${a.org}>${a.org.slice(0,12)}…</div>`:html`<div class="hint" style="font-size:10px">org unknown</div>`}</td>
          <td>${a.projects.length?a.projects.map(pr=>html`<span class="pill" style="background:#2a3a2a;color:#8bc88b;margin:1px">${pr}</span>`):html`<span class="mut" style="font-size:11px">— unused</span>`}</td>
          <td style="min-width:70px"><${Bar} v=${l&&l.u5}/></td>
          <td style="min-width:70px"><${Bar} v=${l&&l.u7}/></td>
          <td style="font-size:12px">${!l?html`<span class="mut">—</span>`:(l.s7==='allowed_warning'||l.s5==='allowed_warning')?html`<span class="warnp">warning</span>`:html`<span class="mut">${l.status||'—'}</span>`}
            ${l?html`<div class="hint" style="font-size:10px">${ago(l.ts)}</div>`:''}</td>
          <td class="mono" style="font-size:12px">${l?rel(l.reset7):'—'}</td>
          <td class="mono" style="font-size:12px;white-space:nowrap">${nfmt(a.usage.calls)} calls<br/>
            <span class="mut">${nfmt(a.usage.tokens)} tok</span>
            ${a.usage.rateLimited>0?html`<br/><span class="down" style="font-size:11px">${nfmt(a.usage.rateLimited)}× 429</span>`:''}</td>
          <td class="mono" style="font-size:12px;white-space:nowrap">${a.usage.calls24h?html`${nfmt(a.usage.calls24h)} calls<br/><span class="mut">${nfmt(a.usage.tokens24h)} tok</span>`:html`<span class="mut">idle</span>`}
            <div class="hint" style="font-size:10px">${ago(a.usage.lastTs)}</div></td>
          <td style="font-size:12px">${!p?html`<span class="mut">not probed</span>`
            :dry?html`<span class="down"><b>DRY</b></span><div class="hint" style="font-size:10px">0/${p.total||p.results.length} models</div>`
            :html`<span class="up"><b>${p.usable.length}/${p.total||p.results.length}</b></span>
                  <div class="hint" style="font-size:10px" title=${p.usable.join(', ')}>${p.usable.slice(0,2).join(', ')}${p.usable.length>2?' +'+(p.usable.length-2):''}</div>`}</td>
          <td><button class="ghost sm" disabled=${!!probing} onClick=${()=>probe(a.name)}>${probing===a.name?'…':'Probe'}</button></td>
        </tr>`;
      })}
      ${d&&!accts.length?html`<tr><td colspan="10" class="hint">The account pool is empty — <code>claudecodeAccountPool</code> in <code>/data/config.json</code> holds the tokens.</td></tr>`:''}
    </table></div>
    <small class="hint">Model-by-model probe detail lives on <a href=${'/models'} onClick=${e=>{e.preventDefault();go('models');}}>Models</a>.</small>
  </${Card}>`;
}

export { Pins, Bar, Accounts };
