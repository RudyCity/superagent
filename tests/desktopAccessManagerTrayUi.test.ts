import {describe,expect,it,vi} from "vitest";
import vm from "node:vm";
import fs from "node:fs";
const code=fs.readFileSync("apps/superagent-tray/ui/access-manager.js","utf8");
const trayStyles=fs.readFileSync("apps/superagent-tray/ui/styles.css","utf8");
const accessManagerStyles=fs.readFileSync("apps/superagent-tray/ui/access-manager.css","utf8");
class Element {
  tagName:string;id="";className="";placeholder="";type="";#textContent="";title="";hidden=false;disabled=false;checked=false;
  tabIndex=0;
  rel="";href="";src="";readOnly=false;style:Record<string,string>={};dataset:Record<string,string>={};parentNode:Element|null=null;
  children:Element[]=[];events=new Map<string,Function>();attributes=new Map<string,string>();
  classList={add:(_c:string)=>{},remove:(_c:string)=>{},toggle:(_c:string,_b?:boolean)=>{}};
  #value:string|undefined;
  constructor(tag:string){this.tagName=tag.toLowerCase();}
  focus=vi.fn();
  get textContent():string{
    if(this.#textContent)return this.#textContent;
    return this.children.map(c=>c.textContent).join(" ");
  }
  set textContent(v:string){this.#textContent=v;}
  get value():string{
    if(this.#value!==undefined)return this.#value;
    return this.tagName==="select"?this.children[0]?.value||"":"";
  }
  set value(v:string){this.#value=v;}
  get firstChild(){return this.children[0]||null;}
  get lastChild(){return this.children[this.children.length-1]||null;}
  addEventListener(name:string,fn:Function){this.events.set(name,fn);}
  setAttribute(k:string,v:string){this.attributes.set(k,v);}
  append(...nodes:Element[]){for(const n of nodes){this.children.push(n);n.parentNode=this;}}
  appendChild(n:Element){this.append(n);return n;}
  replaceChildren(...nodes:Element[]){this.children=[];this.append(...nodes);}
  insertBefore(node:Element,old:Element){const i=this.children.indexOf(old);if(i<0)throw Error("not child");this.children.splice(i,0,node);node.parentNode=this;}
  click(){this.events.get("click")?.();}
  change(){this.events.get("change")?.();}
  input(e?:any){this.events.get("input")?.(e || {target:this});}
}
const discovered={pid:35416,nativeId:"10553336",title:"Antigravity editor",application:"Antigravity"};
const app={platform:"win32",executablePath:"C:\\Apps\\Antigravity.exe",sha256:"f".repeat(64)};
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function boot(nativeEnabled=true, mcpData?: {
  requests?: any[]; identities?: any[]; projects?: any[];
  requestResponses?: Promise<any>[];
  pendingRuleRequests?: any[];
  desktopUiRequests?: any[];
  connectedClients?: {success:boolean;state:string;clients:any[]|null;observedAt?:number};
  tools?: any[];
  failActions?: string[];
  decisionResults?: Record<string, any>;
  desktopUiDecisionResults?: Record<string, any>;
}){
  const parent=new Element("section");parent.id="settings-subpage-security";
  const old=new Element("section");old.id="desktop-trust-panel";parent.append(old);
  const listeners=new Map<string,Function>();
  const nativeEvents=new Map<string,Function>();
  let policy:any={version:2,defaultEffect:"deny",rules:[]};
  let auditLogs:any[]=[];
  const calls:{name:string,args:any}[]=[];
  const notifications:any[]=[];
  const notify=vi.fn((notification:any)=>{notifications.push(notification);return true;});
  const mcpRequests=mcpData?.requests || [];
  const mcpIdentities=mcpData?.identities || [];
  const mcpProjects=(mcpData?.projects || []).map(p=>({...p,enabled:p.enabled!==false,
    description:p.description||"",updatedAt:p.updatedAt??123456789}));
  const desktopUiRequests=(mcpData?.desktopUiRequests || []).map(request=>({...request}));
  const invoke=vi.fn(async(name:string,args:any)=>{
    calls.push({name,args});
    if(name==="desktop_ui_session_requests_action"){
      if(mcpData?.failActions?.includes("desktop_ui_requests"))
        throw Error("Desktop UI request service unavailable");
      if(args.action==="list")return {success:true,requests:desktopUiRequests.map(request=>({...request}))};
      if(["approve","deny"].includes(args.action)){
        const index=desktopUiRequests.findIndex(request=>request.requestId===args.requestId);
        if(index<0)throw Error("Desktop UI request not found");
        const override=mcpData?.desktopUiDecisionResults?.[args.action];
        if(override?.success===false)return override;
        desktopUiRequests[index]={...desktopUiRequests[index],
          status:args.action==="approve"?"approved":"denied",decidedAt:Date.now()};
        return override ?? {success:true,request:{...desktopUiRequests[index]}};
      }
    }
    if(name==="get_permanent_access_registry"){
      if(!nativeEnabled)throw Error("old Tray");
      return policy;
    }
    if(name==="list_desktop_input_windows")return {success:true,windows:[discovered]};
    if(name==="list_installed_desktop_apps")return [{name:"VS Code",executablePath:"C:\\Apps\\Code.exe"}];
    if(name==="pick_permanent_access_executable")return "C:\\Apps\\Notepad.exe";
    if(name==="pick_permanent_access_path"){
      return args.directory?"G:/project/tryout-online":"G:/project/tryout-online/.env";
    }
    if(name==="register_permanent_access_rule"){
      const ruleApp = args.executablePath
        ? {platform:"win32",executablePath:args.executablePath,sha256:"e".repeat(64)}
        : app;
      const ruleId = policy.rules.length === 0 ? "abc" : ("abc-" + (policy.rules.length + 1));
      const rule={
        id:ruleId,kind:args.kind,effect:args.effect,app:ruleApp,operations:args.operations,
        scope:args.kind==="file"
          ?{path:args.filePath,recursive:args.recursive}
          :args.exactWindow?{windowTitle:discovered.title}:{},
      };
      policy={...policy,rules:[...policy.rules,rule]};
      auditLogs.push({
        id:"audit-reg",
        timestamp:Date.now(),
        kind:args.kind,
        application:args.kind==="file"?"SuperAgent Core file tools":(args.executablePath?"VS Code":discovered.application),
        executablePath:ruleApp.executablePath,
        operation:args.operations.join(", "),
        target:args.kind==="file"?args.filePath:(args.exactWindow?discovered.title:"All windows"),
        effect:args.effect,
        ruleId:ruleId,
      });
      return policy;
    }
    if(name==="revoke_permanent_access_rule"){
      policy={...policy,rules:policy.rules.filter((r:any)=>r.id!==args.id)};
      auditLogs.push({
        id:"audit-rev",
        timestamp:Date.now(),
        kind:"rule_management",
        application:"Access Manager",
        executablePath:"SuperAgent Tray",
        operation:"revoke",
        target:args.id,
        effect:"deny",
        ruleId:args.id,
      });
      return policy;
    }
    if(name==="get_pending_active_rule_requests") {
      if(mcpData?.failActions?.includes("pending_rule_requests"))
        throw Error("Active-rule request service unavailable");
      return mcpData?.pendingRuleRequests ?? [];
    }
    if(name==="get_permanent_access_audit_log")return auditLogs;
    if(name==="clear_permanent_access_audit_log"){auditLogs=[];return true;}
    if(name==="mcp_project_access_action"){
      if(mcpData?.failActions?.includes(args.action)) throw Error("MCP Core unavailable");
      if(args.action==="requests") {
        const response=mcpData?.requestResponses?.shift();
        return response ?? {success:true,requests:mcpRequests.slice()};
      }
      if(args.action==="identities") return {success:true,identities:mcpIdentities};
      if(args.action==="projects") return {success:true,projects:mcpProjects.filter(p=>p.enabled)};
      if(args.action==="project_inventory") return {success:true,projects:mcpProjects};
      if(args.action==="tools"){
        const selected=Boolean(args.payload?.identityHandle && args.payload?.projectId);
        const demo=mcpData?.tools ?? [
          {name:"superagent_lan_capabilities",description:"LAN metadata",risk:"safe",
            approvalKind:"read_only",capability:null,hostReadiness:"certified_metadata",
            hostRequirement:"Metadata only.",hostBlocked:false,operationStatus:"recheck_at_execution",
            oauthScopesRequired:["mcp:tools"],grantState:"not_required"},
          {name:"superagent_exec_command",description:"Execute local terminal",risk:"dangerous",
            approvalKind:"project",capability:"execute",hostReadiness:"uncertified",
            hostRequirement:"Uncertified terminal under host v2.",hostBlocked:true,
            operationStatus:"host_uncertified",oauthScopesRequired:["mcp:tools","mcp:tools:write"]},
          {name:"superagent_git_action",description:"Git command",risk:"dangerous",
            approvalKind:"project",capability:null,capabilitiesByAction:{status:"read",diff:"read",log:"read",commit:"git",add:"git"},
            hostReadiness:"action_dependent",hostRequirement:"Check command arguments.",
            hostBlocked:false,operationStatus:"check_action_arguments",
            oauthScopesRequired:["mcp:tools","mcp:tools:write"]},
        ];
        const tools=demo.map(tool=>({
          ...tool,
          grantState:tool.grantState ?? (selected ? tool.capabilitiesByAction ? "action_dependent" : "missing" : "choose_identity_project"),
        }));
        return {success:true,registered:tools.length+12,active:tools.length,disabled:12,
          counts:{hostBlocked:tools.filter(t=>t.hostBlocked).length,
            missingProjectGrant:tools.filter(t=>t.grantState==="missing").length},
          tools};
      }
      if(args.action==="register_project"){
        const input=args.payload;
        const id=input.id||input.name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
        mcpProjects.push({projectId:id,name:input.name,type:input.type,
          target:input.root||input.target,description:input.description||"",
          enabled:true,updatedAt:123456789});
        return {success:true,project:{projectId:id},capabilitiesGranted:false};
      }
      if(args.action==="update_project"){
        const input=args.payload;const project=mcpProjects.find(p=>p.projectId===input.projectId);
        if(!project || input.expectedUpdatedAt!==project.updatedAt)throw Error("PROJECT_STALE_REVISION");
        Object.assign(project,{
          name:input.name??project.name,description:input.description??project.description,
          enabled:input.enabled??project.enabled,target:input.root||input.target||project.target,
          updatedAt:project.updatedAt+1,
        });
        return {success:true,project:{...project},capabilitiesGranted:false};
      }
      if(args.action==="remove_project"){
        const input=args.payload;const index=mcpProjects.findIndex(p=>p.projectId===input.projectId);
        if(index<0||mcpProjects[index].updatedAt!==input.expectedUpdatedAt)
          throw Error("PROJECT_STALE_REVISION");
        mcpProjects.splice(index,1);
        return {success:true,projectId:input.projectId,capabilitiesGranted:false};
      }
      if(args.action==="connected_clients") return mcpData?.connectedClients ??
        {success:true,state:"unavailable",clients:null};
      if(["approve","deny","revoke","direct_grant"].includes(args.action))
        return mcpData?.decisionResults?.[args.action] ?? {success:true};
    }
    throw Error("unknown native command");
  });
  const document={
    readyState:"complete",
    getElementById(id:string):Element|null{
      const walk=(n:Element):Element|null=>n.id===id?n:n.children.map(walk).find(Boolean)||null;
      return walk(parent);
    },
    createElement:(tag:string)=>new Element(tag),
  };
  const window:any={__TAURI__:{core:{invoke},event:{listen:(k:string,f:Function)=>nativeEvents.set(k,f)}},
    TrayFeedback:{notify},addEventListener:(k:string,f:Function)=>listeners.set(k,f),
    confirm:vi.fn(()=>true)};
  vm.runInNewContext(code,{document,window,location:{hash:"#settings"},
    Number,String,Array,Object,Boolean,Error,Promise,Date,Math});
  return {document,parent,old,calls,invoke,listeners,nativeEvents,window,mcpRequests,notifications,notify,getPolicy:()=>policy};
}
describe("real permanent Access Manager Tray panel",()=>{
  it("mounts only after native v2 registry verified and shows zero-grant onboarding",async()=>{
    const ui=boot();await flush();
    expect(ui.old.hidden).toBe(true);
    expect(ui.document.getElementById("access-manager")).not.toBeNull();
    expect(ui.document.getElementById("access-onboarding")?.hidden).toBe(false);
    expect(ui.document.getElementById("access-app-list")?.children.length).toBe(1);
    const legacy=boot(false);await flush();
    expect(legacy.old.hidden).toBe(false);
    expect(legacy.document.getElementById("access-manager")).toBeNull();
  });
  it("registers only a live target through native host and revokes without expiry",async()=>{
    const ui=boot();await flush();
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-submit")!.click();await flush();
    const register=ui.calls.find(c=>c.name==="register_permanent_access_rule");
    expect(register?.args).toMatchObject({pid:35416,nativeId:"10553336",effect:"allow",
      kind:"desktop",operations:["view","input"],exactWindow:false,
      elementRole:null,elementLabel:null});
    expect(ui.getPolicy().rules).toHaveLength(1);
    expect(ui.document.getElementById("access-onboarding")!.hidden).toBe(true);
    const rows=ui.document.getElementById("access-rule-list")!.children;
    expect(rows[0].children[1].children.some((c:any)=>c.className==="access-rule-path" && c.textContent.includes("Antigravity.exe"))).toBe(true);
    rows[0].lastChild!.click();await flush();
    expect(ui.calls.some(c=>c.name==="revoke_permanent_access_rule" && c.args.id==="abc")).toBe(true);
    expect(ui.getPolicy().rules).toHaveLength(0);
  });
  it("binds file rules to native picker and Core file-tool registration",async()=>{
    const ui=boot();await flush();
    const select=ui.document.getElementById("access-kind")!;
    select.value="file";select.change();
    expect(ui.document.getElementById("access-submit")!.disabled).toBe(true);
    expect(ui.document.getElementById("access-file-controls")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-file-path")!.readOnly).toBe(true);
    ui.document.getElementById("access-pick-folder")!.click();await flush();
    expect(ui.document.getElementById("access-file-path")!.value).toContain("tryout-online");
    expect(ui.document.getElementById("access-file-recursive")!.checked).toBe(true);
    expect(ui.document.getElementById("access-submit")!.disabled).toBe(false);
    ui.document.getElementById("access-submit")!.click();await flush();
    expect(ui.calls.some(c=>c.name==="register_permanent_access_rule" &&
      c.args.kind==="file" && c.args.pid===0 && c.args.nativeId==="" &&
      c.args.operations.includes("read") && c.args.recursive===true)).toBe(true);
  });
  it("filters rules by category tabs and rule search query",async()=>{
    const ui=boot();await flush();
    // Register desktop rule
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-submit")!.click();await flush();
    // Register file rule
    const select=ui.document.getElementById("access-kind")!;
    select.value="file";select.change();
    ui.document.getElementById("access-pick-folder")!.click();await flush();
    ui.document.getElementById("access-submit")!.click();await flush();

    expect(ui.getPolicy().rules).toHaveLength(2);
    expect(ui.document.getElementById("access-rule-list")!.children).toHaveLength(2);

    // Switch to desktop tab
    ui.document.getElementById("access-tab-desktop")!.click();
    expect(ui.document.getElementById("access-rule-list")!.children).toHaveLength(1);

    // Switch to file tab
    ui.document.getElementById("access-tab-file")!.click();
    expect(ui.document.getElementById("access-rule-list")!.children).toHaveLength(1);

    // Switch back to all
    ui.document.getElementById("access-tab-all")!.click();
    expect(ui.document.getElementById("access-rule-list")!.children).toHaveLength(2);

    // Search query filter
    const search=ui.document.getElementById("access-rule-search")!;
    search.value="tryout-online";
    search.input();
    expect(ui.document.getElementById("access-rule-list")!.children).toHaveLength(1);

    search.value="nonexistent_app";
    search.input();
    expect(ui.document.getElementById("access-rule-list")!.children[0].textContent).toContain("Tidak ada aturan");
  });
  it("renders operation chip badges and kind badges for registered rules",async()=>{
    const ui=boot();await flush();
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-submit")!.click();await flush();

    const row=ui.document.getElementById("access-rule-list")!.children[0];
    const headerLine=row.children[1].children[0];
    expect(headerLine.children.some((c:any)=>c.className?.includes("access-scope-badge desktop"))).toBe(true);
    expect(headerLine.children.some((c:any)=>c.className?.includes("access-op-chips"))).toBe(true);
  });
  it("displays native access audit trail and allows clearing logs",async()=>{
    const ui=boot();await flush();
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-submit")!.click();await flush();

    const auditList=ui.document.getElementById("access-audit-list")!;
    expect(auditList.children.length).toBeGreaterThan(0);
    expect(auditList.children[0].className).toContain("access-audit-row");

    // Clear logs
    ui.document.getElementById("access-audit-clear")!.click();await flush();
    expect(ui.calls.some(c=>c.name==="clear_permanent_access_audit_log")).toBe(true);
    expect(auditList.children[0].textContent).toContain("Belum ada rekaman audit");
  });
});

describe("element-specific UI enrollment",()=>{
  it("passes host-entered exact role and label into native approval, not core grants",async()=>{
    const ui=boot();await flush();
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-element-role")!.value="button";
    ui.document.getElementById("access-element-label")!.value="OK";
    ui.document.getElementById("access-submit")!.click();
    await flush();
    expect(ui.calls.some(c=>c.name==="register_permanent_access_rule" &&
      c.args.elementRole==="button" && c.args.elementLabel==="OK")).toBe(true);
  });
  it("rejects an element label without a role before invoking native",async()=>{
    const ui=boot();await flush();
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-element-label")!.value="Password";
    ui.document.getElementById("access-submit")!.click();
    await flush();
    expect(ui.calls.some(c=>c.name==="register_permanent_access_rule")).toBe(false);
  });
});

describe("installed applications enrollment and discovery", () => {
  it("switches to Terinstall tab, lists installed applications, and registers with executablePath", async () => {
    const ui = boot();
    await flush();

    const tabInstalled = ui.document.getElementById("access-src-installed")!;
    expect(tabInstalled).not.toBeNull();
    tabInstalled.click();
    await flush();

    const list = ui.document.getElementById("access-app-list")!;
    expect(list.children.length).toBe(1);
    expect(list.children[0].textContent).toContain("VS Code");
    expect(list.children[0].textContent).toContain("C:\\Apps\\Code.exe");

    // Click installed app row
    list.children[0].click();
    expect(ui.document.getElementById("access-selected-title")?.textContent).toBe("VS Code");
    expect(ui.document.getElementById("access-selected-subtitle")?.textContent).toContain("Code.exe");
    expect(ui.document.getElementById("access-exact")?.disabled).toBe(true);

    // Register rule
    ui.document.getElementById("access-submit")!.click();
    await flush();

    const registerCall = ui.calls.find(c => c.name === "register_permanent_access_rule" && c.args.executablePath === "C:\\Apps\\Code.exe");
    expect(registerCall).toBeDefined();
    expect(registerCall?.args).toMatchObject({
      pid: 0,
      nativeId: "",
      executablePath: "C:\\Apps\\Code.exe",
      kind: "desktop",
      effect: "allow",
      exactWindow: false,
    });
    expect(ui.getPolicy().rules).toHaveLength(1);
    expect(ui.getPolicy().rules[0].app.executablePath).toBe("C:\\Apps\\Code.exe");
  });

  it("allows browsing and selecting any executable via pick_permanent_access_executable", async () => {
    const ui = boot();
    await flush();

    const pickExeBtn = ui.document.getElementById("access-pick-exe")!;
    expect(pickExeBtn).not.toBeNull();
    pickExeBtn.click();
    await flush();

    expect(ui.calls.some(c => c.name === "pick_permanent_access_executable")).toBe(true);
    expect(ui.document.getElementById("access-selected-title")?.textContent).toBe("Notepad");
    expect(ui.document.getElementById("access-selected-subtitle")?.textContent).toContain("Notepad.exe");

    // Register picked executable
    ui.document.getElementById("access-submit")!.click();
    await flush();

    const reg = ui.calls.find(c => c.name === "register_permanent_access_rule" && c.args.executablePath === "C:\\Apps\\Notepad.exe");
    expect(reg).toBeDefined();
    expect(reg?.args.pid).toBe(0);
    expect(ui.getPolicy().rules[0].app.executablePath).toBe("C:\\Apps\\Notepad.exe");
  });
});

describe("Security Approval Manager tab navigation and grouping", () => {
  it("opens on Request Center with accurate initial badges and active pane", async () => {
    const ui = boot();
    await flush();

    const tabRequests = ui.document.getElementById("access-nav-tab-requests");
    const tabReg = ui.document.getElementById("access-nav-tab-register");
    const tabRules = ui.document.getElementById("access-nav-tab-rules");
    const tabAudit = ui.document.getElementById("access-nav-tab-audit");
    expect(tabRequests).not.toBeNull();
    expect(tabReg).not.toBeNull();
    expect(tabRules).not.toBeNull();
    expect(tabAudit).not.toBeNull();

    expect(tabRequests?.className).toContain("active");
    expect(tabRequests?.attributes.get("aria-selected")).toBe("true");
    expect(tabRequests?.tabIndex).toBe(0);
    expect(tabReg?.className).not.toContain("active");
    expect(tabReg?.attributes.get("aria-selected")).toBe("false");
    expect(tabReg?.tabIndex).toBe(-1);
    expect(tabRules?.className).not.toContain("active");
    expect(tabAudit?.className).not.toContain("active");

    const badgeRules = ui.document.getElementById("access-tab-badge-rules");
    expect(badgeRules?.textContent).toBe("0");

    const paneRequests = ui.document.getElementById("access-pane-requests");
    const paneReg = ui.document.getElementById("access-pane-register");
    const paneRules = ui.document.getElementById("access-pane-rules");
    const paneAudit = ui.document.getElementById("access-pane-audit");
    expect(paneRequests?.hidden).toBe(false);
    expect(paneReg?.hidden).toBe(true);
    expect(paneRules?.hidden).toBe(true);
    expect(paneAudit?.hidden).toBe(true);
  });

  it("switches between tabs and activates corresponding panels on click", async () => {
    const ui = boot();
    await flush();

    // Click Aturan Terdaftar
    ui.document.getElementById("access-nav-tab-rules")!.click();
    expect(ui.document.getElementById("access-pane-rules")?.hidden).toBe(false);
    expect(ui.document.getElementById("access-pane-register")?.hidden).toBe(true);
    expect(ui.document.getElementById("access-pane-audit")?.hidden).toBe(true);
    expect(ui.document.getElementById("access-nav-tab-rules")?.className).toContain("active");
    expect(ui.document.getElementById("access-nav-tab-register")?.className).not.toContain("active");

    // Click Log Audit
    ui.document.getElementById("access-nav-tab-audit")!.click();
    expect(ui.document.getElementById("access-pane-audit")?.hidden).toBe(false);
    expect(ui.document.getElementById("access-pane-rules")?.hidden).toBe(true);
    expect(ui.document.getElementById("access-pane-register")?.hidden).toBe(true);
    expect(ui.document.getElementById("access-nav-tab-audit")?.className).toContain("active");

    // Click Daftarkan Izin
    ui.document.getElementById("access-nav-tab-register")!.click();
    expect(ui.document.getElementById("access-pane-register")?.hidden).toBe(false);
    expect(ui.document.getElementById("access-pane-rules")?.hidden).toBe(true);
    expect(ui.document.getElementById("access-pane-audit")?.hidden).toBe(true);
    expect(ui.document.getElementById("access-nav-tab-register")?.className).toContain("active");
  });

  it("dynamically updates tab badges when rules and audit logs are modified", async () => {
    const ui = boot();
    await flush();

    // Register a rule
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-submit")!.click();
    await flush();

    const badgeRules = ui.document.getElementById("access-tab-badge-rules");
    expect(badgeRules?.textContent).toBe("1");

    const badgeAudit = ui.document.getElementById("access-tab-badge-audit");
    expect(Number(badgeAudit?.textContent)).toBeGreaterThan(0);

    // Switch to rules tab and revoke rule
    ui.document.getElementById("access-nav-tab-rules")!.click();
    const rows = ui.document.getElementById("access-rule-list")!.children;
    rows[0].lastChild!.click();
    await flush();

    expect(badgeRules?.textContent).toBe("0");
  });
});

describe("host rules and MCP project access stay independent", () => {
  it("explains both authorization layers and navigates in both directions without granting", async () => {
    const ui=boot(true,{identities:[{identityHandle:"idh_test",subject:"ChatGPT",mode:"oauth",scopes:["mcp:tools:write"]}],
      projects:[{projectId:"superagent",name:"SuperAgent",type:"local",enabled:true,target:"D:/superagent"}]});
    await flush();
    const host=ui.document.getElementById("access-host-boundary")!;
    expect(host.textContent).toContain("Ini bukan izin agent atas proyek");
    expect(ui.document.getElementById("access-host-file-rule-count")!.textContent).toContain("0 aturan aktif file/folder");

    ui.document.getElementById("access-host-open-project")!.click(); await flush();
    expect(ui.document.getElementById("access-pane-mcp")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-pane-register")!.hidden).toBe(true);
    const grant=ui.document.getElementById("access-mcp-direct-grant-form")!;
    expect(ui.document.getElementById("access-project-host-boundary")!.textContent)
      .toContain("lapisan perlindungan kedua");
    expect(ui.document.getElementById("access-mcp-project-grant")!.parentNode).toBe(grant);
    expect(ui.document.getElementById("access-project-host-file-rule-count")!.textContent)
      .toContain("0 aturan aktif file/folder");
    expect(ui.document.getElementById("access-pane-mcp")!.textContent)
      .toContain("Otorisasi koneksi OAuth saja tidak memberi izin operasi");

    ui.document.getElementById("access-project-open-file-editor")!.click();
    expect(ui.document.getElementById("access-pane-register")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-kind")!.value).toBe("file");
    expect(ui.document.getElementById("access-file-controls")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-file-path")!.value).toBe("");
    expect(ui.calls.filter(call => ["register_permanent_access_rule","direct_grant"].includes(
      call.name==="mcp_project_access_action"?call.args.action:call.name))).toHaveLength(0);
  });

  it("uses the same host file filter from either tab, updates rule counts, and never auto-grants a project", async () => {
    const ui=boot();await flush();
    ui.document.getElementById("access-kind")!.value="file";
    ui.document.getElementById("access-kind")!.change();
    ui.document.getElementById("access-pick-folder")!.click();await flush();
    ui.document.getElementById("access-submit")!.click();await flush();
    expect(ui.getPolicy().rules).toHaveLength(1);
    expect(ui.document.getElementById("access-host-file-rule-count")!.textContent)
      .toContain("1 aturan aktif file/folder tercatat (lapisan kontrol kedua).");
    expect(ui.document.getElementById("access-project-host-file-rule-count")!.textContent)
      .toContain("1 aturan aktif file/folder tercatat (lapisan kontrol kedua).");

    ui.document.getElementById("access-host-open-file-rules")!.click();
    expect(ui.document.getElementById("access-pane-rules")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-tab-file")!.className).toContain("active");
    expect(ui.document.getElementById("access-pane-rules")!.textContent)
      .toContain("Bukan daftar grant MCP per proyek");

    ui.document.getElementById("access-nav-tab-mcp")!.click();await flush();
    ui.document.getElementById("access-project-open-file-rules")!.click();
    expect(ui.document.getElementById("access-pane-rules")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-tab-file")!.className).toContain("active");
    expect(ui.calls.some(call => call.name==="mcp_project_access_action" &&
      ["direct_grant","approve"].includes(call.args.action))).toBe(false);
  });
});

describe("main navigation promotion", () => {
  it("exposes Security Approval in the primary sidebar navigation menu", () => {
    const html = fs.readFileSync("apps/superagent-tray/ui/index.html", "utf8");
    const appJs = fs.readFileSync("apps/superagent-tray/ui/app.js", "utf8");
    expect(html).toContain('id="nav-security"');
    expect(html).toContain('href="#security"');
    expect(html).toContain('data-page="security"');
    expect(html).toContain('id="page-security"');
    expect(html).toContain('id="page-security-container"');
    expect(appJs).toContain('"security"');
    expect(appJs).toMatch(/validPages\s*=\s*\[[^\]]*"security"[^\]]*\]/);
  });
});


describe("independent MCP Connections and Project Access UI", () => {
  const handle="idh_0123456789abcdef";
  const fixtures = {
    identities:[{identityHandle:handle,subject:"Gemini client",mode:"oauth",scopes:["mcp:tools:write"]}],
    projects:[
      {projectId:"superagent",name:"SuperAgent",type:"local",enabled:true,target:"D:/superagent"},
      {projectId:"disabled",name:"Unavailable",type:"local",enabled:false,target:"D:/disabled"},
    ],
    requests:[
      {requestId:"req_project",projectId:"superagent",projectName:"SuperAgent",
        projectPath:"D:/superagent",subject:"Gemini client",mode:"oauth",status:"pending",
        capabilities:["read","write"],reason:"Review source files",createdAt:1700000000000},
      {requestId:"req_connection",projectId:"mcp-connection",projectName:"MCP Connection Controls",
        projectPath:"mcp://connection",subject:"Gemini client",mode:"oauth",status:"pending",
        capabilities:["execute"],reason:"Run approved MCP operations",createdAt:1700000000000},
    ],
  };

  it("separates the MCP connection and project approval views", async () => {
    const ui=boot(true,fixtures);await flush();
    const connection=ui.document.getElementById("access-pane-connections")!;
    const project=ui.document.getElementById("access-pane-mcp")!;
    expect(connection).not.toBeNull();
    expect(project).not.toBeNull();
    expect(connection.hidden).toBe(true);
    ui.document.getElementById("access-nav-tab-connections")!.click();await flush();
    expect(connection.hidden).toBe(false);
    expect(project.hidden).toBe(true);
    ui.document.getElementById("access-nav-tab-mcp")!.click();await flush();
    expect(connection.hidden).toBe(true);
    expect(project.hidden).toBe(false);
    expect(ui.document.getElementById("access-mcp-pending-list")).toBeNull();
    expect(ui.document.getElementById("access-req-center-incoming-list")!.children).toHaveLength(1);
    expect(ui.document.getElementById("access-mcp-connection-pending-list")).toBeNull();
    expect(connection.textContent).toContain("alur OAuth MCP owner");
  });

  it("loads both pending approval lists from their own Load buttons without granting access", async () => {
    const ui = boot(true, fixtures);
    await flush();
    const project = ui.document.getElementById("access-mcp-projects-refresh")!;
    const connection = ui.document.getElementById("access-mcp-connection-pending-load")!;
    expect(project.textContent).toBe("Muat ulang");
    expect(connection.textContent).toBe("Load");
    const requestCallCount = () => ui.calls.filter(c =>
      c.name === "mcp_project_access_action" && c.args.action === "requests").length;
    const initialCalls = requestCallCount();
    project.click();
    expect(connection.disabled).toBe(true);
    await flush();
    expect(project.disabled).toBe(false);
    expect(connection.disabled).toBe(false);
    expect(project.textContent).toBe("Muat ulang");
    expect(requestCallCount()).toBe(initialCalls + 1);
    connection.click();
    await flush();
    expect(requestCallCount()).toBe(initialCalls + 2);
    expect(ui.document.getElementById("access-req-center-incoming-count")!.textContent).toBe("1 permintaan");
    expect(ui.document.getElementById("access-tab-badge-connections")!.textContent).toBe("0");
    expect(ui.calls.some(c => c.name === "mcp_project_access_action" &&
      ["approve", "deny", "direct_grant"].includes(c.args.action))).toBe(false);
  });

  it("shows a success toast only after Core confirms project access approval", async () => {
    const ui = boot(true, fixtures);
    await flush();
    const list = ui.document.getElementById("access-req-center-incoming-list")!;
    const card = list.children[0];
    const actions = card.children[card.children.length - 1];
    actions.children[0].click();
    await flush();

    expect(ui.calls.some(c => c.name === "mcp_project_access_action" &&
      c.args.action === "approve" && c.args.payload.requestId === "req_project")).toBe(true);
    expect(ui.notify).toHaveBeenCalledWith({
      kind: "success",
      message: "Persetujuan SuperAgent berhasil.",
      scope: "security",
      dedupeKey: "mcp-project-access:req_project:success",
    });
  });

  it("shows an error toast when Core rejects project access approval", async () => {
    const ui = boot(true, {
      ...fixtures,
      decisionResults: {approve:{success:false,error:"Access request is no longer pending"}},
    });
    await flush();
    const list = ui.document.getElementById("access-req-center-incoming-list")!;
    const card = list.children[0];
    const actions = card.children[card.children.length - 1];
    actions.children[0].click();
    await flush();

    expect(ui.notify).toHaveBeenCalledWith({
      kind: "error",
      message: "Persetujuan SuperAgent gagal. Lihat detail pada Access Manager.",
      scope: "security",
      dedupeKey: "mcp-project-access:req_project:error",
    });
  });

  it("shows an error toast when the native approval action fails", async () => {
    const ui = boot(true, {...fixtures, failActions:["approve"]});
    await flush();
    const list = ui.document.getElementById("access-req-center-incoming-list")!;
    const card = list.children[0];
    const actions = card.children[card.children.length - 1];
    actions.children[0].click();
    await flush();

    expect(ui.notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: "error",
      message: "Persetujuan SuperAgent gagal. Lihat detail pada Access Manager.",
      scope: "security",
      dedupeKey: "mcp-project-access:req_project:error",
    }));
  });


  it("re-enables section Load buttons when Core request loading fails", async () => {
    const ui = boot(true, {...fixtures, failActions: ["requests"]});
    await flush();
    const load = ui.document.getElementById("access-mcp-connection-pending-load")!;
    load.click();
    expect(load.disabled).toBe(true);
    await flush();
    expect(load.disabled).toBe(false);
    expect(load.textContent).toBe("Load");
    expect(ui.document.getElementById("access-mcp-connection-load-error")!.hidden).toBe(true);
    expect(ui.document.getElementById("access-mcp-project-load-error")!.hidden).toBe(false);
  });

  it("shows live MCP sessions even when there is no Core-approved identity", async () => {
    const ui=boot(true,{
      requests:[],identities:[],projects:[],
      connectedClients:{success:true,state:"verified",observedAt:Date.now(),clients:[
        {sessionHandle:"ses_aaaaaaaaaaaa",principalHandle:"idh_1111111111111111",
          authMode:"oauth",state:"idle",inFlight:0,lastSeenAt:Date.now(),
          claimedClientName:"ChatGPT",claimedClientVersion:"1.0"},
        {sessionHandle:"ses_bbbbbbbbbbbb",principalHandle:"idh_1111111111111111",
          authMode:"oauth",state:"active",inFlight:1,lastSeenAt:Date.now(),
          claimedClientName:"ChatGPT",claimedClientVersion:"1.0"}
      ]}
    });await flush();
    ui.document.getElementById("access-nav-tab-connections")!.click();await flush();
    expect(ui.document.getElementById("access-mcp-live-summary")!.textContent)
      .toContain("2 sesi · 1 identitas");
    const rows=ui.document.getElementById("access-mcp-live-list")!.children;
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("ChatGPT (nama dari klien)");
    expect(rows[0].textContent).toContain("OAuth");
    expect(rows[1].textContent).toContain("ses_bbbbbbbbbbbb");
    expect(ui.document.getElementById("access-mcp-connection-identity")).toBeNull();
    expect(ui.document.getElementById("access-mcp-connection-grant")).toBeNull();
    expect(ui.document.getElementById("access-tab-badge-connections")!.textContent).toBe("2");
    expect(ui.calls.some(c=>c.name==="mcp_project_access_action" &&
      c.args.action==="direct_grant")).toBe(false);
    expect(ui.calls.some(c=>c.name==="mcp_project_access_action" &&
      c.args.action==="connected_clients")).toBe(true);
  });

  it("registers ChatGPT and Gemini as separate credential connections on one MCP endpoint", async () => {
    const now = Date.now();
    const ui = boot(true, {
      requests: [], identities: [], projects: [],
      connectedClients: {
        success: true, state: "verified", registrationState: "verified",
        observedAt: now,
        clients: [
          {sessionHandle:"ses_aaaaaaaaaaaa",principalHandle:"idh_1111111111111111",
            authMode:"oauth",state:"idle",inFlight:0,lastSeenAt:now,
            claimedClientName:"ChatGPT",claimedClientVersion:"1.0"},
          {sessionHandle:"ses_bbbbbbbbbbbb",principalHandle:"idh_1111111111111111",
            authMode:"oauth",state:"active",inFlight:1,lastSeenAt:now,
            claimedClientName:"ChatGPT",claimedClientVersion:"1.0"},
          {sessionHandle:"ses_cccccccccccc",principalHandle:"idh_2222222222222222",
            authMode:"oauth",state:"idle",inFlight:0,lastSeenAt:now,
            claimedClientName:"Gemini",claimedClientVersion:"1.0"},
        ],
        registeredConnections: [
          {connectionHandle:"idh_1111111111111111",ownerPort:9227,authMode:"oauth",
            reportedClientName:"ChatGPT",firstObservedAt:now-1000,lastObservedAt:now,
            sessionCount:2,status:"connected"},
          {connectionHandle:"idh_2222222222222222",ownerPort:9227,authMode:"oauth",
            reportedClientName:"Gemini",firstObservedAt:now-1000,lastObservedAt:now,
            sessionCount:1,status:"connected"},
        ],
      },
    });
    await flush();
    ui.document.getElementById("access-nav-tab-connections")!.click(); await flush();
    expect(ui.document.getElementById("access-mcp-registered-summary")!.textContent)
      .toContain("2 koneksi · 2 terhubung");
    const cards = ui.document.getElementById("access-mcp-registered-list")!.children;
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("ChatGPT");
    expect(cards[0].textContent).toContain("2 sesi");
    expect(cards[1].textContent).toContain("Gemini");
    expect(cards[1].textContent).toContain("1 sesi");
    // A session sighting MUST NOT authorize a new MCP identity or direct grant.
    expect(ui.document.getElementById("access-mcp-connection-grant")).toBeNull();
    expect(ui.calls.some(c => c.name === "mcp_project_access_action" &&
      c.args?.action === "direct_grant")).toBe(false);
  });

  it("shows the one-time OAuth owner name in MCP requests, live connections and registry", async()=>{
    const now=Date.now();
    const label="ChatGPT - Laptop Rudy";
    const pending={...fixtures.requests[1],ownerConnectionName:label};
    const ui=boot(true,{
      ...fixtures,requests:[pending],
      connectedClients:{
        success:true,state:"verified",registrationState:"verified",observedAt:now,
        clients:[{sessionHandle:"ses_aaaaaaaaaaaa",principalHandle:"idh_1111111111111111",
          authMode:"oauth",state:"idle",inFlight:0,lastSeenAt:now,
          claimedClientName:"A different client name",ownerConnectionName:label,
          claimedClientVersion:"1.0"}],
        registeredConnections:[{connectionHandle:"idh_1111111111111111",ownerPort:9227,
          authMode:"oauth",reportedClientName:"A different client name",ownerConnectionName:label,
          firstObservedAt:now-1000,lastObservedAt:now,sessionCount:1,status:"connected"}],
      },
    });await flush();
    // Legacy virtual Execute requests must not appear as new OAuth connection approvals.
    expect(ui.document.getElementById("access-mcp-connection-pending-list")).toBeNull();
    const online=ui.document.getElementById("access-mcp-live-list")!;
    expect(online.textContent).toContain(label);
    expect(online.textContent).toContain("Aplikasi melaporkan: A different client name");
    const registered=ui.document.getElementById("access-mcp-registered-list")!;
    expect(registered.textContent).toContain(label);
    expect(registered.textContent).toContain("nama dari persetujuan OAuth");
    expect(ui.calls.some(c=>c.name==="mcp_project_access_action" &&
      c.args?.action==="approve")).toBe(false);
  });

  it("retains redacted registration history but never calls it online after owner failure", async () => {
    const now = Date.now();
    const ui = boot(true, {
      requests: [], identities: [], projects: [],
      connectedClients: {
        success: true, state: "unavailable", registrationState: "unverified",
        clients: null, registeredConnections: [
          {connectionHandle:"idh_1111111111111111",ownerPort:9227,authMode:"oauth",
            reportedClientName:"ChatGPT",firstObservedAt:now-1000,
            lastObservedAt:now,sessionCount:0,status:"disconnected"},
        ],
      },
    }); await flush();
    expect(ui.document.getElementById("access-mcp-registered-summary")!.textContent)
      .toContain("status tidak terverifikasi");
    expect(ui.document.getElementById("access-mcp-registered-list")!.textContent)
      .not.toContain("Terhubung");
  });

  it("does not mistake unavailable or invalid session inventory for zero sessions", async () => {
    const unavailable=boot(true,{requests:[],identities:[],projects:[]});await flush();
    expect(unavailable.document.getElementById("access-mcp-live-summary")!.textContent)
      .toBe("Tidak tersedia");
    expect(unavailable.document.getElementById("access-mcp-live-list")!.textContent)
      .toContain("bukan bukti bahwa MCP terputus");

    const invalid=boot(true,{connectedClients:{
      success:true,state:"verified",clients:[
        {sessionHandle:"untrusted",principalHandle:"idh_1111111111111111",
          authMode:"oauth",state:"active",inFlight:0,lastSeenAt:Date.now()}
      ]},requests:[],identities:[],projects:[]});await flush();
    expect(invalid.document.getElementById("access-mcp-live-summary")!.textContent)
      .toBe("Data tidak valid");
    expect(invalid.document.getElementById("access-mcp-live-list")!.children)
      .toHaveLength(1);
  });

  it("surfaces live inventory errors without disabling separately verified Core grants", async () => {
    const ui=boot(true,{...fixtures,failActions:["connected_clients"]});await flush();
    const alert=ui.document.getElementById("access-mcp-connection-load-error")!;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain("live");
    expect(ui.document.getElementById("access-mcp-live-summary")!.textContent)
      .toBe("Tidak tersedia");
    expect(ui.document.getElementById("access-mcp-connection-grant")).toBeNull();
  });

  it("adds a local project via native folder selection without granting MCP privileges", async () => {
    const ui=boot(true,{requests:[],identities:[],projects:[]});await flush();
    const add=ui.document.getElementById("access-project-add")!;
    const form=ui.document.getElementById("access-project-form")!;
    expect(form.hidden).toBe(true);
    add.click();
    expect(form.hidden).toBe(false);
    ui.document.getElementById("access-project-name")!.value="Tryout Online";
    ui.document.getElementById("access-project-id")!.value="tryout-online";
    ui.document.getElementById("access-project-browse")!.click();await flush();
    expect(ui.document.getElementById("access-project-root")!.value)
      .toBe("G:/project/tryout-online");
    ui.document.getElementById("access-project-save")!.click();await flush();
    const registration=ui.calls.find(c=>c.name==="mcp_project_access_action" &&
      c.args.action==="register_project");
    expect(registration?.args.payload).toEqual({id:"tryout-online",name:"Tryout Online",
      type:"local",root:"G:/project/tryout-online"});
    expect(ui.calls.some(c=>c.args?.action==="direct_grant")).toBe(false);
    expect(form.hidden).toBe(true);
    expect(ui.document.getElementById("access-mcp-proj-select")!.value)
      .toBe("tryout-online");
    expect(ui.document.getElementById("access-project-list")!.textContent)
      .toContain("Tryout Online");
  });

  it("registers credential-free SSH target without asking for a local folder", async () => {
    const ui=boot(true,{projects:[]});await flush();
    ui.document.getElementById("access-project-add")!.click();
    ui.document.getElementById("access-project-name")!.value="Remote API";
    const type=ui.document.getElementById("access-project-type")!;
    type.value="ssh";type.change();
    expect(ui.document.getElementById("access-project-remote")!.hidden).toBe(false);
    ui.document.getElementById("access-project-target")!.value="ssh://deploy@example.net/srv/app";
    ui.document.getElementById("access-project-save")!.click();await flush();
    const call=ui.calls.find(c=>c.args?.action==="register_project");
    expect(call?.args.payload).toEqual({name:"Remote API",type:"ssh",
      target:"ssh://deploy@example.net/srv/app"});
    expect(ui.calls.some(c=>c.name==="pick_permanent_access_path")).toBe(false);
    expect(ui.calls.some(c=>c.args?.action==="direct_grant")).toBe(false);
  });

  it("adds an existing Workspace Chain target without granting access", async () => {
    const ui=boot(true,{projects:[]});await flush();
    ui.document.getElementById("access-project-add")!.click();
    ui.document.getElementById("access-project-name")!.value="Build Chain";
    const type=ui.document.getElementById("access-project-type")!;
    type.value="chain";type.change();
    expect(ui.document.getElementById("access-project-remote")!.hidden).toBe(false);
    ui.document.getElementById("access-project-target")!.value="chain:build-app";
    ui.document.getElementById("access-project-save")!.click();await flush();
    const call=ui.calls.find(c=>c.args?.action==="register_project");
    expect(call?.args.payload).toEqual({name:"Build Chain",type:"chain",target:"chain:build-app"});
    expect(ui.calls.some(c=>c.args?.action==="direct_grant")).toBe(false);
  });

  it("searches enabled and disabled projects, edits and disables with revision pin", async () => {
    const ui=boot(true,{projects:[
      {projectId:"superagent",name:"SuperAgent",type:"local",target:"G:/project/superagent",
        updatedAt:111,enabled:true},
      {projectId:"old",name:"Old App",type:"ssh",target:"ssh://host/a",
        updatedAt:222,enabled:false},
    ]});await flush();
    const list=ui.document.getElementById("access-project-list")!;
    expect(list.children).toHaveLength(2);
    const search=ui.document.getElementById("access-project-search")!;
    search.value="old";search.input();
    expect(list.children).toHaveLength(1);
    expect(list.textContent).toContain("Nonaktif");
    search.value="";search.input();
    const row=list.children[0];
    const actions=row.lastChild!;
    actions.firstChild!.click();
    expect(ui.document.getElementById("access-project-form")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-project-id")!.readOnly).toBe(true);
    ui.document.getElementById("access-project-name")!.value="SuperAgent Plus";
    ui.document.getElementById("access-project-save")!.click();await flush();
    const edit=ui.calls.find(c=>c.args?.action==="update_project" && c.args.payload.name);
    expect(edit?.args.payload).toEqual({
      projectId:"superagent",expectedUpdatedAt:111,name:"SuperAgent Plus",
      description:"",root:"G:/project/superagent",
    });
    expect(ui.calls.some(c=>c.args?.action==="direct_grant")).toBe(false);
    list.children[0].lastChild!.children[1].click();await flush();
    const disable=ui.calls.find(c=>c.args?.action==="update_project" &&
      c.args.payload.enabled===false);
    expect(disable?.args.payload.projectId).toBe("superagent");
    expect(ui.document.getElementById("access-mcp-proj-select")!.children.map(c=>c.value))
      .not.toContain("superagent");
    expect(list.textContent).toContain("Nonaktif");
  });

  it("removes a registered project through a separate native confirmation action", async () => {
    const ui=boot(true,{projects:[{projectId:"temporary",name:"Temp",type:"local",
      target:"G:/temp",updatedAt:777,enabled:true}]});await flush();
    const list=ui.document.getElementById("access-project-list")!;
    list.firstChild!.lastChild!.children[2].click();await flush();
    const removed=ui.calls.find(c=>c.args?.action==="remove_project");
    expect(removed?.args.payload).toEqual({
      projectId:"temporary",expectedUpdatedAt:777,
    });
    expect(list.textContent).toContain("Belum ada proyek");
    expect(ui.calls.some(c=>c.args?.action==="direct_grant")).toBe(false);
  });

  it("rejects incomplete Add Project input and retains form after Core failure", async () => {
    const ui=boot(true,{projects:[],failActions:["register_project"]});await flush();
    ui.document.getElementById("access-project-add")!.click();
    ui.document.getElementById("access-project-save")!.click();await flush();
    expect(ui.calls.some(c=>c.args?.action==="register_project")).toBe(false);
    ui.document.getElementById("access-project-name")!.value="Sample";
    ui.document.getElementById("access-project-id")!.value="Bad ID";
    ui.document.getElementById("access-project-browse")!.click();await flush();
    ui.document.getElementById("access-project-save")!.click();await flush();
    expect(ui.calls.some(c=>c.args?.action==="register_project")).toBe(false);
    ui.document.getElementById("access-project-id")!.value="sample";
    ui.document.getElementById("access-project-save")!.click();await flush();
    expect(ui.document.getElementById("access-project-form")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-status")!.textContent)
      .toContain("Core unavailable");
    expect(ui.document.getElementById("access-project-list")!.textContent)
      .not.toContain("Sample");
  });

  it("offers only enabled registered projects and sends the selected read grant", async () => {
    const ui=boot(true,fixtures);await flush();
    const project=ui.document.getElementById("access-mcp-proj-select")!;
    expect(project.children.map(x=>x.value)).toEqual(["","superagent"]);
    expect(project.children.map(x=>x.value)).not.toContain("mcp-connection");
    expect(ui.document.getElementById("access-cap-read")!.checked).toBe(true);
    expect(ui.document.getElementById("access-cap-write")!.checked).toBe(false);
    ui.document.getElementById("access-mcp-ident-select")!.value=handle;
    project.value="superagent";
    ui.document.getElementById("access-mcp-project-grant")!.click();await flush();
    const grant=ui.calls.find(c=>c.name==="mcp_project_access_action" &&
      c.args.action==="direct_grant");
    expect(grant?.args.payload).toEqual({identityHandle:handle,projectId:"superagent",capabilities:["read"]});
  });

  it("grants Execute only from Akses Proyek, not Koneksi MCP", async () => {
    const ui=boot(true,fixtures);await flush();
    expect(ui.document.getElementById("access-mcp-connection-grant")).toBeNull();
    ui.document.getElementById("access-mcp-ident-select")!.value=handle;
    ui.document.getElementById("access-mcp-proj-select")!.value="superagent";
    ui.document.getElementById("access-cap-read")!.checked=false;
    ui.document.getElementById("access-cap-execute")!.checked=true;
    ui.document.getElementById("access-mcp-project-grant")!.click();await flush();
    const grant=ui.calls.find(c=>c.name==="mcp_project_access_action" &&
      c.args.action==="direct_grant");
    expect(grant?.args.payload).toEqual({
      identityHandle:handle,projectId:"superagent",capabilities:["execute"],
    });
  });

  it("permits the owner to narrow the pending project request before approval", async () => {
    const ui=boot(true,fixtures);await flush();
    ui.document.getElementById("req-center-req_project-write")!.checked=false;
    const requestCard=ui.document.getElementById("access-req-center-incoming-list")!.firstChild!;
    requestCard.lastChild!.firstChild!.click();await flush();
    const approve=ui.calls.find(c=>c.name==="mcp_project_access_action" &&
      c.args.action==="approve");
    expect(approve?.args.payload).toEqual({requestId:"req_project",capabilities:["read"]});
  });

  it("reports Core errors instead of showing an invented empty request list", async () => {
    const ui=boot(true,{...fixtures,failActions:["requests"]});await flush();
    const alert=ui.document.getElementById("access-mcp-project-load-error")!;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain("requests");
    expect(ui.document.getElementById("access-req-center-incoming-list")!.firstChild!.textContent)
      .toContain("belum dapat dimuat");
  });

  it("shows loading state on all MCP reload controls during the initial mounted refresh", async () => {
    const pending=deferred<any>();
    const ui=boot(true,{...fixtures,requestResponses:[pending.promise]});
    await flush();

    for(const id of [
      "access-mcp-connections-refresh",
      "access-mcp-connection-pending-load",
      "access-mcp-identity-refresh",
      "access-mcp-projects-refresh",
    ]) {
      const button=ui.document.getElementById(id)!;
      expect(button).not.toBeNull();
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe("Loading…");
      expect(button.attributes.get("aria-busy")).toBe("true");
    }

    pending.resolve({success:true,requests:fixtures.requests});
    await flush();
    for(const id of [
      "access-mcp-connections-refresh",
      "access-mcp-connection-pending-load",
      "access-mcp-identity-refresh",
      "access-mcp-projects-refresh",
    ]) {
      const button=ui.document.getElementById(id)!;
      expect(button.disabled).toBe(false);
      expect(button.attributes.get("aria-busy")).toBe("false");
    }
  });

  it("queues a fresh MCP snapshot when Request Center reload is pressed during an in-flight load", async () => {
    const first=deferred<any>();
    const second=deferred<any>();
    const lateRequest={...fixtures.requests[0],requestId:"req_late",subject:"Late Client"};
    const ui=boot(true,{
      ...fixtures,
      requests:[],
      requestResponses:[first.promise,second.promise],
    });
    await flush();

    const button=ui.document.getElementById("access-req-center-refresh")!;
    button.click();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Loading…");
    expect(button.attributes.get("aria-busy")).toBe("true");

    first.resolve({success:true,requests:[]});
    await flush();
    expect(ui.calls.filter(call =>
      call.name==="mcp_project_access_action" && call.args.action==="requests")).toHaveLength(2);
    expect(button.disabled).toBe(true);

    second.resolve({success:true,requests:[lateRequest]});
    await flush();
    expect(ui.document.getElementById("access-req-center-incoming-list")!.children
      .some(card=>card.dataset.requestId==="req_late")).toBe(true);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Muat ulang");
    expect(button.attributes.get("aria-busy")).toBe("false");
  });

  it("shows Request Center refresh failures and restores its button after loading", async () => {
    const ui=boot(true,{
      ...fixtures,
      failActions:["requests","pending_rule_requests","connected_clients"],
    });
    await flush();

    const button=ui.document.getElementById("access-req-center-refresh")!;
    button.click();
    await flush();

    const alert=ui.document.getElementById("access-req-center-load-error")!;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain("requests: MCP Core unavailable");
    expect(alert.textContent).toContain("Active-rule request service unavailable");
    expect(alert.textContent).not.toContain("live:");
    expect(ui.document.getElementById("access-req-center-rules-list")!.textContent)
      .toContain("Requests could not be loaded");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Muat ulang");
    expect(button.attributes.get("aria-busy")).toBe("false");
  });

  it("re-queries MCP when an incoming-request update event arrives during an in-flight refresh", async () => {
    const first=deferred<any>();
    const second=deferred<any>();
    const lateRequest={...fixtures.requests[0],requestId:"req_event_late",subject:"Event Client"};
    const ui=boot(true,{
      ...fixtures,
      requests:[],
      requestResponses:[first.promise,second.promise],
    });
    await flush();

    const onUpdated=ui.nativeEvents.get("access-manager://requests-updated");
    expect(onUpdated).toBeDefined();
    onUpdated!();
    first.resolve({success:true,requests:[]});
    await flush();
    expect(ui.calls.filter(call =>
      call.name==="mcp_project_access_action" && call.args.action==="requests")).toHaveLength(2);

    second.resolve({success:true,requests:[lateRequest]});
    await flush();
    expect(ui.document.getElementById("access-req-center-incoming-list")!.children
      .some(card=>card.dataset.requestId==="req_event_late")).toBe(true);
  });

  it("keeps the attended native desktop input session panel accessible", async () => {
    const ui=boot(true,fixtures);await flush();
    expect(ui.old.hidden).toBe(true);
    ui.document.getElementById("access-trusted-session-toggle")!.click();
    expect(ui.old.hidden).toBe(false);
    ui.document.getElementById("access-trusted-session-toggle")!.click();
    expect(ui.old.hidden).toBe(true);
  });

  it("re-queries Core when focusRequest arrives during an in-flight reload", async () => {
    const ui=boot(true,{...fixtures,requests:[]});await flush();
    // Start a refresh while requests array is empty, then append the new pending request
    // before focusing so the first in-flight response does not yet contain req_late.
    ui.window.__superagentAccessManagerRefresh();
    ui.mcpRequests.push({
      requestId:"req_late",
      projectId:"superagent",
      identityHandle:handle,
      ownerConnectionName:"Late Client",
      clientLabel:"Late Client",
      capabilities:["execute"],
      status:"pending",
      requestedAt:Date.now(),
    });
    const outcome=await ui.window.__superagentAccessManagerFocusRequest("req_late","requests");
    expect(outcome).toEqual({targetFound:true,tab:"requests"});
    const list=ui.document.getElementById("access-req-center-incoming-list")!;
    expect(list.children.some(c=>c.dataset.requestId==="req_late")).toBe(true);
  });
  const identityHandle="idh_0123456789abcdef";
  const base={
    identities:[{identityHandle,subject:"ChatGPT test",mode:"oauth",scopes:["mcp:tools","mcp:tools:write"]}],
    projects:[{projectId:"superagent",name:"SuperAgent",type:"local",target:"D:/superagent",enabled:true}],
    requests:[],
  };
  it("renders a 238-tool inventory with search, filters, pagination, host status and no automatic grants", async () => {
    const tools=Array.from({length:238},(_,i)=>({
      name:i===0?"superagent_terminal_example":("superagent_catalog_"+String(i).padStart(3,"0")),
      description:i===0?"Terminal command example":"Bounded metadata tool "+i,
      risk:i===0?"dangerous":"safe",approvalKind:i===0?"project":"read_only",
      capability:i===0?"execute":null,
      hostReadiness:i===0?"uncertified":"certified_metadata",
      hostRequirement:i===0?"Uncertified host operation.":"Metadata only.",
      hostBlocked:i===0,operationStatus:i===0?"host_uncertified":"recheck_at_execution",
      oauthScopesRequired:i===0?["mcp:tools","mcp:tools:write"]:["mcp:tools"],
      grantState:i===0?"choose_identity_project":"not_required",
    }));
    const ui=boot(true,{...base,tools});await flush();
    expect(ui.document.getElementById("access-mcp-tool-count")!.textContent).toContain("238 aktif");
    const list=ui.document.getElementById("access-mcp-tool-list")!;
    expect(list.children).toHaveLength(25);
    expect(ui.document.getElementById("access-mcp-tool-summary")!.textContent).toContain("238 dari 238");
    ui.document.getElementById("access-mcp-tool-more")!.click();
    expect(list.children).toHaveLength(50);
    const search=ui.document.getElementById("access-mcp-tool-search")!;
    search.value="terminal";search.input();
    expect(list.textContent).toContain("superagent_terminal_example");
    expect(list.textContent).toContain("Tunduk pada Aturan Aktif / policy");
    search.value="";search.input();
    const filter=ui.document.getElementById("access-mcp-tool-filter")!;
    filter.value="host_uncertified";filter.change();
    expect(ui.calls.some(c=>c.name==="mcp_project_access_action" &&
      ["approve","direct_grant"].includes(c.args.action))).toBe(false);
  });

  it("prepares only the selected Git action capability and never grants it automatically", async () => {
    const ui=boot(true,base);await flush();
    const identity=ui.document.getElementById("access-mcp-ident-select")!;
    const project=ui.document.getElementById("access-mcp-proj-select")!;
    identity.value=identityHandle;project.value="superagent";
    identity.change();project.change();await flush();
    const git=ui.document.getElementById("access-mcp-tool-review-superagent_git_action")!;
    git.click();
    expect(ui.document.getElementById("access-cap-read")!.checked).toBe(true);
    expect(ui.document.getElementById("access-cap-execute")!.checked).toBe(false);
    const action=ui.document.getElementById("access-mcp-tool-git-action-superagent_git_action")!;
    action.value="commit";git.click();
    expect(ui.document.getElementById("access-cap-git")!.checked).toBe(true);
    expect(ui.document.getElementById("access-cap-read")!.checked).toBe(false);
    expect(ui.document.getElementById("access-mcp-tool-selection-note")!.textContent)
      .toContain("Tidak ada grant otomatis");
    expect(ui.calls.some(c=>c.name==="mcp_project_access_action" &&
      ["direct_grant","approve"].includes(c.args.action))).toBe(false);
  });

  it("shows missing project selection and host certification as independent blockers", async () => {
    const ui=boot(true,base);await flush();
    ui.document.getElementById("access-mcp-tool-review-superagent_exec_command")!.click();
    expect(ui.document.getElementById("access-status")!.textContent)
      .toContain("Pilih Identitas MCP");
    ui.document.getElementById("access-mcp-tool-host-superagent_exec_command")!.click();
    expect(ui.document.getElementById("access-pane-rules")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-status")!.textContent)
      .toContain("membuat aturan Allow tidak otomatis memperbaikinya");
    expect(ui.calls.some(c=>c.name==="mcp_project_access_action" &&
      ["direct_grant","approve"].includes(c.args.action))).toBe(false);
  });

  it("opens matrix and preflight inspection drawer with capability matrix metadata", async () => {
    const ui = boot(true, base); await flush();
    const matrixBtn = ui.document.getElementById("access-mcp-tool-matrix-superagent_git_action")!;
    expect(matrixBtn).not.toBeNull();
    matrixBtn.click();

    const inspector = ui.document.getElementById("access-mcp-matrix-inspector")!;
    expect(inspector.hidden).toBe(false);
    expect(inspector.textContent).toContain("Matrix & Preflight: superagent_git_action");
    expect(inspector.textContent).toContain("OAuth Scopes");
    expect(inspector.textContent).toContain("Project Capability");

    const closeBtn = ui.document.getElementById("access-mcp-matrix-close")!;
    expect(closeBtn).not.toBeNull();
    closeBtn.click();
    expect(inspector.hidden).toBe(true);
  });

  it("fails closed when catalog loading fails; never displays stale grants", async () => {
    const ui=boot(true,{...base,failActions:["tools"]});await flush();
    expect(ui.document.getElementById("access-mcp-tool-list")!.textContent)
      .toContain("Data belum terverifikasi");
    expect(ui.document.getElementById("access-mcp-tool-summary")!.textContent)
      .toContain("Inventaris tools gagal dimuat");
    expect(ui.document.getElementById("access-mcp-tool-count")!.textContent)
      .toContain("Tidak tersedia");
  });

  it("sends legacy mcp-connection approvals only to a native denial panel, not to OAuth grants", async () => {
    const legacy={requestId:"req_legacy",projectId:"mcp-connection",projectName:"MCP Connection Controls",
      status:"pending",subject:"Old client",capabilities:["execute"],reason:"Old request"};
    const ui=boot(true,{...base,requests:[legacy]});await flush();
    const panel=ui.document.getElementById("access-mcp-legacy-requests")!;
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("tidak boleh disetujui");
    expect(ui.document.getElementById("access-pane-connections")!.hidden).toBe(true);
    expect(ui.document.getElementById("access-req-center-incoming-list")!.textContent)
      .not.toContain("req_legacy");
    const deny = ui.document.getElementById("access-mcp-legacy-list")!.firstChild!.lastChild!;
    expect(deny.textContent).toBe("Tolak permintaan lama");
    deny.click(); await flush();
    expect(ui.calls.some(c => c.name === "mcp_project_access_action" && c.args.action === "deny" &&
      c.args.payload.requestId === "req_legacy")).toBe(true);
    expect(ui.calls.some(c => c.name === "mcp_project_access_action" &&
      ["approve", "direct_grant"].includes(c.args.action))).toBe(false);
  });
});

describe("bulk permanent access rule operations", () => {
  it("hides bulk toolbar when no rules are registered, and displays it when rules exist", async () => {
    const ui = boot(); await flush();
    const bulkBar = ui.document.getElementById("access-rule-bulk-bar")!;
    expect(bulkBar.hidden).toBe(true);

    // Register a rule
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-submit")!.click(); await flush();

    expect(bulkBar.hidden).toBe(false);
    expect(ui.document.getElementById("access-rule-selected-count")?.textContent).toBe("0 dipilih");
    expect(ui.document.getElementById("access-rule-bulk-revoke")?.disabled).toBe(true);
  });

  it("selects rules individually, updates counter and enables bulk revoke button", async () => {
    const ui = boot(); await flush();
    // Register 2 rules
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-submit")!.click(); await flush();

    const select = ui.document.getElementById("access-kind")!;
    select.value = "file"; select.change();
    ui.document.getElementById("access-pick-folder")!.click(); await flush();
    ui.document.getElementById("access-submit")!.click(); await flush();

    const rows = ui.document.getElementById("access-rule-list")!.children;
    expect(rows).toHaveLength(2);

    // Select first rule
    const checkbox1 = rows[0].children[0].children[0];
    checkbox1.checked = true;
    checkbox1.change();

    expect(ui.document.getElementById("access-rule-selected-count")?.textContent).toBe("1 dipilih");
    const bulkRevoke = ui.document.getElementById("access-rule-bulk-revoke")!;
    expect(bulkRevoke.disabled).toBe(false);
    expect(bulkRevoke.textContent).toContain("Cabut (1) Terpilih");

    // Select second rule
    const checkbox2 = rows[1].children[0].children[0];
    checkbox2.checked = true;
    checkbox2.change();

    expect(ui.document.getElementById("access-rule-selected-count")?.textContent).toBe("2 dipilih");
    expect(bulkRevoke.textContent).toContain("Cabut (2) Terpilih");

    // Click Batal
    const clearBtn = ui.document.getElementById("access-rule-bulk-clear")!;
    expect(clearBtn.hidden).toBe(false);
    clearBtn.click();

    expect(ui.document.getElementById("access-rule-selected-count")?.textContent).toBe("0 dipilih");
    expect(bulkRevoke.disabled).toBe(true);
  });

  it("selects all filtered rules via select-all checkbox and revokes them in bulk", async () => {
    const ui = boot(); await flush();
    // Register desktop rule
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-submit")!.click(); await flush();

    // Register file rule
    const select = ui.document.getElementById("access-kind")!;
    select.value = "file"; select.change();
    ui.document.getElementById("access-pick-folder")!.click(); await flush();
    ui.document.getElementById("access-submit")!.click(); await flush();

    expect(ui.getPolicy().rules).toHaveLength(2);

    // Select all via bulk toolbar checkbox
    const selectAll = ui.document.getElementById("access-rule-select-all")!;
    selectAll.checked = true;
    selectAll.change();

    expect(ui.document.getElementById("access-rule-selected-count")?.textContent).toBe("2 dipilih");
    const bulkRevoke = ui.document.getElementById("access-rule-bulk-revoke")!;
    expect(bulkRevoke.disabled).toBe(false);

    // Execute bulk revoke
    bulkRevoke.click();
    await flush();

    // Both rules revoked
    expect(ui.getPolicy().rules).toHaveLength(0);
    const revokeCalls = ui.calls.filter(c => c.name === "revoke_permanent_access_rule");
    expect(revokeCalls).toHaveLength(2);
    expect(ui.document.getElementById("access-rule-list")!.children[0].textContent).toContain("Belum ada aplikasi tepercaya");
  });
});

describe("Pusat Permintaan (Request Center)", () => {
  it("renders Pusat Permintaan tab with incoming access requests and pending active rule requests", async () => {
    const incomingReq = {
      requestId: "req_incoming_1",
      projectId: "superagent",
      projectName: "SuperAgent",
      projectPath: "D:/superagent",
      status: "pending",
      subject: "Gemini MCP",
      mode: "oauth",
      capabilities: ["read", "write"],
      reason: "Akses workspace",
      createdAt: 1700000000000,
    };
    const ui = boot(true, { requests: [incomingReq] });
    await flush();

    const tabBtn = ui.document.getElementById("access-nav-tab-requests")!;
    expect(tabBtn).not.toBeNull();
    expect(tabBtn.textContent).toContain("Pusat Permintaan");
    expect(ui.document.getElementById("access-tab-badge-requests")?.textContent).toBe("1");

    tabBtn.click();
    await flush();
    expect(ui.document.getElementById("access-pane-requests")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-req-center-incoming-list")!.textContent).toContain("Gemini MCP");
    expect(ui.document.getElementById("access-req-center-rules-list")!.textContent)
      .toContain("Tidak ada permintaan aturan aktif");
  });

  it("ensures all requests stay in Pusat Permintaan, Akses Proyek has no request badge, and Aturan Aktif has Request Permit banner", async () => {
    const ui = boot(true, { requests: [] });
    await flush();

    // 1. Tab Akses Proyek should NOT have request badge (clean tab)
    const tabMcp = ui.document.getElementById("access-nav-tab-mcp")!;
    expect(tabMcp).not.toBeNull();
    expect(ui.document.getElementById("access-tab-badge-mcp")).toBeNull();
    expect(tabMcp.textContent.trim()).toBe("Akses Proyek");

    // 2. Tab Aturan Aktif has Request Permit banner
    ui.document.getElementById("access-nav-tab-rules")!.click();
    await flush();
    expect(ui.document.getElementById("access-pane-rules")!.hidden).toBe(false);
    const permitBanner = ui.document.getElementById("access-rule-permit-banner")!;
    expect(permitBanner).not.toBeNull();
    expect(permitBanner.textContent).toContain("Request Permit Aturan Aktif");
    expect(permitBanner.textContent).toContain("Pusat Permintaan");

    // 3. Clicking "+ Ajukan Request Permit" navigates to Pusat Permintaan, rules sub-tab, and opens form
    const openPermitBtn = ui.document.getElementById("access-rules-open-permit-form")!;
    expect(openPermitBtn).not.toBeNull();
    openPermitBtn.click();
    await flush();

    expect(ui.document.getElementById("access-pane-requests")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-pane-rules")!.hidden).toBe(true);
    expect(ui.document.getElementById("access-req-rule-form")!.hidden).toBe(false);
  });
});

describe("Desktop Live session requests in Request Center", () => {
  const makeRequest = (overrides: Record<string, unknown> = {}) => {
    const now = Date.now();
    return {
      requestId: "desktop_req_" + "a".repeat(32),
      principalId: "local-agent",
      pid: 4812,
      nativeId: "hwnd-4812",
      title: "Workspace Editor",
      application: "Code Editor",
      accessMode: "input",
      ttlMs: 300_000,
      reason: "Review and update the active workspace",
      createdAt: now - 1_000,
      expiresAt: now + 4 * 60_000,
      status: "pending",
      ...overrides,
    };
  };

  it("shows Desktop Live as a separate subtab and includes its pending count in Request Center", async () => {
    const ui = boot(true, {
      requests: [{
        requestId: "req_project_live",
        projectId: "superagent",
        projectName: "SuperAgent",
        status: "pending",
        subject: "Gemini MCP",
        mode: "oauth",
        capabilities: ["read"],
        reason: "Inspect workspace",
        createdAt: Date.now(),
      }],
      desktopUiRequests: [makeRequest()],
    });
    await flush();

    expect(ui.document.getElementById("access-tab-badge-requests")?.textContent).toBe("2");
    ui.document.getElementById("access-nav-tab-requests")!.click();
    await flush();

    const desktopTab = ui.document.getElementById("access-req-subtab-desktop")!;
    expect(desktopTab.textContent).toBe("Desktop Live (1)");
    desktopTab.click();
    const desktopCard = ui.document.getElementById("access-req-center-desktop-card")!;
    expect(desktopCard.hidden).toBe(false);
    expect(ui.document.getElementById("access-req-center-incoming-card")!.hidden).toBe(true);
    expect(ui.document.getElementById("access-req-center-rules-card")!.hidden).toBe(true);

    const list = ui.document.getElementById("access-req-center-desktop-list")!;
    expect(list.textContent).toContain("Code Editor");
    expect(list.textContent).toContain("Workspace Editor");
    expect(list.textContent).toContain("PID 4812");
    expect(list.textContent).toContain("local-agent");
    expect(list.textContent).toContain("Viewer + Input");
    expect(list.textContent).toContain("Review and update the active workspace");
    expect(list.textContent).toContain("hanya sekali");
  });

  it("runs approval only through the native Tray command and records the confirmed history", async () => {
    const request = makeRequest();
    const ui = boot(true, { desktopUiRequests: [request] });
    await flush();
    ui.document.getElementById("access-nav-tab-requests")!.click();
    await flush();
    ui.document.getElementById("access-req-subtab-desktop")!.click();

    const card = ui.document.getElementById("access-req-center-desktop-list")!.children[0];
    const actions = card.children[card.children.length - 1];
    actions.children[0].click();
    await flush();

    expect(ui.calls.some(call => call.name === "desktop_ui_session_requests_action" &&
      call.args.action === "approve" && call.args.requestId === request.requestId)).toBe(true);
    expect(ui.document.getElementById("access-req-center-desktop-history")!.textContent)
      .toContain("Disetujui · menunggu dipakai");
    expect(ui.getPolicy().rules).toHaveLength(0);
    expect(ui.calls.some(call => call.name === "register_permanent_access_rule")).toBe(false);
    expect(ui.calls.some(call => call.name === "mcp_project_access_action" &&
      ["approve", "direct_grant"].includes(call.args.action))).toBe(false);
  });

  it("routes denial through native Tray and never presents an approval as a completed grant", async () => {
    const request = makeRequest({ accessMode: "view", requestId: "desktop_req_" + "b".repeat(32) });
    const ui = boot(true, { desktopUiRequests: [request] });
    await flush();
    ui.document.getElementById("access-nav-tab-requests")!.click();
    await flush();
    ui.document.getElementById("access-req-subtab-desktop")!.click();

    const card = ui.document.getElementById("access-req-center-desktop-list")!.children[0];
    const actions = card.children[card.children.length - 1];
    actions.children[1].click();
    await flush();

    expect(ui.calls.some(call => call.name === "desktop_ui_session_requests_action" &&
      call.args.action === "deny" && call.args.requestId === request.requestId)).toBe(true);
    expect(ui.document.getElementById("access-req-center-desktop-history")!.textContent).toContain("Ditolak");
    expect(ui.getPolicy().rules).toHaveLength(0);
  });

  it("reports an unavailable Desktop Live request queue instead of showing stale actionable cards", async () => {
    const ui = boot(true, { desktopUiRequests: [makeRequest()], failActions: ["desktop_ui_requests"] });
    await flush();
    ui.document.getElementById("access-nav-tab-requests")!.click();
    await flush();
    ui.document.getElementById("access-req-subtab-desktop")!.click();

    expect(ui.document.getElementById("access-req-center-desktop-list")!.textContent)
      .toContain("could not be loaded");
    expect(ui.document.getElementById("access-req-center-desktop-list")!.textContent)
      .not.toContain("Workspace Editor");
    expect(ui.document.getElementById("access-req-subtab-desktop")!.textContent).toBe("Desktop Live (!)");
    expect(ui.document.getElementById("access-tab-badge-requests")!.textContent).toBe("!");
  });
});

describe("Access history placement and responsive layout", () => {
  it("keeps each history inside its matching Request Center subtab", async () => {
    const now = Date.now();
    const ui = boot(true, {
      requests: [{
        requestId: "req_project_history_moved",
        projectId: "superagent",
        projectName: "SuperAgent",
        status: "approved",
        subject: "Gemini MCP",
        mode: "oauth",
        capabilities: ["read", "write"],
        reason: "Workspace access review",
        createdAt: now - 60_000,
        decidedAt: now,
      }],
      pendingRuleRequests: [{
        id: "req_rule_history_moved",
        status: "approved",
        kind: "file",
        effect: "allow",
        sourceName: "Gemini MCP",
        targetPath: "G:/project/superagent",
        operations: ["read", "write"],
        reason: "Workspace host access review",
        createdAt: now - 60_000,
        decidedAt: now,
      }],
    });
    await flush();

    const projectHistory = ui.document.getElementById("access-mcp-history-list")!;
    const ruleHistory = ui.document.getElementById("access-req-center-rules-history")!;
    const desktopHistory = ui.document.getElementById("access-req-center-desktop-history")!;
    const requestPane = ui.document.getElementById("access-pane-requests")!;
    const incomingCard = ui.document.getElementById("access-req-center-incoming-card")!;
    const rulesCard = ui.document.getElementById("access-req-center-rules-card")!;
    const desktopCard = ui.document.getElementById("access-req-center-desktop-card")!;
    const projectHistoryCard = ui.document.getElementById("access-req-center-project-history-card")!;
    const ruleHistoryCard = ui.document.getElementById("access-req-center-rules-history-card")!;
    const desktopHistoryCard = ui.document.getElementById("access-req-center-desktop-history-card")!;
    const projectPane = ui.document.getElementById("access-pane-mcp")!;
    const rulesPane = ui.document.getElementById("access-pane-rules")!;

    expect(projectHistory.parentNode?.parentNode).toBe(incomingCard);
    expect(ruleHistory.parentNode?.parentNode).toBe(rulesCard);
    expect(desktopHistory.parentNode?.parentNode).toBe(desktopCard);
    expect(projectHistory.textContent).toContain("Gemini MCP");
    expect(projectHistory.textContent).toContain("Disetujui");
    expect(ruleHistory.textContent).toContain("G:/project/superagent");
    expect(ruleHistory.textContent).toContain("Disetujui");
    expect(projectHistoryCard.hidden).toBe(true);
    expect(ruleHistoryCard.hidden).toBe(true);
    expect(desktopHistoryCard.hidden).toBe(true);

    ui.document.getElementById("access-nav-tab-requests")!.click();
    ui.document.getElementById("access-req-subtab-incoming")!.click();
    expect(incomingCard.hidden).toBe(false);
    expect(rulesCard.hidden).toBe(true);
    expect(desktopCard.hidden).toBe(true);
    expect(projectHistoryCard.hidden).toBe(false);
    expect(ruleHistoryCard.hidden).toBe(true);
    expect(desktopHistoryCard.hidden).toBe(true);
    expect(projectHistory.parentNode?.parentNode).toBe(incomingCard);

    ui.document.getElementById("access-req-subtab-rules")!.click();
    expect(incomingCard.hidden).toBe(true);
    expect(rulesCard.hidden).toBe(false);
    expect(desktopCard.hidden).toBe(true);
    expect(projectHistoryCard.hidden).toBe(true);
    expect(ruleHistoryCard.hidden).toBe(false);
    expect(desktopHistoryCard.hidden).toBe(true);
    expect(ruleHistory.parentNode?.parentNode).toBe(rulesCard);

    ui.document.getElementById("access-req-subtab-desktop")!.click();
    expect(incomingCard.hidden).toBe(true);
    expect(rulesCard.hidden).toBe(true);
    expect(desktopCard.hidden).toBe(false);
    expect(projectHistoryCard.hidden).toBe(true);
    expect(ruleHistoryCard.hidden).toBe(true);
    expect(desktopHistoryCard.hidden).toBe(false);
    expect(desktopHistory.parentNode?.parentNode).toBe(desktopCard);

    ui.document.getElementById("access-req-subtab-all")!.click();
    expect(incomingCard.hidden).toBe(false);
    expect(rulesCard.hidden).toBe(false);
    expect(desktopCard.hidden).toBe(false);
    expect(projectHistoryCard.hidden).toBe(true);
    expect(ruleHistoryCard.hidden).toBe(true);
    expect(desktopHistoryCard.hidden).toBe(true);

    ui.document.getElementById("access-nav-tab-rules")!.click();
    await flush();
    expect(rulesPane.hidden).toBe(false);
    expect(requestPane.hidden).toBe(true);
    expect(rulesPane.children.some(child => child === ruleHistory.parentNode)).toBe(false);

    ui.document.getElementById("access-nav-tab-mcp")!.click();
    await flush();
    expect(projectPane.hidden).toBe(false);
    expect(projectPane.children.some(child => child === projectHistory.parentNode)).toBe(false);
    expect(requestPane.hidden).toBe(true);
    expect(ui.document.getElementById("access-nav-tab-audit")?.textContent).toContain("Audit Host");
  });

  it("keeps Core Status visible at short heights and Request Center filters scrollable on mobile", () => {
    expect(trayStyles).toMatch(/\.side-bottom\s*\{[^}]*flex:\s*0 0 auto/s);
    expect(trayStyles).toContain("@media (max-height: 680px)");
    expect(trayStyles).toContain("white-space: normal");
    expect(accessManagerStyles).toContain(".access-req-center-subtabs .access-filter-tabs");
    expect(accessManagerStyles).toContain("overflow-x:auto");
  });

  it("refreshes incoming project and active-rule requests on requests-updated and window focus", async () => {
    const dynamicRules: any[] = [];
    const ui = boot(true, { pendingRuleRequests: dynamicRules });
    await flush();
    expect(ui.document.getElementById("access-req-subtab-all")!.textContent).toBe("Semua (0)");

    ui.mcpRequests.push({
      requestId: "req_live_incoming_1",
      projectId: "superagent",
      projectName: "SuperAgent",
      status: "pending",
      subject: "yui",
      ownerConnectionName: "yui",
      mode: "oauth",
      capabilities: ["read"],
      reason: "Live incoming project request",
      createdAt: Date.now(),
    });
    dynamicRules.push({
      id: "rule_req_live_1",
      status: "pending",
      kind: "file",
      effect: "allow",
      sourceName: "MCP Agent yui",
      targetPath: "D:/backup from pc asus/Documents Development/superagent/README.md",
      recursive: false,
      operations: ["read"],
      reason: "Live active rule request",
      createdAt: Date.now(),
    });

    await ui.nativeEvents.get("access-manager://requests-updated")!();
    await flush();
    expect(ui.document.getElementById("access-req-subtab-all")!.textContent).toBe("Semua (2)");
    expect(ui.document.getElementById("access-req-center-incoming-list")!.textContent).toContain("yui");
    expect(ui.document.getElementById("access-req-center-rules-list")!.textContent).toContain("README.md");

    ui.mcpRequests.length = 0;
    dynamicRules.length = 0;
    ui.listeners.get("focus")!();
    await flush();
    expect(ui.document.getElementById("access-req-subtab-all")!.textContent).toBe("Semua (0)");
  });

  it("switches Request Center active-rule form to view/input and exe picker for desktop rules", async () => {
    const ui = boot(true, { pendingRuleRequests: [] });
    await flush();

    ui.document.getElementById("access-nav-tab-requests")!.click();
    ui.document.getElementById("access-req-new-rule-toggle")!.click();

    const kindSelect = ui.document.getElementById("access-req-rule-kind")!;
    const pickDir = ui.document.getElementById("access-req-pick-dir")!;
    const pickFile = ui.document.getElementById("access-req-pick-file")!;
    const pickExe = ui.document.getElementById("access-req-pick-exe")!;
    const fileOps = ui.document.getElementById("access-req-ops-file")!;
    const desktopOps = ui.document.getElementById("access-req-ops-desktop")!;
    const recWrap = ui.document.getElementById("access-req-rule-recursive")!.parentNode!;

    expect(pickDir.hidden).toBe(false);
    expect(pickExe.hidden).toBe(true);
    expect(desktopOps.hidden).toBe(true);

    kindSelect.value = "desktop";
    kindSelect.change();

    expect(pickDir.hidden).toBe(true);
    expect(pickFile.hidden).toBe(true);
    expect(pickExe.hidden).toBe(false);
    expect(fileOps.hidden).toBe(true);
    expect(desktopOps.hidden).toBe(false);
    expect(recWrap.hidden).toBe(true);

    pickExe.click();
    await flush();
    expect(ui.document.getElementById("access-req-rule-path")!.value).toBe("C:\\Apps\\Notepad.exe");

    ui.document.getElementById("access-req-op-input")!.checked = true;
    ui.document.getElementById("access-req-rule-reason")!.value = "Allow Notepad desktop launch";

    const form = ui.document.getElementById("access-req-rule-form")!;
    const submitBtn = form.children[form.children.length - 1];
    submitBtn.click();
    await flush();

    const submitCall = ui.calls.find(c => c.name === "submit_active_rule_request");
    expect(submitCall?.args).toMatchObject({
      kind: "desktop",
      targetPath: "C:\\Apps\\Notepad.exe",
      recursive: false,
      operations: ["view", "input"],
    });
  });

  it("renders dynamic capabilitiesByAction dropdowns for non-Git tools and routes desktop host policy button to desktop filter", async () => {
    const ui = boot(true, {
      identities: [{
        identityHandle: "agent-1",
        subject: "Gemini MCP",
        ownerConnectionName: "Gemini",
      }],
      projects: [{ projectId: "superagent", name: "SuperAgent", type: "local", target: "D:/superagent", enabled: true }],
      tools: [
        {
          name: "superagent_manage_worktrees",
          description: "Manage git worktrees",
          risk: "dangerous",
          approvalKind: "project",
          capability: null,
          capabilitiesByAction: { list: "read", create: "worktree", merge: "git" },
          hostReadiness: "certified",
          hostRequirement: "Project root scope.",
          hostBlocked: false,
          operationStatus: "check_action_arguments",
          oauthScopesRequired: ["mcp:tools", "mcp:tools:write"],
          grantState: "action_dependent",
        },
        {
          name: "superagent_desktop_ui",
          description: "Desktop perception and app lifecycle",
          risk: "dangerous",
          approvalKind: "project",
          capability: "execute",
          hostReadiness: "action_dependent",
          hostRequirement: "Requires permanent desktop rule for open/input/launch_app.",
          hostBlocked: true,
          operationStatus: "check_action_arguments",
          oauthScopesRequired: ["mcp:tools", "mcp:tools:write"],
          grantState: "choose_identity_project",
        },
      ],
    });
    await flush();

    const identity = ui.document.getElementById("access-mcp-ident-select")!;
    const project = ui.document.getElementById("access-mcp-proj-select")!;
    identity.value = "agent-1";
    project.value = "superagent";
    identity.change();
    project.change();
    await flush();

    const wtSelect = ui.document.getElementById("access-mcp-tool-git-action-superagent_manage_worktrees")!;
    expect(wtSelect.children.map(o => o.value)).toEqual(["list", "create", "merge"]);
    wtSelect.value = "create";
    wtSelect.change();

    ui.document.getElementById("access-mcp-tool-review-superagent_manage_worktrees")!.click();
    expect(ui.document.getElementById("access-cap-worktree")!.checked).toBe(true);
    expect(ui.document.getElementById("access-cap-read")!.checked).toBe(false);

    ui.document.getElementById("access-mcp-tool-host-superagent_desktop_ui")!.click();
    expect(ui.document.getElementById("access-pane-rules")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-tab-desktop")!.className).toContain("active");
  });
});
