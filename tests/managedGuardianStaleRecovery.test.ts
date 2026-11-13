import {describe,it,expect} from "vitest";
import {assertGuardianStaleRecoverySafety} from "../src/core/runtime/managedGuardianStaleRecovery.js";

const safe={
  coreSupervisorPid:20128,previousSupervisorPid:31480,
  ownerPid:37208,leasePid:31408,ownerPresent:true,
  controlPortBound:false,oldPidPresent:false,verifiedGuardian:false,
};
describe("explicit orphaned Guardian owner recovery",()=>{
  it("accepts only an absent, old-generation Guardian",()=>{
    expect(()=>assertGuardianStaleRecoverySafety(safe)).not.toThrow();
  });
  it("refuses a live or PID-reused old Guardian",()=>{
    expect(()=>assertGuardianStaleRecoverySafety({...safe,oldPidPresent:true})).toThrow();
  });
  it("refuses a bound private control port",()=>{
    expect(()=>assertGuardianStaleRecoverySafety({...safe,controlPortBound:true})).toThrow();
  });
  it("refuses an authenticated Guardian",()=>{
    expect(()=>assertGuardianStaleRecoverySafety({...safe,verifiedGuardian:true})).toThrow();
  });
  it("refuses previous Core supervisor or Guardian pointing at current Core",()=>{
    for(const variant of [
      {...safe,previousSupervisorPid:safe.coreSupervisorPid},
      {...safe,ownerPid:safe.coreSupervisorPid},
      {...safe,leasePid:safe.coreSupervisorPid},
    ])expect(()=>assertGuardianStaleRecoverySafety(variant)).toThrow();
  });
  it("requires owner records",()=>{
    expect(()=>assertGuardianStaleRecoverySafety({...safe,ownerPresent:false})).toThrow();
  });
});
