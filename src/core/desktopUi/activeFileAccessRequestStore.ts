/**
 * Agent-originated requests for the existing Tray "Active Rules" approval queue.
 *
 * This module only appends a pending request to the shared queue consumed by
 * SuperAgent Tray. It never edits the permanent host ACL or approves a request.
 * The native Tray remains the sole authority that verifies the selected path,
 * attests the Core executable, displays the approval dialog, and writes grants.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getRootConfigDir } from "../config/paths.js";
import { getProjectPrincipalKey, type ProjectAccessIdentity } from "../project/projectAccessPolicy.js";

export const ACTIVE_RULE_REQUESTS_FILENAME = "pending-active-rule-requests.json";
export const MAX_ACTIVE_RULE_REQUESTS = 128;
const MAX_STORE_BYTES = 128 * 1024;

export type ActiveFileOperation = "read" | "write" | "delete";
export type ActiveDesktopOperation = "view" | "input";

export interface CreateActiveFileAccessRequestInput {
  filePath: string;
  operations: ActiveFileOperation[];
  recursive?: boolean;
  reason: string;
}

export interface CreateActiveApplicationAccessRequestInput {
  executablePath: string;
  operations: ActiveDesktopOperation[];
  reason: string;
}

export interface PendingActiveRuleRequestRecord {
  id: string;
  sourceName: string;
  kind: "file" | "desktop";
  effect: "allow" | "deny";
  targetPath: string;
  recursive: boolean;
  operations: string[];
  reason: string;
  createdAt: number;
  status: "pending" | "approved" | "denied";
  decidedAt?: number;
}

interface ActiveFileAccessRequestStoreOptions {
  configDir?: string;
  now?: () => number;
  id?: () => string;
}

function storePath(configDir?: string): string {
  const root = configDir ?? getRootConfigDir();
  if (!path.isAbsolute(root)) throw new Error("Active rule request store directory must be absolute.");
  return path.join(root, ACTIVE_RULE_REQUESTS_FILENAME);
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validateHostPath(value: unknown): string {
  if (!validText(value, 2048)) {
    throw new Error("filePath must be a non-empty absolute local path (maximum 2048 characters).");
  }
  if (process.platform === "win32") {
    if (!/^[a-zA-Z]:\\/.test(value) || value.startsWith("\\\\") ||
        value.includes("/") || path.win32.normalize(value) !== value ||
        path.win32.parse(value).root === value) {
      throw new Error("filePath must be a normalized absolute Windows drive path; UNC, device, and volume-root paths are not allowed.");
    }
  } else if (!value.startsWith("/") || value.includes("\\") ||
      path.posix.normalize(value) !== value || value === "/") {
    throw new Error("filePath must be a normalized absolute local path, not a filesystem root.");
  }
  return value;
}

function validateInput(input: unknown): {
  targetPath: string;
  reason: string;
  operations: ActiveFileOperation[];
  recursive: boolean;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A file access request object is required.");
  }
  const value = input as Record<string, unknown>;
  const allowedFields = new Set(["filePath", "operations", "recursive", "reason"]);
  if (Object.keys(value).some(key => !allowedFields.has(key))) {
    throw new Error("Unsupported field in file access request.");
  }

  const targetPath = validateHostPath(value.filePath);
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (reason.length < 5 || reason.length > 500 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(reason)) {
    throw new Error("reason must contain 5-500 printable characters.");
  }
  if (!Array.isArray(value.operations) || value.operations.length < 1 ||
      value.operations.length > 3 ||
      value.operations.some(op => typeof op !== "string" ||
        !["read", "write", "delete"].includes(op)) ||
      new Set(value.operations).size !== value.operations.length) {
    throw new Error("operations must be a unique non-empty subset of read, write, and delete.");
  }
  if (value.recursive !== undefined && typeof value.recursive !== "boolean") {
    throw new Error("recursive must be a boolean.");
  }

  return {
    targetPath,
    reason,
    operations: [...value.operations] as ActiveFileOperation[],
    recursive: value.recursive === true,
  };
}

/** Shared structural validator used by both runtime execution and SAFE-owner filtering. */
export function isValidActiveFileAccessRequestInput(input: unknown): input is CreateActiveFileAccessRequestInput {
  try {
    validateInput(input);
    return true;
  } catch {
    return false;
  }
}


