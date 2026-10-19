import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { createHash, randomUUID } from "node:crypto";
import * as ts from "typescript";
import type {
  SafeReplayAction,
  SkillReplayCheckResult,
  SkillReplayFixture,
  SkillReplayResult,
} from "./skillLifecycle.js";

const MAX_FIXTURE_FILES = 50;
const MAX_FIXTURE_ACTIONS = 100;
const MAX_FILE_BYTES = 100_000;
const MAX_SANDBOX_BYTES = 500_000;
const MAX_TOOL_CALLS = 300;
const MAX_REPLAY_TIMEOUT_MS = 10 * 60 * 1000;
const VALID_CHECKS = new Set(["assert_file_exists", "assert_file_contains", "read_file", "verify_syntax"]);

export interface SkillReplayTools {
  listFiles(): Promise<string[]>;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  assertFileExists(relativePath: string): Promise<void>;
  verifySyntax(relativePath: string): Promise<void>;
}

export interface SkillReplayExecutorContext {
  skillName: string;
  skillVersion: string;
  /** Candidate markdown is untrusted guidance, passed as data to the executor. */
  instructions: string;
  taskPrompt: string;
  fixtureId: string;
  signal: AbortSignal;
  /** Canonical temporary root for trusted adapter setup; never include this in the model prompt. */
  workspaceRoot: string;
  /** Tool-only workspace API: no shell, network, arbitrary path, or live-workspace access. */
  tools: SkillReplayTools;
}

export type SkillReplayExecutor = (context: SkillReplayExecutorContext) => Promise<unknown>;

function ownRecord(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`Invalid ${label} object prototype.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`Invalid ${label} key.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`Invalid ${label} property.`);
    if (!allowedKeys.includes(key)) throw new Error(`Unsupported ${label} field: ${key}.`);
  }
  return value as Record<string, unknown>;
}

function safeRelativePath(input: unknown): string {
  if (typeof input !== "string" || !input.trim() || input.length > 240) throw new Error("Replay file path must be a short relative path.");
  const normalized = input.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.startsWith("//") || /^[a-z]:/i.test(normalized) ||
      normalized.includes("\0") || normalized.split("/").some(segment => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new Error("Replay refused an absolute, traversal, or malformed file path.");
  }
  return normalized;
}

function boundedText(input: unknown, name: string, limit: number): string {
  if (typeof input !== "string" || !input.trim() || input.length > limit || /\0/.test(input)) {
    throw new Error(`Replay ${name} must be a non-empty string up to ${limit} characters.`);
  }
  return input;
}
function boundedFileContents(input: unknown): string {
  if (typeof input !== "string" || input.length > MAX_FILE_BYTES || /\0/.test(input)) {
    throw new Error(`Replay file contents must be text up to ${MAX_FILE_BYTES} characters.`);
  }
  return input;
}

