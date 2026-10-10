/**
 * processMailbox.ts — Cross-process IPC event mailbox for Superagent CLI & Server.
 *
 * Allows MCP tools, background daemons, and external agents to send instructions,
 * steering messages, pause, resume, or interrupt signals to any active Superagent
 * CLI process across the machine by PID or Session ID.
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { getRootConfigDir } from "../config/paths.js";
import { loadActiveProcesses, isPidAlive } from "../mcp/processJournal.js";

export type ProcessIpcType = "message" | "pause" | "resume" | "interrupt";

export interface ProcessIpcEnvelope {
  id: string;
  type: ProcessIpcType;
  message?: string;
  sender?: string;
  timestamp: number;
}

export function getMailboxDir(): string {
  return path.join(getRootConfigDir(), "ipc");
}

export function ensureMailboxDir(): string {
  const dir = getMailboxDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getMailboxPath(pid: number): string {
  return path.join(getMailboxDir(), `${pid}.json`);
}

/**
 * Sends an IPC envelope to a running Superagent CLI process identified by PID or Session ID.
 */
export function sendEnvelopeToProcess(
  target: number | string,
  envelope: Omit<ProcessIpcEnvelope, "id" | "timestamp">
): { success: boolean; pid?: number; message?: string } {
  ensureMailboxDir();

  let targetPid: number | null = null;
  const numTarget = typeof target === "number" ? target : parseInt(String(target), 10);

  if (!isNaN(numTarget) && numTarget > 0) {
    if (isPidAlive(numTarget)) {
      targetPid = numTarget;
    }
  }

  // If not resolved by PID, check active processes by sessionId or working directory
  if (!targetPid) {
    const processes = loadActiveProcesses();
    const strTarget = String(target).toLowerCase();
    const match = processes.find(
      (p) =>
        (p.sessionId && p.sessionId.toLowerCase() === strTarget) ||
        (p.workingDirectory && p.workingDirectory.toLowerCase() === strTarget)
    );
    if (match && isPidAlive(match.pid)) {
      targetPid = match.pid;
    }
  }

  if (!targetPid) {
    return {
      success: false,
      message: `No active Superagent CLI process found matching "${target}".`,
    };
  }

  const mailboxFile = getMailboxPath(targetPid);
  let queue: ProcessIpcEnvelope[] = [];

  try {
    if (fs.existsSync(mailboxFile)) {
      const raw = fs.readFileSync(mailboxFile, "utf-8");
      queue = JSON.parse(raw);
      if (!Array.isArray(queue)) queue = [];
    }
  } catch {
    queue = [];
  }

  const newEnvelope: ProcessIpcEnvelope = {
    id: randomUUID(),
    timestamp: Date.now(),
    ...envelope,
  };

  queue.push(newEnvelope);

  try {
    const tmp = `${mailboxFile}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(queue, null, 2), "utf-8");
    fs.renameSync(tmp, mailboxFile);
    return {
      success: true,
      pid: targetPid,
      message: `Enqueued ${envelope.type} envelope for PID ${targetPid}.`,
    };
  } catch (err: any) {
    return {
      success: false,
      pid: targetPid,
      message: `Failed to write mailbox for PID ${targetPid}: ${err.message}`,
    };
  }
}

/**
 * Atomically drains and returns all pending envelopes for the given PID.
 */
export function pollProcessMailbox(pid: number): ProcessIpcEnvelope[] {
  const mailboxFile = getMailboxPath(pid);
  if (!fs.existsSync(mailboxFile)) return [];

  try {
    const raw = fs.readFileSync(mailboxFile, "utf-8");
    const envelopes: ProcessIpcEnvelope[] = JSON.parse(raw);
    try {
      fs.unlinkSync(mailboxFile);
    } catch {}
    return Array.isArray(envelopes) ? envelopes : [];
  } catch {
    return [];
  }
}

/**
 * Removes the mailbox file when the process exits.
 */
export function cleanupProcessMailbox(pid: number): void {
  try {
    const mailboxFile = getMailboxPath(pid);
    if (fs.existsSync(mailboxFile)) {
      fs.unlinkSync(mailboxFile);
    }
  } catch {}
}

/**
 * Starts a background mailbox polling listener for a CLI process.
 */
export function startMailboxListener(
  pid: number,
  onEnvelope: (env: ProcessIpcEnvelope) => void,
  intervalMs = 1000
): () => void {
  ensureMailboxDir();

  const timer = setInterval(() => {
    const envelopes = pollProcessMailbox(pid);
    for (const env of envelopes) {
      try {
        onEnvelope(env);
      } catch (err) {
        console.error(`[IPC Mailbox] Error processing envelope:`, err);
      }
    }
  }, intervalMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  const cleanup = () => {
    clearInterval(timer);
    cleanupProcessMailbox(pid);
  };

  process.once("exit", cleanup);
  return cleanup;
}
