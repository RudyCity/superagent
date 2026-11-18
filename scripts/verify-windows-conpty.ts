/**
 * CI-native Windows ConPTY acceptance smoke. Must execute with Bun directly.
 * Tests the actual ConPTY API, not the Node.js pipe fallback in Vitest.
 */
import assert from "node:assert/strict";
import { LanTerminalTaskManager } from "../src/core/lanRemote/terminalTasks.js";

if (process.platform !== "win32") throw Error("This smoke must run on a Windows runner.");
if (!process.versions.bun) throw Error("Native Bun is required to verify Windows ConPTY.");

const manager = new LanTerminalTaskManager();
const sessionId = "ci-conpty-receiver-session";
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function observe(
  jobId: string, predicate: (output: string, running: boolean) => boolean, timeoutMs = 30_000,
): Promise<{ output: string; running: boolean; exitCode: number | null; reason: string | null }> {
  let cursor = 0;
  let output = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = manager.read(sessionId, jobId, cursor);
    output += snap.chunks.map(chunk => chunk.text).join("");
    cursor = snap.nextCursor;
    if (predicate(output, snap.running))
      return { output, running: snap.running, exitCode: snap.exitCode, reason: snap.reason };
    await wait(60);
  }
  throw Error("ConPTY smoke timed out. Tail: " + output.slice(-900));
}

try {
  const interactive = manager.start(sessionId,
    "Write-Output CONPTY_READY; $v = Read-Host CONPTY_INPUT; Write-Output ('CONPTY_OK_' + $v)");
  assert.equal(interactive.mode, "conpty", "must not silently fall back to pipes");
  console.log("PTY_STARTED", interactive.jobId, interactive.mode);
  await observe(interactive.jobId, output => output.includes("CONPTY_INPUT"), 30_000);
  assert.throws(() => manager.read("another-session", interactive.jobId), /not found/);
  assert.throws(() => manager.resize("another-session", interactive.jobId, 120, 40), /not found/);
  assert.throws(() => manager.key("another-session", interactive.jobId, "ArrowUp"), /not found/);
  assert.throws(() => manager.resize(sessionId, interactive.jobId, 1, 40), /dimensions/);

  const resized = manager.resize(sessionId, interactive.jobId, 120, 40);
  assert.equal(resized.cols, 120);
  assert.equal(resized.rows, 40);
  manager.input(sessionId, interactive.jobId, "verified", true);
  const completed = await observe(interactive.jobId, (_output, running) => !running, 30_000);
  assert.equal(completed.exitCode, 0, "interactive PowerShell should exit cleanly");
  assert.equal(completed.reason, "exited");
  // PowerShell may emit ConPTY-specific VT setup sequences but not alter the payload.
  assert.match(completed.output, /CONPTY_OK_verified/);
  console.log("PTY_INTERACTIVE_OK input, output, resize and session isolation");

  const unicode = manager.start(sessionId,
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output 'CONPTY_UTF8_é_漢字_🙂'");
  assert.equal(unicode.mode, "conpty");
  const encoded = await observe(unicode.jobId, (_output, running) => !running, 30_000);
  assert.equal(encoded.exitCode, 0);
  assert.match(encoded.output, /CONPTY_UTF8_é_漢字_🙂/);
  console.log("PTY_UTF8_OK streaming non-ASCII output");


  const long = manager.start(sessionId, "Write-Output CONPTY_STOP_READY; Start-Sleep -Seconds 60");
  assert.equal(long.mode, "conpty");
  await observe(long.jobId, output => output.includes("CONPTY_STOP_READY"), 30_000);
  const stopped = manager.stop(sessionId, long.jobId);
  assert.equal(stopped.reason, "stopped_by_owner");
  const done = await observe(long.jobId, (_output, running) => !running, 15_000);
  assert.equal(done.reason, "stopped_by_owner");
  console.log("PTY_STOP_OK target-owned process terminated");
} finally {
  manager.stopAll();
}
