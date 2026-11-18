/**
 * Fan-out of owner-approved LAN terminal operations across distinct devices.
 * Each target has independent pairing, session, task, approval and process.
 * No credentials or commands are cached by the fleet coordinator.
 */
import type { LanDevice, LanTerminalSnapshot } from "./controller.js";
import {
  listLanDevices, openLanSession, closeLanSession, startLanTerminal, readLanTerminal, inputLanTerminal,
  stopLanTerminal, keyLanTerminal, resizeLanTerminal, execAndroidShellCommand,
} from "./controller.js";
import { assertAndroidShellCommand } from "./androidCapabilities.js";
import { isFullYoloMode, isSystemDestructiveCommand } from "../permissions.js";

export const LAN_TERMINAL_FLEET_MAX_DEVICES = 8;
export type LanTerminalFleetAction = "open" | "close" | "start" | "read" | "input" | "key" | "resize" | "stop";
type Target = { deviceId: string; command?: string; jobId?: string; cursor?: number; text?: string; appendNewline?: boolean; key?: string; cols?: number; rows?: number };
type AndroidReceipt = Awaited<ReturnType<typeof execAndroidShellCommand>>;
export type FleetTerminalResult =
  | { deviceId: string; platform: "windows" | "android"; ok: true; session: { connected: boolean } }
  | { deviceId: string; platform: "windows"; ok: true; terminal: LanTerminalSnapshot }
  | { deviceId: string; platform: "android"; ok: true; shell: AndroidReceipt; outputTruncated: boolean }
  | { deviceId: string; platform: "android"; ok: false; shell: AndroidReceipt; outputTruncated: boolean; error: string }
  | { deviceId: string; platform: "windows" | "android"; ok: false; error: string };
export type FleetTerminalReply = {
  action: LanTerminalFleetAction;
  requested: number;
  succeeded: number;
  failed: number;
  results: FleetTerminalResult[];
};

export interface LanTerminalFleetDeps {
  list(): LanDevice[];
  open(deviceId: string): Promise<LanDevice>;
  close(deviceId: string): Promise<void>;
  start(deviceId: string, command: string): Promise<LanTerminalSnapshot>;
  read(deviceId: string, jobId: string, cursor: number): Promise<LanTerminalSnapshot>;
  input(deviceId: string, jobId: string, text: string, appendNewline: boolean): Promise<LanTerminalSnapshot>;
  stop(deviceId: string, jobId: string): Promise<LanTerminalSnapshot>;
  key(deviceId: string, jobId: string, key: string): Promise<LanTerminalSnapshot>;
  resize(deviceId: string, jobId: string, cols: number, rows: number): Promise<LanTerminalSnapshot>;
  android(deviceId: string, command: string): Promise<AndroidReceipt>;
  fullYolo(): boolean;
  destructive(command: string): boolean;
}

