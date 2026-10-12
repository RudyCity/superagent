import type { CdpTarget } from "./chromeCdpHelpers.js";

export const CDP_DIAGNOSTIC_COMMANDS = ["start_debug_capture", "read_debug_capture", "stop_debug_capture", "clear_debug_capture"] as const;
export type CdpDiagnosticCommand = (typeof CDP_DIAGNOSTIC_COMMANDS)[number];

type DebugEvent = { at: string; kind: string; details: Record<string, unknown> };
type CaptureState = { active: boolean; events: DebugEvent[]; requests: Map<string, { url: string; startedAt: number; method: string; type?: string }> };
const captures = new Map<string, CaptureState>();
const MAX_EVENTS = 300;

function stateFor(targetId: string): CaptureState {
  let state = captures.get(targetId);
  if (!state) {
    state = { active: false, events: [], requests: new Map() };
    captures.set(targetId, state);
  }
  return state;
}

function safeUrl(input: unknown): string {
  try {
    const url = new URL(String(input));
    return url.origin + url.pathname;
  } catch {
    return String(input || "").split(/[?#]/, 1)[0].slice(0, 300);
  }
}

function redact(input: unknown): string {
  return String(input ?? "")
    .replace(/(authorization|cookie|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 1200);
}

export function recordCdpDebugEvent(targetId: string, method: string, params: any): void {
  const state = stateFor(targetId);
  if (!state.active) return;
  const now = Date.now();
  let event: DebugEvent | undefined;

  if (method === "Runtime.consoleAPICalled") {
    const values = Array.isArray(params?.args) ? params.args.map((arg: any) => redact(arg?.value ?? arg?.description ?? arg?.type)).slice(0, 12) : [];
    event = { at: new Date(now).toISOString(), kind: "console", details: { level: params?.type || "log", values, executionContextId: params?.executionContextId } };
  } else if (method === "Runtime.exceptionThrown") {
    const ex = params?.exceptionDetails;
    event = { at: new Date(now).toISOString(), kind: "exception", details: { text: redact(ex?.text), description: redact(ex?.exception?.description), url: safeUrl(ex?.url), lineNumber: ex?.lineNumber, columnNumber: ex?.columnNumber } };
  } else if (method === "Log.entryAdded") {
    const entry = params?.entry || {};
    event = { at: new Date(now).toISOString(), kind: "log", details: { level: entry.level, source: entry.source, text: redact(entry.text), url: safeUrl(entry.url), lineNumber: entry.lineNumber } };
  } else if (method === "Network.requestWillBeSent") {
    const request = params?.request || {};
    const requestId = String(params?.requestId || "");
    state.requests.set(requestId, { url: safeUrl(request.url), startedAt: now, method: String(request.method || "GET"), type: params?.type });
    event = { at: new Date(now).toISOString(), kind: "request", details: { requestId, method: request.method || "GET", url: safeUrl(request.url), type: params?.type } };
  } else if (method === "Network.responseReceived") {
    const response = params?.response || {};
    event = { at: new Date(now).toISOString(), kind: "response", details: { requestId: params?.requestId, url: safeUrl(response.url), status: response.status, mimeType: response.mimeType, fromDiskCache: response.fromDiskCache, type: params?.type } };
  } else if (method === "Network.loadingFailed") {
    event = { at: new Date(now).toISOString(), kind: "request_failed", details: { requestId: params?.requestId, errorText: redact(params?.errorText), canceled: params?.canceled, blockedReason: params?.blockedReason } };
  } else if (method === "Network.loadingFinished") {
    const requestId = String(params?.requestId || "");
    const request = state.requests.get(requestId);
    event = { at: new Date(now).toISOString(), kind: "request_finished", details: { requestId, url: request?.url, method: request?.method, durationMs: request ? now - request.startedAt : undefined, encodedDataLength: params?.encodedDataLength } };
    state.requests.delete(requestId);
  }

  if (event) {
    state.events.push(event);
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  }
}

export async function executeCdpDiagnosticsCommand(
  cdpSend: (target: CdpTarget, method: string, params?: Record<string, unknown>) => Promise<any>,
  target: CdpTarget,
  command: CdpDiagnosticCommand,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const state = stateFor(target.id);
  if (command === "start_debug_capture") {
    state.events = [];
    state.requests.clear();
    state.active = true;
    await Promise.all(["Runtime.enable", "Log.enable", "Network.enable"].map(method => cdpSend(target, method, {})));
    return `control_chrome_cdp: debug capture started for ${safeUrl(target.url)}; recording console messages, uncaught exceptions, and network request/response metadata (without bodies or query strings).`;
  }
  if (command === "clear_debug_capture") {
    state.events = [];
    state.requests.clear();
    return `control_chrome_cdp: cleared debug capture buffer for target ${target.id}.`;
  }
  if (command === "stop_debug_capture") {
    state.active = false;
    return `control_chrome_cdp: debug capture stopped; ${state.events.length} event(s) retained for read_debug_capture.`;
  }
  const limitRaw = Number(payload.limit ?? 100);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(MAX_EVENTS, Math.floor(limitRaw))) : 100;
  const events = state.events.slice(-limit);
  return `control_chrome_cdp: debug capture for ${safeUrl(target.url)} — ${events.length} of ${state.events.length} retained event(s), capture ${state.active ? "active" : "stopped"}.\n${JSON.stringify(events, null, 2)}`;
}

export const _cdpDiagnosticsTestHooks = {
  clear(): void { captures.clear(); },
  stateFor,
};