function validateApplicationInput(input: unknown): {
  targetPath: string;
  reason: string;
  operations: ActiveDesktopOperation[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("An application access request object is required.");
  }
  const value = input as Record<string, unknown>;
  const allowedFields = new Set(["executablePath", "operations", "reason"]);
  if (Object.keys(value).some(key => !allowedFields.has(key))) {
    throw new Error("Unsupported field in application access request.");
  }
  const targetPath = validateHostPath(value.executablePath);
  if (targetPath.includes("*") || targetPath.includes("?") || targetPath.includes("..")) {
    throw new Error("executablePath must identify one exact executable, without traversal or wildcards.");
  }
  if (process.platform === "win32" && !/\.exe$/i.test(targetPath)) {
    throw new Error("executablePath must point to a Windows .exe executable.");
  }
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (reason.length < 5 || reason.length > 500 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(reason)) {
    throw new Error("reason must contain 5-500 printable characters.");
  }
  if (!Array.isArray(value.operations) || value.operations.length < 1 ||
      value.operations.length > 2 ||
      value.operations.some(op => typeof op !== "string" || !["view", "input"].includes(op)) ||
      new Set(value.operations).size !== value.operations.length) {
    throw new Error("operations must be a unique non-empty subset of view and input.");
  }
  return {
    targetPath,
    reason,
    operations: [...value.operations] as ActiveDesktopOperation[],
  };
}

/** Shared structural validator used by runtime execution and SAFE-owner filtering. */
export function isValidActiveApplicationAccessRequestInput(
  input: unknown,
): input is CreateActiveApplicationAccessRequestInput {
  try {
    validateApplicationInput(input);
    return true;
  } catch {
    return false;
  }
}


function validateStoredRequest(raw: unknown): raw is PendingActiveRuleRequestRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  if (!validText(value.id, 128) || !validText(value.sourceName, 120) ||
      !["file", "desktop"].includes(String(value.kind)) ||
      !["allow", "deny"].includes(String(value.effect)) ||
      !validText(value.targetPath, 2048) || typeof value.recursive !== "boolean" ||
      !Array.isArray(value.operations) || value.operations.length < 1 ||
      !validText(value.reason, 500) || typeof value.createdAt !== "number" ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
      !["pending", "approved", "denied"].includes(String(value.status))) return false;
  const allowed = value.kind === "file" ? ["read", "write", "delete"] : ["view", "input"];
  if (value.operations.length > allowed.length ||
      value.operations.some(op => typeof op !== "string" || !allowed.includes(op)) ||
      new Set(value.operations).size !== value.operations.length) return false;
  if (value.decidedAt !== undefined &&
      (typeof value.decidedAt !== "number" ||
       !Number.isSafeInteger(value.decidedAt) || value.decidedAt < 0)) return false;
  return true;
}

function readQueue(target: string): PendingActiveRuleRequestRecord[] {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("The active-rule request queue cannot be inspected; refusing to replace it.");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      metadata.size < 2 || metadata.size > MAX_STORE_BYTES) {
    throw new Error("The active-rule request queue is unsafe or exceeds its size limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    throw new Error("The active-rule request queue is unreadable or corrupt; refusing to overwrite it.");
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_ACTIVE_RULE_REQUESTS ||
      !parsed.every(validateStoredRequest) ||
      new Set(parsed.map(item => item.id)).size !== parsed.length) {
    throw new Error("The active-rule request queue failed schema validation; refusing to overwrite it.");
  }
  return parsed as PendingActiveRuleRequestRecord[];
}