function validateFixture(input: SkillReplayFixture): SkillReplayFixture {
  const record = ownRecord(input, ["fixtureId", "name", "description", "taskPrompt", "initialFiles", "actions"], "fixture");
  const fixtureId = boundedText(record.fixtureId, "fixtureId", 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(fixtureId)) throw new Error("Replay fixtureId contains unsupported characters.");
  const name = boundedText(record.name, "name", 160);
  const description = boundedText(record.description, "description", 500);
  const taskPrompt = boundedText(record.taskPrompt, "taskPrompt", 4_000);
  const initialFilesRaw = record.initialFiles === undefined ? {} : ownRecord(record.initialFiles, Object.keys(record.initialFiles as object), "initialFiles");
  const initialEntries = Object.entries(initialFilesRaw);
  if (initialEntries.length > MAX_FIXTURE_FILES) throw new Error(`Replay fixture may contain at most ${MAX_FIXTURE_FILES} initial files.`);
  const initialFiles: Record<string, string> = Object.create(null);
  let totalBytes = 0;
  for (const [rawPath, rawContents] of initialEntries) {
    const relative = safeRelativePath(rawPath);
    const contents = boundedFileContents(rawContents);
    totalBytes += Buffer.byteLength(contents, "utf8");
    if (totalBytes > MAX_SANDBOX_BYTES) throw new Error("Replay fixture initial files exceed the sandbox size budget.");
    initialFiles[relative] = contents;
  }
  const actionValues = record.actions;
  if (!Array.isArray(actionValues) || actionValues.length < 1 || actionValues.length > MAX_FIXTURE_ACTIONS) {
    throw new Error(`Replay fixture must include between 1 and ${MAX_FIXTURE_ACTIONS} postcondition checks.`);
  }
  for (let index = 0; index < actionValues.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(actionValues, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error("Replay fixture actions cannot contain holes or accessor properties.");
  }
  const actions: SafeReplayAction[] = actionValues.map((raw) => {
    const action = ownRecord(raw, ["type", "target", "expected"], "replay action");
    if (typeof action.type !== "string" || !VALID_CHECKS.has(action.type)) throw new Error("Replay fixture contains an unsupported check action.");
    const target = safeRelativePath(action.target);
    const expected = action.expected === undefined ? undefined : boundedText(action.expected, "expected output", 2_000);
    if (action.type === "assert_file_contains" && expected === undefined) throw new Error("assert_file_contains requires an expected substring.");
    return { type: action.type as SafeReplayAction["type"], target, ...(expected ? { expected } : {}) };
  });
  return { fixtureId, name, description, taskPrompt, initialFiles, actions };
}

function safeReplayLabel(value: unknown, limit = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]")
    .replace(/[\r\n\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
  return clean || undefined;
}

function boundedTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(10_000_000, Math.floor(value));
}

function shortError(error: unknown, sandboxRoot?: string): string {
  const message = error instanceof Error ? error.message : "Executor failed.";
  return message
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]")
    .replace(/[\r\n\x00-\x1f\x7f]+/g, " ")
    .replace(sandboxRoot || "\u0001", "[sandbox]")
    .slice(0, 240);
}

function parseSyntax(filePath: string, source: string): void {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    JSON.parse(source);
    return;
  }
  const scriptKind = ext === ".tsx" ? ts.ScriptKind.TSX
    : ext === ".jsx" ? ts.ScriptKind.JSX
    : [".js", ".mjs", ".cjs", ".jsm"].includes(ext) ? ts.ScriptKind.JS
    : [".ts", ".mts", ".cts"].includes(ext) ? ts.ScriptKind.TS
    : undefined;
  if (scriptKind === undefined) throw new Error("Syntax verification supports only JSON, JS/JSX, and TS/TSX files.");
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics.length) {
    const first = parseDiagnostics[0];
    throw new Error("Syntax parse failed: " + ts.flattenDiagnosticMessageText(first.messageText, " ").slice(0, 180));
  }
  if (scriptKind === ts.ScriptKind.JS) {
    // Parse only: do not run candidate- or fixture-provided JavaScript.
    new vm.Script(source, { filename: path.basename(filePath) });
  }
}

async function listSandboxFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 8 || output.length >= 500) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Replay sandbox refused a symbolic link.");
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative, depth + 1);
      else if (entry.isFile()) output.push(relative);
      if (output.length >= 500) return;
    }
  };
  await walk(root, "", 0);
  return output.sort();
}

