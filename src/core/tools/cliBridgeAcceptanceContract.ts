import path from "node:path";
import type {
  AcceptanceContract,
  AcceptanceArtifactRequirement,
  AcceptanceGitDiffRequirement,
  TypedVerificationCommand,
  VerificationCommandSpec,
} from "./cliBridgeAcceptance.js";

const MAX_ARTIFACTS = 12;
const MAX_VERIFIERS = 8;
const MAX_PATH_LENGTH = 240;
const SHA256_RE = /^[a-f0-9]{64}$/i;

export class AcceptanceContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptanceContractValidationError";
  }
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AcceptanceContractValidationError("acceptanceContract must be an object.");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], scope: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new AcceptanceContractValidationError(`${scope} contains unsupported field '${key}'.`);
    }
  }
}

function validateRelativePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AcceptanceContractValidationError(`${field} must be a non-empty relative path.`);
  }
  const candidate = value.trim();
  if (candidate.length > MAX_PATH_LENGTH) {
    throw new AcceptanceContractValidationError(`${field} exceeds ${MAX_PATH_LENGTH} characters.`);
  }
  if (path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) {
    throw new AcceptanceContractValidationError(`${field} must be relative to the delegated workspace.`);
  }
  const normalized = path.posix.normalize(candidate.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new AcceptanceContractValidationError(`${field} escapes the delegated workspace.`);
  }
  return normalized;
}

function normalizeArtifacts(value: unknown): AcceptanceArtifactRequirement[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ARTIFACTS) {
    throw new AcceptanceContractValidationError(`acceptanceContract.artifacts requires 1-${MAX_ARTIFACTS} entries.`);
  }
  return value.map((raw, index) => {
    const obj = plainObject(raw);
    rejectUnknownKeys(obj, ["path", "mustExist", "minBytes", "expectedSha256"], `artifacts[${index}]`);
    const out: AcceptanceArtifactRequirement = {
      path: validateRelativePath(obj.path, `artifacts[${index}].path`),
    };
    if (obj.mustExist !== undefined) {
      if (typeof obj.mustExist !== "boolean") throw new AcceptanceContractValidationError(`artifacts[${index}].mustExist must be boolean.`);
      out.mustExist = obj.mustExist;
    }
    if (obj.minBytes !== undefined) {
      if (!Number.isSafeInteger(obj.minBytes) || Number(obj.minBytes) < 0 || Number(obj.minBytes) > 1024 * 1024 * 1024) {
        throw new AcceptanceContractValidationError(`artifacts[${index}].minBytes must be an integer between 0 and 1 GiB.`);
      }
      out.minBytes = Number(obj.minBytes);
    }
    if (obj.expectedSha256 !== undefined) {
      if (typeof obj.expectedSha256 !== "string" || !SHA256_RE.test(obj.expectedSha256)) {
        throw new AcceptanceContractValidationError(`artifacts[${index}].expectedSha256 must be a 64-character SHA-256 hex digest.`);
      }
      out.expectedSha256 = obj.expectedSha256.toLowerCase();
    }
    return out;
  });
}

