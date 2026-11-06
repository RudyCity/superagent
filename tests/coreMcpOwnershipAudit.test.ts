import {describe,it,expect} from "vitest";
import {auditCoreMcpOwnership,parseWindowsListenerOwners} from "../src/core/runtime/coreMcpOwnershipAudit.js";
describe("Phase 5m read-only Core/MCP process ownership",()=>{
  it("parses Windows listeners without mistaking established connections for owners",()=>{
    const out=parseWindowsListenerOwners([
      "  TCP    127.0.0.1:7888   0.0.0.0:0   LISTENING   13424",
      "  TCP    127.0.0.1:6789   0.0.0.0:0   LISTENING   13424",
      "  TCP    127.0.0.1:9877   0.0.0.0:0   LISTENING   10060",
      "  TCP    127.0.0.1:6789   127.0.0.1:59215   ESTABLISHED   10000",
    ].join("\r\n"));
    expect(out.get(7888)).toBe(13424);
    expect(out.get(6789)).toBe(13424);
    expect(out.get(9877)).toBe(10060);
  });
  it("recovers PID-0 localhost listeners only from unanimous server-side established rows",()=>{
    const out=parseWindowsListenerOwners([
      "  TCP    127.0.0.1:9229   127.0.0.1:0       LISTENING     0",
      "  TCP    127.0.0.1:9229   127.0.0.1:49202   ESTABLISHED   20364",
      "  TCP    127.0.0.1:9229   127.0.0.1:58572   ESTABLISHED   20364",
      "  TCP    127.0.0.1:49202  127.0.0.1:9229    ESTABLISHED   8456",
    ].join("\r\n"));
    expect(out.get(9229)).toBe(20364);
    const ambiguous=parseWindowsListenerOwners([
      "  TCP    127.0.0.1:9229   127.0.0.1:0       LISTENING     0",
      "  TCP    127.0.0.1:9229   127.0.0.1:50001   ESTABLISHED   20364",
      "  TCP    127.0.0.1:9229   127.0.0.1:50002   ESTABLISHED   99999",
    ].join("\r\n"));
    expect(ambiguous.get(9229)).toBe(0);
  });
  it("blocks cutover when legacy API and live MCP listener share exact verified PID",async()=>{
    const data=await auditCoreMcpOwnership({
      corePort:7888,coreRegistration:"legacy_or_foreign",
      listeners:new Map([[7888,13424],[6789,13424],[9877,10060]]),
      mcps:[{port:6789,pid:13424,authMode:"oauth"},
        {port:9877,pid:10060,authMode:"oauth"}],
    });
    expect(data.decision).toBe("shared_owner_do_not_cutover");
    expect(data.mcp.every(m=>m.identity==="pid_verified")).toBe(true);
    expect(data.canStopMcp).toBe(false);
    expect(data.canRestartCore).toBe(false);
    expect(data.canTransferOAuth).toBe(false);
  });
  it("never mistakes stale state PID or missing OS evidence for safe separation",async()=>{
    for(const listeners of [null,new Map([[7888,13500],[6789,14000]]),new Map([[7888,13500]])]){
      const data=await auditCoreMcpOwnership({
        corePort:7888,coreRegistration:"supervised",listeners,
        mcps:[{port:6789,pid:13500,authMode:"oauth"}],
      });
      expect(data.decision).toBe("unverified_do_not_cutover");
      expect(data.externalProcessSignalsSent).toBe(false);
    }
  });
  it("separate supervisor and verified MCP owner remain operator-only, not auto-cutover",async()=>{
    const data=await auditCoreMcpOwnership({
      corePort:58911,coreRegistration:"supervised",
      listeners:new Map([[58911,13500],[58921,14000]]),
      mcps:[{port:58921,pid:14000,authMode:"static-bearer"}],
    });
    expect(data.decision).toBe("separate_owners_needs_operator_review");
    expect(data.canRestartCore).toBe(false);
  });
});
