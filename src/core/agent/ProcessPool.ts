import { spawn } from "node:child_process";
import { mapConcurrentOrdered } from "../concurrency.js";

export interface FileReadProcessJob {
  filePath: string;
  displayPath: string;
  offset: number;
  limit: number;
  mimeType?: string | null;
}

export interface ProcessPoolMetrics {
  spawned: number;
  completed: number;
  failed: number;
  timedOut: number;
  fallbackReads: number;
  active: number;
  maxActive: number;
  lastDurationMs: number;
}

const metrics: ProcessPoolMetrics = {
  spawned: 0,
  completed: 0,
  failed: 0,
  timedOut: 0,
  fallbackReads: 0,
  active: 0,
  maxActive: 0,
  lastDurationMs: 0,
};

/**
 * Worker process is intentionally restricted to file reads. It receives only
 * resolved paths and display metadata after the parent has applied path guards.
 * No tool dispatch, shell execution, config mutation, or user supplied code runs
 * in the worker.
 */
const READ_WORKER_SCRIPT = String.raw`
const fs = require("node:fs/promises");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const jobs = JSON.parse(input);
    const out = [];
    for (const job of jobs) {
      try {
        const stat = await fs.stat(job.filePath);
        if (stat.isDirectory()) {
          out.push("--- File: " + job.displayPath + " (Directory) ---\nError: Cannot read directory in bulk mode.");
          continue;
        }
        const buffer = await fs.readFile(job.filePath);
        if (job.mimeType) {
          out.push("--- File: " + job.displayPath + " ---\ndata:" + job.mimeType + ";base64," + buffer.toString("base64"));
          continue;
        }
        let binary = false;
        for (let i = 0; i < Math.min(buffer.length, 1024); i++) {
          if (buffer[i] === 0) { binary = true; break; }
        }
        if (binary) {
          out.push("--- File: " + job.displayPath + " ---\nError: Cannot read binary file");
          continue;
        }
        const content = buffer.toString("utf8");
        const lines = content.replace(/\r\n/g, "\n").split("\n");
        const offset = Math.max(1, Number(job.offset) || 1);
        const limit = Math.max(1, Number(job.limit) || 800);
        const sliced = lines.slice(offset - 1, offset - 1 + limit);
        const body = sliced.map((line, i) => (offset + i) + ": " + line).join("\n");
        const endLine = Math.min(offset + limit - 1, lines.length);
        let result = "--- File: " + job.displayPath + " (lines " + offset + "-" + endLine + " of " + lines.length + ") ---\n" + body;
        if (lines.length > offset - 1 + limit) {
          const remaining = lines.length - (offset - 1 + limit);
          result += "\n... (output truncated, showing " + limit + " of " + lines.length + " lines. There are " + remaining + " more lines)";
        }
        out.push(result);
      } catch (err) {
        out.push("--- File: " + job.displayPath + " ---\nError: " + (err && err.message ? err.message : String(err)));
      }
    }
    process.stdout.write(JSON.stringify(out));
  } catch (err) {
    process.stderr.write(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  }
});
`;

const MAX_WORKERS = 4;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;

/** Global FIFO semaphore: the cap applies across all simultaneous read batches. */
class WorkerSemaphore {
  private available: number;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      const error = new Error("File read worker aborted while waiting for a process slot");
      error.name = "AbortError";
      throw error;
    }

    if (this.available > 0) {
      this.available -= 1;
      return this.makeRelease();
    }

    return await new Promise<() => void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          const error = new Error("File read worker aborted while waiting for a process slot");
          error.name = "AbortError";
          reject(error);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!;
        if (waiter.signal?.aborted) {
          waiter.signal.removeEventListener("abort", waiter.onAbort!);
          const error = new Error("File read worker aborted while waiting for a process slot");
          error.name = "AbortError";
          waiter.reject(error);
          continue;
        }
        if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(this.makeRelease());
        return;
      }
      this.available += 1;
    };
  }
}

const processSlots = new WorkerSemaphore(MAX_WORKERS);

function splitIntoChunks<T>(items: T[], count: number): T[][] {
  const chunkCount = Math.min(count, items.length);
  return Array.from({ length: chunkCount }, (_, index) => {
    const start = Math.floor((index * items.length) / chunkCount);
    const end = Math.floor(((index + 1) * items.length) / chunkCount);
    return items.slice(start, end);
  });
}

