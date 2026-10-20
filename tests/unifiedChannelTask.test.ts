import { describe, expect, it } from "vitest";
import { authorizeChannelOperation, projectCliDelegate, projectDaemonRun } from "../src/core/channels/unifiedChannelTask.js";
import type { DaemonRunRecord } from "../src/core/daemon/daemonTypes.js";
import type { DelegateJob } from "../src/core/tools/cliBridgeDelegateJobs.js";

const daemon: DaemonRunRecord = {
  runId:"run-1", jobId:"job-1", attemptNumber:1, workspacePath:"/workspace/a",
  projectId:"a", mode:"single", status:"success", startedAt:100,
  completedAt:120, executionPolicyJson:"{}", notificationStatus:"failed",
  outputSummary:"Completed", notificationError:"delivery failed",
};
const cli: DelegateJob = {
  jobId:"clj_1234567890123_aabbccdd", cliAlias:"test", binary:"node", cwd:"/workspace/a",
  workspaceRoot:"/workspace/a", pid:null, status:"succeeded",
  startedAt:100, updatedAt:120, exitCode:0, timedOut:false, timeoutMs:1000,
  completionState:"artifacts_verified", outputTail:"ok", outputBytes:2, logPath:"/tmp/out",
};
describe("Hermes Phase 5 channel contract",()=>{
 it("preserves channel identity, separate delivery status and evidence",()=>{
   expect(projectDaemonRun(daemon)).toMatchObject({
     channel:"daemon", taskId:"run-1", projectId:"a", sessionId:null, status:"succeeded",
     notification:"failed", authorization:"daemon_policy_snapshot", evidence:"unverified",
   });
   expect(projectCliDelegate(cli)).toMatchObject({
     channel:"cli",status:"succeeded",evidence:"verified",notification:"not_configured",
   });
 });
 it("does not interpret daemon successful exit as verified evidence",()=>{
   expect(projectDaemonRun({...daemon, status:"success"}).evidence).toBe("unverified");
   expect(projectDaemonRun({...daemon, status:"interrupted"}).status).toBe("interrupted");
   expect(projectCliDelegate({...cli,status:"verification_failed",completionState:"artifact_verification_failed"}).evidence).toBe("failed");
 });
 it("requires trusted identity, workspace, capability and out-of-band owner approval",()=>{
   const allowed = {trustedIdentity:true, workspaceAuthorized:true, allowWrite:true,
     allowPrivileged:false, unattended:false, approvedByOwner:true};
   expect(authorizeChannelOperation("read",allowed).allowed).toBe(true);
   expect(authorizeChannelOperation("write",allowed).allowed).toBe(true);
   expect(authorizeChannelOperation("privileged",allowed).allowed).toBe(false);
   expect(authorizeChannelOperation("write",{...allowed, unattended:true}).allowed).toBe(false);
   expect(authorizeChannelOperation("write",{...allowed, approvedByOwner:false}).allowed).toBe(false);
   expect(authorizeChannelOperation("read",{...allowed,trustedIdentity:false}).allowed).toBe(false);
   expect(authorizeChannelOperation("read",{...allowed,workspaceAuthorized:false}).allowed).toBe(false);
 });
 it("does not embed conversation history in normalized tasks",()=>{
   expect(Object.keys(projectDaemonRun(daemon))).not.toContain("messages");
   expect(projectDaemonRun({...daemon,outputSummary:"x".repeat(4000)}).summary?.length).toBeLessThanOrEqual(600);
 });
});
