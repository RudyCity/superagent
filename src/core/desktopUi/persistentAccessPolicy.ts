/**
 * Persistent host-owned access registration (schema v2).
 *
 * This is a pure, fail-closed policy parser/evaluator, NOT a grant mechanism.
 * Callers must supply an OS-verified executable path + SHA-256, a freshly
 * verified target window/element, and a canonicalized file path. No MCP or
 * WebView payload may attest those identities itself. Runtime/session leases
 * and native host authorization remain independent.
 */
import path from "node:path";

export type AccessPlatform = "win32" | "darwin" | "linux";
export type AccessEffect = "allow" | "deny";
export type DesktopOperation = "view" | "input";
export type FileOperation = "read" | "write" | "delete";

export interface ExecutableIdentity {
  platform: AccessPlatform;
  executablePath: string;
  sha256: string;
}
export interface DesktopAccessRule {
  id: string;
  kind: "desktop";
  effect: AccessEffect;
  app: ExecutableIdentity;
  operations: DesktopOperation[];
  scope: {
    windowTitle?: string;
    elementRole?: string;
    elementLabel?: string;
  };
}
export interface FileAccessRule {
  id: string;
  kind: "file";
  effect: AccessEffect;
  app: ExecutableIdentity;
  operations: FileOperation[];
  scope: { path: string; recursive: boolean };
}
export type PersistentAccessRule = DesktopAccessRule | FileAccessRule;
export interface PersistentAccessPolicy {
  version: 2;
  defaultEffect: "deny";
  rules: PersistentAccessRule[];
}
export type PersistentAccessRequest =
  | { kind: "desktop"; app: ExecutableIdentity; operation: DesktopOperation;
      windowTitle: string; elementRole?: string; elementLabel?: string }
  | { kind: "file"; app: ExecutableIdentity; operation: FileOperation; path: string };
export interface AccessDecision {
  effect: AccessEffect;
  matchedRuleId: string | null;
}
export const EMPTY_ACCESS_POLICY: PersistentAccessPolicy = Object.freeze({
  version: 2, defaultEffect: "deny", rules: [],
});