function normalizeGitDiff(value: unknown): AcceptanceGitDiffRequirement | undefined {
  if (value === undefined) return undefined;
  const obj = plainObject(value);
  rejectUnknownKeys(obj, ["maxChangedFiles", "prohibitedPaths", "requireCommit", "baseCommitSha"], "acceptanceContract.gitDiff");
  const out: AcceptanceGitDiffRequirement = {};
  if (obj.maxChangedFiles !== undefined) {
    if (!Number.isSafeInteger(obj.maxChangedFiles) || Number(obj.maxChangedFiles) < 0 || Number(obj.maxChangedFiles) > 10000) {
      throw new AcceptanceContractValidationError("acceptanceContract.gitDiff.maxChangedFiles must be an integer between 0 and 10000.");
    }
    out.maxChangedFiles = Number(obj.maxChangedFiles);
  }
  if (obj.requireCommit !== undefined) {
    if (typeof obj.requireCommit !== "boolean") throw new AcceptanceContractValidationError("acceptanceContract.gitDiff.requireCommit must be boolean.");
    out.requireCommit = obj.requireCommit;
  }
  if (obj.baseCommitSha !== undefined) {
    if (typeof obj.baseCommitSha !== "string" || !/^[a-f0-9]{7,64}$/i.test(obj.baseCommitSha)) {
      throw new AcceptanceContractValidationError("acceptanceContract.gitDiff.baseCommitSha must be a 7-64 character hexadecimal Git object id.");
    }
    out.baseCommitSha = obj.baseCommitSha;
  }
  if (obj.prohibitedPaths !== undefined) {
    if (!Array.isArray(obj.prohibitedPaths) || obj.prohibitedPaths.length > 64) {
      throw new AcceptanceContractValidationError("acceptanceContract.gitDiff.prohibitedPaths must be an array with at most 64 entries.");
    }
    out.prohibitedPaths = obj.prohibitedPaths.map((item, index) =>
      validateRelativePath(item, `acceptanceContract.gitDiff.prohibitedPaths[${index}]`)
    );
  }
  return out;
}

const ALLOWED_BINARIES = new Set([
  "git", "node", "bun", "npm", "npx", "pytest", "python", "python3", "cargo", "go"
]);

function normalizeCommandArgs(value: unknown, scope: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AcceptanceContractValidationError(`${scope} must be an array of string arguments.`);
  }
  if (value.length > 32) {
    throw new AcceptanceContractValidationError(`${scope} exceeds maximum argument count of 32.`);
  }
  return value.map((arg, idx) => {
    if (typeof arg !== "string") {
      throw new AcceptanceContractValidationError(`${scope}[${idx}] must be a string.`);
    }
    const candidate = arg.trim();
    if (candidate.length > 256) {
      throw new AcceptanceContractValidationError(`${scope}[${idx}] exceeds 256 characters.`);
    }
    if (/[;&|><`]|\$\(/.test(candidate)) {
      throw new AcceptanceContractValidationError(`${scope}[${idx}] contains forbidden shell metacharacters (; & | > < $() \`).`);
    }
    if (/(?:^|\s|\/|\\)\.\.(?:\/|\\|\s|$)/.test(candidate)) {
      throw new AcceptanceContractValidationError(`${scope}[${idx}] contains path traversal outside workspace.`);
    }
    return candidate;
  });
}

export function normalizeTypedVerificationCommand(
  raw: unknown,
  scope: string
): TypedVerificationCommand {
  if (typeof raw === "string") {
    throw new AcceptanceContractValidationError(
      `${scope} contains unsupported field '${scope.split(".").pop()}' with raw shell string. Use structured typed verifiers ({ kind: 'npm-script'|'bun-script'|'binary'|'git-status'|'git-diff' }).`
    );
  }
  const obj = plainObject(raw);
  const kind = obj.kind;
  if (typeof kind !== "string") {
    throw new AcceptanceContractValidationError(`${scope}.kind must be a string.`);
  }

  if (kind === "npm-script" || kind === "bun-script") {
    rejectUnknownKeys(obj, ["kind", "name", "args"], scope);
    if (typeof obj.name !== "string" || !/^[a-zA-Z0-9_:.-]+$/.test(obj.name)) {
      throw new AcceptanceContractValidationError(
        `${scope}.name must be an alphanumeric script name (e.g. 'test', 'build', 'lint').`
      );
    }
    const args = normalizeCommandArgs(obj.args, `${scope}.args`);
    return { kind, name: obj.name, args };
  }

  if (kind === "binary") {
    rejectUnknownKeys(obj, ["kind", "executable", "args"], scope);
    if (typeof obj.executable !== "string" || !obj.executable.trim()) {
      throw new AcceptanceContractValidationError(`${scope}.executable must be a non-empty string.`);
    }
    const exe = obj.executable.trim();
    const isSafeRelative = (exe.startsWith("./") || exe.startsWith(".\\")) && !exe.includes("..");
    if (!ALLOWED_BINARIES.has(exe.toLowerCase()) && !isSafeRelative) {
      throw new AcceptanceContractValidationError(
        `${scope}.executable '${exe}' is not an authorized verification binary.`
      );
    }
    const args = normalizeCommandArgs(obj.args, `${scope}.args`);
    return { kind: "binary", executable: exe, args };
  }

  if (kind === "git-status" || kind === "git-diff") {
    rejectUnknownKeys(obj, ["kind", "args"], scope);
    const args = normalizeCommandArgs(obj.args, `${scope}.args`);
    return { kind, args };
  }

  throw new AcceptanceContractValidationError(
    `Unsupported verification command kind '${kind}' at ${scope}. Allowed kinds: npm-script, bun-script, binary, git-status, git-diff.`
  );
}

