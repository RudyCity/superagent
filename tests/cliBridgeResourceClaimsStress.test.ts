import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  acquireResourceClaims,
  releaseResourceClaims,
  type ResourceClaimRequest,
} from "../src/core/tools/cliBridgeResourceClaims.js";

describe("Milestone M3 — Resource Claims Atomic Mutual Exclusion Stress Test", () => {
  const tempDir = path.join(os.tmpdir(), `superagent-claims-stress-${Date.now()}`);
  process.env.SUPERAGENT_CLI_BRIDGE_CLAIMS_DIR = tempDir;

  fs.mkdirSync(tempDir, { recursive: true });

  afterAll(() => {
    delete process.env.SUPERAGENT_CLI_BRIDGE_CLAIMS_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("proves 0 double-writer wins across 40 simultaneous writer race probes", async () => {
    const iterations = 40;
    let doubleWriterWins = 0;
    let successfulAcquisitions = 0;
    let conflictRejections = 0;

    for (let i = 0; i < iterations; i++) {
      const target = `contested-file-${i}.txt`;
      const req: ResourceClaimRequest[] = [{ type: "file", target, mode: "write" }];

      // Fire two writers simultaneously
      const [resA, resB] = await Promise.allSettled([
        acquireResourceClaims(req, `writer-A-${i}`),
        acquireResourceClaims(req, `writer-B-${i}`),
      ]);

      const aWon = resA.status === "fulfilled";
      const bWon = resB.status === "fulfilled";

      if (aWon && bWon) {
        doubleWriterWins++;
        // Clean up both
        await releaseResourceClaims(resA.value);
        await releaseResourceClaims(resB.value);
      } else if (aWon) {
        successfulAcquisitions++;
        conflictRejections++;
        await releaseResourceClaims(resA.value);
      } else if (bWon) {
        successfulAcquisitions++;
        conflictRejections++;
        await releaseResourceClaims(resB.value);
      }
    }

    expect(doubleWriterWins).toBe(0);
    expect(successfulAcquisitions).toBe(iterations);
    expect(conflictRejections).toBe(iterations);
  }, 30_000);
});
