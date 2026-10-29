import { describe, expect, beforeEach, afterEach, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { statusCommand } from "../src/core/commands/serviceStatusCommand.js";
import { doctorCommand } from "../src/core/commands/processDoctorCommand.js";
import { getProcessSupervisor, resetProcessSupervisorForTest } from "../src/core/process/processSupervisor.js";
import { getRuntimeGeneration, type ProcessRecord } from "../src/core/process/processRegistry.js";

const WS = "D:/safe/one";
const OTHER = "D:/foreign-secret/private";
let tmp: string;
let lines: string[];
const ctx = () => ({
  agent: { workingDirectory: WS },
  addLine: (line: {content:string}) => { lines.push(line.content); },
}) as any;

function record(workspace: string, id: string): ProcessRecord {
  return {
    recordId: id, pid: null, parentPid: 1,
    creationIdentity: null, executable: "node",
    sanitizedArgs: ["PRIVATE_PROMPT_NEVER_PRINT"],
    runtimeGeneration: getRuntimeGeneration(),
    ownership: { workspaceRoot: workspace, jobId: "private_job", sessionId: "private_session" },
    component: "cli_bridge", launchIntent: "headless", state: "exited",
    lifecycle: "job", cleanupPolicy: "caller_owned",
    exitCode: 0, signal: null, registeredAt: Date.now()-5000,
    updatedAt: Date.now(), exitedAt: Date.now(),
  };
}
describe("Process CLI read-only observability and workspace privacy", () => {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-proc-observe-"));
    process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR = path.join(tmp, "checkpoints");
    lines = [];
    resetProcessSupervisorForTest();
    const sup = getProcessSupervisor({ storagePath: path.join(tmp, "registry.json") });
    await sup.initialize();
    const { writeJobCheckpoint } = await import("../src/core/tools/cliBridgeReconciliation.js");
    await writeJobCheckpoint({
      checkpointId: "chk_clean",
      jobId: "private_job",
      timestamp: Date.now() - 5000,
      lastEvent: "verified_succeeded",
      resourceClaims: [],
      verificationState: "verified",
      hasMutatingWrite: false,
    });
    sup.getRegistry().addRecord(record(WS,"safe_record"));
    sup.getRegistry().addRecord(record(OTHER,"foreign_secret_record"));
  });
  afterEach(async () => {
    resetProcessSupervisorForTest();
    await fs.rm(tmp,{recursive:true,force:true});
  });
  it("/status processes shows only caller-workspace count, no other workspace details", async () => {
    await statusCommand.execute("processes",ctx());
    const text = lines.join("\n");
    expect(text).toContain("Managed process records: 1");
    expect(text).toContain("Terminal: 1");
    expect(text).toContain("Reconciliation findings: 1 mutating job(s) require review ('unknown_outcome_review_required')");
    expect(text).toContain("Recommendation: operator review required");
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain("foreign_secret_record");
    expect(text).not.toContain("PRIVATE_PROMPT_NEVER_PRINT");
  });

  it("/status and /doctor show reconciliation findings when mutating jobs require review", async () => {
    const { writeJobCheckpoint } = await import("../src/core/tools/cliBridgeReconciliation.js");
    await writeJobCheckpoint({
      checkpointId: "chk_test_mutating",
      jobId: "private_job",
      timestamp: Date.now() - 10000,
      lastEvent: "agent_tool_exec",
      resourceClaims: [],
      verificationState: "verifying",
      hasMutatingWrite: true,
    });

    lines = [];
    await statusCommand.execute("processes", ctx());
    let text = lines.join("\n");
    expect(text).toContain("unknown_outcome_review_required");
    expect(text).toContain("Recommendation: operator review required");

    lines = [];
    await doctorCommand.execute("processes", ctx());
    text = lines.join("\n");
    expect(text).toContain("job_status=unknown_outcome_review_required");
    expect(text).toContain("action=review");
    expect(text).not.toContain(OTHER);
  });
  it("/doctor processes provides only local scoped metadata and safe actions", async () => {
    await doctorCommand.execute("processes",ctx());
    const text = lines.join("\n");
    expect(text).toContain("PROCESS DOCTOR");
    expect(text).toContain("job=private_job");
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain("foreign_secret_record");
    expect(text).not.toContain("PRIVATE_PROMPT_NEVER_PRINT");
    expect(text).toContain("No process termination");
  });
  it("/doctor refuses unsupported input instead of other OS scans", async () => {
    await doctorCommand.execute("all",ctx());
    expect(lines.join("\n")).toContain("Usage: /doctor processes");
  });
});
