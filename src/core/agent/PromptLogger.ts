import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { getGlobalConfigDir, ensureGlobalConfigDir } from "../config.js";
import { getSettings } from "../config/jsonConfig.js";

// ── State ──────────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_ROTATED_FILES = 5;
const COMPRESS_AFTER_MS = 24 * 60 * 60 * 1000; // 24h
const DEDUP_WINDOW_MS = 5000; // 5s dedup window for FastPath double-calls

let writeStream: fs.WriteStream | null = null;
let lastRotateCheck = 0;
let lastEntryHash = "";
let lastEntryTime = 0;

// ── Helpers ────────────────────────────────────────────────────────────────────

function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function truncateSystem(system: string | undefined): string {
  if (!system) return "-";
  return `<hash:${hashContent(system)}, len:${Buffer.byteLength(system, "utf-8")} chars>`;
}

function getLogDir(): string {
  ensureGlobalConfigDir();
  return path.join(getGlobalConfigDir(), "prompts");
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getSessionFile(sessionId: string): string {
  const dir = getLogDir();
  ensureDir(dir);
  return path.join(dir, `sess_${sessionId}.jsonl`);
}

function getFallbackFile(): string {
  const dir = getGlobalConfigDir();
  ensureGlobalConfigDir();
  return path.join(dir, "prompts.log");
}

function getStream(filePath: string): fs.WriteStream {
  if (writeStream) {
    // Close old stream if path changed (session switch)
    // We only lazy-close on rotate or new file
    return writeStream;
  }
  writeStream = fs.createWriteStream(filePath, { flags: "a" });
  writeStream.on("error", () => {});
  return writeStream;
}

function closeStream(): void {
  if (writeStream) {
    try { writeStream.end(); } catch {}
    writeStream = null;
  }
}

function rotateIfNeeded(filePath: string): void {
  const now = Date.now();
  if (now - lastRotateCheck < 60_000) return; // check max once per minute
  lastRotateCheck = now;

  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_FILE_SIZE) return;
  } catch {
    return; // file doesn't exist yet
  }

  // Close current stream before rotating
  closeStream();

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath); // .jsonl or .log
  const base = path.basename(filePath, ext);

  // Shift rotated files down
  for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
    const oldPath = path.join(dir, `${base}.${i}${ext}`);
    const newPath = path.join(dir, `${base}.${i + 1}${ext}`);
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, newPath);
    }
  }

  // Rename current -> .1
  const rotatedPath = path.join(dir, `${base}.1${ext}`);
  fs.renameSync(filePath, rotatedPath);

  // Compress .1 if older than 24h (triggered on next write)
  tryCompressOld(dir, base, ext);
}

function tryCompressOld(dir: string, base: string, ext: string): void {
  for (let i = 1; i <= MAX_ROTATED_FILES; i++) {
    const logPath = path.join(dir, `${base}.${i}${ext}`);
    const gzPath = logPath + ".gz";
    try {
      const stat = fs.statSync(logPath);
      if (fs.existsSync(gzPath)) continue;
      if (Date.now() - stat.mtimeMs < COMPRESS_AFTER_MS) continue;

      const content = fs.readFileSync(logPath);
      const compressed = gzipSync(content, { level: 6 });
      fs.writeFileSync(gzPath, compressed);
      fs.unlinkSync(logPath);
    } catch {
      // skip if file gone or unreadable
    }
  }
}

/**
 * Strip messages from metadata-mode log entry.
 * Keeps only: count, total tokens estimation, first/last message summary.
 */
function stripMessages(messages: any[] | string | undefined): any {
  if (!messages) return undefined;
  if (typeof messages === "string") {
    return `<string, len:${Buffer.byteLength(messages, "utf-8")}>`;
  }
  if (!Array.isArray(messages)) return messages;
  const count = messages.length;
  if (count === 0) return { count: 0 };
  const first = messages[0];
  const last = messages[count - 1];
  const firstRole = first?.role || "?";
  const lastRole = last?.role || "?";
  const firstLen = first?.content
    ? Buffer.byteLength(
        typeof first.content === "string" ? first.content : JSON.stringify(first.content),
        "utf-8"
      )
    : 0;
  const lastLen = last?.content
    ? Buffer.byteLength(
        typeof last.content === "string" ? last.content : JSON.stringify(last.content),
        "utf-8"
      )
    : 0;
  return {
    count,
    first: { role: firstRole, len: firstLen },
    last: { role: lastRole, len: lastLen },
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function logPrompt(
  label: string,
  modelName: string | undefined,
  system: string | undefined,
  messages: any[] | string | undefined,
  agentOrMeta?: any
): void {
  try {
    const settings = getSettings();
    const level = settings.promptLogLevel ?? "full";

    // OFF mode — skip entirely
    if (level === "off") return;

    // Extract metadata from agent
    const timestamp = new Date().toISOString();
    let meta: Record<string, any> = {};
    let sessionId = "-";

    if (agentOrMeta && typeof agentOrMeta === "object") {
      if (agentOrMeta.conversation && typeof agentOrMeta.tier === "string") {
        const agent = agentOrMeta;
        meta = {
          tier: agent.tier,
          depth: agent.delegationDepth,
          multi: agent.isMultiAgent,
          worktree: agent.worktreePath || "-",
          subagentType: agent.subagentType || "-",
        };
        sessionId = agent.conversation?.sessionId || "-";
      } else {
        meta = { ...agentOrMeta };
        sessionId = (agentOrMeta as any).sessionId || "-";
      }
    }

    // Build log entry based on level
    const logEntry: Record<string, any> = {
      timestamp,
      label,
      model: modelName || "-",
      ...meta,
      sessionId,
    };

    if (level === "metadata") {
      // METADATA mode — no full messages, no full system prompt
      logEntry.system = truncateSystem(system);
      logEntry.messages = stripMessages(messages);
    } else {
      // FULL mode — keep everything
      logEntry.system = system;
      logEntry.messages = messages;
    }

    // ── Dedup (FastPath double-call prevention) ──
    const entryStr = JSON.stringify({ label, model: modelName || "-", sessionId, ...logEntry.messages ? { msgCount: Array.isArray(messages) ? messages.length : 1 } : {} });
    const entryHash = hashContent(entryStr);
    const now = Date.now();
    if (label.startsWith("FastPath:") && entryHash === lastEntryHash && now - lastEntryTime < DEDUP_WINDOW_MS) {
      return; // skip duplicate FastPath log
    }
    lastEntryHash = entryHash;
    lastEntryTime = now;

    // Determine output file
    const filePath = sessionId !== "-" ? getSessionFile(sessionId) : getFallbackFile();

    // Rotate if needed
    rotateIfNeeded(filePath);

    // Write asynchronously
    const line = JSON.stringify(logEntry) + "\n";
    const stream = fs.createWriteStream(filePath, { flags: "a" });
    stream.on("error", () => {});
    stream.write(line, "utf-8", () => {
      stream.end();
    });
  } catch (err) {
    // Ignore logging errors to prevent crashing the agent
  }
}

/**
 * Cleanup: close write stream. Call on agent shutdown.
 */
export function closePromptLogger(): void {
  closeStream();
}
