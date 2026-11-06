#!/usr/bin/env bun
/** Isolated native Windows EXE folder-export smoke: no live Core or user Downloads mutations. */
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { lanInterfaces } from "../src/core/lanRemote/transport.js";
import {
  pairLanDevice, openLanSession, offerLanFile, getLanFileChunk, finalizeLanFile,
  closeLanSession, revokeLanDevice,
} from "../src/core/lanRemote/controller.js";
import { inspectFolderPackage } from "../src/core/lanRemote/folderPackage.js";

async function main(): Promise<void> {
  if (process.platform !== "win32") throw Error("Native EXE check requires Windows");
  const network = lanInterfaces()[0];
  if (!network) throw Error("No verified private physical IPv4 adapter");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sa-native-folder-"));
  const folder = path.join(temp, "DemoFolder");
  await fs.mkdir(path.join(folder, "notes"), { recursive: true });
  await fs.writeFile(path.join(folder, "notes", "hello.txt"), "HELLO NATIVE");
  await fs.writeFile(path.join(folder, "readme.txt"), "FOLDER TEST");
  const exe = path.resolve(import.meta.dir, "..", "artifacts", "lan-client", "superagent-lan-client.exe");
  const child = spawn(exe, ["--bind=" + network.address, "--port=0", "--segment=team-lab"], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", approvals = 0;
  child.stdout?.on("data", (buf: Buffer) => {
    output += buf.toString("utf8");
    const requests = (output.match(/Type APPROVE to allow/g) || []).length;
    while (approvals < requests) { approvals++; child.stdin?.write("approve\n"); }
  });
  child.stderr?.on("data", (buf: Buffer) => { output += buf.toString("utf8"); });
  async function wait(text: RegExp, retries = 160) {
    for (let i = 0; i < retries; i++) {
      if (child.exitCode !== null) throw Error("Native client exited: " + output.slice(-500));
      if (text.test(output)) return;
      await Bun.sleep(100);
    }
    throw Error("Native folder client timed out: " + output.slice(-1000));
  }
  let deviceId: string | null = null;
  try {
    await wait(/Listening only on [\d.]+:\d+/);
    const port = Number(output.match(/Listening only on [\d.]+:(\d+)/)?.[1]);
    const code = output.match(/Pairing code: (\d{8})/)?.[1];
    const fp = output.match(/(?:\r?\n)([a-f0-9]{64})(?:\r?\n)/i)?.[1];
    if (!port || !code || !fp) throw Error("Missing native pairing details");
    child.stdin?.write('share-folder "' + folder + '"\n');
    await wait(/Owner selected folder for sharing: DemoFolder.safolder/);
    const paired = await pairLanDevice({ host: network.address, port, fingerprint: fp,
      code, segmentName: "team-lab", controller: "Isolated Native Folder" });
    deviceId = paired.id;
    await openLanSession(paired.id);
    const offer = await offerLanFile(paired.id, "download");
    if (offer.name !== "DemoFolder.safolder") throw Error("Wrong outgoing folder");
    const chunks: Buffer[] = [];
    for (let seq = 0, pos = 0; pos < offer.size; seq++, pos += 4096) {
      chunks.push(Buffer.from((await getLanFileChunk(paired.id, offer.transferId, seq)).data, "base64"));
    }
    const archive = Buffer.concat(chunks);
    if (crypto.createHash("sha256").update(archive).digest("hex") !== offer.sha256)
      throw Error("Native folder archive hash mismatch");
    const manifest = inspectFolderPackage(archive);
    if (manifest.files.map((f) => f.path).join("|") !== "notes/hello.txt|readme.txt")
      throw Error("Unexpected folder structure " + JSON.stringify(manifest.files));
    await finalizeLanFile(paired.id, offer.transferId);
    await closeLanSession(paired.id);
    await revokeLanDevice(paired.id);
    deviceId = null;
    console.log("NATIVE_WINDOWS_LAN_FOLDER_PASS: owner choice + matched segment + folder manifest + 2 SHA-256 files verified");
  } finally {
    if (deviceId) {
      try { await closeLanSession(deviceId); await revokeLanDevice(deviceId); } catch {}
    }
    try { child.stdin?.write("stop\n"); } catch {}
    await Bun.sleep(300);
    if (child.exitCode === null) child.kill();
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
