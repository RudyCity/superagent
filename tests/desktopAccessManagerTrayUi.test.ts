import {describe,expect,it,vi} from "vitest";
import vm from "node:vm";
import fs from "node:fs";
const code=fs.readFileSync("apps/superagent-tray/ui/access-manager.js","utf8");
class Element {
  tagName:string;id="";className="";placeholder="";type="";#textContent="";title="";hidden=false;disabled=false;checked=false;
  rel="";href="";src="";readOnly=false;style:Record<string,string>={};dataset:Record<string,string>={};parentNode:Element|null=null;
  children:Element[]=[];events=new Map<string,Function>();attributes=new Map<string,string>();
  #value:string|undefined;
  constructor(tag:string){this.tagName=tag.toLowerCase();}
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
function boot(nativeEnabled=true, mcpData?: {
  requests?: any[]; identities?: any[]; projects?: any[];
  connectedClients?: {success:boolean;state:string;clients:any[]|null;observedAt?:number};
  failActions?: string[];
}){
  const parent=new Element("section");parent.id="settings-subpage-security";
  const old=new Element("section");old.id="desktop-trust-panel";parent.append(old);
  const listeners=new Map<string,Function>();
  let policy:any={version:2,defaultEffect:"deny",rules:[]};
  let auditLogs:any[]=[];
  const calls:{name:string,args:any}[]=[];
  const mcpRequests=mcpData?.requests || [];
  const mcpIdentities=mcpData?.identities || [];
  const mcpProjects=mcpData?.projects || [];
  const invoke=vi.fn(async(name:string,args:any)=>{
    calls.push({name,args});
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
      const rule={
        id:"abc",kind:args.kind,effect:args.effect,app:ruleApp,operations:args.operations,
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
        ruleId:"abc",
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
    if(name==="get_permanent_access_audit_log")return auditLogs;
    if(name==="clear_permanent_access_audit_log"){auditLogs=[];return true;}
    if(name==="mcp_project_access_action"){
      if(mcpData?.failActions?.includes(args.action)) throw Error("MCP Core unavailable");
      if(args.action==="requests") return {success:true,requests:mcpRequests};
      if(args.action==="identities") return {success:true,identities:mcpIdentities};
      if(args.action==="projects") return {success:true,projects:mcpProjects};
      if(args.action==="connected_clients") return mcpData?.connectedClients ??
        {success:true,state:"unavailable",clients:null};
      if(["approve","deny","revoke","direct_grant"].includes(args.action)) return {success:true};
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
  const window={__TAURI__:{core:{invoke}},addEventListener:(k:string,f:Function)=>listeners.set(k,f),
    confirm:vi.fn(()=>true)};
  vm.runInNewContext(code,{document,window,location:{hash:"#settings"},
    Number,String,Array,Object,Boolean,Error,Promise,Date,Math});
  return {document,parent,old,calls,invoke,listeners,getPolicy:()=>policy};
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
  it("renders the 3 main section tabs with accurate initial badges and active pane", async () => {
    const ui = boot();
    await flush();

    const tabReg = ui.document.getElementById("access-nav-tab-register");
    const tabRules = ui.document.getElementById("access-nav-tab-rules");
    const tabAudit = ui.document.getElementById("access-nav-tab-audit");
    expect(tabReg).not.toBeNull();
    expect(tabRules).not.toBeNull();
    expect(tabAudit).not.toBeNull();

    expect(tabReg?.className).toContain("active");
    expect(tabRules?.className).not.toContain("active");
    expect(tabAudit?.className).not.toContain("active");

    const badgeRules = ui.document.getElementById("access-tab-badge-rules");
    expect(badgeRules?.textContent).toBe("0");

    const paneReg = ui.document.getElementById("access-pane-register");
    const paneRules = ui.document.getElementById("access-pane-rules");
    const paneAudit = ui.document.getElementById("access-pane-audit");
    expect(paneReg?.hidden).toBe(false);
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
    expect(ui.document.getElementById("access-mcp-pending-list")!.children).toHaveLength(1);
    expect(ui.document.getElementById("access-mcp-connection-pending-list")!.children).toHaveLength(1);
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
    expect(ui.document.getElementById("access-mcp-connection-identity")!.children)
      .toHaveLength(1);
    expect(ui.document.getElementById("access-mcp-connection-grant")!.disabled).toBe(true);
    expect(ui.calls.some(c=>c.name==="mcp_project_access_action" &&
      c.args.action==="direct_grant")).toBe(false);
    expect(ui.calls.some(c=>c.name==="mcp_project_access_action" &&
      c.args.action==="connected_clients")).toBe(true);
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
    expect(ui.document.getElementById("access-mcp-connection-grant")!.disabled)
      .toBe(false);
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

  it("uses only connection execute for independent MCP Connections approval", async () => {
    const ui=boot(true,fixtures);await flush();
    ui.document.getElementById("access-mcp-connection-identity")!.value=handle;
    ui.document.getElementById("access-mcp-connection-grant")!.click();await flush();
    const grant=ui.calls.find(c=>c.name==="mcp_project_access_action" &&
      c.args.action==="direct_grant");
    expect(grant?.args.payload).toEqual({
      identityHandle:handle,projectId:"mcp-connection",capabilities:["execute"],
    });
  });

  it("permits the owner to narrow the pending project request before approval", async () => {
    const ui=boot(true,fixtures);await flush();
    ui.document.getElementById("approval-req_project-write")!.checked=false;
    const requestCard=ui.document.getElementById("access-mcp-pending-list")!.firstChild!;
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
    expect(ui.document.getElementById("access-mcp-pending-list")!.firstChild!.textContent)
      .toContain("belum dapat dimuat");
  });

  it("keeps the attended native desktop input session panel accessible", async () => {
    const ui=boot(true,fixtures);await flush();
    expect(ui.old.hidden).toBe(true);
    ui.document.getElementById("access-trusted-session-toggle")!.click();
    expect(ui.old.hidden).toBe(false);
    ui.document.getElementById("access-trusted-session-toggle")!.click();
    expect(ui.old.hidden).toBe(true);
  });
});