const defaultDeps: LanTerminalFleetDeps = {
  list: listLanDevices,
  open: openLanSession,
  close: closeLanSession,
  start: startLanTerminal,
  read: readLanTerminal,
  input: inputLanTerminal,
  stop: stopLanTerminal,
  key: keyLanTerminal,
  resize: resizeLanTerminal,
  android: execAndroidShellCommand,
  fullYolo: isFullYoloMode,
  destructive: isSystemDestructiveCommand,
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const COMMAND_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;
const MAX_ANDROID_REPLY = 4096;
const VALID_KEYS = new Set(["Enter","Backspace","Tab","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","Delete","PageUp","PageDown","CtrlC"]);
const MAX_ERROR = 240;
const allowedFields: Record<LanTerminalFleetAction, readonly string[]> = {
  open: ["deviceId"],
  close: ["deviceId"],
  start: ["deviceId", "command"],
  read: ["deviceId", "jobId", "cursor"],
  input: ["deviceId", "jobId", "text", "appendNewline"],
  key: ["deviceId", "jobId", "key"],
  resize: ["deviceId", "jobId", "cols", "rows"],
  stop: ["deviceId", "jobId"],
};
const message = (error: unknown): string => {
  const content = error instanceof Error ? error.message : "Target refused or did not confirm operation.";
  return content.length > MAX_ERROR ? content.slice(0, MAX_ERROR) + "..." : content;
};

function validate(action: LanTerminalFleetAction, input: unknown, devices: LanDevice[],
  deps: LanTerminalFleetDeps): { targets: Target[]; deviceById: Map<string, LanDevice> } {
  if (!Array.isArray(input) || input.length < 2 || input.length > LAN_TERMINAL_FLEET_MAX_DEVICES)
    throw Error("Fleet requires 2–8 distinct approved device targets.");
  if (["open", "start", "read", "input", "key", "resize"].includes(action) && !deps.fullYolo())
    throw Error("Full YOLO must be enabled locally for agent fleet execution.");
  const deviceById = new Map(devices.map(device => [device.id, device]));
  const targets: Target[] = [];
  const ids = new Set<string>();
  const physical = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw Error("Each fleet target must be an object.");
    const t = raw as Record<string, unknown>;
    if (Object.keys(t).some(key => !allowedFields[action].includes(key)))
      throw Error("Unexpected terminal fleet target field.");
    if (typeof t.deviceId !== "string" || !UUID.test(t.deviceId))
      throw Error("Each target requires a valid deviceId.");
    if (ids.has(t.deviceId)) throw Error("Duplicate deviceId is not permitted.");
    ids.add(t.deviceId);
    const device = deviceById.get(t.deviceId);
    if (!device || !device.paired)
      throw Error("Every target must be paired individually before a fleet operation.");
    if (action === "open" && device.connected)
      throw Error("Target already has an approved support session; close it before reopening.");
    if (!["open", "close"].includes(action) && !device.connected)
      throw Error("Every device must have its own approved open support session.");
    // A receiver may be reachable by LAN and reverse HTTPS tunnel at once.
    // Its pinned certificate fingerprint, not route or handle, identifies it.
    const identity = "receiver:" + device.fingerprint.toLowerCase();
    if (physical.has(identity)) throw Error("Same physical receiver appears more than once.");
    physical.add(identity);
    if (action === "open" || action === "close") {
      targets.push({ deviceId: t.deviceId });
    } else if (action === "start") {
      if (typeof t.command !== "string" || !t.command.trim() ||
          t.command.length > (device.platform === "android" ? 512 : 2000) ||
          COMMAND_CONTROL.test(t.command) || deps.destructive(t.command))
        throw Error("Terminal command violates device bounds or safety policy.");
      if (device.platform === "android") assertAndroidShellCommand(t.command);
      targets.push({ deviceId: t.deviceId, command: t.command });
    } else {
      if (device.platform !== "windows")
        throw Error("Persistent terminal read/input/stop is Windows-only; Android supports approved single commands.");
      if (typeof t.jobId !== "string" || !UUID.test(t.jobId))
        throw Error("Each Windows target requires its own valid terminal jobId.");
      if (action === "read" && t.cursor !== undefined &&
          (!Number.isSafeInteger(t.cursor) || Number(t.cursor) < 0))
        throw Error("Terminal cursor must be a non-negative safe integer.");
      if (action === "input" &&
          (typeof t.text !== "string" || !t.text ||
            t.text.length > 1024 || COMMAND_CONTROL.test(t.text) ||
            deps.destructive(t.text) ||
            (t.appendNewline !== undefined && typeof t.appendNewline !== "boolean")))
        throw Error("Terminal input violates bounds or safety policy.");
      if (action === "key" && (typeof t.key !== "string" || !VALID_KEYS.has(t.key)))
        throw Error("Unsupported fleet terminal key.");
      if (action === "resize" &&
          (!Number.isSafeInteger(t.cols) || Number(t.cols) < 20 || Number(t.cols) > 300 ||
           !Number.isSafeInteger(t.rows) || Number(t.rows) < 5 || Number(t.rows) > 120))
        throw Error("Invalid fleet terminal dimensions.");
      targets.push({
        deviceId: t.deviceId, jobId: t.jobId as string,
        ...(action === "read" ? { cursor: (t.cursor as number | undefined) ?? 0 } : {}),
        ...(action === "input" ? {
          text: t.text as string, appendNewline: (t.appendNewline as boolean | undefined) === true,
        } : {}),
        ...(action === "key" ? { key: t.key as string } : {}),
        ...(action === "resize" ? { cols: t.cols as number, rows: t.rows as number } : {}),
      });
    }
  }
  return { targets, deviceById };
}

