#!/usr/bin/env bun
/** Native Windows EXE smoke test on one verified physical LAN adapter.
 * No hidden unattended target permission: the test drives the visible client console
 * itself, and must only run in a temporary nonproduction test process.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { lanInterfaces } from "../src/core/lanRemote/transport.js";
import {
  pairLanDevice, openLanSession, execLanCommand, closeLanSession, revokeLanDevice,
} from "../src/core/lanRemote/controller.js";

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Native Windows LAN smoke requires Windows.");
  const target = lanInterfaces()[0];
  if (!target) throw new Error("No physical private network adapter.");
  const exe = path.resolve(import.meta.dir, "..", "artifacts", "lan-client", "superagent-lan-client.exe");
  const child = spawn(exe, ["--bind=" + target.address, "--port=0", "--segment=test-lan"], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", approvalsSent = 0, id = "";
  child.stdout?.on("data", (data: Buffer) => {
    output += data.toString("utf8");
    const count = (output.match(/Type APPROVE to allow/g) || []).length;
    while (approvalsSent < count) {
      child.stdin?.write("approve\n");
      approvalsSent++;
    }
  });
  child.stderr?.on("data", (data: Buffer) => { output += data.toString("utf8"); });
  let finished = false;
  const stop = () => {
    if (finished) return;
    finished = true;
    try { child.stdin?.write("stop\n"); } catch {}
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1500).unref();
  };
  const timer = setTimeout(stop, 15_000);
  try {
    let port = 0, code = "", fingerprint = "";
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error("Client exited: " + output.slice(-1500));
      const pm = output.match(/Listening only on [\d.]+:(\d+)/);
      const cm = output.match(/Pairing code: (\d{8})/);
      const fm = output.match(/(?:\r?\n)([a-f0-9]{64})(?:\r?\n)/i);
      port = Number(pm?.[1] || 0);
      code = cm?.[1] || "";
      fingerprint = fm?.[1] || "";
      if (port && code && fingerprint) break;
      await Bun.sleep(100);
    }
    if (!port || !code || !fingerprint) throw new Error("Client startup did not emit pairing metadata: " + output.slice(-1500));
    const device = await pairLanDevice({ host: target.address, port, code, fingerprint, controller: "Native EXE integration test" });
    id = device.id;
    const session = await openLanSession(id);
    if (!session.connected) throw new Error("Target declined session.");
    const result = await execLanCommand(id, "Write-Output NATIVE_LAN_EXE_OK");
    if (!result.ok || result.exitCode !== 0 || !result.stdout.includes("NATIVE_LAN_EXE_OK")) {
      throw new Error("Terminal execution failed: " + JSON.stringify(result));
    }
    await closeLanSession(id);
    await revokeLanDevice(id);
    id = "";
    console.log("PASS: native Windows EXE pairing -> explicit console approval x2 -> authenticated PowerShell -> close -> revoke.");
    console.log("Physical adapter:", target.name);
  } finally {
    if (id) {
      try { await closeLanSession(id); await revokeLanDevice(id); } catch {}
    }
    stop();
    clearTimeout(timer);
    await Bun.sleep(300);
    if (child.exitCode === null) child.kill();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
