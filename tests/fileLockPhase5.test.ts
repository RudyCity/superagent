import { describe, it, expect, beforeEach } from "vitest";
import {
  lockFile,
  releaseFile,
  lockEventEmitter,
} from "../src/core/storage/sharedMemory.js";
import { predictSemanticConflict } from "../src/core/storage/semanticConflictPredictor.js";
import { generateLockReportTool } from "../src/core/tools/lockTools.js";

describe("Phase 5 Token-Efficient Final Conflict & Analytics Features", () => {
  const testFile = "src/phase5-lock-target.ts";
  const sessionA = "sess_cli_p5_A";

  beforeEach(() => {
    releaseFile(testFile, undefined, undefined, true);
  });

  it("should predict semantic conflict using zero-token heuristic matcher", () => {
    lockFile(testFile, sessionA, "cli", 5000);

    const prediction = predictSemanticConflict(testFile, "sess_cli_p5_B");
    expect(prediction.hasConflictRisk).toBe(true);
    expect(prediction.riskScore).toBeGreaterThan(0);
    expect(prediction.reason).toContain("Direct lock");
  });

  it("should emit OS notification toast event on lock release", async () => {
    let toastEvent: any = null;
    const listener = (data: any) => {
      toastEvent = data;
    };

    lockFile(testFile, sessionA, "cli", 5000);
    lockEventEmitter.once("os_notification_toast", listener);
    releaseFile(testFile, sessionA);

    expect(toastEvent).not.toBeNull();
    expect(toastEvent?.title).toBe("File Lock Released");
  });

  it("should generate markdown lock health report via generate_lock_report tool", async () => {
    lockFile(testFile, sessionA, "cli", 5000);

    const report = await generateLockReportTool.execute({ targetFile: testFile }, process.cwd());
    expect(report).toContain("Multi-Terminal Lock Health & Audit Report");
    expect(report).toContain("Semantic Conflict Risk");
  });
});
