import {describe,it,expect} from "vitest";
import type {spawnSync} from "node:child_process";
import {
  visionPythonCandidates,resolveVisionPython,
} from "../src/core/runtime/visionPythonRuntime.js";

const identity={exe:process.execPath,version:"3.12.9"};
function fakeRunner(
  decide:(cmd:string,args:readonly string[])=>boolean,
  calls:string[],
):typeof spawnSync{
  return ((command:string,args:string[])=>{
    calls.push(command);
    return decide(command,args)
      ? {status:0,stdout:JSON.stringify(identity)+"\n"}
      : {status:1,stdout:""};
  }) as unknown as typeof spawnSync;
}
describe("Vision Python discovery from MCP/Tray runtimes",()=>{
  it("prefers explicit SUPERAGENT_VISION_PYTHON and never falls back on its failure",()=>{
    const env={SUPERAGENT_VISION_PYTHON:"/missing/configured/python",PATH:"/another/path"};
    expect(visionPythonCandidates(env,"linux")).toEqual([
      {command:"/missing/configured/python",flags:[],source:"configured"},
    ]);
    const calls:string[]=[];
    expect(resolveVisionPython(env,"linux",fakeRunner(()=>false,calls))).toBeNull();
    expect(calls).toEqual(["/missing/configured/python"]);
  });
  it("resolves an actual interpreter executable, not its PATH launcher",()=>{
    const calls:string[]=[];
    const result=resolveVisionPython({PATH:""}, "linux",
      fakeRunner((command,args)=>command==="python3"&&args.includes("-c"),calls));
    expect(result).toEqual({executable:process.execPath,version:"3.12.9",source:"path"});
    expect(calls).toEqual(["python","python3"]);
  });
  it("uses common Windows install locations even when service PATH lacks Python",()=>{
    const env={PATH:"",LOCALAPPDATA:"C:\\Users\\test\\AppData\\Local"};
    const candidates=visionPythonCandidates(env,"win32");
    const installation=candidates.find(x=>x.command.includes("Python312")&&
      x.command.endsWith("python.exe"));
    expect(installation?.source).toBe("windows-install");
    const calls:string[]=[];
    const result=resolveVisionPython(env,"win32",
      fakeRunner(command=>command===installation!.command,calls));
    expect(result?.source).toBe("windows-install");
    expect(result?.version).toBe("3.12.9");
    expect(calls).toContain(installation!.command);
  });
  it("rejects malformed or relative returned interpreter identities",()=>{
    const calls:string[]=[];
    const run=((cmd:string)=>{
      calls.push(cmd);
      return {status:0,stdout:JSON.stringify({exe:"python.exe",version:"3.12.9"})+"\n"};
    }) as unknown as typeof spawnSync;
    expect(resolveVisionPython({PATH:""},"linux",run)).toBeNull();
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
