import { describe, it, expect } from "vitest";
import { sshReadToolExecute, sshWriteToolExecute } from "../src/core/ssh/sshCommands.js";
import { sshProxy } from "../src/core/ssh/sshProxy.js";

describe("SSH Bulk File Operations", () => {
  it("should handle bulk file read array structure gracefully when disconnected", async () => {
    const res = await sshReadToolExecute([
      "file1.txt",
      { path: "file2.txt" }
    ]);
    expect(res).toContain("=== File: file1.txt ===");
    expect(res).toContain("=== File: file2.txt ===");
  });

  it("should handle bulk file write array structure gracefully when disconnected", async () => {
    const res = await sshWriteToolExecute([
      { filePath: "file1.txt", content: "hello" },
      { filePath: "file2.txt", content: "world" }
    ]);
    expect(res).toContain("Error writing SSH remote file file1.txt");
    expect(res).toContain("Error writing SSH remote file file2.txt");
  });

  it("should support registering a password handler", () => {
    let called = false;
    sshProxy.setPasswordHandler(async () => {
      called = true;
      return "secret";
    });
    expect(typeof (sshProxy as any).passwordHandler).toBe("function");
  });
});
