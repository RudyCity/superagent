import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = (relative: string) => fs.readFileSync(path.join(root, "src", relative), "utf8");

describe("TASK-307 unattended execution entry-point policy audit", () => {
  it("routes CLI, TUI, and REST manual triggers through one scheduler gate", () => {
    const entrypoints = [
      src("core/daemon/daemonCli.ts"),
      src("core/commands/daemonCommand.ts"),
      src("core/daemon/daemonRoutes.ts"),
    ];
    for (const source of entrypoints) {
      expect(source).toContain("daemonScheduler.triggerJobNow(");
      expect(source).not.toMatch(/new\s+Agent\s*\(/);
      expect(source).not.toMatch(/\.executeJob\s*\(/);
    }
  });

  it("keeps both scheduled and manual execution in the same private policy guarded runner", () => {
    const source = src("core/daemon/daemonScheduler.ts");
    expect(source).toMatch(/private async executeJob\(job: DaemonJob\)/);
    expect(source).toContain("return await this.executeJob(job)");
    expect(source).toContain("this.executeJob(job).catch(");
    expect(source).toContain("assertNoSymlinkWorkspacePath(configuredWorkspace)");
    expect(source).toContain("disableAmbientYoloMode: true");
    expect(source).toContain("fileLockGuard:");
    expect(source).toContain("this.resolvePinnedSkill(job)");
    expect(source).toContain("insertDaemonRun({");
    expect(source).toContain("updateDaemonRun(runId");
  });

  it("rejects arbitrary job kind, internal PATCH fields, and in-flight policy replacement", () => {
    const source = src("core/daemon/daemonScheduler.ts");
    expect(source).toContain("Daemon job PATCH refused immutable/internal field(s)");
    expect(source).toContain("Cannot modify the execution configuration of a running daemon job.");
    expect(source).toContain('params.kind !== "agent"');
    expect(source).toContain("if (this.runningJobIds.has(id)) return false;");
  });
});