async function runWorkerChunk(
  jobs: FileReadProcessJob[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const releaseWorkerSlot = await processSlots.acquire(signal);
  const startedAt = Date.now();
  return await new Promise<string[]>((resolve, reject) => {
    if (signal?.aborted) {
      releaseWorkerSlot();
      const error = new Error("File read worker aborted before start");
      error.name = "AbortError";
      reject(error);
      return;
    }

    const child = spawn(process.execPath, ["-e", READ_WORKER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        PATH: process.env.PATH || "",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      },
    });
    metrics.spawned += 1;
    metrics.active += 1;
    metrics.maxActive = Math.max(metrics.maxActive, metrics.active);

    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      metrics.timedOut += 1;
      child.kill();
      finish(new Error(`File read worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      const error = new Error("File read worker aborted");
      error.name = "AbortError";
      child.kill();
      finish(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      metrics.active = Math.max(0, metrics.active - 1);
      metrics.lastDurationMs = Date.now() - startedAt;
      releaseWorkerSlot();
    };
    const finish = (error?: Error, value?: string[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        metrics.failed += 1;
        reject(error);
      } else {
        metrics.completed += 1;
        resolve(value || []);
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += value.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill();
        finish(new Error("File read worker output exceeded the 32 MiB safety limit"));
        return;
      }
      stdoutChunks.push(value);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stderrBytes < MAX_STDERR_BYTES) {
        const accepted = value.subarray(0, MAX_STDERR_BYTES - stderrBytes);
        stderr += accepted.toString("utf8");
        stderrBytes += accepted.length;
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`File read worker exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        // Decode once after concatenation so split UTF-8 code points remain intact.
        const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8"));
        if (!Array.isArray(parsed) || parsed.length !== jobs.length || parsed.some((item) => typeof item !== "string")) {
          throw new Error("Worker returned an invalid or incomplete result batch");
        }
        finish(undefined, parsed as string[]);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.stdin.end(JSON.stringify(jobs));
  });
}

async function readChunkInline(jobs: FileReadProcessJob[]): Promise<string[]> {
  const fs = await import("node:fs/promises");
  return await mapConcurrentOrdered(jobs, 4, async (job) => {
    try {
      const stat = await fs.stat(job.filePath);
      if (stat.isDirectory()) {
        return `--- File: ${job.displayPath} (Directory) ---\nError: Cannot read directory in bulk mode.`;
      }
      const buffer = await fs.readFile(job.filePath);
      if (job.mimeType) {
        return `--- File: ${job.displayPath} ---\ndata:${job.mimeType};base64,${buffer.toString("base64")}`;
      }
      if (buffer.subarray(0, Math.min(buffer.length, 1024)).includes(0)) {
        return `--- File: ${job.displayPath} ---\nError: Cannot read binary file`;
      }
      const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
      const offset = Math.max(1, Number(job.offset) || 1);
      const limit = Math.max(1, Number(job.limit) || 800);
      const body = lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}: ${line}`).join("\n");
      const endLine = Math.min(offset + limit - 1, lines.length);
      let result = `--- File: ${job.displayPath} (lines ${offset}-${endLine} of ${lines.length}) ---\n${body}`;
      if (lines.length > offset - 1 + limit) {
        result += `\n... (output truncated, showing ${limit} of ${lines.length} lines. There are ${lines.length - (offset - 1 + limit)} more lines)`;
      }
      return result;
    } catch (error) {
      return `--- File: ${job.displayPath} ---\nError: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
}

export async function readFilesInProcessPool(
  jobs: FileReadProcessJob[],
  options: { timeoutMs?: number; signal?: AbortSignal; maxWorkers?: number } = {},
): Promise<string[]> {
  if (jobs.length === 0) return [];
  const maxWorkers = Math.max(1, Math.min(MAX_WORKERS, Math.floor(options.maxWorkers || MAX_WORKERS)));
  const chunks = splitIntoChunks(jobs, maxWorkers);
  try {
    const chunkResults = await Promise.all(chunks.map((chunk) =>
      runWorkerChunk(chunk, options.timeoutMs || DEFAULT_TIMEOUT_MS, options.signal),
    ));
    return chunkResults.flat();
  } catch (error) {
    // Availability-first fallback runs in the orchestrator and is counted. The caller
    // still gets ordered per-file errors/results rather than losing the whole batch.
    metrics.fallbackReads += 1;
    if (options.signal?.aborted) throw error;
    return await readChunkInline(jobs);
  }
}

export function getProcessPoolMetrics(): Readonly<ProcessPoolMetrics> {
  return { ...metrics };
}
