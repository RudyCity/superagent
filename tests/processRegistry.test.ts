import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ProcessRegistry,
  generateProcessRecordId,
  getRuntimeGeneration,
  setRuntimeGenerationForTest,
  sanitizeProcessCommand,
  type ProcessRecord,
} from "../src/core/process/processRegistry.js";
import {
  ProcessSupervisor,
  resetProcessSupervisorForTest,
} from "../src/core/process/processSupervisor.js";
import { readProcessStartIdentity } from "../src/core/tools/cliBridgeProcessIdentity.js";

describe("M1 Durable Process Ownership Registry Foundation", () => {
  let tempDir: string;
  let registryFile: string;
  const originalGeneration = getRuntimeGeneration();

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sp-proc-test-"));
    registryFile = path.join(tempDir, "process-registry-v1.json");
    resetProcessSupervisorForTest();
    setRuntimeGenerationForTest(`gen_test_${Date.now()}_${process.pid}`);
  });

  afterEach(async () => {
    resetProcessSupervisorForTest();
    setRuntimeGenerationForTest(originalGeneration);
    try {
      if (fs.existsSync(tempDir)) {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe("1. Stable Record ID Independent of PID", () => {
    it("generates distinct, stable record IDs independent of OS PID", () => {
      const id1 = generateProcessRecordId();
      const id2 = generateProcessRecordId();

      expect(id1).toMatch(/^sp_proc_\d+_[a-f0-9]+$/);
      expect(id2).toMatch(/^sp_proc_\d+_[a-f0-9]+$/);
      expect(id1).not.toBe(id2);
    });

    it("maintains the same record ID across PID assignment and state transitions", async () => {
      const supervisor = new ProcessSupervisor({ storagePath: registryFile });
      const record = await supervisor.registerProcess({
        component: "cli_bridge",
        executable: "node",
        args: ["--version"],
        launchIntent: "headless",
      });

      const initialId = record.recordId;
      expect(record.pid).toBeNull();
      expect(record.state).toBe("registered");

      // Assign PID upon spawn
      const spawned = await supervisor.recordProcessSpawn(initialId, 99999);
      expect(spawned?.recordId).toBe(initialId);
      expect(spawned?.pid).toBe(99999);
      expect(spawned?.state).toBe("running");

      // Record exit
      const exited = await supervisor.recordProcessExit(initialId, { exitCode: 0 });
      expect(exited?.recordId).toBe(initialId);
      expect(exited?.pid).toBe(99999);
      expect(exited?.state).toBe("exited");
    });
  });

  describe("2. PID Reuse & Creation Identity Mismatch Rejection", () => {
    it("verifies ownership when PID, start identity, and runtime generation match", () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      const recordId = generateProcessRecordId();

      const record: ProcessRecord = {
        recordId,
        pid: 12345,
        parentPid: process.pid,
        creationIdentity: "win:638000000000000000",
        executable: "node.exe",
        sanitizedArgs: ["server.js"],
        runtimeGeneration: getRuntimeGeneration(),
        component: "core",
        launchIntent: "headless",
        state: "running",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: null,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      };
      registry.addRecord(record);

      const check = registry.verifyOwnership(
        recordId,
        "win:638000000000000000",
        "pid_present_unverified"
      );

      expect(check.status).toBe("verified_owner");
      expect(check.isOwnedByCurrentRuntime).toBe(true);
      expect(check.identityComparison).toBe("matched_unverified");
    });

    it("rejects ownership and flags identity mismatch on PID reuse", () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      const recordId = generateProcessRecordId();

      const record: ProcessRecord = {
        recordId,
        pid: 12345,
        parentPid: process.pid,
        creationIdentity: "win:638000000000000000",
        executable: "node.exe",
        sanitizedArgs: ["server.js"],
        runtimeGeneration: getRuntimeGeneration(),
        component: "core",
        launchIntent: "headless",
        state: "running",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: null,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      };
      registry.addRecord(record);

      // Observed identity is different (PID reused by another process)
      const check = registry.verifyOwnership(
        recordId,
        "win:999999999999999999",
        "pid_present_unverified"
      );

      expect(check.status).toBe("identity_mismatch_blocked");
      expect(check.isOwnedByCurrentRuntime).toBe(false);
      expect(check.identityComparison).toBe("mismatch");
      expect(check.reason).toMatch(/PID reuse suspected/i);
    });

    it("never treats a live PID alone as proof of ownership without creation identity", () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      const recordId = generateProcessRecordId();

      const record: ProcessRecord = {
        recordId,
        pid: 12345,
        parentPid: process.pid,
        creationIdentity: null, // No birth identity recorded yet
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "shell_tool",
        launchIntent: "headless",
        state: "running",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: null,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      };
      registry.addRecord(record);

      const check = registry.verifyOwnership(recordId, undefined, "pid_present_unverified");

      expect(check.status).toBe("unverified_pid_present");
      expect(check.isOwnedByCurrentRuntime).toBe(false);
      expect(check.reason).toMatch(/PID alone NEVER proves ownership/i);
    });

    it("never adopts historical processes from an older runtime generation", () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      const recordId = generateProcessRecordId();

      const record: ProcessRecord = {
        recordId,
        pid: 12345,
        parentPid: 8888,
        creationIdentity: "win:638000000000000000",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: "gen_previous_session_12345", // Historical generation
        component: "cli_bridge",
        launchIntent: "headless",
        state: "running",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: null,
        registeredAt: Date.now() - 10000,
        updatedAt: Date.now() - 10000,
      };
      registry.addRecord(record);

      const check = registry.verifyOwnership(
        recordId,
        "win:638000000000000000",
        "pid_present_unverified"
      );

      expect(check.status).toBe("historical_unverified");
      expect(check.isOwnedByCurrentRuntime).toBe(false);
      expect(check.reason).toMatch(/different runtime generation.*never adopted/i);
    });
  });

  describe("3. Corrupt Registry Fails Closed", () => {
    it("fails closed on unparseable corrupted JSON without overwriting data", async () => {
      await fsp.writeFile(registryFile, "{\"version\": 1, \"corrupt_unclosed_data: [", "utf8");

      const registry = new ProcessRegistry({ storagePath: registryFile });
      const loadResult = await registry.load();

      expect(loadResult.success).toBe(false);
      expect(loadResult.error).toMatch(/Malformed JSON/i);
      expect(registry.isRegistryCorrupt()).toBe(true);

      // Ownership checks fail closed
      const check = registry.verifyOwnership("some_id");
      expect(check.status).toBe("corrupt_blocked");
      expect(check.isOwnedByCurrentRuntime).toBe(false);

      // Save throws fail-closed to avoid data corruption or overwriting
      await expect(registry.save()).rejects.toThrow(/fail-closed/i);

      // Verify the on-disk file was not wiped or modified
      const diskContent = await fsp.readFile(registryFile, "utf8");
      expect(diskContent).toContain("corrupt_unclosed_data");
    });

    it("fails closed on schema version mismatch or invalid records format", async () => {
      await fsp.writeFile(
        registryFile,
        JSON.stringify({ version: 99, records: "not-an-array" }),
        "utf8"
      );

      const registry = new ProcessRegistry({ storagePath: registryFile });
      const loadResult = await registry.load();

      expect(loadResult.success).toBe(false);
      expect(loadResult.error).toMatch(/Schema violation/i);
      expect(registry.isRegistryCorrupt()).toBe(true);
    });
  });

  describe("4. Bounded Retention & Compaction", () => {
    it("compacts terminal records to stay within bounded max while preserving all active records", async () => {
      const registry = new ProcessRegistry({
        storagePath: registryFile,
        maxRecords: 6,
      });

      // Add 3 active records
      for (let i = 1; i <= 3; i++) {
        registry.addRecord({
          recordId: `active_${i}`,
          pid: 1000 + i,
          parentPid: process.pid,
          creationIdentity: null,
          executable: "node",
          sanitizedArgs: [],
          runtimeGeneration: getRuntimeGeneration(),
          component: "core",
          launchIntent: "headless",
          state: "running",
          cleanupPolicy: "caller_owned",
          exitCode: null,
          signal: null,
          registeredAt: 1000,
          updatedAt: 1000,
        });
      }

      // Add 8 terminal records with increasing timestamps
      for (let i = 1; i <= 8; i++) {
        registry.addRecord({
          recordId: `terminal_${i}`,
          pid: 2000 + i,
          parentPid: process.pid,
          creationIdentity: null,
          executable: "node",
          sanitizedArgs: [],
          runtimeGeneration: getRuntimeGeneration(),
          component: "shell_tool",
          launchIntent: "headless",
          state: "exited",
          cleanupPolicy: "caller_owned",
          exitCode: 0,
          signal: null,
          registeredAt: 1000 + i * 10,
          updatedAt: 1000 + i * 10,
          exitedAt: 1000 + i * 10,
        });
      }

      expect(registry.listRecords().length).toBe(11);

      // Perform compaction
      registry.compact();

      const remaining = registry.listRecords();
      expect(remaining.length).toBe(6);

      // All 3 active records must be preserved
      const remainingIds = new Set(remaining.map((r) => r.recordId));
      expect(remainingIds.has("active_1")).toBe(true);
      expect(remainingIds.has("active_2")).toBe(true);
      expect(remainingIds.has("active_3")).toBe(true);

      // Only the newest terminal records (terminal_8, terminal_7, terminal_6) are kept
      expect(remainingIds.has("terminal_8")).toBe(true);
      expect(remainingIds.has("terminal_7")).toBe(true);
      expect(remainingIds.has("terminal_6")).toBe(true);

      // Oldest terminal records pruned
      expect(remainingIds.has("terminal_1")).toBe(false);
      expect(remainingIds.has("terminal_2")).toBe(false);
    });
  });

  describe("5. Secret & Raw Prompt Redaction", () => {
    it("redacts raw prompts, API keys, tokens, and encoded commands", () => {
      const rawArgs = [
        "--prompt",
        "Write a secret payload with sk-proj-1234567890abcdef1234567890",
        "--api-key",
        "AIzaSyD-1234567890abcdefghijklmnopqrst",
        "-encodedcommand",
        "SQBuAHYAbwBrAGUALQBXAGUAYgBSAGUAcQB1AGUAcwB0AA==",
        "--normal-flag",
        "safe-value",
      ];

      const { sanitizedExecutable, sanitizedArgs } = sanitizeProcessCommand(
        "C:\\Tools\\secret-binary.exe",
        rawArgs
      );

      expect(sanitizedExecutable).toBe("secret-binary.exe");

      // Verify no raw prompts or keys survive
      const argsJoined = sanitizedArgs.join(" ");
      expect(argsJoined).not.toContain("Write a secret payload");
      expect(argsJoined).not.toContain("sk-proj-");
      expect(argsJoined).not.toContain("AIzaSyD-");
      expect(argsJoined).not.toContain("SQBuAHYAbw");

      // Verified redacted markers
      expect(sanitizedArgs).toContain("[REDACTED_PROMPT len=62]");
      expect(sanitizedArgs).toContain("[REDACTED]");
      expect(sanitizedArgs).toContain("[REDACTED_ENCODED len=48]");
      expect(sanitizedArgs).toContain("safe-value");
    });

    it("never writes raw prompts or secrets to the persisted registry file", async () => {
      const supervisor = new ProcessSupervisor({ storagePath: registryFile });
      await supervisor.registerProcess({
        component: "cli_bridge",
        executable: "node.exe",
        args: [
          "--prompt",
          "Confidential prompt instructions that must never be written to disk",
          "--bearer",
          "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-oN_3p7fqWIlDRfdPyujWeAnDY8wsUOiW4RrytNmRs",
        ],
      });

      const rawFileContent = await fsp.readFile(registryFile, "utf8");
      expect(rawFileContent).not.toContain("Confidential prompt");
      expect(rawFileContent).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI");
      expect(rawFileContent).toContain("[REDACTED_PROMPT");
    });
  });

  describe("6. Registration Lifecycle & Read-Only Diagnostics", () => {
    it("manages process lifecycle from registration through exit observation", async () => {
      const supervisor = new ProcessSupervisor({ storagePath: registryFile });

      // Step 1: Register
      const registered = await supervisor.registerProcess({
        component: "shell_tool",
        executable: "powershell.exe",
        args: ["-NoProfile", "-Command", "Get-Date"],
        workspaceRoot: tempDir,
        launchIntent: "headless",
      });

      expect(registered.state).toBe("registered");
      expect(registered.recordId).toBeDefined();

      // Step 2: Spawn
      const spawned = await supervisor.recordProcessSpawn(registered.recordId, 45678, {
        creationIdentity: "win:638000000000000001",
      });
      expect(spawned?.state).toBe("running");
      expect(spawned?.pid).toBe(45678);
      expect(spawned?.creationIdentity).toBe("win:638000000000000001");

      // Step 3: Heartbeat
      await supervisor.recordProcessHeartbeat(registered.recordId);
      const afterHeartbeat = supervisor.getRegistry().getRecord(registered.recordId);
      expect(afterHeartbeat?.heartbeatAt).toBeDefined();

      // Step 4: Exit
      const exited = await supervisor.recordProcessExit(registered.recordId, {
        exitCode: 0,
        source: "shellTools.run_command",
      });

      expect(exited?.state).toBe("exited");
      expect(exited?.exitCode).toBe(0);
      expect(exited?.terminalObservation).toBeDefined();
      expect(exited?.terminalObservation?.source).toBe("shellTools.run_command");
    });

    it("verifies a live current-runtime process in diagnostics using its creation identity", async () => {
      const supervisor = new ProcessSupervisor({ storagePath: registryFile });
      const creationIdentity = await readProcessStartIdentity(process.pid);
      expect(creationIdentity).toBeTruthy();

      const registered = await supervisor.registerProcess({
        component: "diagnostic_probe",
        executable: process.execPath,
        workspaceRoot: tempDir,
      });
      await supervisor.recordProcessSpawn(registered.recordId, process.pid, {
        creationIdentity: creationIdentity!,
      });

      const diag = await supervisor.getProcessDiagnostics({ callerWorkspaceRoot: tempDir });
      const entry = diag.entries.find((item) => item.recordId === registered.recordId);
      expect(entry?.ownershipStatus).toBe("verified_owner");
      expect(entry?.isOwnedByCurrentRuntime).toBe(true);
      expect(diag.activeOwnedCount).toBe(1);
    });

    it("serializes concurrent registry saves so all registered records survive reload", async () => {
      const supervisor = new ProcessSupervisor({ storagePath: registryFile, maxRecords: 100 });
      const created = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          supervisor.registerProcess({
            component: "concurrent_save_probe",
            executable: process.execPath,
            args: ["--probe", String(index)],
            workspaceRoot: tempDir,
          })
        )
      );
      expect(new Set(created.map((record) => record.recordId)).size).toBe(24);

      const reloaded = new ProcessRegistry({ storagePath: registryFile, maxRecords: 100 });
      const load = await reloaded.load();
      expect(load.success).toBe(true);
      expect(reloaded.listRecords()).toHaveLength(24);
    });

    it("generates privacy-safe diagnostic reports masking foreign workspace paths", async () => {
      const supervisor = new ProcessSupervisor({ storagePath: registryFile });

      const wsLocal = path.join(tempDir, "local-workspace");
      const wsForeign = path.join(tempDir, "foreign-workspace");

      await supervisor.registerProcess({
        component: "cli_bridge",
        executable: "agy.exe",
        workspaceRoot: wsLocal,
        jobId: "job_local_123",
        sessionId: "sess_local_123",
      });

      await supervisor.registerProcess({
        component: "cli_bridge",
        executable: "agy.exe",
        workspaceRoot: wsForeign,
        jobId: "job_foreign_456",
        sessionId: "sess_foreign_456",
      });

      // Query diagnostics as caller from wsLocal
      const diag = await supervisor.getProcessDiagnostics({
        callerWorkspaceRoot: wsLocal,
      });

      expect(diag.totalTracked).toBe(2);
      expect(diag.isCorrupt).toBe(false);

      const localEntry = diag.entries.find((e) => e.ownership.jobId === "job_local_123");
      const foreignEntry = diag.entries.find((e) => e.ownership.isForeignWorkspace);

      expect(localEntry).toBeDefined();
      expect(localEntry?.ownership.workspaceRoot).toBe(wsLocal);
      expect(localEntry?.ownership.sessionId).toBe("sess_local_123");

      expect(foreignEntry).toBeDefined();
      expect(foreignEntry?.ownership.workspaceRoot).toMatch(/^\[foreign_workspace:[a-f0-9]+\]$/);
      expect(foreignEntry?.ownership.jobId).toBe("[foreign_job]");
      expect(foreignEntry?.ownership.sessionId).toBe("[foreign_session]");
    });
  });
});