/**
 * Promise.all fans out across distinct receiver sessions concurrently.
 * Per-target failures never cancel another target. Only start/input are
 * locked per physical receiver, so read/stop can proceed during approval.
 */
export class LanTerminalFleet {
  private readonly activeMutations = new Set<string>();

  constructor(private readonly deps: LanTerminalFleetDeps = defaultDeps) {}

  async execute(action: LanTerminalFleetAction, input: unknown): Promise<FleetTerminalReply> {
    if (!["open", "close", "start", "read", "input", "key", "resize", "stop"].includes(action))
      throw Error("Unknown fleet terminal operation.");
    const { targets, deviceById } = validate(action, input, this.deps.list(), this.deps);
    const results = await Promise.all(targets.map(async (t): Promise<FleetTerminalResult> => {
      const device = deviceById.get(t.deviceId)!;
      const mutating = action === "open" || action === "start" || action === "input" || action === "key" || action === "resize";
      const identity = "receiver:" + device.fingerprint.toLowerCase();
      if (mutating && this.activeMutations.has(identity)) {
        return { deviceId: t.deviceId, platform: device.platform, ok: false,
          error: "Another terminal mutation is awaiting this device's approval." };
      }
      if (mutating) this.activeMutations.add(identity);
      try {
        if (action === "open") {
          const approved = await this.deps.open(t.deviceId);
          if (approved.id !== t.deviceId || approved.connected !== true)
            throw Error("Target did not confirm an approved device session.");
          return { deviceId: t.deviceId, platform: device.platform, ok: true,
            session: { connected: true } };
        }
        if (action === "close") {
          await this.deps.close(t.deviceId);
          return { deviceId: t.deviceId, platform: device.platform, ok: true,
            session: { connected: false } };
        }
        if (action === "start" && device.platform === "android") {
          const shell = await this.deps.android(t.deviceId, t.command!);
          const outputTruncated = shell.stdout.length > MAX_ANDROID_REPLY;
          const completed = shell.ok === true && shell.exitCode === 0;
          const boundedShell = { ...shell, stdout: shell.stdout.slice(0, MAX_ANDROID_REPLY) };
          return completed
            ? { deviceId: t.deviceId, platform: "android", ok: true, shell: boundedShell, outputTruncated }
            : { deviceId: t.deviceId, platform: "android", ok: false, shell: boundedShell,
                outputTruncated, error: "Android sandbox command failed or was cancelled." };
        }
        const terminal = action === "start" ? await this.deps.start(t.deviceId, t.command!)
          : action === "read" ? await this.deps.read(t.deviceId, t.jobId!, t.cursor!)
          : action === "input" ? await this.deps.input(t.deviceId, t.jobId!, t.text!, t.appendNewline!)
          : action === "key" ? await this.deps.key(t.deviceId, t.jobId!, t.key!)
          : action === "resize" ? await this.deps.resize(t.deviceId, t.jobId!, t.cols!, t.rows!)
          : await this.deps.stop(t.deviceId, t.jobId!);
        return { deviceId: t.deviceId, platform: "windows", ok: true, terminal };
      } catch (error) {
        return { deviceId: t.deviceId, platform: device.platform, ok: false, error: message(error) };
      } finally {
        if (mutating) this.activeMutations.delete(identity);
      }
    }));
    return { action, requested: targets.length,
      succeeded: results.filter(result => result.ok).length,
      failed: results.filter(result => !result.ok).length, results };
  }
}

export const lanTerminalFleet = new LanTerminalFleet();
