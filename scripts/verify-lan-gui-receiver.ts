#!/usr/bin/env bun
/** Smoke-check only the disposable, test-owned Windows receiver process. */
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { lanInterfaces } from "../src/core/lanRemote/transport.js";

if (process.platform !== "win32") throw Error("Native GUI receiver smoke test needs Windows.");
const adapter = lanInterfaces()[0];
if (!adapter) throw Error("No physical private adapter available.");
const exe = path.resolve("apps/superagent-lan-windows/src-tauri/resources/superagent-lan-client.exe");
const inspected = spawnSync(exe, ["--list-adapters"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
if (inspected.error || inspected.status !== 0) throw Error("GUI adapter discovery failed.");
const adapters = JSON.parse(inspected.stdout) as { adapters: Array<{ name: string; address: string }> };
if (!adapters.adapters?.some(item => item.address === adapter.address && item.name === adapter.name))
  throw Error("GUI adapter list excluded the verified physical adapter.");
console.log("PASS: GUI native physical adapter discovery.");
const child = spawn(exe, ["--tauri-receiver", "--segment=gui-smoke", "--bind=" + adapter.address], {
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
let combined = "", stderr = "", exit = false;
const results: Array<Record<string, any>> = [];
child.stdout?.on("data", (part: Buffer) => {
  combined += part.toString("utf8");
  while (combined.includes("\n")) {
    const index = combined.indexOf("\n"), line = combined.slice(0, index);
    combined = combined.slice(index + 1);
    if (line.startsWith("@@SUPERAGENT_LAN_GUI@@")) {
      try { results.push(JSON.parse(line.slice("@@SUPERAGENT_LAN_GUI@@".length))); } catch {}
    }
  }
});
child.stderr?.on("data", (part: Buffer) => { stderr += part.toString("utf8").slice(0, 2000); });
child.once("exit", () => { exit = true; });
function send(value: Record<string, unknown>) {
  if (!child.stdin?.writable) throw Error("Receiver stdin already closed.");
  child.stdin.write(JSON.stringify(value) + "\n");
}
async function next(name: string, timeout = 16000): Promise<any> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const index = results.findIndex(item => item.event === name);
    if (index !== -1) return results.splice(index, 1)[0];
    if (exit) throw Error("Receiver exited before " + name + ". " + stderr.slice(0, 450));
    await Bun.sleep(75);
  }
  throw Error("Timeout waiting for " + name + ". " + stderr.slice(0, 450));
}
const timeout = setTimeout(() => { if (!exit) child.kill(); }, 30000);
try {
  const ready = await next("ready");
  if (ready.host !== adapter.address || !/^[a-f0-9]{64}$/i.test(ready.fingerprint) ||
      !/^\d{8}$/.test(ready.pairingCode)) throw Error("Receiver identity invalid.");
  send({ type: "rotate" });
  const code = await next("pairing_code");
  if (!/^\d{8}$/.test(code.code)) throw Error("Pairing-code rotation failed.");
  send({ type: "approve", id: "11111111-2222-4333-8444-555555555555" });
  const refused = await next("error");
  if (!String(refused.message).includes("Approval no longer pending"))
    throw Error("Unauthorized approval request was not rejected.");
  send({ type: "status" });
  const state = await next("state");
  if (state.waitingApproval !== false || state.tunnelActive !== false)
    throw Error("Receiver unexpectedly has active remote access.");
  send({ type: "revoke" });
  await next("revoked");
  send({ type: "stop" });
  await next("stopped");
  console.log("PASS: Windows GUI receiver start, identity, rotate, unauthorized-approval refusal, status, revoke, and stop.");
  console.log("Physical interface:", adapter.name);
} finally {
  clearTimeout(timeout);
  child.stdin?.end();
  await Bun.sleep(550);
  if (!exit) child.kill(); // Only exact test-owned child.
}
