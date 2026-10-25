import {describe,it,expect} from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
 DEFAULT_SENOPATI_LIFECYCLE,
 eligibleForSenopatiLifecycle,parseSenopatiLifecycleConfig,
 readSenopatiLifecycleConfig,setSenopatiLifecycleConfig,
} from "../src/core/senopatiLifecycle.js";
import {
 makeSenopatiWindowsStartupScript,installSenopatiWindowsStartup,
 uninstallSenopatiWindowsStartup,senopatiWindowsStartupStatus,
} from "../src/core/senopatiWindowsStartup.js";

const sharedPolicy={backend:"mmbert-v64-seed73" as const,
 enabled:true,inferenceMode:"shared_only" as const};
describe("Senopati V6.9 CLI/T-Line app lifecycle admission",()=>{
 it("starts only guarded shared-only mode, not legacy, local or core-worker",()=>{
  expect(eligibleForSenopatiLifecycle(sharedPolicy)).toBe(true);
  expect(eligibleForSenopatiLifecycle(sharedPolicy,{disable:true})).toBe(false);
  expect(eligibleForSenopatiLifecycle(sharedPolicy,{testMode:true})).toBe(false);
  expect(eligibleForSenopatiLifecycle(sharedPolicy,{coreWorker:true})).toBe(false);
  expect(eligibleForSenopatiLifecycle({...sharedPolicy,enabled:false})).toBe(false);
  expect(eligibleForSenopatiLifecycle({...sharedPolicy,inferenceMode:"local"})).toBe(false);
  expect(eligibleForSenopatiLifecycle({...sharedPolicy,backend:"legacy"})).toBe(false);
 });
 it("accepts only explicit config with keep-model-on-client-exit",()=>{
  expect(parseSenopatiLifecycleConfig(DEFAULT_SENOPATI_LIFECYCLE))
   .toEqual(DEFAULT_SENOPATI_LIFECYCLE);
  expect(()=>parseSenopatiLifecycleConfig({autoStartOnAppLaunch:true,
    keepModelAfterClientExit:false})).toThrow();
  expect(()=>parseSenopatiLifecycleConfig({autoStartOnAppLaunch:1,
    keepModelAfterClientExit:true})).toThrow();
  expect(()=>parseSenopatiLifecycleConfig(null)).toThrow();
 });
 it("persists off/on lifecycle config within an isolated user profile",()=>{
  const old=process.env.SUPERAGENT_CONFIG_DIR;
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"senopati-lifecycle-"));
  try{
   process.env.SUPERAGENT_CONFIG_DIR=folder;
   // A temporary/staging profile does not auto-start 500+ MiB without
   // explicit local configuration.
   expect(readSenopatiLifecycleConfig()).toMatchObject({
    autoStartOnAppLaunch:false,
   });
   const off=setSenopatiLifecycleConfig({autoStartOnAppLaunch:false,
    keepModelAfterClientExit:true});
   expect(off.autoStartOnAppLaunch).toBe(false);
   expect(readSenopatiLifecycleConfig()).toEqual(off);
   const on=setSenopatiLifecycleConfig(DEFAULT_SENOPATI_LIFECYCLE);
   expect(readSenopatiLifecycleConfig()).toEqual(on);
  }finally{
   if(old===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
   else process.env.SUPERAGENT_CONFIG_DIR=old;
   fs.rmSync(folder,{recursive:true,force:true});
  }
 });
 it("renders safe Windows command without injecting shell operators",()=>{
  const bun=path.resolve("node_modules",".bin","bun.exe");
  const runner=path.resolve("scripts","senopati-login.ts");
  const contents=makeSenopatiWindowsStartupScript(bun,runner);
  expect(contents).toContain("senopati-login.ts");
  expect(contents).toContain("@echo off");
  expect(contents).toContain("start \"\" /min");
  expect(()=>makeSenopatiWindowsStartupScript(bun+" & echo malicious",runner)).toThrow();
  expect(()=>makeSenopatiWindowsStartupScript(bun,runner+"\"")).toThrow();
 });
 it.skipIf(process.platform!=="win32")(
  "installs only one owner-managed per-user Startup file; removal cannot destroy foreign files",
  ()=>{
   const old=process.env.APPDATA;
   const folder=fs.mkdtempSync(path.join(os.tmpdir(),"senopati-login-"));
   try{
    process.env.APPDATA=folder;
    expect(senopatiWindowsStartupStatus().installed).toBe(false);
    const installed=installSenopatiWindowsStartup();
    expect(fs.existsSync(installed)).toBe(true);
    expect(senopatiWindowsStartupStatus()).toMatchObject({
     installed:true,managed:true,
    });
    expect(installSenopatiWindowsStartup()).toBe(installed);
    fs.writeFileSync(installed,"unknown manually created user script");
    expect(senopatiWindowsStartupStatus().managed).toBe(false);
    expect(()=>uninstallSenopatiWindowsStartup()).toThrow();
    fs.unlinkSync(installed);
    installSenopatiWindowsStartup();
    expect(uninstallSenopatiWindowsStartup()).toBe(true);
    expect(senopatiWindowsStartupStatus().installed).toBe(false);
   }finally{
    if(old===undefined)delete process.env.APPDATA;
    else process.env.APPDATA=old;
    fs.rmSync(folder,{recursive:true,force:true});
   }
  },
 );
});
