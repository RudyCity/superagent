#!/usr/bin/env bun
/** Real native Windows EXE -> controller file transfer smoke test.
 * Isolated temporary source, same verified physical LAN interface, no
 * existing service stop, no target Downloads writes, no host configuration.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { lanInterfaces } from "../src/core/lanRemote/transport.js";
import {
  pairLanDevice, openLanSession, offerLanFile, getLanFileChunk,
  finalizeLanFile, closeLanSession, revokeLanDevice,
} from "../src/core/lanRemote/controller.js";

async function main() {
  if (process.platform !== "win32") throw Error("Windows native EXE is required.");
  const network = lanInterfaces()[0];
  if (!network) throw Error("No verified physical private LAN interface.");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lan-native-file-e2e-"));
  const source = path.join(dir, "target-owned-file.txt");
  const contents = crypto.randomBytes(9_197);
  await fs.writeFile(source, contents);
  const exe = path.resolve(import.meta.dir, "..", "artifacts", "lan-client", "superagent-lan-client.exe");
  const child = spawn(exe, ["--bind=" + network.address, "--port=0", "--segment=test-lan"], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", approvals = 0;
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    const requests = (output.match(/Type APPROVE to allow/g) || []).length;
    while (approvals < requests) { approvals++; child.stdin?.write("approve\n"); }
  });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const wait = async (condition: () => boolean, max = 160) => {
    for (let i = 0; i < max; i++) {
      if (child.exitCode !== null) throw Error("Native client exited: " + output.slice(-900));
      if (condition()) return;
      await Bun.sleep(100);
    }
    throw Error("Native LAN file smoke timed out: " + output.slice(-900));
  };
  let deviceId: string | null = null;
  try {
    await wait(() => /Listening only on [\d.]+:\d+/.test(output));
    const port = Number(output.match(/Listening only on [\d.]+:(\d+)/)?.[1]);
    const pin = output.match(/Pairing code: (\d{8})/)?.[1];
    const fingerprint = output.match(/(?:\r?\n)([a-f0-9]{64})(?:\r?\n)/i)?.[1];
    if (!port || !pin || !fingerprint) throw Error("Missing native pairing details.");
    child.stdin?.write("share \"" + source + "\"\n");
    await wait(() => output.includes("Owner selected for sharing: target-owned-file.txt"));
    const device = await pairLanDevice({ host: network.address, port,
      code: pin, fingerprint, controller: "Isolated Windows file test" });
    deviceId = device.id;
    await openLanSession(device.id);
    const offer = await offerLanFile(device.id, "download");
    if (offer.name !== "target-owned-file.txt" || offer.size !== contents.length) {
      throw Error("Owner-selected file metadata differs.");
    }
    const chunks: Buffer[] = [];
    for (let seq = 0, offset = 0; offset < contents.length; seq++, offset += 4096) {
      const receipt = await getLanFileChunk(device.id, offer.transferId, seq);
      chunks.push(Buffer.from(receipt.data, "base64"));
    }
    const reconstructed = Buffer.concat(chunks);
    if (!reconstructed.equals(contents) ||
        crypto.createHash("sha256").update(reconstructed).digest("hex") !== offer.sha256)
      throw Error("Native client sent incorrect file bytes.");
    await finalizeLanFile(device.id, offer.transferId);
    await closeLanSession(device.id);
    await revokeLanDevice(device.id);
    deviceId = null;
    console.log("NATIVE_WINDOWS_LAN_FILE_PASS: owner-select -> pair/session approval -> file approval -> SHA-256 and bytes verified");
  } finally {
    if (deviceId) {
      try { await closeLanSession(deviceId); await revokeLanDevice(deviceId); } catch {}
    }
    try { child.stdin?.write("stop\n"); } catch {}
    await Bun.sleep(350);
    if (child.exitCode === null) child.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
