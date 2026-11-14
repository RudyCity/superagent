/**
 * Remote Tray management frontend. No screenshots or input controls, only
 * authenticated handle inventory, exact session revocation and logout.
 */
export const REMOTE_TRAY_LOCK_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SuperAgent Tray · Protected management</title><link rel="stylesheet" href="/view.css"></head>
<body><main class="login-shell"><div class="eyebrow">SUPERAGENT / PRIVATE ACCESS</div>
<h1>Tray management</h1><p>Enter your separately configured Tray management password. Screen images and device input are not exposed here.</p>
<form action="/login" method="post" autocomplete="off">
<label for="password">Management password</label>
<input id="password" name="password" type="password" autocomplete="current-password" minlength="12" maxlength="128" required>
<button type="submit">Unlock management</button></form>
<small>Native approval remains required for viewing and input. Sessions expire automatically.</small></main></body></html>`;

export const REMOTE_TRAY_MANAGER_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SuperAgent Tray · Desktop Live</title><link rel="stylesheet" href="/view.css">
<script src="/view.js" defer></script></head><body><div class="shell">
<header><div><div class="eyebrow">SUPERAGENT TRAY / REMOTE MANAGEMENT</div><h1>Desktop Live</h1>
<p>Application windows, managed CDP and Delegate tabs. No screenshot or VNC stream.</p></div>
<div class="header-actions"><button type="button" id="refresh">Refresh</button><button type="button" id="logout" class="outline">Sign out</button></div>
</header><main><nav id="filters" aria-label="Filter handles">
<button type="button" data-kind="all" aria-pressed="true">All</button>
<button type="button" data-kind="native">Applications</button>
<button type="button" data-kind="managed-cdp">Chrome CDP</button>
<button type="button" data-kind="cdp-delegate">CDP Delegate</button></nav>
<div id="status" role="status" aria-live="polite">Authenticating session…</div>
<div id="list" class="items"></div></main>
<footer>Only session access can be revoked here. Windows, processes and tabs are not closed.</footer>
</div></body></html>`;

export const REMOTE_TRAY_CSS = `
:root{color-scheme:dark;--bg:#0d1117;--surface:#151c27;--line:#2a3544;--text:#f1f5fa;--muted:#a3b1c3;--accent:#a8c9fa;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);overflow-x:clip}
body{padding:clamp(18px,3vw,42px)}.shell{max-width:1100px;margin:0 auto}.eyebrow{letter-spacing:.12em;font-size:.69rem;font-weight:750;color:var(--accent)}
h1{font-size:clamp(1.7rem,3vw,2.5rem);font-weight:750;line-height:1.15;margin:.5rem 0}.shell header{display:flex;align-items:end;justify-content:space-between;gap:20px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:23px}
p{color:var(--muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}main{margin-top:24px}
button{font:inherit;border:1px solid var(--line);background:var(--accent);color:#111a25;border-radius:7px;padding:.68rem .9rem;font-weight:650;cursor:pointer;min-height:42px;white-space:nowrap}
button:hover{filter:brightness(1.08)}button:active{transform:translateY(1px)}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
button:disabled{opacity:.5;cursor:not-allowed}.outline,#filters button,.item button{background:transparent;color:var(--text)}
.header-actions{display:flex;gap:.6rem}#filters{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:20px}
#filters button[aria-pressed=true]{border-color:var(--accent);background:var(--surface)}
#status{color:var(--muted);font-size:.82rem;min-height:26px;margin-bottom:12px}.items{display:grid;gap:9px}
.item{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;display:grid;grid-template-columns:55px minmax(0,1fr) auto;gap:12px;align-items:center}
.kind{font-size:.7rem;font-weight:750;letter-spacing:.03em;text-align:center;padding:.6rem .3rem;background:var(--bg);border-radius:6px}
.item strong{overflow-wrap:anywhere;font-size:.96rem}.item small{display:block;color:var(--muted);font-size:.75rem;overflow-wrap:anywhere;margin-top:3px}
.status-badge{font-size:.7rem;padding:.2rem .38rem;margin-left:.5rem;border:1px solid var(--line);border-radius:5px}
.item button{font-size:.8rem}.login-shell{max-width:410px;margin:clamp(35px,9vw,110px) auto 0}
.login-shell form{display:grid;gap:12px;margin:25px 0}.login-shell label{font-size:.8rem;font-weight:650}
.login-shell input{padding:13px 14px;border-radius:7px;border:1px solid var(--line);background:var(--surface);color:var(--text);font:inherit;width:100%}
.login-shell small{color:var(--muted)}footer{padding:24px 0;color:var(--muted);font-size:.75rem}
@media(max-width:590px){.item{grid-template-columns:38px minmax(0,1fr)}.item button{grid-column:2;justify-self:start}.kind{font-size:.6rem}.header-actions{width:100%}.header-actions button{flex:1}}
`;

