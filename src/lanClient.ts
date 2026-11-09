#!/usr/bin/env bun
/**
 * Standalone support client for direct LAN or reverse HTTPS Device Tunnel.
 * Always visible in its terminal; no service, startup persistence, or hidden unattended authorization.
 */
import os from "node:os";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { lanInterfaces, startLanServer, LAN_PORT, type ApprovalRequest } from "./core/lanRemote/transport.js";
import { normalizeNetworkSegment } from "./core/lanRemote/networkSegment.js";
import { runDeviceTunnelRelay } from "./core/deviceTunnel/client.js";

function ensureStandardUser(): void {
  if (process.platform !== "win32") return;
  const check = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
  ], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (check.error || check.status !== 0) {
    throw new Error("Cannot verify Windows token elevation; refusing remote support.");
  }
  if (check.stdout.trim().toLowerCase() !== "false") {
    throw new Error("The LAN Client must be launched as a standard, non-elevated user. Remote support never inherits an administrator token.");
  }
}

async function main() {
  ensureStandardUser();
  const adapters = lanInterfaces();
  console.log("\nSuperAgent LAN Client — Local-network support only\n");
  if (!adapters.length) throw new Error("No eligible physical private IPv4 interface detected.");
  adapters.forEach((item, index) => console.log(String(index + 1) + ". " + item.name + ": " + item.address));
  let selected = adapters[0];
  const hostArg = process.argv.find((a) => a.startsWith("--bind="))?.slice(7);
  if (hostArg) {
    const match = adapters.find((a) => a.address === hostArg);
    if (!match) throw new Error("Requested --bind address is not an approved local network adapter.");
    selected = match;
  }
  console.log("\nNetwork: " + selected.name + ", address: " + selected.address);
  console.log("This process runs as " + os.userInfo().username + " without elevation.");
  console.log("You must approve every pairing and every terminal session.");
  const argSegment = process.argv.find((a) => a.startsWith("--segment="));
  if (!argSegment && !process.stdin.isTTY) throw Error("Network segment required: pass --segment=NAME when stdin is not interactive.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let segmentName: string;
  try {
    const raw = argSegment === undefined
      ? await new Promise<string>((resolve) => rl.question("Network segment name (3–32 ASCII characters): ", resolve))
      : argSegment.slice("--segment=".length);
    segmentName = normalizeNetworkSegment(raw);
  } catch (error) { rl.close(); throw error; }
  console.log("Discovery segment: " + segmentName + " (filter only; pairing still requires approval).");
  let pending: { resolve: (allowed: boolean) => void; timer: ReturnType<typeof setTimeout>; request: ApprovalRequest } | null = null;
  const approve = (request: ApprovalRequest): Promise<boolean> => {
    if (pending) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending?.resolve === resolve) { pending = null; resolve(false); console.log("Request expired."); }
      }, 90_000);
      pending = { resolve, timer, request };
      console.log("\nINCOMING " + request.kind.toUpperCase() + " REQUEST");
      console.log("Controller: " + request.controller + " | LAN IP: " + request.ip);
      if (request.detail) console.log("File: " + request.detail);
      console.log("Type APPROVE to allow, or DENY to reject (90 seconds).");
    });
  };
  const client = await startLanServer({
    host: selected.address,
    segmentName,
    port: Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) || LAN_PORT),
    onApproval: approve,
    onNotice: (message) => console.log("[LAN] " + message),
  });
  console.log("\nPairing code: " + client.code + " (valid for 2 minutes)");
  console.log("Verify full SHA-256 certificate fingerprint on the controller:");
  console.log(client.fingerprint);
  console.log("Listening only on " + client.host + ":" + client.port);

  let tunnelUrl = process.argv.find((a) => a.startsWith("--tunnel-url="))?.slice("--tunnel-url=".length);
  let tunnelInvite = process.argv.find((a) => a.startsWith("--tunnel-invite="))?.slice("--tunnel-invite=".length);
  let tunnelJoinCode = "";
  const interactiveTunnel = process.argv.includes("--tunnel");
  if (interactiveTunnel && (tunnelUrl || tunnelInvite))
    throw new Error("Use either --tunnel for local setup JSON entry, or --tunnel-url/--tunnel-invite, not both.");
  if (Boolean(tunnelUrl) !== Boolean(tunnelInvite))
    throw new Error("Use --tunnel-url and --tunnel-invite together. The one-time join code is entered interactively.");
  if (interactiveTunnel) {
    if (!process.stdin.isTTY) throw new Error("--tunnel requires an interactive terminal.");
    const setupText = await new Promise<string>((resolve) =>
      rl.question("Paste Device Tunnel setup JSON from SuperAgent Tray: ", resolve));
    let parsed: unknown;
    try { parsed = JSON.parse(setupText.trim()); } catch { throw new Error("Invalid Device Tunnel setup JSON."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid Device Tunnel setup JSON.");
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "code,inviteId,url"
        || typeof value.url !== "string" || typeof value.inviteId !== "string" || typeof value.code !== "string")
      throw new Error("Paste the complete Device Tunnel setup JSON from SuperAgent Tray.");
    tunnelUrl = value.url; tunnelInvite = value.inviteId; tunnelJoinCode = value.code;
  }
  const tunnelAbort = new AbortController();
  let tunnelActive = false;
  if (tunnelUrl && tunnelInvite) {
    if (!process.stdin.isTTY) throw new Error("Tunnel enrollment requires an interactive terminal for the one-time join code.");
    if (!tunnelJoinCode) tunnelJoinCode = await new Promise<string>((resolve) =>
      rl.question("Device Tunnel join code (10 digits, not stored): ", resolve));
    tunnelJoinCode = tunnelJoinCode.trim();
    if (!/^\d{10}$/.test(tunnelJoinCode)) throw new Error("Invalid Device Tunnel join code.");
    const enrollment = { url: tunnelUrl, inviteId: tunnelInvite, code: tunnelJoinCode };
    tunnelJoinCode = "";
    void runDeviceTunnelRelay({
      enrollment,
      platform: "windows", name: os.hostname().slice(0, 60),
      fingerprint: client.fingerprint, localHost: client.host, localPort: client.port,
      signal: tunnelAbort.signal,
      onNotice: (message) => console.log("[TUNNEL] " + message),
    }).then(() => { tunnelActive = false; }, (error: Error) => {
      tunnelActive = false;
      if (!tunnelAbort.signal.aborted) console.log("[TUNNEL] stopped: " + error.message);
    });
    tunnelActive = true;
  }
  console.log("Commands: pair | share <local-file> | share-folder <local-folder> | approve | deny | status | revoke | stop");
  let stopped = false;
  async function stop() {
    if (stopped) return; stopped = true;
    if (pending) { clearTimeout(pending.timer); pending.resolve(false); pending = null; }
    console.log("Stopping device sharing and terminating active commands...");
    tunnelAbort.abort();
    await client.close();
    rl.close();
    console.log("Device sharing is OFF.");
  }
  rl.on("line", (line) => {
    const command = line.trim().toLowerCase();
    if (command === "approve" || command === "deny") {
      if (!pending) { console.log("No pending request."); return; }
      const current = pending; pending = null; clearTimeout(current.timer);
      current.resolve(command === "approve");
      console.log(command === "approve" ? "Approved." : "Denied.");
    } else if (command.startsWith("share-folder ")) {
      // Only a human owner at the target console can select the source folder.
      const selectedFolder = line.trim().slice("share-folder ".length).trim().replace(/^"|"$/g, "");
      void client.shareSelectedFolder(selectedFolder).then(
        (folder) => console.log("Owner selected folder for sharing: " + folder.name +
          " (" + folder.files + " files; " + folder.size + " bytes). Each download still needs APPROVE."),
        (error: Error) => console.log("Folder not shared: " + error.message),
      );
    } else if (command.startsWith("share ")) {
      const chosen = line.trim().slice(6).trim().replace(/^"|"$/g, "");
      void client.shareSelectedFile(chosen).then(
        (file) => console.log("Owner selected for sharing: " + file.name + " (" + file.size + " bytes). Future transfer still needs APPROVE."),
        (error: Error) => console.log("File not shared: " + error.message),
      );
    } else if (command === "pair") console.log("New code: " + client.rotatePairCode() + " (valid for 2 minutes)");
    else if (command === "status") console.log(JSON.stringify({ ...client.state(), tunnelActive }));
    else if (command === "revoke") { client.revoke(); console.log("Paired devices revoked."); }
    else if (command === "stop" || command === "quit" || command === "exit") void stop();
    else console.log("Commands: pair | share <local-file> | share-folder <local-folder> | approve | deny | status | revoke | stop");
  });
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}
main().catch((error) => { console.error("LAN Client startup failed:", error.message); process.exitCode = 1; });

