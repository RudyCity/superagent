import { createHash, randomUUID } from "node:crypto";

/** Diagnostic data must never contain page content, URLs, tokens, or input text. */
export type DelegateActionCategory =
  | "INPUT_INVALID" | "PERMISSION_DENIED" | "DISCONNECTED" | "TARGET_MISSING"
  | "LEASE_CONFLICT" | "LEASE_EXPIRED" | "TIMEOUT" | "EXECUTION_FAILED";
export type DelegateActionOutcome = "verified" | "executed" | "failed" | "unknown";
export type DelegateRetryPolicy = "safe_read_only" | "manual_reconcile" | "never";

export interface DelegateActionDiagnostic {
  operationId: string;
  at: number;
  transport: "delegate";
  command: string;
  clientFingerprint?: string;
  tabId?: number;
  elapsedMs: number;
  outcome: DelegateActionOutcome;
  retryPolicy: DelegateRetryPolicy;
  category?: DelegateActionCategory;
}

const MAX_ENTRIES = 128;
const entries: DelegateActionDiagnostic[] = [];
const READ_ONLY = new Set([
  "transport_status", "list_targets", "list_sessions", "coordinator_status",
  "snapshot", "shared_snapshot", "read_page", "extract_links", "get_cursor",
  "wait_for", "session_participants",
]);

function errorCode(value: unknown): string {
  const raw = value && typeof value === "object" && "code" in value
    ? (value as { code?: unknown }).code : undefined;
  return typeof raw === "string" && /^[A-Z][A-Z0-9_]{2,80}$/.test(raw) ? raw : "";
}

export function classifyDelegateActionError(value: unknown): DelegateActionCategory {
  const code = errorCode(value);
  if (/INVALID|AMBIGUOUS|TOKEN_CONFLICT|TARGET_REQUIRED|COMMAND_UNSUPPORTED/.test(code)) return "INPUT_INVALID";
  if (/DENIED|PERMISSION|FORBIDDEN|OWNER_REQUIRED|ROLE_INVALID|UNAUTHORIZED|NOT_ALLOWED/.test(code)) return "PERMISSION_DENIED";
  if (/EXPIRED|STALE_SESSION/.test(code)) return "LEASE_EXPIRED";
  if (/LEASE|STALE_REVISION|RESERVED|ALREADY_CLAIMED|CONFLICT/.test(code)) return "LEASE_CONFLICT";
  if (/NOT_CONNECTED|DISCONNECTED|BRIDGE_CLOSED|CONNECTION_CLOSED/.test(code)) return "DISCONNECTED";
  if (/NOT_FOUND|TARGET_MISSING|TARGET_CLOSED|TAB_NOT_FOUND/.test(code)) return "TARGET_MISSING";
  if (/TIMEOUT|TIMED_OUT/.test(code)) return "TIMEOUT";
  return "EXECUTION_FAILED";
}

export function retryPolicyForDelegateAction(
  command: string, outcome: DelegateActionOutcome,
): DelegateRetryPolicy {
  if (READ_ONLY.has(command)) return "safe_read_only";
  return outcome === "unknown" || outcome === "executed" ? "manual_reconcile" : "never";
}

function resultFailed(result: unknown): boolean {
  if (typeof result !== "string") return false;
  if (result.startsWith("control_chrome_cdp failed:")) return true;
  if (result.startsWith("control_chrome_cdp: Delegate wait_for timed out.")) return true;
  if (/^control_chrome_cdp: Delegate (click|type): \{"ok":false/.test(result)) return true;
  return false;
}

function resultCategory(result: unknown): DelegateActionCategory {
  if (typeof result !== "string") return "EXECUTION_FAILED";
  const match = /^control_chrome_cdp failed:\s*([A-Z][A-Z0-9_]{2,80}):/.exec(result);
  return classifyDelegateActionError(match ? { code: match[1] } : undefined);
}

export function delegateActionOutcome(
  command: string, result?: unknown, error?: unknown,
): Pick<DelegateActionDiagnostic, "outcome" | "retryPolicy" | "category"> {
  if (error !== undefined) {
    const category = classifyDelegateActionError(error);
    // A network failure during a mutation could have happened after dispatch.
    const outcome: DelegateActionOutcome = READ_ONLY.has(command) ||
      (category !== "TIMEOUT" && category !== "DISCONNECTED" && category !== "EXECUTION_FAILED")
      ? "failed" : "unknown";
    return { outcome, category, retryPolicy: retryPolicyForDelegateAction(command, outcome) };
  }
  if (resultFailed(result)) {
    const category = resultCategory(result);
    return { outcome: "failed", category, retryPolicy: retryPolicyForDelegateAction(command, "failed") };
  }
  const outcome: DelegateActionOutcome = READ_ONLY.has(command) ? "verified" : "executed";
  return { outcome, retryPolicy: retryPolicyForDelegateAction(command, outcome) };
}

export function recordDelegateAction(input: {
  command: string;
  clientId?: string;
  tabId?: number;
  startedAt: number;
  result?: unknown;
  error?: unknown;
}): DelegateActionDiagnostic {
  const assessment = delegateActionOutcome(input.command, input.result, input.error);
  const entry: DelegateActionDiagnostic = {
    operationId: randomUUID(),
    at: Date.now(),
    transport: "delegate",
    command: /^[a-z][a-z0-9_]{0,60}$/.test(input.command) ? input.command : "unknown",
    ...(input.clientId ? {
      clientFingerprint: createHash("sha256").update(input.clientId).digest("hex").slice(0, 12),
    } : {}),
    ...(Number.isSafeInteger(input.tabId) && (input.tabId as number) > 0 ? { tabId: input.tabId } : {}),
    elapsedMs: Math.max(0, Date.now() - input.startedAt),
    ...assessment,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  if (process.env.SUPERAGENT_CDP_ACTION_TRACE === "1") {
    console.info("[delegate-cdp-action]", JSON.stringify(entry));
  }
  return { ...entry };
}

/** Read-only, bounded trace; callers must keep the same authorization boundary as the browser session. */
export function readDelegateActionDiagnostics(limit = 20): DelegateActionDiagnostic[] {
  const count = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_ENTRIES, Math.trunc(limit))) : 0;
  if (count === 0) return [];
  return entries.slice(-count).map(entry => ({ ...entry }));
}