function normalizeVerificationCommands(
  value: unknown,
  fieldName: "tests" | "build" | "commands",
  scope: string
): TypedVerificationCommand[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_VERIFIERS) {
    throw new AcceptanceContractValidationError(`${scope} requires 1-${MAX_VERIFIERS} verification commands.`);
  }
  return value.map((item, idx) => {
    if (typeof item === "string") {
      throw new AcceptanceContractValidationError(
        `acceptanceContract contains unsupported field '${fieldName}' with raw shell string. Use structured typed verifiers ({ kind: 'npm-script'|'bun-script'|'binary'|'git-status'|'git-diff' }).`
      );
    }
    return normalizeTypedVerificationCommand(item, `${scope}[${idx}]`);
  });
}

/**
 * Normalizes and validates public MCP/CLI Bridge acceptance contracts.
 * Enforces typed verifiers for commands/tests/build; raw shell strings are rejected fail-closed.
 */
export function normalizePublicAcceptanceContract(value: unknown): AcceptanceContract | undefined {
  if (value === undefined || value === null) return undefined;
  const obj = plainObject(value);

  // Reject raw string fields for commands/tests/build/customVerifier explicitly
  for (const field of ["commands", "tests", "build"] as const) {
    if (Array.isArray(obj[field]) && obj[field].some((x: unknown) => typeof x === "string")) {
      throw new AcceptanceContractValidationError(
        `acceptanceContract contains unsupported field '${field}' with raw shell text; use structured typed verifiers.`
      );
    }
  }
  if (typeof obj.customVerifier === "string") {
    throw new AcceptanceContractValidationError(
      `acceptanceContract contains unsupported field 'customVerifier' with raw shell text; use structured typed verifiers.`
    );
  }

  rejectUnknownKeys(obj, ["artifacts", "gitDiff", "tests", "build", "commands", "customVerifier"], "acceptanceContract");

  const artifacts = normalizeArtifacts(obj.artifacts);
  const gitDiff = normalizeGitDiff(obj.gitDiff);
  const tests = normalizeVerificationCommands(obj.tests, "tests", "acceptanceContract.tests");
  const build = normalizeVerificationCommands(obj.build, "build", "acceptanceContract.build");
  const commands = normalizeVerificationCommands(obj.commands, "commands", "acceptanceContract.commands");
  const customVerifier = obj.customVerifier
    ? normalizeTypedVerificationCommand(obj.customVerifier, "acceptanceContract.customVerifier")
    : undefined;

  if (!artifacts && !gitDiff && !tests && !build && !commands && !customVerifier) {
    throw new AcceptanceContractValidationError(
      "acceptanceContract must contain at least one verification criterion (artifacts, gitDiff, tests, build, commands, or customVerifier)."
    );
  }

  return { artifacts, gitDiff, tests, build, commands, customVerifier };
}
