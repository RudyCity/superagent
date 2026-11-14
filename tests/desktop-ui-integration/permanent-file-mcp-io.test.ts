import {afterEach,describe,expect,it,vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {handleReadFile,handleWriteFile} from "../../src/core/mcp/tools/workspaceTools.js";
const configs:string[]=[];
const folders:string[]=[];
const fileText=(r:any)=>(r.content||[]).map((x:any)=>x.type==="text"?x.text:"").join("\n");
function fixture(){
  const config=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-config-"));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-file-"));
  configs.push(config); folders.push(root);
  fs.writeFileSync(path.join(root,"safe.txt"),"SAFE CONTENT");
  fs.writeFileSync(path.join(root,".env"),"SECRET_DO_NOT_LEAK");
  const executablePath=fs.realpathSync.native(process.execPath).replace(/^\\\\\?\\/,"");
  const app={
    platform:process.platform==="win32"?"win32":process.platform==="darwin"?"darwin":"linux",
    executablePath,sha256:crypto.createHash("sha256").update(fs.readFileSync(executablePath)).digest("hex"),
  };
  const rules=[
    {id:"allow-read",kind:"file",effect:"allow",app,operations:["read"],
      scope:{path:root,recursive:true}},
    {id:"block-secret",kind:"file",effect:"deny",app,operations:["read"],
      scope:{path:path.join(root,".env"),recursive:false}},
  ];
  fs.writeFileSync(path.join(config,"desktop-access-registry.json"),
    JSON.stringify({version:2,defaultEffect:"deny",rules}));
  return {config,root};
}
afterEach(()=>{
  vi.unstubAllEnvs();
  for(const dir of configs.splice(0).concat(folders.splice(0)))fs.rmSync(dir,{recursive:true,force:true});
});
describe("MCP direct read handler respects host-owned permanent file rules",()=>{
  it("denies direct MCP writes before modifying blocked content",async()=>{
    const {config,root}=fixture();
    vi.stubEnv("SUPERAGENT_CONFIG_DIR",config);
    const original=fs.readFileSync(path.join(root,".env"),"utf8");
    const denied=await handleWriteFile({filePath:".env",content:"OVERRIDE",cwd:root});
    expect(denied.isError).toBe(true);
    expect(fileText(denied)).toMatch(/permanent host file policy/);
    expect(fs.readFileSync(path.join(root,".env"),"utf8")).toBe(original);
  });
  it("returns permitted content but prevents blocked file contents from leaking",async()=>{
    const {config,root}=fixture();
    vi.stubEnv("SUPERAGENT_CONFIG_DIR",config);
    const allowed=await handleReadFile({filePath:"safe.txt",cwd:root});
    expect(allowed.isError).not.toBe(true);
    expect(fileText(allowed)).toContain("SAFE CONTENT");
    const denied=await handleReadFile({filePath:".env",cwd:root});
    expect(denied.isError).toBe(true);
    expect(fileText(denied)).toMatch(/permanent host file policy/);
    expect(fileText(denied)).not.toContain("SECRET_DO_NOT_LEAK");
  });
});
