import { describe, expect, it } from "vitest";
import { auditCoreRetainedWorkers, type RetainedWorkerAuditInput } from "../src/core/runtime/coreRetainedWorkerAudit.js";
import type { CoreDrainMetrics } from "../src/core/runtime/coreDrainInspection.js";

const zeroMetrics: CoreDrainMetrics = {
  sessions:0,sseClients:0,browserClients:0,pendingPrompts:0,backgroundTasks:0,
  agents:0,cliBridgeSessions:0,detachedCliBridgeSessions:0,scheduledJobs:0,
  remoteTasks:0,daemonRunning:0,museWatcher:0,
};
const nonce = "a".repeat(32);
const base = (): RetainedWorkerAuditInput => ({
  status: {
    supervisorPid: 10, publicPort: 7888,
    active: {pid:11,port:50011,since:1000},
    retained:[{pid:12,port:50012,since:1100}], maxRetainedWorkers:4,
  },
  checkpoint: {
    activePid:11,
    workers:[
      {pid:11,port:50011,since:1000,generationId:"b".repeat(32),drainEligible:false},
      {pid:12,port:50012,since:1100,generationId:nonce,drainEligible:true},
    ], sessions:[],
  },
  evidence:[{
    pid:12,port:50012,since:1100,generationId:nonce,
    drainEligible:true,adopted:false,supervisorChildVerified:true,
    pinnedSessions:0,inflightRequests:0,
    drainReport:{pid:12,workerGenerationId:nonce,transportIsolated:true,visionOwner:false,safe:true,blockers:[],metrics:{...zeroMetrics}},
    secondDrainReport:{pid:12,workerGenerationId:nonce,transportIsolated:true,visionOwner:false,safe:true,blockers:[],metrics:{...zeroMetrics}},
  }],
});
describe("read-only retained worker audit", () => {
  it("produces only a supervisor drain candidate, never termination authority", () => {
    const result=auditCoreRetainedWorkers(base());
    expect(result.findings[0].classification).toBe("candidate-for-supervisor-drain");
    expect(result.mutationAuthorized).toBe(false);
    expect(result.restartBlocked).toBe(false);
  });
  it("treats missing checkpoint and ownership evidence as no-go", () => {
    const input=base(); delete input.checkpoint; delete input.evidence;
    const result=auditCoreRetainedWorkers(input);
    expect(result.classification).toBe("no-go");
    expect(result.findings[0].classification).toBe("blocked");
  });
  it("blocks helper owner and adopted process despite zero sessions", () => {
    const input=base(); input.checkpoint!.workers[1].drainEligible=false;
    input.evidence![0].adopted=true;
    const result=auditCoreRetainedWorkers(input);
    expect(result.findings[0].blockers.join(" ")).toMatch(/Helper owner/);
    expect(result.findings[0].blockers.join(" ")).toMatch(/Adopted/);
  });
  it("blocks unverified nonce and session ownership", () => {
    const input=base(); input.evidence![0].generationId="f".repeat(32);
    input.checkpoint!.sessions.push({owner:{pid:12,port:50012,since:1100}});
    expect(auditCoreRetainedWorkers(input).findings[0].blockers.join(" ")).toMatch(/nonce mismatch/);
    expect(auditCoreRetainedWorkers(input).findings[0].blockers.join(" ")).toMatch(/pins a session/);
  });
  it("rejects duplicated PIDs, unknown evidence and pending ledger", () => {
    const input=base(); input.status.retained.push({pid:11,port:50013,since:1200});
    input.ledger=[{action:"drain",state:"pending",beforePid:11}];
    const result=auditCoreRetainedWorkers(input);
    expect(result.globalBlockers.join(" ")).toMatch(/Duplicate PID/);
    expect(result.globalBlockers.join(" ")).toMatch(/Pending/);
  });
  it("does not treat repeated report object as independent inspections", () => {
    const input=base(); input.evidence![0].secondDrainReport=input.evidence![0].drainReport;
    expect(auditCoreRetainedWorkers(input).findings[0].classification).toBe("blocked");
  });
  it("fails closed on nonzero work and malformed metrics", () => {
    const input=base(); input.evidence![0].secondDrainReport!.metrics.backgroundTasks=1;
    expect(auditCoreRetainedWorkers(input).findings[0].classification).toBe("blocked");
    input.evidence![0].secondDrainReport!.metrics.backgroundTasks=-1;
    expect(auditCoreRetainedWorkers(input).findings[0].classification).toBe("blocked");
  });
  it("recognizes exact limit reached without suggesting automatic cleanup", () => {
    const input=base();
    for (let i=0;i<3;i++) input.status.retained.push({pid:30+i,port:51000+i,since:1400+i});
    const result=auditCoreRetainedWorkers(input);
    expect(result.restartBlocked).toBe(true);
    expect(result.mutationAuthorized).toBe(false);
  });
});