function writeQueue(target: string, items: PendingActiveRuleRequestRecord[]): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const current = fs.lstatSync(target);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error("The active-rule request queue destination is unsafe.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const trimmed = items.slice(0, MAX_ACTIVE_RULE_REQUESTS);
  const bytes = Buffer.from(JSON.stringify(trimmed, null, 2), "utf8");
  if (bytes.length > MAX_STORE_BYTES) {
    throw new Error("The active-rule request queue exceeds its storage limit.");
  }
  const temporary = path.join(dir, `pending-active-rule-requests-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw new Error("Could not atomically save the active-rule request queue: " +
      (error instanceof Error ? error.message : String(error)));
  }
}

export function createActiveFileAccessRequest(
  identity: ProjectAccessIdentity | null | undefined,
  input: CreateActiveFileAccessRequestInput,
  options: ActiveFileAccessRequestStoreOptions = {},
) {
  if (!identity) throw new Error("An authenticated MCP identity is required to request file access.");
  const validated = validateInput(input);
  const { targetPath, reason, recursive } = validated;

  // Only a one-way fingerprint is shown in Tray; raw OAuth subjects and bearer
  // credentials are never placed into the active-rule request file.
  const principalKey = getProjectPrincipalKey(identity);
  const sourceName = "MCP Agent " + principalKey.slice(0, 12);
  const operations = [...validated.operations].sort();
  const target = storePath(options.configDir);
  const items = readQueue(target);
  const existing = items.find(item =>
    item.status === "pending" && item.kind === "file" && item.effect === "allow" &&
    item.recursive === recursive &&
    (process.platform === "win32"
      ? item.targetPath.toLowerCase() === targetPath.toLowerCase()
      : item.targetPath === targetPath) &&
    item.operations.length === operations.length &&
    item.operations.every((operation, index) => operation === operations[index]));

  if (existing) {
    return {
      requestId: existing.id,
      status: "pending" as const,
      kind: "file" as const,
      effect: "allow" as const,
      filePath: existing.targetPath,
      recursive: existing.recursive,
      operations: existing.operations,
      sourceName: existing.sourceName,
      duplicate: true,
      grantCreated: false as const,
      message: "An identical request is already waiting in SuperAgent Tray > Access Manager > Requests > Active Rules. No file permission has been granted yet.",
    };
  }

  const id = `rule_req_${(options.id ?? (() => crypto.randomUUID().replace(/-/g, "")))()}`;
  const request: PendingActiveRuleRequestRecord = {
    id,
    sourceName,
    kind: "file",
    effect: "allow",
    targetPath,
    recursive,
    operations,
    reason,
    createdAt: (options.now ?? Date.now)(),
    status: "pending",
  };
  items.unshift(request);
  writeQueue(target, items);

  return {
    requestId: id,
    status: "pending" as const,
    kind: "file" as const,
    effect: "allow" as const,
    filePath: targetPath,
    recursive,
    operations,
    sourceName,
    duplicate: false,
    grantCreated: false as const,
    message: "File access request added to SuperAgent Tray > Access Manager > Requests > Active Rules. The operator must review it in the native Tray dialog; this request does not grant access.",
  };
}


export function createActiveApplicationAccessRequest(
  identity: ProjectAccessIdentity | null | undefined,
  input: CreateActiveApplicationAccessRequestInput,
  options: ActiveFileAccessRequestStoreOptions = {},
) {
  if (!identity) throw new Error("An authenticated MCP identity is required to request application access.");
  const validated = validateApplicationInput(input);
  const principalKey = getProjectPrincipalKey(identity);
  const sourceName = "MCP Agent " + principalKey.slice(0, 12);
  const operations = [...validated.operations].sort();
  const target = storePath(options.configDir);
  const items = readQueue(target);
  const samePath = (a: string, b: string) => process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
  const existing = items.find(item =>
    item.status === "pending" && item.kind === "desktop" && item.effect === "allow" &&
    item.sourceName === sourceName && item.recursive === false &&
    samePath(item.targetPath, validated.targetPath) &&
    item.operations.length === operations.length &&
    item.operations.every((operation, index) => operation === operations[index]));
  if (existing) {
    return {
      requestId: existing.id,
      status: "pending" as const,
      kind: "desktop" as const,
      effect: "allow" as const,
      executablePath: existing.targetPath,
      operations: existing.operations,
      sourceName: existing.sourceName,
      duplicate: true,
      grantCreated: false as const,
      message: "An identical application request is already waiting in SuperAgent Tray > Access Manager > Requests > Active Rules. No application permission has been granted yet.",
    };
  }
  const id = `rule_req_${(options.id ?? (() => crypto.randomUUID().replace(/-/g, "")))()}`;
  const request: PendingActiveRuleRequestRecord = {
    id,
    sourceName,
    kind: "desktop",
    effect: "allow",
    targetPath: validated.targetPath,
    recursive: false,
    operations,
    reason: validated.reason,
    createdAt: (options.now ?? Date.now)(),
    status: "pending",
  };
  items.unshift(request);
  writeQueue(target, items);
  return {
    requestId: id,
    status: "pending" as const,
    kind: "desktop" as const,
    effect: "allow" as const,
    executablePath: validated.targetPath,
    operations,
    sourceName,
    duplicate: false,
    grantCreated: false as const,
    message: "Application access request added to SuperAgent Tray > Access Manager > Requests > Active Rules. Tray must verify the executable and the operator must approve it in the native dialog; this request does not grant access.",
  };
}
