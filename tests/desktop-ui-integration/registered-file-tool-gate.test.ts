import {afterEach,describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  registeredFileToolGate,getPermanentFileToolReadiness,type FileToolCall,
} from "../../src/core/tools/registeredFileToolGate.js";
import type {ExecutableIdentity,PersistentAccessPolicy} from "../../src/core/desktopUi/persistentAccessPolicy.js";
const roots:string[]=[];
function setup(){
  const raw=fs.mkdtempSync(path.join(os.tmpdir(),"sa-native-file-gate-"));
  roots.push(raw);
  const root=fs.realpathSync.native(raw);
  fs.mkdirSync(path.join(root,"src"));
  fs.writeFileSync(path.join(root,"src","main.ts"),"const safe = true;\n");
  fs.writeFileSync(path.join(root,".env"),"SECRET=only-a-test\n");
  const exe=fs.realpathSync.native(process.execPath).replace(/^\\\\\?\\/,"");
  const app:ExecutableIdentity={
    platform:process.platform==="win32"?"win32":process.platform==="darwin"?"darwin":"linux",
    executablePath:exe,sha256:"a".repeat(64),
  };
  const rule=(id:string,effect:"allow"|"deny",location:string,operations:("read"|"write"|"delete")[],recursive=false)=>({
    id,kind:"file" as const,effect,app,operations,scope:{path:location,recursive},
  });
  const p=(...rules:PersistentAccessPolicy["rules"]):PersistentAccessPolicy=>({version:2,defaultEffect:"deny",rules});
  const identity=()=>app;
  return {root,app,rule,p,identity};
}
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
describe("permanent file access enforced at Core tool boundary",()=>{
  it("preserves legacy file tools only before v2; v2 defaults to deny",()=>{
    const a=setup();
    const call:FileToolCall={name:"read",args:{filePaths:[".env"]}};
    expect(registeredFileToolGate(call,a.root,{registry:()=>null,identity:a.identity})).toBeNull();
    expect(registeredFileToolGate(call,a.root,{registry:()=>a.p(),identity:a.identity})).toMatch(/denies read/);
  });
  it("allows in-scope files but blocks exact protected child files and unrelated roots",()=>{
    const a=setup();
    const allowed=a.rule("project","allow",a.root,["read"],true);
    const blocked=a.rule("secret","deny",path.join(a.root,".env"),["read"]);
    const opts={registry:()=>a.p(allowed,blocked),identity:a.identity};
    const read=(f:string)=>registeredFileToolGate({name:"read",args:{filePaths:[f]}},a.root,opts);
    expect(read("src/main.ts")).toBeNull();
    expect(read(".env")).toMatch(/denies read/);
    expect(read("../somewhere.txt")).toMatch(/traversal/);
    expect(read(path.resolve(a.root,"..","outside.txt"))).toMatch(/denies read/);
  });
  it("enforces write needs read+write and patch needs delete permission",()=>{
    const a=setup();
    const read=a.rule("r","allow",a.root,["read"],true);
    const write=a.rule("w","allow",a.root,["write"],true);
    const base={name:"write_to_file",args:{files:[{filePath:"src/main.ts",content:"x"}]}};
    expect(registeredFileToolGate(base,a.root,{registry:()=>a.p(read),identity:a.identity})).toMatch(/denies write/);
    expect(registeredFileToolGate(base,a.root,{registry:()=>a.p(read,write),identity:a.identity})).toBeNull();
    const patch={name:"apply_patch",args:{patches:[{filePath:"src/main.ts"}]}};
    expect(registeredFileToolGate(patch,a.root,{registry:()=>a.p(read,write),identity:a.identity})).toMatch(/denies delete/);
  });
  it("blocks shell, recursive grep, unknown tool, and nested MCP gateway aliases",()=>{
    const a=setup();
    const opts={registry:()=>a.p(a.rule("allow","allow",a.root,["read","write"],true)),identity:a.identity};
    expect(registeredFileToolGate({name:"superagent_exec_command",args:{command:"cat .env"}},a.root,opts))
      .toMatch(/not certified/);
    expect(registeredFileToolGate({name:"superagent_grep_search",args:{query:"SECRET"}},a.root,opts))
      .toMatch(/Unmediated/);
    expect(registeredFileToolGate({name:"superagent_tool_execute",args:{
      name:"superagent_read_files",arguments:{files:["src/main.ts"]},
    }},a.root,opts)).toBeNull();
    expect(registeredFileToolGate({name:"superagent_tool_execute",args:{
      name:"superagent_exec_command",arguments:{command:"type .env"},
    }},a.root,opts)).toMatch(/not certified/);
    expect(registeredFileToolGate({name:"unknown_file_reader"},a.root,opts)).toMatch(/not certified/);
  });
  it("certifies only safe browser inventory under active permanent file policy",()=>{
    const a=setup(), opts={registry:()=>a.p(),identity:a.identity};
    const gate=(name:string,args:Record<string,unknown>)=>
      registeredFileToolGate({name,args},a.root,opts);
    expect(gate("superagent_browser_gateway",{action:"identity"})).toBeNull();
    expect(gate("superagent_browser_gateway",{action:"policy"})).toBeNull();
    expect(gate("superagent_list_running_chrome",{})).toBeNull();
    expect(gate("superagent_chrome_cdp",{command:"list_targets"})).toBeNull();
    expect(gate("superagent_control_chrome_cdp",{command:"transport_status",debug_port:9222})).toBeNull();
    expect(gate("superagent_tool_execute",{name:"superagent_chrome_cdp",arguments:{command:"list_targets"}})).toBeNull();
    for(const [name,args] of [
      ["superagent_chrome_cdp",{command:"evaluate",payload:"{}"}],
      ["superagent_chrome_cdp",{command:"navigate",url:"file:///secret"}],
      ["superagent_chrome_cdp",{command:"upload_file",files:["/secret"]}],
      ["superagent_chrome_cdp",{command:"list_targets",transport:"delegate"}],
      ["superagent_chrome_cdp",{command:"list_targets",payload:"{}"}],
      ["superagent_chrome_cdp",{command:"list_targets",debug_port:1}],
      ["superagent_browser_gateway",{action:"execute",command:"evaluate"}],
      ["superagent_browser_gateway",{action:"discover"}],
      ["superagent_browser_gateway",{action:"identity",payload:{filePath:"/secret"}}],
      ["superagent_list_running_chrome",{customUserDataPath:"/secret"}],
      ["superagent_list_chrome_profiles",{}],
    ] as const)expect(gate(name,args)).toMatch(/not certified/);
  });
  it("distinguishes metadata, app-owned storage, explicit file paths and action-dependent tools",()=>{
    const a=setup(),opts={registry:()=>a.p(),identity:a.identity};
    const gate=(name:string,args:Record<string,unknown>)=>registeredFileToolGate({name,args},a.root,opts);
    for(const name of ["superagent_process_pool_status","superagent_lan_capabilities"]) {
      expect(getPermanentFileToolReadiness(name)).toBe("certified_metadata");
      expect(gate(name,{})).toBeNull();
    }
    expect(getPermanentFileToolReadiness("superagent_delegate_sync_history")).toBe("certified_app_storage");
    expect(gate("superagent_delegate_sync_history",{maxChats:100,refreshRecent:10,force:false})).toBeNull();
    expect(gate("superagent_tool_execute",{name:"superagent_delegate_sync_history",
      arguments:{clientId:"client_1234",maxChats:25}})).toBeNull();
    for(const args of [
      {workspace:a.root}, {filePath:"src/main.ts"}, {maxChats:501},
      {force:"true"}, {clientId:"../../etc"},
    ]) {
      expect(gate("superagent_delegate_sync_history",args)).toMatch(/not certified/);
    }
    expect(getPermanentFileToolReadiness("superagent_read_files")).toBe("requires_explicit_files");
    expect(getPermanentFileToolReadiness("superagent_browser_gateway")).toBe("action_dependent");
    expect(getPermanentFileToolReadiness("superagent_exec_command")).toBe("uncertified");
    expect(gate("superagent_exec_command",{command:"echo hi"})).toMatch(/not certified/);
    for(const name of ["git_diff","get_git_diff","git_log"]) {
      expect(gate(name,{})).toMatch(/not certified/);
    }
  });
  it("certifies LAN inventory without permitting filePath injection or device actions",()=>{
    const a=setup(),opts={registry:()=>a.p(),identity:a.identity};
    const gate=(name:string,args:Record<string,unknown>)=>
      registeredFileToolGate({name,args},a.root,opts);
    for(const name of ["superagent_lan_list_devices","superagent_device_list","superagent_device_tunnel_list"]) {
      expect(getPermanentFileToolReadiness(name)).toBe("action_dependent");
      expect(gate(name,{})).toBeNull();
      expect(gate(name,{filePath:".env"})).toMatch(/not certified/);
    }
    for(const name of ["superagent_lan_pair_status","superagent_device_pair_status"]){
      expect(gate(name,{requestId:"12345678-1234-1234-1234-123456789abc"})).toBeNull();
      expect(gate(name,{requestId:"invalid"})).toMatch(/not certified/);
      expect(gate(name,{requestId:"12345678-1234-1234-1234-123456789abc",
        workspace:a.root})).toMatch(/not certified/);
    }
    expect(gate("superagent_lan_device_exec",{command:"cat /private"})).toMatch(/not certified/);
    expect(gate("superagent_lan_android_screen",{deviceId:"123"})).toMatch(/not certified/);
  });

  it("allows only attested Core lifecycle requests through file policy, not through MCP authorization",()=>{
    const a=setup(),opts={registry:()=>a.p(),identity:a.identity};
    const gate=(name:string,args:Record<string,unknown>)=>
      registeredFileToolGate({name,args},a.root,opts);
    const approvedShape={port:7888,confirm:true,
      operationId:"sample-operation-id-0001",expectedBuildDigest:"a".repeat(64)};
    for(const name of ["superagent_core_restart","superagent_core_rollback","superagent_core_drain"]){
      expect(getPermanentFileToolReadiness(name)).toBe("action_dependent");
      expect(gate(name,approvedShape)).toBeNull();
      expect(gate("superagent_tool_execute",{name,arguments:approvedShape})).toBeNull();
      expect(gate(name,{...approvedShape,confirm:false})).toMatch(/not certified/);
      expect(gate(name,{...approvedShape,expectedBuildDigest:"bad"})).toMatch(/not certified/);
      expect(gate(name,{...approvedShape,operationId:"short"})).toMatch(/not certified/);
      expect(gate(name,{...approvedShape,executablePath:"/tmp/core"})).toMatch(/not certified/);
      expect(gate(name,{...approvedShape,filePath:"/secret"})).toMatch(/not certified/);
    }
    expect(gate("superagent_cli_bridge",{action:"delegate",permissionMode:"full-auto"}))
      .toMatch(/not certified/);
  });
  it("allows bounded desktop metadata but refuses window content and input under v2",()=>{
    const a=setup(),opts={registry:()=>a.p(),identity:a.identity};
    const gate=(args:Record<string,unknown>)=>
      registeredFileToolGate({name:"superagent_desktop_ui",args},a.root,opts);
    expect(getPermanentFileToolReadiness("superagent_desktop_ui")).toBe("action_dependent");
    for(const args of [
      {command:"probe"}, {command:"list_windows",limit:50},
      {action:"get_active_window"}, {command:"find_window",query:"Chrome",pid:2345},
      {command:"list_installed_apps",limit:50},
      {command:"live_inventory"}, {command:"inspect_security_prompts"},
    ])expect(gate(args)).toBeNull();
    for(const args of [
      {command:"snapshot",sessionToken:"a".repeat(64)},
      {command:"open",pid:100},
      {command:"action",action:"click",elementId:"button"},
      {command:"inspect_window",includeScreenshotImage:true},
      {command:"list_windows",filePath:".env"},
      {command:"find_window",query:""},
      {command:"find_window",query:"Chrome",pid:-1},
      {command:"list_windows",limit:1000},
      {command:"live_inventory",sessionToken:"a".repeat(64)},
    ])expect(gate(args)).toMatch(/not certified/);
  });

  it("permits document/PDF/media readers only for explicitly authorized input files",()=>{
    const a=setup();
    const allowed=a.rule("project-read","allow",a.root,["read"],true);
    const blocked=a.rule("protected","deny",path.join(a.root,".env"),["read"]);
    const opts={registry:()=>a.p(allowed,blocked),identity:a.identity};
    const gate=(name:string,args:Record<string,unknown>)=>
      registeredFileToolGate({name,args},a.root,opts);
    for(const name of ["superagent_pdf_inspect","superagent_pdf_extract",
      "superagent_pdf_ocr","superagent_pdf_verify","superagent_media_inspect"]){
      expect(getPermanentFileToolReadiness(name)).toBe("requires_explicit_files");
      expect(gate(name,{inputPath:"src/main.ts"})).toBeNull();
      expect(gate(name,{inputPath:".env"})).toMatch(/denies read/);
      expect(gate(name,{inputPath:"src/main.ts",outputPath:"../../secret.txt"}))
        .toMatch(/certified argument/);
      expect(gate(name,{inputPath:"src/main.ts",certificatePath:"/private/key.p12"}))
        .toMatch(/certified argument/);
    }
    expect(getPermanentFileToolReadiness("superagent_read_document")).toBe("requires_explicit_files");
    expect(gate("superagent_read_document",{filePath:"src/main.ts"})).toBeNull();
    expect(gate("superagent_read_document",{filePath:".env"})).toMatch(/denies read/);
    expect(gate("superagent_tool_execute",{name:"superagent_read_document",
      arguments:{filePath:".env"}})).toMatch(/denies read/);
    expect(gate("superagent_pdf_extract",{inputPath:"src/main.ts",maxChars:500})).toBeNull();
    expect(gate("superagent_pdf_ocr",{inputPath:"src/main.ts",engine:"tiny"})).toBeNull();
    expect(gate("superagent_pdf_verify",{inputPath:"src/main.ts",expectedPageCount:1})).toBeNull();
    for(const name of ["superagent_pdf_render","superagent_pdf_edit",
      "superagent_pdf_sign","superagent_pdf_verify_signature","superagent_media_transform",
      "superagent_media_convert","superagent_media_batch"]){
      expect(gate(name,{inputPath:"src/main.ts"})).toMatch(/not certified/);
    }
    expect(gate("superagent_media_capabilities",{})).toBeNull();
    expect(gate("__proto__",{filePath:"src/main.ts"})).toMatch(/not certified/);
  });
  it("rejects service-manager mutation parameters disguised as read-only status",()=>{
    const a=setup(),opts={registry:()=>a.p(),identity:a.identity};
    const gate=(args:Record<string,unknown>)=>
      registeredFileToolGate({name:"superagent_manage_services",args},a.root,opts);
    expect(gate({action:"status",service:"mcp",limit:30,port:7888})).toBeNull();
    expect(gate({action:"dashboard",service:"all"})).toBeNull();
    for(const args of [
      {action:"status",expectedExecutablePath:"C:/private/secret.exe"},
      {action:"status",confirm:true,expectedBuildDigest:"a".repeat(64)},
      {action:"status",targetAction:"restart"},
      {action:"status",workspace:"/private"},
      {action:"restart",confirm:true},
      {action:"status",port:1},
      {action:"health",limit:9999},
    ])expect(gate(args)).toMatch(/not certified/);
  });
  it("authorizes every explicit media plan input, watermark and destination lookup",()=>{
    const a=setup();
    fs.writeFileSync(path.join(a.root,"src","stamp.png"),"fake png signature for policy test");
    const permit=a.rule("project","allow",a.root,["read"],true);
    const protectedFile=a.rule("secret","deny",path.join(a.root,".env"),["read"]);
    const opts={registry:()=>a.p(permit,protectedFile),identity:a.identity};
    const gate=(args:Record<string,unknown>)=>
      registeredFileToolGate({name:"superagent_media_plan",args},a.root,opts);
    expect(getPermanentFileToolReadiness("superagent_media_plan")).toBe("requires_explicit_files");
    expect(gate({inputPaths:["src/main.ts","src/stamp.png"],outputPath:"src/new.png"})).toBeNull();
    expect(gate({inputPath:"src/main.ts",outputPath:"src/new.png",
      operation:"watermark",watermarkPath:"src/stamp.png"})).toBeNull();
    expect(gate({inputPaths:["src/main.ts",".env"],outputPath:"src/new.png"}))
      .toMatch(/denies read/);
    expect(gate({inputPath:"src/main.ts",outputPath:".env"})).toMatch(/denies read/);
    expect(gate({inputPath:"src/main.ts",outputPath:"src/new.png",
      operation:"watermark",watermarkPath:".env"})).toMatch(/denies read/);
    expect(gate({inputPath:"src/main.ts",inputPaths:[".env"],outputPath:"src/new.png"}))
      .toMatch(/requires all explicit/);
    expect(gate({inputPath:"src/main.ts",outputPath:"src/new.png",
      filePath:"/private/hidden.txt"})).toMatch(/certified argument|requires all explicit/);
    expect(gate({inputPath:"src/main.ts",outputPath:"../private/new.png"})).toMatch(/traversal/);
  });
  it("blocks symlinked targets before IO when host OS authorizes links",()=>{
    const a=setup();
    const link=path.join(a.root,"link.ts");
    try{
      fs.symlinkSync(path.join(a.root,"src","main.ts"),link,"file");
    }catch{return;}
    const opts={registry:()=>a.p(a.rule("allow","allow",a.root,["read"],true)),identity:a.identity};
    expect(registeredFileToolGate({name:"read",args:{filePaths:["link.ts"]}},a.root,opts))
      .toMatch(/Non-canonical/);
  });
  it("fails closed for missing executable identity when file policy is active",()=>{
    const a=setup();
    const opts={registry:()=>a.p(a.rule("allow","allow",a.root,["read"],true)),identity:()=>null};
    expect(registeredFileToolGate({name:"read",args:{filePaths:["src/main.ts"]}},a.root,opts))
      .toMatch(/identity/);
  });
});
