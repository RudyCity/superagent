import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stageVisionStandaloneAsset, verifyVisionStandaloneAsset,
  VISION_STANDALONE_RELATIVE,
} from "../scripts/vision-standalone-asset.js";

function fixture(run: (root: string, stage: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-standalone-test-"));
  const root = path.join(dir, "source");
  const stage = path.join(dir, "stage");
  const sourceFile = path.join(root, VISION_STANDALONE_RELATIVE);
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(sourceFile, "# trusted vision helper\n" + "print('vision')\n".repeat(100));
  try { run(root, stage); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe("standalone Python Vision asset integrity", () => {
  it("stages the identical trusted helper and returns its SHA-256", () => fixture((root, stage) => {
    const hash = stageVisionStandaloneAsset(root, stage);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyVisionStandaloneAsset(root, stage)).toBe(hash);
  }));

  it("refuses a missing Vision helper in standalone staging", () => fixture((root, stage) => {
    expect(() => verifyVisionStandaloneAsset(root, stage)).toThrow();
  }));

  it("rejects modifications to a staged helper", () => fixture((root, stage) => {
    stageVisionStandaloneAsset(root, stage);
    fs.appendFileSync(path.join(stage, VISION_STANDALONE_RELATIVE), "# corrupted\n");
    expect(() => verifyVisionStandaloneAsset(root, stage)).toThrow("VISION_STANDALONE_SOURCE_MISMATCH");
  }));

  it("refuses to overwrite an unexpected pre-existing helper", () => fixture((root, stage) => {
    const target = path.join(stage, VISION_STANDALONE_RELATIVE);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "pre-existing file");
    expect(() => stageVisionStandaloneAsset(root, stage)).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("pre-existing file");
  }));
});
