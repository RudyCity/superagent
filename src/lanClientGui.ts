#!/usr/bin/env bun
/**
 * Foreground, non-elevated Windows receiver engine for the Tauri companion.
 * Only newline-delimited, fixed-schema commands from the native parent are
 * accepted; access requests always require explicit target-side consent.
 */
import crypto from "node:crypto";
import os from "node:os";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { lanInterfaces, startLanServer, LAN_PORT, type ApprovalRequest } from "./core/lanRemote/transport.js";
import { normalizeNetworkSegment } from "./core/lanRemote/networkSegment.js";
import { runDeviceTunnelRelay } from "./core/deviceTunnel/client.js";
import { parseWindowsTunnelQrPayload } from "./core/deviceTunnel/windowsQrConnect.js";

const PREFIX = "@@SUPERAGENT_LAN_GUI@@";
function emit(event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(PREFIX + JSON.stringify({ event, ...fields }) + "\n");
}
function fail(error: unknown) {
  emit("error", { message: (error instanceof Error ? error.message : "Unknown error").slice(0, 230) });
}
function requireUnprivileged() {
  if (process.platform !== "win32") throw Error("Windows receiver requires Windows.");
  const check = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  ], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (check.error || check.status !== 0 || check.stdout.trim().toLowerCase() !== "false")
    throw Error("Run SuperAgent LAN Client as a standard non-elevated Windows user.");
}
async function main() {
  if (!process.argv.includes("--tauri-receiver")) throw Error("Use the SuperAgent LAN Client GUI.");
  requireUnprivileged();
  const segmentArg = process.argv.find(x => x.startsWith("--segment="));
  if (!segmentArg) throw Error("Network segment is required.");
  const segmentName = normalizeNetworkSegment(segmentArg.slice(10));
  const adapters = lanInterfaces();
  if (!adapters.length) throw Error("No eligible physical private IPv4 adapter was found.");
  const preferred = process.argv.find(x => x.startsWith("--bind="))?.slice(7);
  const selected = preferred ? adapters.find(x => x.address === preferred) : adapters[0];
  if (!selected) throw Error("Selected physical LAN adapter is no longer available.");

  let pending: { id: string; resolve: (allowed: boolean) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let relay: AbortController | null = null;
  let relayInProgress = false;
  let stopped = false;
  const approve = (request: ApprovalRequest) => {
    if (pending || stopped) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (pending?.id === id) {
          pending = null;
          emit("approval_expired", { id });
          resolve(false);
        }
      }, 90_000);
      pending = { id, resolve, timer };
      emit("approval_required", {
        id, kind: request.kind, controller: request.controller,
        ip: request.ip, detail: request.detail ?? "", expiresAt: Date.now() + 90_000,
      });
    });
  };
  const client = await startLanServer({
    host: selected.address, segmentName, port: LAN_PORT, onApproval: approve,
    onNotice: message => emit("notice", { message }),
  });
  emit("ready", {
    host: client.host, port: client.port, segment: segmentName,
    adapter: selected.name, fingerprint: client.fingerprint,
    pairingCode: client.code, platform: "windows",
    username: os.userInfo().username,
  });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (pending) {
      const request = pending; pending = null;
      clearTimeout(request.timer); request.resolve(false);
    }
    relay?.abort(); relay = null;
    await client.close();
    rl.close();
    emit("stopped");
  }
  async function handle(raw: string) {
    if (stopped) return;
    if (Buffer.byteLength(raw, "utf8") > 4000) throw Error("GUI command exceeded size limit.");
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw Error("Malformed native GUI request."); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("Invalid native GUI command.");
    const action = data as Record<string, unknown>;
    const type = action.type;
    if (type === "approve" || type === "deny") {
      if (Object.keys(action).sort().join(",") !== "id,type" || typeof action.id !== "string")
        throw Error("Invalid approval receipt.");
      if (!pending || action.id !== pending.id) throw Error("Approval no longer pending.");
      const request = pending; pending = null;
      clearTimeout(request.timer);
      request.resolve(type === "approve");
      emit("approval_resolved", { id: request.id, allowed: type === "approve" });
      return;
    }
    if (type === "connect") {
      if (Object.keys(action).sort().join(",") !== "payload,type" || typeof action.payload !== "string")
        throw Error("Invalid QR connection request.");
      if (relay || relayInProgress) throw Error("Device Tunnel already active. Disconnect first.");
      const invite = parseWindowsTunnelQrPayload(action.payload);
      relayInProgress = true;
      relay = new AbortController();
      const active = relay;
      const pairCode = client.rotatePairCode();
      emit("connecting", { origin: invite.url });
      const autoPair = { code: pairCode, controller: "SuperAgent Tray QR" };
      void runDeviceTunnelRelay({
        enrollment: invite, platform: "windows", name: os.hostname().slice(0, 60),
        fingerprint: client.fingerprint, localHost: client.host, localPort: client.port,
        autoPair, signal: active.signal,
        onNotice: message => {
          emit("notice", { message });
          if (message.includes("enrolled")) emit("connected", { origin: invite.url });
        },
      }).then(() => emit("disconnected"), error => {
        if (!active.signal.aborted) fail(error);
        emit("disconnected");
      }).finally(() => {
        if (relay === active) relay = null;
        relayInProgress = false;
      });
      return;
    }
    if (type === "disconnect") {
      if (Object.keys(action).length !== 1) throw Error("Invalid disconnect request.");
      relay?.abort(); relay = null;
      client.revoke();
      emit("disconnected");
      return;
    }
    if (type === "revoke") {
      if (Object.keys(action).length !== 1) throw Error("Invalid revoke request.");
      client.revoke();
      emit("revoked");
      return;
    }
    if (type === "rotate") {
      if (Object.keys(action).length !== 1) throw Error("Invalid rotate request.");
      emit("pairing_code", { code: client.rotatePairCode() });
      return;
    }
    if (type === "share_file" || type === "share_folder") {
      if (Object.keys(action).sort().join(",") !== "path,type"
          || typeof action.path !== "string" || action.path.length > 1024)
        throw Error("Invalid owner file selection.");
      if (type === "share_file") {
        const item = await client.shareSelectedFile(action.path);
        emit("shared", { kind: "file", ...item });
      } else {
        const item = await client.shareSelectedFolder(action.path);
        emit("shared", { kind: "folder", ...item });
      }
      return;
    }
    if (type === "status") {
      if (Object.keys(action).length !== 1) throw Error("Invalid status request.");
      emit("state", { state: client.state(), tunnelActive: Boolean(relay), waitingApproval: Boolean(pending) });
      return;
    }
    if (type === "stop") {
      if (Object.keys(action).length !== 1) throw Error("Invalid stop request.");
      await stop();
      return;
    }
    throw Error("Unsupported native GUI action.");
  }
  rl.on("line", line => {
    void handle(line).catch(fail);
  });
  rl.once("close", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
}
main().catch(error => {
  fail(error);
  process.exitCode = 1;
});