async function safeTarget(root: string, relativePath: string): Promise<string> {
  const relative = safeRelativePath(relativePath);
  const target = path.resolve(root, ...relative.split("/"));
  const relation = path.relative(root, target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error("Replay file path escaped its disposable sandbox.");
  let cursor = root;
  for (const segment of relative.split("/")) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error("Replay sandbox refuses symbolic links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

export async function runSandboxSkillReplay(
  candidate: { name: string; version: string; markdownContent: string },
  inputFixture: SkillReplayFixture,
  executor: SkillReplayExecutor,
  options: { timeoutMs?: number } = {},
): Promise<SkillReplayResult> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const fixture = validateFixture(inputFixture);
  const fixtureSha256 = createHash("sha256").update(JSON.stringify(fixture), "utf8").digest("hex");
  const timeoutMs = Math.max(1_000, Math.min(MAX_REPLAY_TIMEOUT_MS, Math.floor(options.timeoutMs ?? 120_000)));
  const instructions = boundedText(candidate.markdownContent, "candidate instructions", 80_000);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.name) || !/^[a-f0-9]{12}$/.test(candidate.version)) {
    throw new Error("Replay requires a canonical candidate name and immutable version.");
  }
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-skill-replay-"));
  try {
    await fs.chmod(sandboxRoot, 0o700).catch(() => {});
    let bytesWritten = 0;
    let toolCalls = 0;
    const controller = new AbortController();
    const ensureActive = () => {
      if (controller.signal.aborted) throw new Error("Replay stopped or timed out.");
      if (++toolCalls > MAX_TOOL_CALLS) throw new Error("Replay exceeded the safe tool-call limit.");
    };
    const writeSandboxFile = async (relativePath: string, contents: string, countAsToolCall = true): Promise<void> => {
      if (countAsToolCall) ensureActive();
      else if (controller.signal.aborted) throw new Error("Replay stopped or timed out.");
      const content = boundedFileContents(contents);
      const target = await safeTarget(sandboxRoot, relativePath);
      let oldSize = 0;
      let targetExists = false;
      try {
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Replay write target is not a regular sandbox file.");
        oldSize = stat.size;
        targetExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const newBytes = Buffer.byteLength(content, "utf8");
      if (bytesWritten - oldSize + newBytes > MAX_SANDBOX_BYTES) throw new Error("Replay sandbox exceeded its byte budget.");
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      // Recheck after parent directory creation so an unexpected symlink fails closed.
      const checkedTarget = await safeTarget(sandboxRoot, relativePath);
      const tempPath = checkedTarget + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        if (targetExists) await fs.rm(checkedTarget, { force: true });
        await fs.rename(tempPath, checkedTarget);
      } finally {
        await fs.rm(tempPath, { force: true }).catch(() => {});
      }
      bytesWritten = bytesWritten - oldSize + newBytes;
    };
    for (const [relativePath, contents] of Object.entries(fixture.initialFiles || {})) {
      // Initial fixture files are trusted test inputs but still use the same path and size guards.
      await writeSandboxFile(relativePath, contents, false);
    }

    const tools: SkillReplayTools = {
      listFiles: async () => { ensureActive(); return listSandboxFiles(sandboxRoot); },
      readFile: async (relativePath) => {
        ensureActive();
        const target = await safeTarget(sandboxRoot, relativePath);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("Replay read target is not a bounded regular file.");
        return fs.readFile(target, "utf8");
      },
      writeFile: writeSandboxFile,
      assertFileExists: async (relativePath) => {
        ensureActive();
        const target = await safeTarget(sandboxRoot, relativePath);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Expected a regular file to exist in the replay sandbox.");
      },
      verifySyntax: async (relativePath) => {
        ensureActive();
        const target = await safeTarget(sandboxRoot, relativePath);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("Syntax target is not a bounded regular file.");
        parseSyntax(relativePath, await fs.readFile(target, "utf8"));
      },
    };

    let timedOut = false;
    let executorError: string | undefined;
    let executorOutput: unknown;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const executorPromise = Promise.resolve().then(() => executor({
      skillName: candidate.name,
      skillVersion: candidate.version,
      instructions,
      taskPrompt: fixture.taskPrompt,
      fixtureId: fixture.fixtureId,
      signal: controller.signal,
      workspaceRoot: sandboxRoot,
      tools,
    }));
    // The executor is trusted application code, not candidate code. This disposable-workspace boundary is not OS/container isolation.
    // Never pass shell, network, arbitrary filesystem, or other privileged tools to an executor adapter.
    executorPromise.catch(() => {});
    try {
      executorOutput = await Promise.race([
        executorPromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error("Sandbox replay timed out."));
          }, timeoutMs);

        }),
      ]);
    } catch (error) {
      executorError = shortError(error, sandboxRoot);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      controller.abort();
    }

    const checks: SkillReplayCheckResult[] = [];
    if (executorError) {
      checks.push({ action: "executor", status: "fail", detail: executorError });
    }
    if (!executorError) {
      for (const action of fixture.actions) {
        try {
          const target = await safeTarget(sandboxRoot, action.target);
          if (action.type === "assert_file_exists") {
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Expected a regular file to exist.");
          } else if (action.type === "read_file") {
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("Expected a bounded regular file to be readable.");
            const contents = await fs.readFile(target, "utf8");
            if (action.expected && !contents.includes(action.expected)) throw new Error("Expected content was not found.");
          } else if (action.type === "assert_file_contains") {
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("Expected a bounded regular file.");
            if (!(await fs.readFile(target, "utf8")).includes(action.expected || "")) throw new Error("Expected content was not found.");
          } else if (action.type === "verify_syntax") {
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("Expected a bounded regular file.");
            parseSyntax(action.target, await fs.readFile(target, "utf8"));
          }
          checks.push({ action: action.type + ":" + action.target, status: "pass", detail: "Postcondition passed in disposable sandbox." });
        } catch (error) {
          checks.push({ action: action.type + ":" + action.target, status: "fail", detail: shortError(error, sandboxRoot) });
        }
      }
    } else {
      for (const action of fixture.actions) {
        checks.push({ action: action.type + ":" + action.target, status: "fail", detail: "Postcondition skipped because the executor did not complete successfully." });
      }
    }

    let changedFiles: string[] = [];
    try {
      const finalFiles = await listSandboxFiles(sandboxRoot);
      const finalFileSet = new Set(finalFiles);
      const fixtureInitialFiles = fixture.initialFiles || {};
      for (const relativePath of finalFiles) {
        if (!Object.prototype.hasOwnProperty.call(fixtureInitialFiles, relativePath)) {
          changedFiles.push(relativePath);
          continue;
        }
        const currentText = await fs.readFile(await safeTarget(sandboxRoot, relativePath), "utf8");
        if (currentText !== fixtureInitialFiles[relativePath]) changedFiles.push(relativePath);
      }
      for (const initialPath of Object.keys(fixtureInitialFiles)) {
        if (!finalFileSet.has(initialPath)) changedFiles.push(initialPath);
      }
    } catch (error) {
      checks.push({ action: "workspace-diff", status: "fail", detail: shortError(error, sandboxRoot) });
    }

    const execution = executorOutput && typeof executorOutput === "object" && !Array.isArray(executorOutput)
      ? executorOutput as Record<string, unknown>
      : {};
    return {
      fixtureId: fixture.fixtureId,
      status: !executorError && checks.every(check => check.status === "pass") ? "passed" : "failed",
      actionsExecuted: toolCalls,
      checks: checks.slice(0, MAX_FIXTURE_ACTIONS + 1),
      durationMs: Date.now() - startedAt,
      ...(executorError ? { error: executorError + (timedOut ? " (timeout)" : "") } : {}),
      runId,
      skillVersion: candidate.version,
      fixtureSha256,
      ...(safeReplayLabel(execution.provider, 80) ? { provider: safeReplayLabel(execution.provider, 80) } : {}),
      ...(safeReplayLabel(execution.model, 100) ? { model: safeReplayLabel(execution.model, 100) } : {}),
      ...(boundedTokenCount(execution.promptTokens) !== undefined ? { promptTokens: boundedTokenCount(execution.promptTokens) } : {}),
      ...(boundedTokenCount(execution.completionTokens) !== undefined ? { completionTokens: boundedTokenCount(execution.completionTokens) } : {}),
      changedFiles: [...new Set(changedFiles)].sort().slice(0, 100),
      finishedAt: Date.now(),
    };
  } finally {
    // Executor tools have no handle to the live workspace; disposable files are always removed.
    await fs.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
  }
}