export const REMOTE_TRAY_JS = `"use strict";
(async function(){
  const $=id=>document.getElementById(id);
  const list=$("list"),status=$("status"),filters=$("filters");
  const session=await fetch("/api/session",{cache:"no-store",credentials:"same-origin"});
  if(!session.ok){location.assign("/");return;}
  const {csrf}=await session.json();
  let rows=[],kind="all",busy=false;
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
  async function post(path,body){
    return fetch(path,{method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"x-tray-csrf":csrf,"content-type":"application/json"},body:JSON.stringify(body)});
  }
  function draw(){
    list.replaceChildren();
    const selection=rows.filter(r=>kind==="all"||r.kind===kind);
    if(!selection.length){list.append(el("p","","No verified active handles in this category."));return;}
    for(const item of selection){
      const article=el("article","item"),glyph=el("span","kind",
        item.kind==="native"?"APP":item.kind==="managed-cdp"?"CDP":"DLG");
      const info=el("div"),title=el("strong","",item.title||"Untitled");
      title.append(el("span","status-badge",item.status));
      info.append(title,el("small","",item.application+" · "+item.handle));
      if(item.owner)info.append(el("small","","Owner: "+item.owner));
      article.append(glyph,info);
      if(item.stopAction){
        const btn=el("button","outline",item.stopAction==="takeover"?"Take over":
          item.stopAction==="stop-delegate-tab"?"Stop tab session":
          item.stopAction==="disconnect-profile"?"Disconnect profile":"Stop session");
        btn.type="button";btn.addEventListener("click",async()=>{
          if(busy)return;
          if(item.stopAction==="disconnect-profile"&&!confirm("Disconnect the whole Delegate profile? Browser tabs remain open."))return;
          busy=true;btn.disabled=true;status.textContent="Revoking session…";
          try{
            const req={id:item.id,...((item.stopAction==="takeover"||item.stopAction==="stop-delegate-tab")?{expectedRevision:item.revision}:{}),
              ...(item.stopAction==="disconnect-profile"?{confirmProfile:true}:{})};
            const response=await post("/api/stop",req);
            if(!response.ok)throw Error("Stop rejected");
            await load();
          }catch{status.textContent="Revocation not confirmed; refresh the handle before retrying.";}
          finally{btn.disabled=false;busy=false;}
        });
        article.append(btn);
      }else article.append(el("span","","Not controlled"));
      list.append(article);
    }
  }
  async function load(){
    status.textContent="Checking verified handles…";
    const response=await fetch("/api/inventory",{credentials:"same-origin",cache:"no-store"});
    if(!response.ok){rows=[];draw();status.textContent="Unable to read host inventory.";return;}
    const result=await response.json();rows=Array.isArray(result.items)?result.items:[];draw();
    status.textContent=rows.length+" handles listed. Only authenticated session controls are available.";
  }
  filters.addEventListener("click",event=>{
    const target=event.target.closest("button[data-kind]");if(!target)return;
    kind=target.dataset.kind;
    for(const node of filters.querySelectorAll("button"))node.setAttribute("aria-pressed",String(node===target));
    draw();
  });
  $("refresh").addEventListener("click",()=>void load());
  $("logout").addEventListener("click",async()=>{await post("/logout",{});location.assign("/");});
  await load();
})();
`;
