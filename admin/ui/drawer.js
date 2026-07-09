import { html, h, useState, useEffect, api, toast, nfmt, fmtMs, fmtTime, ProviderPill, StatusPill, KV } from "./core.js";

/* ───────── call drawer ───────── */
function CallDrawer({id,onClose}){
  const [c,setC]=useState(null);
  useEffect(()=>{ if(id==null){setC(null);return;} setC('loading');
    (async()=>{ try{ setC(await api('call?id='+id)); }catch(e){ setC({error:e.message}); } })();
  },[id]);
  useEffect(()=>{ const h=e=>{ if(e.key==='Escape')onClose(); }; window.addEventListener('keydown',h); return ()=>window.removeEventListener('keydown',h); },[onClose]);
  const open=id!=null;
  const copy=()=>{ if(c&&typeof c==='object'&&!c.error) navigator.clipboard.writeText(JSON.stringify(c,null,2)).then(()=>toast('copied call JSON')); };
  return html`
  <div class=${'dov'+(open?' open':'')} onClick=${onClose}></div>
  <aside class=${'drawer'+(open?' open':'')} aria-hidden=${!open}>
    <div class="drawer-hd">
      <div style="font-weight:600">${c&&c.id?html`Call #${c.id} <${StatusPill} status=${c.status} error=${c.error}/> <${ProviderPill} provider=${c.provider}/>`:'Call'}</div>
      <span style="flex:1"></span>
      <button class="ghost sm" onClick=${copy}>Copy JSON</button>
      <button class="ghost sm" onClick=${onClose}>✕</button>
    </div>
    <div class="drawer-bd">
      ${c==null||c==='loading'?html`<span class="mut">${c==='loading'?'loading…':''}</span>`
      : c.error?html`<span class="down">error: ${c.error}</span>`
      : html`
      <div class="dsec"><div class="dmeta">
        <${KV} n="when">${fmtTime(c.ts)}<//>
        <${KV} n="project">${c.project||'(none)'}<//>
        <${KV} n="model">${c.req_model||'-'}${c.sent_model&&c.sent_model!==c.req_model?html` <span class="mut">→ ${c.sent_model}</span>`:''}<//>
        <${KV} n="key">${c.key_label||'—'}<//>
        <${KV} n="latency">${fmtMs(c.duration_ms)}<//>
        <${KV} n="stream">${c.stream?'yes':'no'}<//>
        <${KV} n="tokens">${c.prompt_tokens??'?'} → ${c.completion_tokens??'?'} <span class="mut">(${c.total_tokens??'?'})</span><//>
        <${KV} n="effort">${c.effort?html`<span style="color:var(--amb)">🧠 ${c.effort}</span>`:'—'}<//>
        <${KV} n="thinking">${c.thinking_tokens==null?'—':c.thinking_tokens===0?'off':html`<span style="color:var(--acc)">💭 ${nfmt(c.thinking_tokens)} tok</span>`}<//>
        <${KV} n="max tokens">${c.max_tokens?nfmt(c.max_tokens):'—'}<//>
        <${KV} n="temperature">${c.temperature==null?'—':c.temperature}<//>
        <${KV} n="ip">${c.ip||'—'}<//>
      </div></div>
      ${c.error&&html`<div class="dsec"><div class="dlbl" style="color:var(--red)">error</div><div class="msgbox" style="color:var(--red)">${c.error}</div></div>`}
      <div class="dsec"><div class="dlbl">prompt</div><div class="msgbox">${c.req_content||'(not stored)'}</div></div>
      <div class="dsec"><div class="dlbl">reply</div><div class="msgbox">${c.resp_content||'(not stored)'}</div></div>
      ${c.ua&&html`<div class="dsec"><div class="dlbl">client · user-agent</div><div class="msgbox" style="max-height:none">${c.ua}</div></div>`}
      `}
    </div>
  </aside>`;
}


export { CallDrawer };
