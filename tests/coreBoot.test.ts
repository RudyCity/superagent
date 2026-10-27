import { describe, expect, it } from "vitest";
import { createCoreWindowsStartupPlan } from "../src/core/runtime/coreWindowsStartup.js";
import { decideCoreBoot } from "../src/core/runtime/coreBoot.js";
const clean={checkpointPresent:false,discoveryPresent:false,guardianLeasePresent:false,
  verifiedRunningOwner:false,checkpointValid:false,checkpointModeMatches:false,coldResetAllowed:false};
describe("fail-closed Core login bootstrap",()=>{
  it("starts fresh guardian only with an empty owner namespace",()=>{
    expect(decideCoreBoot(clean)).toBe("fresh_guard");
    expect(decideCoreBoot({...clean,discoveryPresent:true})).toBe("refuse");
    expect(decideCoreBoot({...clean,guardianLeasePresent:true})).toBe("refuse");
  });
  it("recovers only a well-formed checkpoint whose client mode matches",()=>{
    expect(decideCoreBoot({...clean,checkpointPresent:true,checkpointValid:true,checkpointModeMatches:true})).toBe("recover_survivors");
    expect(decideCoreBoot({...clean,checkpointPresent:true,checkpointValid:false,checkpointModeMatches:true})).toBe("refuse");
    expect(decideCoreBoot({...clean,checkpointPresent:true,checkpointValid:true,checkpointModeMatches:false})).toBe("refuse");
  });
  it("permits cold reset only after explicit safe audit",()=>{
    expect(decideCoreBoot({...clean,checkpointPresent:true,checkpointValid:true,checkpointModeMatches:true,
      guardianLeasePresent:true,discoveryPresent:true,coldResetAllowed:true})).toBe("cold_reset");
    expect(decideCoreBoot({...clean,checkpointPresent:true,checkpointValid:true,checkpointModeMatches:true,
      guardianLeasePresent:true,discoveryPresent:true,coldResetAllowed:false})).toBe("refuse");
  });
  it("running authenticated owner always wins",()=>{
    expect(decideCoreBoot({...clean,verifiedRunningOwner:true,coldResetAllowed:true})).toBe("already_running");
  });
});
describe("Windows startup task planning is safe and opt-in",()=>{
  const opts={port:7888,cliFile:"D:\\Projects\\super agent\\dist\\cli.js",
    bunExecutable:"C:\\Users\\USER\\.bun\\bin\\bun.exe",
    launcherFile:"C:\\Users\\USER\\.superagent-r\\windows-startup\\core-boot-7888.ps1"};
  it("uses current-user logon and no kill commands",()=>{
    const plan=createCoreWindowsStartupPlan(opts);
    expect(plan.taskName).toBe("SuperAgent-Core-Boot-7888");
    expect(plan.registerCommand).toContain("New-ScheduledTaskTrigger -AtLogOn");
    expect(plan.registerCommand).toContain("-RunLevel Limited");
    expect(plan.registerCommand).not.toContain("-Force");
    expect(plan.launcherContent).toContain("core boot --port 7888 --client-mode tline");
    expect(plan.launcherContent).not.toContain("taskkill");
  });
  it("escapes quotes and rejects unsafe paths",()=>{
    expect(createCoreWindowsStartupPlan({...opts,cliFile:"D:\\O'Brian\\app\\dist\\cli.js"}).launcherContent)
      .toContain("'D:\\O''Brian\\app\\dist\\cli.js'");
    expect(()=>createCoreWindowsStartupPlan({...opts,port:80})).toThrow();
    expect(()=>createCoreWindowsStartupPlan({...opts,cliFile:"\\\\server\\remote\\dist\\cli.js"})).toThrow();
  });
});
