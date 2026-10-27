import {describe,it,expect} from "vitest";
import {assessWindowsStartupRegistrationR5,type WindowsStartupRegistrationEvidenceR5}
  from "../src/core/runtime/coreWindowsStartupGuardR5.js";
const safe:WindowsStartupRegistrationEvidenceR5={
  port:7903,stageProfileVerified:true,ownerInventoryVerified:true,listenerPid:null,scheduledTaskPresent:false,
  coldAssessment:{decision:"fresh_guard_allowed",reasons:["CLEAN_AND_VERIFIED_NAMESPACE"],
    automaticToolReplay:false,mayDeleteCheckpoint:false,mayArchiveStaleRuntime:false},
};
const judge=(o:Partial<WindowsStartupRegistrationEvidenceR5>)=>assessWindowsStartupRegistrationR5({...safe,...o});
describe("R5 Windows startup registration preflight",()=>{
  it("permits isolated staging candidate",()=>{
    const r=judge({});expect(r.status).toBe("staging_registration_candidate");
    expect(r.productionApproved).toBe(false);expect(r.automaticReplayAllowed).toBe(false);
  });
  it("blocks legacy ports in staging and invalid ports everywhere",()=>{
    for(const port of [6789,7888,9877]) expect(judge({port}).blockers).toContain("LEGACY_OR_INVALID_PORT_PROHIBITED");
    for(const port of [0,-1,65536,15.1,NaN]) expect(judge({port}).blockers).toContain("INVALID_PORT");
  });
  it("allows explicit production registration only with verified live owners",()=>{
    const r=judge({
      port:7888,productionRequested:true,stageProfileVerified:false,listenerPid:20292,
      supervisedCoreVerified:true,guardianVerified:true,independentMcpVerified:true,
      coldAssessment:{...safe.coldAssessment,decision:"already_running"},
    });
    expect(r.status).toBe("production_registration_candidate");
    expect(r.productionApproved).toBe(true);
    expect(r.startScheduledTaskAllowed).toBe(false);
  });
  it("fails production closed on missing evidence",()=>{
    for(const key of ["supervisedCoreVerified","guardianVerified","independentMcpVerified"] as const){
      const r=judge({
        port:7888,productionRequested:true,listenerPid:20292,
        supervisedCoreVerified:true,guardianVerified:true,independentMcpVerified:true,
        coldAssessment:{...safe.coldAssessment,decision:"already_running"},[key]:false,
      });
      expect(r.status).toBe("blocked");
    }
  });
  it("refuses duplicate/unknown task",()=>{
    for(const scheduledTaskPresent of [true,null]) expect(judge({scheduledTaskPresent}).status).toBe("blocked");
  });
});
