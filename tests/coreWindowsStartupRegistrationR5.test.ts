import {describe,it,expect} from "vitest";
import {createCoreWindowsStartupPlan} from "../src/core/runtime/coreWindowsStartup.js";
import {assessWindowsStartupRegistrationR5,
  type WindowsStartupRegistrationEvidenceR5} from
  "../src/core/runtime/coreWindowsStartupGuardR5.js";

const safe:WindowsStartupRegistrationEvidenceR5={
 port:7903,
 stageProfileVerified:true,
 ownerInventoryVerified:true,
 listenerPid:null,
 scheduledTaskPresent:false,
 coldAssessment:{decision:"fresh_guard_allowed",
  reasons:["CLEAN_AND_VERIFIED_NAMESPACE"],
  automaticToolReplay:false,mayDeleteCheckpoint:false},
};
const judge=(o:Partial<WindowsStartupRegistrationEvidenceR5>)=>
  assessWindowsStartupRegistrationR5({...safe,...o});
describe("R5 staging-only Scheduled Task registration preflight",()=>{
 it("permits operator-only staging registration candidate without approving startup",()=>{
  const result=judge({});
  expect(result.status).toBe("staging_registration_candidate");
  expect(result.blockers).toEqual([]);
  expect(result.productionApproved).toBe(false);
  expect(result.startScheduledTaskAllowed).toBe(false);
  expect(result.automaticReplayAllowed).toBe(false);
 });
 it("never permits shared Core/MCP ports or invalid ports",()=>{
  for(const port of [6789,7888,9877,0,-1,65536,15.1,NaN]){
   const result=judge({port});
   expect(result.status).toBe("blocked");
   expect(result.blockers).toContain("LEGACY_OR_INVALID_PORT_PROHIBITED");
  }
 });
 it("requires verified staging profile and OS listener inventory",()=>{
  expect(judge({stageProfileVerified:false}).blockers)
    .toContain("ISOLATED_PROFILE_NOT_VERIFIED");
  expect(judge({ownerInventoryVerified:false}).blockers)
    .toContain("TCP_OWNER_FREE_NOT_VERIFIED");
  expect(judge({listenerPid:4444}).status).toBe("blocked");
 });
 it("refuses scheduled task already present or unknown",()=>{
  for(const scheduledTaskPresent of [true,null]){
   expect(judge({scheduledTaskPresent}).blockers)
     .toContain("SCHEDULED_TASK_ABSENCE_NOT_VERIFIED");
  }
 });
 it("refuses cold boot on old worker/checkpoint/guardian evidence",()=>{
  for(const decision of ["already_running","recover_verified_survivors",
   "operator_review","blocked"] as const){
   expect(judge({coldAssessment:{...safe.coldAssessment,decision}}).blockers)
     .toContain("COLD_START_NAMESPACE_UNSAFE");
  }
 });
 it("fails closed if the cold-start assessor unexpectedly allows replay",()=>{
  const unsafe={...safe.coldAssessment,automaticToolReplay:true as false};
  expect(judge({coldAssessment:unsafe}).status).toBe("blocked");
 });
 it("launches isolated profile with explicit staging-only environment variables",()=>{
  const plan=createCoreWindowsStartupPlan({
   port:7903,cliFile:"D:\\Projects\\runtime\\dist\\cli.js",
   bunExecutable:"C:\\Users\\USER\\.bun\\bin\\bun.exe",
   launcherFile:"C:\\Users\\USER\\.superagent-local-staging\\r5\\windows-startup\\core-boot-7903.ps1",
   isolatedStageProfile:"C:\\Users\\USER\\.superagent-local-staging\\r5",
  });
  expect(plan.launcherContent).toContain("$env:SUPERAGENT_CONFIG_DIR = 'C:\\Users\\USER\\.superagent-local-staging\\r5'");
  expect(plan.launcherContent).toContain("$env:SUPERAGENT_CORE_STAGING = '1'");
  expect(plan.launcherContent).toContain("$env:SUPERAGENT_SENOPATI_AUTOSTART = '0'");
  expect(plan.launcherContent).toContain("core boot --port 7903");
  expect(plan.registerCommand).not.toContain("-Force");
 });
 it("quotes staged paths and rejects UNC/relative profile",()=>{
  const opts={port:7903,cliFile:"D:\\a\\dist\\cli.js",
   bunExecutable:"C:\\bun.exe",launcherFile:"C:\\tmp\\x.ps1"};
  expect(createCoreWindowsStartupPlan({...opts,
   isolatedStageProfile:"D:\\O'Brian\\recovery"}).launcherContent)
   .toContain("$env:SUPERAGENT_CONFIG_DIR = 'D:\\O''Brian\\recovery'");
  for(const path of ["..\\relative","\\\\server\\share\\profile","D:\\bad"+String.fromCharCode(10)+"line"])
   expect(()=>createCoreWindowsStartupPlan({...opts,isolatedStageProfile:path})).toThrow();
 });
});
