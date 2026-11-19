/** Bounded, shell-free discovery of a real Python interpreter for Vision.
 * MCP/Tray processes on Windows often do not inherit the interactive shell's
 * PATH. Never treat a Windows Store alias or launcher as the server owner PID.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type VisionPython = { executable: string; version: string; source: "configured" | "path" | "windows-install" };
export type VisionPythonCandidate = { command: string; flags: string[]; source: VisionPython["source"] };
export function visionPythonCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): VisionPythonCandidate[] {
  const configured = env.SUPERAGENT_VISION_PYTHON?.trim();
  // Explicit configuration must never silently fall back to a different
  // interpreter with different site-packages or a different security identity.
  if(configured)return [{command:configured,flags:[],source:"configured"}];
  const result: VisionPythonCandidate[] = [
    {command:"python",flags:[],source:"path"},
    {command:"python3",flags:[],source:"path"},
    {command:"py",flags:["-3"],source:"path"},
  ];
  if(platform==="win32"){
    const roots=[
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA,"Programs","Python"),
      env.ProgramFiles,
      env.ProgramFiles && path.win32.join(env.ProgramFiles,"Python"),
    ].filter((v):v is string=>typeof v==="string"&&path.win32.isAbsolute(v));
    for(const root of roots){
      for(const name of ["Python313","Python312","Python311","Python310","Python314"]){
        result.push({command:path.win32.join(root,name,"python.exe"),flags:[],source:"windows-install"});
      }
    }
  }
  return result;
}
export function resolveVisionPython(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  run: typeof spawnSync = spawnSync,
): VisionPython | null {
  const script="import json,sys; print(json.dumps({'exe':sys.executable,'version':sys.version.split()[0]}))";
  for(const candidate of visionPythonCandidates(env,platform)){
    try{
      const probe=run(candidate.command,[...candidate.flags,"-c",script],{
        windowsHide:true,timeout:5000,encoding:"utf8",
        stdio:["ignore","pipe","ignore"],env,
      });
      if(probe.error||probe.status!==0||typeof probe.stdout!=="string")continue;
      const lines=probe.stdout.trim().split(/\r?\n/);
      const data=JSON.parse(lines.at(-1)||"{}") as {exe?:unknown;version?:unknown};
      if(typeof data.exe!=="string"||!path.isAbsolute(data.exe)||
         typeof data.version!=="string"||!/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(data.version))continue;
      // Verify the actual binary. Launch sys.executable itself (not the shim)
      // so PID/kernel owner checks remain meaningful.
      const real=fs.realpathSync.native(data.exe);
      const stat=fs.statSync(real);
      if(!stat.isFile())continue;
      return {executable:data.exe,version:data.version,source:candidate.source};
    }catch{
      // One missing alias or a Store stub must not break other candidates.
    }
  }
  return null;
}