const MAX_RULES = 128;
const SHA256 = /^[a-f0-9]{64}$/i;
const RULE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DESKTOP_OPERATIONS = new Set<DesktopOperation>(["view", "input"]);
const FILE_OPERATIONS = new Set<FileOperation>(["read", "write", "delete"]);
const platformValues = new Set<AccessPlatform>(["win32", "darwin", "linux"]);
const own = (obj: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
const isObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const exactKeys = (x: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(k => own(x,k)) && Object.keys(x).every(k => required.includes(k) || optional.includes(k));
const label = (x: unknown, max = 512): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= max &&
  x.trim() === x && !/[\u0000-\u001f\u007f]/.test(x);

function nativePath(platform: AccessPlatform, value: unknown): value is string {
  if (!label(value, 2048)) return false;
  const p = platform === "win32" ? path.win32 : path.posix;
  // Disallow UNC/network shares, device paths and uncanonical lexical variants.
  if (platform === "win32") {
    if (!/^[a-zA-Z]:\\[^\\]/.test(value) && !/^[a-zA-Z]:\\[^\\]+\b/.test(value)) return false;
    if (value.includes("/")) return false;
  } else if (!value.startsWith("/") || value.includes("\\")) return false;
  if (value.includes("\0") || p.normalize(value) !== value) return false;
  return true;
}
function validIdentity(x: unknown): x is ExecutableIdentity {
  return isObject(x) && exactKeys(x, ["platform","executablePath","sha256"]) &&
    platformValues.has(x.platform as AccessPlatform) &&
    nativePath(x.platform as AccessPlatform, x.executablePath) &&
    typeof x.sha256 === "string" && SHA256.test(x.sha256);
}
function validOps(x: unknown, kind: "desktop" | "file"): boolean {
  const allowed: Set<string> = kind === "desktop" ? DESKTOP_OPERATIONS : FILE_OPERATIONS;
  return Array.isArray(x) && x.length >= 1 && x.length <= allowed.size &&
    x.every(item => typeof item === "string" && allowed.has(item)) &&
    new Set(x).size === x.length;
}
function validScope(x: unknown, kind: "desktop" | "file", app: ExecutableIdentity): boolean {
  if (!isObject(x)) return false;
  if (kind === "file") {
    return exactKeys(x, ["path","recursive"]) && typeof x.recursive === "boolean" &&
      nativePath(app.platform, x.path);
  }
  if (!exactKeys(x, [], ["windowTitle","elementRole","elementLabel"])) return false;
  if (own(x,"windowTitle") && !label(x.windowTitle)) return false;
  if (own(x,"elementRole") && !label(x.elementRole, 128)) return false;
  if (own(x,"elementLabel") && !label(x.elementLabel)) return false;
  // Exact label without role is ambiguous in accessibility trees.
  if (own(x,"elementLabel") && !own(x,"elementRole")) return false;
  return true;
}
function validRule(x: unknown): x is PersistentAccessRule {
  if (!isObject(x) || !exactKeys(x, ["id","kind","effect","app","operations","scope"]) ||
    typeof x.id !== "string" || !RULE_ID.test(x.id) ||
    (x.kind !== "desktop" && x.kind !== "file") ||
    (x.effect !== "allow" && x.effect !== "deny") ||
    !validIdentity(x.app) || !validOps(x.operations, x.kind)) return false;
  return validScope(x.scope, x.kind, x.app);
}

/** Strict parser: rejects corruption, duplicates, extra fields and broad wildcard identities. */
export function parsePersistentAccessPolicy(value: unknown): PersistentAccessPolicy | null {
  if (!isObject(value) || !exactKeys(value, ["version","defaultEffect","rules"]) ||
    value.version !== 2 || value.defaultEffect !== "deny" ||
    !Array.isArray(value.rules) || value.rules.length > MAX_RULES ||
    value.rules.some(rule => !validRule(rule))) return null;
  const rules = value.rules as PersistentAccessRule[];
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) return null;
  return { version: 2, defaultEffect: "deny", rules };
}
function samePath(platform: AccessPlatform, a: string, b: string): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function matchesApp(expected: ExecutableIdentity, observed: ExecutableIdentity): boolean {
  return expected.platform === observed.platform && validIdentity(observed) &&
    samePath(expected.platform, expected.executablePath, observed.executablePath) &&
    expected.sha256.toLowerCase() === observed.sha256.toLowerCase();
}
function matchRule(rule: PersistentAccessRule, request: PersistentAccessRequest): boolean {
  if (rule.kind !== request.kind || !matchesApp(rule.app, request.app)) return false;
  if (!((rule.operations as string[]).includes(request.operation))) return false;
  if (rule.kind === "desktop" && request.kind === "desktop") {
    const s = rule.scope;
    return (!s.windowTitle || s.windowTitle === request.windowTitle) &&
      (!s.elementRole || s.elementRole === request.elementRole) &&
      (!s.elementLabel || s.elementLabel === request.elementLabel);
  }
  if (rule.kind === "file" && request.kind === "file") {
    if (!nativePath(request.app.platform, request.path)) return false;
    const scope = rule.scope.path;
    if (samePath(request.app.platform, scope, request.path)) return true;
    if (!rule.scope.recursive) return false;
    const sep = request.app.platform === "win32" ? "\\" : "/";
    const prefix = scope.endsWith(sep) ? scope : scope + sep;
    const target = request.app.platform === "win32" ? request.path.toLowerCase() : request.path;
    return target.startsWith(request.app.platform === "win32" ? prefix.toLowerCase() : prefix);
  }
  return false;
}
/** Deny always beats allow, independent of registration order; no expiry field. */
export function evaluatePersistentAccess(
  rawPolicy: unknown, request: PersistentAccessRequest,
): AccessDecision {
  const deny: AccessDecision = { effect: "deny", matchedRuleId: null };
  const policy = parsePersistentAccessPolicy(rawPolicy);
  if (!policy || !validIdentity(request?.app) ||
    (request.kind === "desktop" && (!label(request.windowTitle) ||
      !DESKTOP_OPERATIONS.has(request.operation))) ||
    (request.kind === "file" && (!nativePath(request.app.platform, request.path) ||
      !FILE_OPERATIONS.has(request.operation))) ||
    (request.kind !== "desktop" && request.kind !== "file")) return deny;
  const matches = policy.rules.filter(rule => matchRule(rule,request));
  const explicitDeny = matches.find(rule => rule.effect === "deny");
  if (explicitDeny) return { effect: "deny", matchedRuleId: explicitDeny.id };
  const allowed = matches.find(rule => rule.effect === "allow");
  return allowed ? { effect: "allow", matchedRuleId: allowed.id } : deny;
}

/**
 * Session admission for input where an allow rule may target a specific
 * accessibility element. Does not grant input. Every actual dispatched
 * action still needs the exact element-level evaluatePersistentAccess check.
 */
export function hasRegisteredDesktopInputCandidate(
  raw: unknown, app: ExecutableIdentity, windowTitle: string,
): boolean {
  const policy = parsePersistentAccessPolicy(raw);
  if (!policy || !validIdentity(app) || !label(windowTitle)) return false;
  // A broad deny for this executable/window blocks all element-scoped allows.
  const blocked = policy.rules.some(rule =>
    rule.kind === "desktop" && rule.effect === "deny" &&
    rule.operations.includes("input") && matchesApp(rule.app,app) &&
    (!rule.scope.windowTitle || rule.scope.windowTitle === windowTitle) &&
    !rule.scope.elementRole && !rule.scope.elementLabel);
  if (blocked) return false;
  return policy.rules.some(rule =>
    rule.kind === "desktop" && rule.effect === "allow" &&
    rule.operations.includes("input") && matchesApp(rule.app,app) &&
    (!rule.scope.windowTitle || rule.scope.windowTitle === windowTitle));
}
