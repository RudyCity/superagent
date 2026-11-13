/**
 * Read-only Windows Bun process memory recorder owned by the Core supervisor.
 * Never records command lines, tokens, or environment variables; never kills PIDs.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getRootConfigDir } from "../config/paths.js";
import { assessMemoryTrend, trimMemoryTrendSamples, type MemoryTrendSample } from "./memoryTrend.js";

const exec = promisify(execFile);
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const MAX_LOG_BYTES = 4 * MiB;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_PROCESSES = 128;
const ALERT_COOLDOWN_MS = 5 * 60_000;
const WINDOWS_SCRIPT = [
  "$rows=@(Get-CimInstance Win32_Process -Filter 'Name = ''bun.exe''' -ErrorAction SilentlyContinue)",
  "$out=@(foreach($p in $rows){try{$q=Get-Process -Id $p.ProcessId -ErrorAction Stop",
  "[pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId",
  "startedAt=([DateTimeOffset]$q.StartTime).ToUnixTimeMilliseconds()",
  "rssBytes=[long]$q.WorkingSet64;privateBytes=[long]$q.PrivateMemorySize64",
  "peakRssBytes=[long]$q.PeakWorkingSet64}}catch{}})",
  "ConvertTo-Json -InputObject $out -Compress -Depth 3",
].join("; ");

export interface BunProcessMemorySample {
  pid: number;
  parentPid: number;
  startedAt: number;
  rssBytes: number;
  privateBytes: number;
  peakRssBytes: number;
}
export interface KnownBunProcess {
  pid: number;
  role: "core_supervisor" | "core_worker" | "retained_core_worker";
  startedAt: number;
}
export interface BunMemoryAlert extends BunProcessMemorySample {
  at: number;
  role: KnownBunProcess["role"] | "unverified_bun";
  ownershipVerified: boolean;
  reason: "private_bytes_high" | "rss_high" | "sustained_growth";
  recovery: "operator_review_only" | "never_kill_unverified";
}
export interface BunMemoryWatchStatus {
  running: boolean;
  lastSampleAt: number | null;
  observedProcesses: number;
  largestPrivateBytes: number;
  largestPrivatePid: number | null;
  alertsRecorded: number;
  lastAlert: BunMemoryAlert | null;
  errorCode: string | null;
  evidenceFile: string;
}

export function normalizeBunProcessSamples(value: unknown): BunProcessMemorySample[] {
  const rows = Array.isArray(value) ? value : value == null ? [] : [value];
  const result: BunProcessMemorySample[] = [];
  const seen = new Set<number>();
  for (const row of rows.slice(0, MAX_PROCESSES)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const keys = ["pid", "parentPid", "startedAt", "rssBytes", "privateBytes", "peakRssBytes"];
    if (keys.some(k => !Number.isSafeInteger(r[k]) || Number(r[k]) < 0)) continue;
    const sample = row as BunProcessMemorySample;
    if (sample.pid <= 0 || sample.startedAt <= 0 || seen.has(sample.pid)) continue;
    seen.add(sample.pid);
    result.push(sample);
  }
  return result;
}
export async function readWindowsBunProcessSamples(): Promise<BunProcessMemorySample[]> {
  if (process.platform !== "win32") return [];
  const { stdout } = await exec("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT,
  ], { encoding: "utf8", timeout: 8_000, maxBuffer: 256 * 1024, windowsHide: true });
  return normalizeBunProcessSamples(JSON.parse(stdout.trim() || "[]"));
}
export function identifyBunProcess(
  sample: BunProcessMemorySample, known: readonly KnownBunProcess[],
): Pick<BunMemoryAlert, "role" | "ownershipVerified" | "recovery"> {
  // PID equality alone is never considered ownership evidence.
  const match = known.find(k => k.pid === sample.pid && Number.isSafeInteger(k.startedAt) &&
    k.startedAt > 0 && Math.abs(k.startedAt - sample.startedAt) <= 30_000);
  return match
    ? { role: match.role, ownershipVerified: true, recovery: "operator_review_only" }
    : { role: "unverified_bun", ownershipVerified: false, recovery: "never_kill_unverified" };
}
export function detectBunMemoryAlert(
  sample: BunProcessMemorySample, history: readonly MemoryTrendSample[],
  known: readonly KnownBunProcess[], at: number,
): BunMemoryAlert | null {
  // MemoryTrend's second numeric channel is private bytes here, not heap.
  const trend = assessMemoryTrend(history);
  const reason = sample.privateBytes >= 2 * GiB ? "private_bytes_high"
    : sample.rssBytes >= 2 * GiB ? "rss_high"
    : trend.suspicious && sample.privateBytes >= 512 * MiB ? "sustained_growth"
    : null;
  return reason
    ? { ...sample, at, ...identifyBunProcess(sample, known), reason } : null;
}
function appendEvidence(file: string, record: unknown): void {
  const line = JSON.stringify(record) + "\n";
  const size = Buffer.byteLength(line);
  if (size > MAX_RECORD_BYTES) throw new Error("BUN_MEMORY_EVIDENCE_RECORD_TOO_LARGE");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let current: fs.Stats | null = null;
  try { current = fs.lstatSync(file); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (current && (!current.isFile() || current.isSymbolicLink()))
    throw new Error("BUN_MEMORY_EVIDENCE_UNSAFE_PATH");
  if (current && current.size + size > MAX_LOG_BYTES) {
    const archive = file + ".1";
    if (fs.existsSync(archive)) {
      const stat = fs.lstatSync(archive);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("BUN_MEMORY_EVIDENCE_UNSAFE_ARCHIVE");
      fs.rmSync(archive);
    }
    fs.renameSync(file, archive);
  }
  fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
}
export function createBunProcessMemoryWatch(options: {
  port: number;
  getKnownProcesses: () => readonly KnownBunProcess[];
  readSamples?: () => Promise<BunProcessMemorySample[]>;
  evidenceFile?: string;
  intervalMs?: number;
  now?: () => number;
}) {
  if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535)
    throw new Error("BUN_MEMORY_INVALID_PORT");
  const evidenceFile = options.evidenceFile ?? path.join(
    getRootConfigDir(), "logs", "process-memory", "core-" + options.port + ".jsonl");
  const read = options.readSamples ?? readWindowsBunProcessSamples;
  const now = options.now ?? Date.now;
  const history = new Map<string, { samples: MemoryTrendSample[]; lastAlertAt: number; reason: string }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false, closed = false;
  let lastSampleAt: number | null = null, observedProcesses = 0;
  let largestPrivateBytes = 0, largestPrivatePid: number | null = null;
  let alertsRecorded = 0, lastAlert: BunMemoryAlert | null = null;
  let errorCode: string | null = null;

  async function sample(): Promise<boolean> {
    if (closed || busy) return false;
    busy = true;
    try {
      const rows = normalizeBunProcessSamples(await read());
      if (closed) return false;
      const at = now(), known = options.getKnownProcesses(), seen = new Set<string>();
      const alerts: BunMemoryAlert[] = [];
      largestPrivateBytes = 0; largestPrivatePid = null;
      for (const row of rows) {
        const key = row.pid + ":" + row.startedAt;
        seen.add(key);
        const state = history.get(key) ?? { samples: [], lastAlertAt: 0, reason: "" };
        state.samples = trimMemoryTrendSamples([
          ...state.samples, { at, rssBytes: row.rssBytes, heapUsedBytes: row.privateBytes },
        ], 12);
        const alert = detectBunMemoryAlert(row, state.samples, known, at);
        if (row.privateBytes > largestPrivateBytes) {
          largestPrivateBytes = row.privateBytes; largestPrivatePid = row.pid;
        }
        if (alert && (state.reason !== alert.reason ||
          at - state.lastAlertAt >= ALERT_COOLDOWN_MS)) {
          alerts.push(alert); state.lastAlertAt = at; state.reason = alert.reason;
        }
        history.set(key, state);
      }
      for (const key of history.keys()) if (!seen.has(key)) history.delete(key);
      appendEvidence(evidenceFile, { kind: "bun_process_memory_sample", version: 1, at,
        processes: rows.map(row => ({ ...row, ...identifyBunProcess(row, known) })) });
      for (const alert of alerts) {
        appendEvidence(evidenceFile, { kind: "bun_process_memory_alert", version: 1, ...alert });
        lastAlert = alert; alertsRecorded++;
      }
      lastSampleAt = at; observedProcesses = rows.length; errorCode = null;
      return true;
    } catch {
      // An unavailable diagnostic channel must never affect Core lifecycle.
      errorCode = "BUN_MEMORY_SAMPLE_FAILED";
      return false;
    } finally { busy = false; }
  }
  function start() {
    if (closed || timer || (process.platform !== "win32" && !options.readSamples)) return;
    timer = setInterval(() => { void sample(); }, Math.max(10_000, options.intervalMs ?? 60_000));
    timer.unref?.();
    void sample();
  }
  function stop() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    history.clear();
  }
  function status(): BunMemoryWatchStatus {
    return { running: !closed && Boolean(timer), lastSampleAt, observedProcesses,
      largestPrivateBytes, largestPrivatePid, alertsRecorded, lastAlert, errorCode, evidenceFile };
  }
  return { start, stop, sample, status };
}
