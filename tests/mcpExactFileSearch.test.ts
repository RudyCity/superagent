import {afterEach,describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {searchExplicitAuthorizedFiles} from "../src/core/mcp/mcpExactFileSearch.js";
import {certifiedExplicitGrepSearchArgs,registeredFileToolGate}
  from "../src/core/tools/registeredFileToolGate.js";

const folders:string[]=[];
const make=()=>{
  const folder=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"sa-explicit-grep-")));
  folders.push(folder);
  fs.writeFileSync(path.join(folder,"alpha.txt"),"Hello world\nA second hello\nno match\n");
  fs.writeFileSync(path.join(folder,"secret.txt"),"private content\n");
  return folder;
};
afterEach(()=>{for(const folder of folders.splice(0))fs.rmSync(folder,{recursive:true,force:true});});

describe("bounded explicit approved-file literal search",()=>{
  it("paginates deterministic line matches without recursive traversal",()=>{
    const cwd=make();
    const first=searchExplicitAuthorizedFiles({filePaths:["alpha.txt"],query:"hello",limit:1},cwd);
    expect(first.matches).toEqual([{file:"alpha.txt",line:1,text:"Hello world"}]);
    expect(first.totalMatches).toBe(2);
    expect(first.hasMore).toBe(true);
    const second=searchExplicitAuthorizedFiles({filePaths:["alpha.txt"],query:"hello",offset:1,limit:1},cwd);
    expect(second.matches[0].line).toBe(2);
    expect(second.hasMore).toBe(false);
    const exact=searchExplicitAuthorizedFiles({filePaths:["alpha.txt"],query:"Hello",
      caseSensitive:true},cwd);
    expect(exact.totalMatches).toBe(1);
  });
  it("rejects regex, directory scans, traversal, symlinks and oversized files",()=>{
    const cwd=make();
    for(const args of [
      {query:"Hello",filePaths:[]}, {query:"Hello",path:"."},
      {query:"Hello",filePaths:["alpha.txt"],isRegex:true},
      {query:"Hello",filePaths:["alpha.txt"],limit:500},
      {query:"Hello",filePaths:["alpha.txt"],include:"*.txt"},
    ])expect(certifiedExplicitGrepSearchArgs(args)).toBe(false);
    expect(()=>searchExplicitAuthorizedFiles({filePaths:["../alpha.txt"],query:"Hello"},cwd))
      .toThrow();
    expect(()=>searchExplicitAuthorizedFiles({filePaths:["."],query:"Hello"},cwd))
      .toThrow();
    fs.writeFileSync(path.join(cwd,"large.txt"),"a".repeat(1024*1024+1));
    expect(()=>searchExplicitAuthorizedFiles({filePaths:["large.txt"],query:"a"},cwd))
      .toThrow(/BUDGET/);
    try{
      fs.symlinkSync(path.join(cwd,"alpha.txt"),path.join(cwd,"link.txt"),"file");
      expect(()=>searchExplicitAuthorizedFiles({filePaths:["link.txt"],query:"Hello"},cwd))
        .toThrow(/Non-canonical/);
    }catch(error){
      if(process.platform!=="win32")throw error;
    }
  });
  it("keeps v2 recursive grep denied but checks every explicit search target",()=>{
    const cwd=make();
    const app={
      platform:process.platform==="win32"?"win32" as const:
        process.platform==="darwin"?"darwin" as const:"linux" as const,
      executablePath:fs.realpathSync.native(process.execPath).replace(/^\\\\\?\\/,""),
      sha256:"a".repeat(64),
    };
    const allow={id:"search",kind:"file" as const,effect:"allow" as const,app,
      operations:["read" as const],scope:{path:cwd,recursive:true}};
    const deny={id:"private",kind:"file" as const,effect:"deny" as const,app,
      operations:["read" as const],scope:{path:path.join(cwd,"secret.txt"),recursive:false}};
    const opts={registry:()=>({version:2 as const,defaultEffect:"deny" as const,rules:[allow,deny]}),
      identity:()=>app};
    const gate=(args:Record<string,unknown>)=>
      registeredFileToolGate({name:"superagent_grep_search",args},cwd,opts);
    expect(gate({query:"hello",filePaths:["alpha.txt"],limit:2})).toBeNull();
    expect(gate({query:"hello",filePaths:["alpha.txt","secret.txt"]})).toMatch(/denies read/);
    expect(gate({query:"hello",path:cwd})).toMatch(/Unmediated/);
    expect(gate({query:"hello",filePaths:["alpha.txt"],isRegex:true})).toMatch(/Unmediated/);
    expect(gate({query:"hello",filePaths:["alpha.txt"],workspace:"../outside"}))
      .toMatch(/Unmediated|workspace|traversal|not certified/);
  });
});
