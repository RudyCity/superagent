import {afterEach,describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  registeredFileToolGate,type FileToolCall,
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
