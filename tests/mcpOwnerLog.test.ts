import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  appendMcpOwnerLog, readMcpOwnerLogs, formatMcpOwnerLogs, mcpOwnerLogPath,
} from "../src/core/runtime/mcpOwnerLog.js";

describe("MCP owner lifecycle journal: safe metadata only", () => {
  const port = 19881;
  let root: string;
  let home: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-owner-log-test-"));
    home = vi.spyOn(os, "homedir").mockReturnValue(root);
  });
  afterEach(() => {
    home.mockRestore();
    fs.rmSync(root, {recursive:true,force:true});
  });

  it("logs reload state, bounded tail and excludes arbitrary private details", () => {
    const privateMessage = "DO_NOT_WRITE_PRIVATE_CHAT_BODY";
    appendMcpOwnerLog(port, "owner_started", {ownerPid:111, backendPid:222});
    appendMcpOwnerLog(port, "backend_reload_started", {ownerPid:111, backendPid:222});
    appendMcpOwnerLog(port, "backend_reload_succeeded", {
      ownerPid:111, backendPid:333, previousBackendPid:222,
      durationMs:47, code:privateMessage,
    });
    const events = readMcpOwnerLogs(port);
    expect(events.map(e=>e.event)).toEqual([
      "owner_started", "backend_reload_started", "backend_reload_succeeded",
    ]);
    expect(events[2].previousBackendPid).toBe(222);
    expect(events[2].durationMs).toBe(47);
    expect(events[2].code).toBeUndefined();
    expect(readMcpOwnerLogs(port, 2)).toHaveLength(2);
    const displayed = formatMcpOwnerLogs(port);
    expect(displayed).toContain("backend_reload_succeeded");
    expect(displayed).not.toContain(privateMessage);
    expect(displayed).not.toContain("Bearer");
    expect(fs.readFileSync(mcpOwnerLogPath(port), "utf8")).not.toContain(privateMessage);
  });

  it("refuses invalid ports/tail values and reports empty legacy journal", () => {
    expect(formatMcpOwnerLogs(port)).toContain("no reloadable-owner events");
    expect(() => readMcpOwnerLogs(port, 101)).toThrow("tail must be 1..100");
    expect(() => readMcpOwnerLogs(port, 0)).toThrow("tail must be 1..100");
    expect(() => mcpOwnerLogPath(0)).toThrow("Invalid MCP lifecycle log port");
  });

  it("rotates at 256 KiB and continues reading the latest safe events", () => {
    const file = mcpOwnerLogPath(port);
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.writeFileSync(file, "x".repeat(257 * 1024));
    appendMcpOwnerLog(port, "backend_reload_failed", {
      ownerPid:444, code:"MCP_BACKEND_RELOAD_FAILED",
    });
    expect(fs.existsSync(file + ".1")).toBe(true);
    const entries = readMcpOwnerLogs(port);
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe("backend_reload_failed");
    expect(entries[0].code).toBe("MCP_BACKEND_RELOAD_FAILED");
  });

  it("never follows symlinks when reading or appending", () => {
    const file = mcpOwnerLogPath(port);
    fs.mkdirSync(path.dirname(file), {recursive:true});
    const target = path.join(root, "private.txt");
    fs.writeFileSync(target, "PRIVATE_OTHER_FILE");
    try { fs.symlinkSync(target, file, "file"); }
    catch { return; } // Windows developer mode may disallow test symlinks.
    expect(() => readMcpOwnerLogs(port)).toThrow("Unsafe MCP owner log file");
    expect(() => appendMcpOwnerLog(port, "owner_started", {ownerPid:100})).toThrow("Unsafe MCP owner log file");
    expect(fs.readFileSync(target,"utf8")).toBe("PRIVATE_OTHER_FILE");
  });
});
