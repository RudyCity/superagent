import { describe, it, expect, beforeEach } from "vitest";
import {
  lockFile,
  releaseFile,
} from "../src/core/storage/sharedMemory.js";

describe("Final Micro-Gap Verification", () => {
  const testFile = "src/final-gaps-lock-target.ts";
  const sessionA = "sess_cli_fg_A";
  const sessionB = "sess_cli_fg_B";

  beforeEach(() => {
    releaseFile(testFile, undefined, undefined, true);
  });

  it("should execute lockFile, conflict block, and releaseFile with SQLite logging without throwing", () => {
    expect(() => {
      lockFile(testFile, sessionA, "cli", 5000);
      lockFile(testFile, sessionB, "cli", 5000); // Conflict block
      releaseFile(testFile, sessionA);
    }).not.toThrow();
  });
});
