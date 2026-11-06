import { delegateBridge } from "./bridge.js";
import { delegateMultiTabOrchestrator } from "./multiTabOrchestrator.js";
import { executeFileUploadCommand, validateUploadPaths, type FileUploadCommand } from "../tools/chromeCdpFileUpload.js";
import { noteDelegateAttachment, forgetDelegateAttachment, touchDelegateAttachment, listDelegateAttachments } from "./cdpAttachmentRegistry.js";
import { assertDelegateCdpMethodAllowed, assertDelegateUrlAllowed } from "../browserTransport/delegateCdpPolicy.js";
import { delegateTargetId, parseBrowserTargetId } from "../browserTransport/targetIdentity.js";
import {
  assertDelegateMcpActorForCommand, visibleDelegateSessions, isDelegateMcpBoundary,
} from "../browserTransport/delegatePrincipalPolicy.js";
import {
  authorizeDelegateTarget, assertDelegateLeaseReady, enterDelegateProtectedCdpRpc,
  claimDelegateTarget, recoverDelegateTarget, hasDelegateClaim,
  listDelegateSessions, noteDelegateWriteSuccess, releaseDelegateTarget, withDelegateTargetLock,
  setDelegateSharing, inviteDelegateAgent, joinDelegateTarget,
  leaveDelegateTarget, revokeDelegateAgent, handoverDelegateTarget, getDelegateParticipation, heartbeatDelegateSession,
} from "../browserTransport/sessionCoordinator.js";
import { BrowserTransportError, type BrowserTargetRef, type BrowserTransport } from "../browserTransport/types.js";
import { DELEGATE_V18_COMMANDS, unsupportedBrowserCommand } from "../browserTransport/commandCapabilities.js";
import { getDelegateLeaseRuntimeStatus } from "../browserTransport/delegateLeaseRuntime.js";

type RpcMethod =
  | "delegate.cdp.list_targets" | "delegate.cdp.attach" | "delegate.cdp.detach"
  | "delegate.cdp.command" | "delegate.cdp.health" | "delegate.cdp.attachments" | "delegate.cdp.events"
  | "delegate.cdp.tab_action";

type DelegateTarget = {
  transport: "delegate";
  clientId: string;
  tabId: number;
  targetId: string;
  title?: string;
  url?: string;
  active?: boolean;
  attached?: boolean;
};

const WRITE_COMMANDS = new Set([
  "new_tab", "close_tab", "activate", "navigate", "evaluate", "click", "type", "handle_dialog",
  "move_cursor", "drag_and_drop", "emulate_device",
  "upload_file", "handle_file_chooser",
]);
const delegateCursorPositions = new Map<string, { x: number; y: number }>();

function parseJson<T = any>(raw: string): T {
  try { return JSON.parse(raw) as T; }
  catch { throw new BrowserTransportError("DELEGATE_CDP_INVALID_RESPONSE", "Delegate-CDP returned malformed JSON."); }
}

function semverAtLeast180(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version || "");
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 1 || (major === 1 && minor >= 8);
}

export class DelegateCdpHostTransport implements BrowserTransport {
  readonly kind = "delegate" as const;

  private assertClientCapability(clientId?: string): void {
    const clients = delegateBridge.listConnections();
    const selected = clientId ? clients.find(client => client.clientId === clientId)
      : clients.length === 1 ? clients[0] : undefined;
    if (clientId && clients.length && !selected) {
      throw new BrowserTransportError("DELEGATE_TARGET_NOT_CONNECTED", `Delegate client ${clientId} is not connected.`);
    }
    if (selected && !selected.capabilities.includes("delegate-cdp-v1")) {
      throw new BrowserTransportError(
        "DELEGATE_CDP_EXTENSION_TOO_OLD",
        `Delegate extension ${selected.extensionVersion || "unknown"} does not advertise delegate-cdp-v1. Upgrade/reload Delegate 1.8.x.`,
      );
    }
    if (selected && !semverAtLeast180(selected.extensionVersion)) {
      throw new BrowserTransportError(
        "DELEGATE_CDP_EXTENSION_TOO_OLD",
        `Delegate extension ${selected.extensionVersion || "unknown"} is too old. Upgrade/reload Delegate 1.8.x.`,
      );
    }
  }

  async rpc<T = any>(method: RpcMethod, params: Record<string, unknown> = {}, signal?: AbortSignal, clientId?: string): Promise<T> {
    const isProtected = method === "delegate.cdp.attach" || method === "delegate.cdp.detach" ||
      method === "delegate.cdp.command" || method === "delegate.cdp.tab_action";
    // In durable mode a low-level caller must already be inside the global
    // operation fence, with its RPC counted until resolution.
    const finishRpc = isProtected ? enterDelegateProtectedCdpRpc() : undefined;
    try {
      this.assertClientCapability(clientId);
      try {
        const raw = await delegateBridge.request(method, params, signal, 20_000, clientId);
        return parseJson<T>(raw);
      } catch (error: any) {
        const message = String(error?.message || error);
        if (/DELEGATE_TIMEOUT/.test(message)) {
          const selected = delegateBridge.listConnections().find(client => !clientId || client.clientId === clientId);
          if (selected && !selected.capabilities.includes("delegate-cdp-v1")) {
            throw new BrowserTransportError("DELEGATE_CDP_EXTENSION_TOO_OLD", "Connected Delegate does not support CDP. Upgrade/reload Delegate 1.8.x.");
          }
        }
        throw error;
      }
    } finally {
      finishRpc?.();
    }
  }

  async listTargets(connectionId?: string, signal?: AbortSignal): Promise<BrowserTargetRef[]> {
    const rows = await this.rpc<DelegateTarget[]>("delegate.cdp.list_targets", {}, signal, connectionId);
    return rows.map(row => ({
      kind: "delegate", connectionId: row.clientId, targetId: `tab:${row.tabId}`,
      tabId: row.tabId, title: row.title, url: row.url,
    }));
  }

  async attach(target: BrowserTargetRef, signal?: AbortSignal): Promise<void> {
    if (target.kind !== "delegate" || !target.tabId) throw new BrowserTransportError("BROWSER_TARGET_INVALID", "Delegate target required.");
    await this.rpc("delegate.cdp.attach", { tabId: target.tabId }, signal, target.connectionId);
    noteDelegateAttachment(target.connectionId, target.tabId);
  }

  async detach(target: BrowserTargetRef, signal?: AbortSignal): Promise<void> {
    if (target.kind !== "delegate" || !target.tabId) throw new BrowserTransportError("BROWSER_TARGET_INVALID", "Delegate target required.");
    await this.rpc("delegate.cdp.detach", { tabId: target.tabId }, signal, target.connectionId);
    forgetDelegateAttachment(target.connectionId, target.tabId);
  }

  async command(
    target: BrowserTargetRef, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal,
    policy: { trustedGenerated?: boolean; dangerousApproved?: boolean } = {},
  ): Promise<unknown> {
    if (target.kind !== "delegate" || !target.tabId) throw new BrowserTransportError("BROWSER_TARGET_INVALID", "Delegate target required.");
    assertDelegateCdpMethodAllowed(method, policy);
    if (method === "Page.navigate") assertDelegateUrlAllowed(String(params.url || ""));
    touchDelegateAttachment(target.connectionId, target.tabId);
    return this.rpc("delegate.cdp.command", { tabId: target.tabId, method, params, meta: policy }, signal, target.connectionId);
  }

  async capabilities() {
    return { commands: DELEGATE_V18_COMMANDS, rawCdp: false, cookies: false, privilegedUrls: false };
  }

  async health(connectionId?: string, signal?: AbortSignal) {
    const detail = await this.rpc<any>("delegate.cdp.health", {}, signal, connectionId);
    return { ok: detail?.enabled === true, kind: "delegate" as const, connectionId: connectionId || detail?.clientId || "", detail: JSON.stringify(detail) };
  }

  async events(target: BrowserTargetRef, clear = false, signal?: AbortSignal) {
    if (target.kind !== "delegate" || !target.tabId) throw new BrowserTransportError("BROWSER_TARGET_INVALID", "Delegate target required.");
    return this.rpc<any[]>("delegate.cdp.events", { tabId: target.tabId, clear }, signal, target.connectionId);
  }

  async tabAction(clientId: string | undefined, action: "new_tab" | "close_tab" | "activate", params: Record<string, unknown>, signal?: AbortSignal) {
    return this.rpc<any>("delegate.cdp.tab_action", { action, ...params }, signal, clientId);
  }
}

export const delegateCdpTransport = new DelegateCdpHostTransport();

async function resolveTarget(
  args: Record<string, unknown>, payload: Record<string, unknown>, signal?: AbortSignal,
): Promise<BrowserTargetRef> {
  // A qualified ID is one atomic (profile, tab) selector: never splice in
  // conflicting independent hints or silently fall back to a different tab.
  if (args.targetId !== undefined && payload.targetId !== undefined && args.targetId !== payload.targetId)
    throw new BrowserTransportError("DELEGATE_CDP_TARGET_CONFLICT", "Conflicting targetId values.");
  const rawTarget = args.targetId ?? payload.targetId ?? "";
  if (rawTarget && typeof rawTarget !== "string")
    throw new BrowserTransportError("DELEGATE_CDP_TARGET_INVALID", "targetId must be a qualified string.");
  const parsed = rawTarget ? parseBrowserTargetId(rawTarget as string) : null;
  if (rawTarget && !parsed)
    throw new BrowserTransportError("DELEGATE_CDP_TARGET_INVALID", "Invalid qualified Delegate targetId.");
  const clients = [args.delegateClientId, payload.delegateClientId, args.connectionId, payload.connectionId]
    .filter((v): v is string => v !== undefined) ;
  const tabs = [args.delegateTabId, payload.delegateTabId].filter(v => v !== undefined);
  if (clients.some(v => typeof v !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(v)) ||
      new Set(clients).size > 1 || (parsed && clients.some(v => v !== parsed.connectionId)))
    throw new BrowserTransportError("DELEGATE_CDP_PROFILE_CONFLICT", "Delegate profile selector mismatch.");
  if (tabs.some(v => typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) ||
      new Set(tabs).size > 1 || (parsed && tabs.some(v => v !== parsed.tabId)))
    throw new BrowserTransportError("DELEGATE_CDP_TAB_CONFLICT", "Delegate tab selector mismatch.");
  let clientId = clients[0] ?? parsed?.connectionId ?? "";
  let tabId = (tabs[0] as number | undefined) ?? parsed?.tabId ?? 0;
  if (parsed && parsed.kind !== "delegate") {
    throw new BrowserTransportError("BROWSER_TARGET_TRANSPORT_MISMATCH", "Managed target ID cannot be used with Delegate transport.");
  }
  if (!clientId) {
    const clients = delegateBridge.listConnections();
    if (clients.length > 1) throw new BrowserTransportError("DELEGATE_MULTIPLE_CLIENTS", "Multiple Delegate Chrome profiles are connected; specify delegateClientId.");
    if (clients.length === 1) clientId = clients[0].clientId;
  }
  if (!tabId) {
    const targets = await delegateCdpTransport.listTargets(clientId || undefined, signal);
    if (targets.length !== 1) {
      throw new BrowserTransportError(
        "DELEGATE_CDP_TARGET_AMBIGUOUS",
        targets.length ? "Multiple Delegate tabs are available; specify delegateTabId or a qualified targetId." : "No controllable Delegate tab is available.",
      );
    }
    return targets[0];
  }
  if (!clientId) throw new BrowserTransportError("DELEGATE_CDP_CLIENT_REQUIRED", "delegateClientId is required when no unique connected profile exists.");
  return { kind: "delegate", connectionId: clientId, targetId: `tab:${tabId}`, tabId };
}

async function withAttached<T>(
  target: BrowserTargetRef, signal: AbortSignal | undefined, fn: () => Promise<T>,
  authorize?: () => void, onComplete?: (value: T) => void,
): Promise<T> {
  return withDelegateTargetLock(target.connectionId, target.tabId!, async () => {
    // Authorization and expectedRevision must be evaluated AFTER entering the
    // FIFO lock, not before waiting: otherwise two stale writers may both pass.
    authorize?.();
    await delegateCdpTransport.attach(target, signal);
    try {
      const value = await fn();
      onComplete?.(value);
      return value;
    } finally {
      try { await delegateCdpTransport.detach(target, signal); } catch {}
    }
  });
}

function valueFromEvaluate(result: any): any {
  if (result?.exceptionDetails) {
    throw new BrowserTransportError("DELEGATE_CDP_EVALUATE_ERROR", String(result.exceptionDetails?.text || "Runtime.evaluate failed."));
  }
  return result?.result?.value ?? result?.result?.description ?? null;
}

function generatedReadEval(target: BrowserTargetRef, expression: string, signal?: AbortSignal) {
  return delegateCdpTransport.command(target, "Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  }, signal, { trustedGenerated: true });
}

function generatedWriteEval(target: BrowserTargetRef, expression: string, signal?: AbortSignal) {
  return delegateCdpTransport.command(target, "Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  }, signal, { dangerousApproved: true });
}

export async function executeDelegateChromeCommand(
  command: string,
  args: Record<string, unknown>,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const aliases: Record<string, string> = {
    move_mouse: "move_cursor",
    drag: "drag_and_drop",
    drag_drop: "drag_and_drop",
    set_device: "emulate_device",
    set_viewport: "emulate_device",
    emulate_viewport: "emulate_device",
  };
  command = aliases[command] || command;
  const unsupported = unsupportedBrowserCommand("delegate", command);
  if (unsupported) return "control_chrome_cdp failed: " + unsupported;
  const clientHint = String(args.delegateClientId ?? payload.delegateClientId ?? args.connectionId ?? payload.connectionId ?? "") || undefined;
  if (args.sessionToken !== undefined && payload.sessionToken !== undefined && args.sessionToken !== payload.sessionToken)
    throw new BrowserTransportError("DELEGATE_CDP_TOKEN_CONFLICT", "Conflicting session capability values.");
  // MCP requests without a trusted per-connection principal may inspect only
  // anonymous inventory, never claim/operate a protected browser session.
  const principalAgent = assertDelegateMcpActorForCommand(command, args.agentId, payload.agentId);
  const sessionsForCaller = () => visibleDelegateSessions(listDelegateSessions());

  if (command === "transport_status") {
    const health = await delegateCdpTransport.health(clientHint, signal);
    return JSON.stringify({ transport: "delegate", health,
      durableLeaseRuntime: getDelegateLeaseRuntimeStatus(),
      connections: isDelegateMcpBoundary() ? [] : delegateBridge.listConnections(),
      attachments: isDelegateMcpBoundary() ? [] : listDelegateAttachments() });
  }
  if (command === "list_targets") {
    if (getDelegateLeaseRuntimeStatus().status === "BLOCKED")
      return JSON.stringify({ status: "BLOCKED", durableLeaseRuntime: getDelegateLeaseRuntimeStatus(), targets: [] });
    const allTargets = await delegateCdpTransport.listTargets(clientHint, signal);
    const sessions = listDelegateSessions();
    const visible = sessionsForCaller();
    const targets = !isDelegateMcpBoundary() ? allTargets : allTargets.filter(t => {
      const claimed = sessions.find(s => s.clientId === t.connectionId && s.tabId === t.tabId);
      return !claimed || visible.includes(claimed);
    });
    if (!targets.length) return "control_chrome_cdp: Delegate connected, but no controllable normal web tabs are open.";
    return targets.map(t => `- id: ${delegateTargetId(t.connectionId, t.tabId!)}\n  title: ${t.title || ""}\n  url: ${t.url || ""}\n  transport: delegate`).join("\n");
  }
  if (command === "list_sessions" || command === "coordinator_status") {
    const durableLeaseRuntime = getDelegateLeaseRuntimeStatus();
    const visible = durableLeaseRuntime.status === "BLOCKED" ? [] : sessionsForCaller();
    return JSON.stringify({ transport: "delegate", durableLeaseRuntime, sessions: visible,
      ...(command === "coordinator_status" ? {
        attachments: durableLeaseRuntime.status === "BLOCKED" || isDelegateMcpBoundary()
          ? [] : listDelegateAttachments(),
      } : {}) });
  }
  if (command === "new_tab") {
    const url = String(payload.url || args.url || "https://example.com/");
    assertDelegateUrlAllowed(url);
    assertDelegateLeaseReady();
    return withDelegateTargetLock("__global_new_tab__", 0, async () => {
      const result = await delegateCdpTransport.tabAction(clientHint, "new_tab", { url, active: true }, signal);
      return JSON.stringify({ status: "opened", transport: "delegate", ...result });
    });
  }

  if (command === "recover_session") {
    const qualified = args.targetId ?? payload.targetId;
    const profile = args.delegateClientId ?? payload.delegateClientId ?? args.connectionId ?? payload.connectionId;
    const tab = args.delegateTabId ?? payload.delegateTabId;
    const explicitQualified = typeof qualified === "string" &&
      parseBrowserTargetId(qualified)?.kind === "delegate";
    const explicitPair = typeof profile === "string" && typeof tab === "number" &&
      Number.isSafeInteger(tab) && tab > 0;
    if (!explicitQualified && !explicitPair)
      throw new BrowserTransportError("DELEGATE_LEASE_TARGET_REQUIRED",
        "Recovery requires an explicit exact Delegate profile and tab (or qualified targetId).");
  }
  const target = await resolveTarget(args, payload, signal);
  const agentId = principalAgent;
  const sessionToken = args.sessionToken !== undefined ? String(args.sessionToken) : payload.sessionToken !== undefined ? String(payload.sessionToken) : undefined;
  if ((command === "claim_target" || command === "recover_session" || WRITE_COMMANDS.has(command) ||
       ["share_target", "stop_sharing", "invite_agent", "join_target", "leave_target",
        "revoke_agent", "handover_target"].includes(command)) &&
      delegateMultiTabOrchestrator.isReserved(target.connectionId, target.tabId!)) {
    throw new BrowserTransportError("MULTITAB_TARGET_RESERVED",
      "The tab is owned by the multi-tab orchestrator. Release its claim before a competing CDP mutation.");
  }

  if (command === "recover_session") {
    if (!agentId || !sessionToken)
      throw new BrowserTransportError("DELEGATE_LEASE_RECOVERY_DENIED", "Original owner identity and capability are required.");
    return withDelegateTargetLock(target.connectionId, target.tabId!, async () => {
      // No debugger attach or browser mutation before exact profile/tab, owner,
      // original token and old Core retirement have been verified on disk.
      const session = recoverDelegateTarget(target.connectionId, target.tabId!, agentId, sessionToken);
      return JSON.stringify({ status: "recovered", ...session });
    }, true);
  }
  if (command === "claim_target") {
    if (!agentId) return "control_chrome_cdp failed: Delegate claim requires agentId.";
    return withDelegateTargetLock(target.connectionId, target.tabId!, async () => {
      await delegateCdpTransport.attach(target, signal);
      await delegateCdpTransport.detach(target, signal);
      const session = claimDelegateTarget(target.connectionId, target.tabId!, agentId, sessionToken);
      return JSON.stringify({ status: "claimed", ...session });
    });
  }
  if (["heartbeat_session", "share_target", "stop_sharing", "invite_agent",
       "join_target", "leave_target", "revoke_agent", "handover_target", "session_participants"].includes(command)) {
    if (!agentId) throw new BrowserTransportError("DELEGATE_CDP_AGENT_REQUIRED", "A named agentId is required.");
    return withDelegateTargetLock(target.connectionId, target.tabId!, async () => {
      const client = target.connectionId, tab = target.tabId!;
      const member = String(args.memberId ?? payload.memberId ?? "");
      switch (command) {
        case "heartbeat_session": return JSON.stringify({ session: heartbeatDelegateSession(client, tab, agentId, sessionToken) });
        case "share_target": return JSON.stringify({ status: "shared", session: setDelegateSharing(client, tab, agentId, sessionToken, true) });
        case "stop_sharing": return JSON.stringify({ status: "isolated", session: setDelegateSharing(client, tab, agentId, sessionToken, false) });
        case "invite_agent": return JSON.stringify(inviteDelegateAgent(client, tab, agentId, sessionToken,
          member, String(args.role ?? payload.role ?? "") as "observer" | "contributor"));
        case "join_target": return JSON.stringify({ status: "joined", ...joinDelegateTarget(client, tab, agentId,
          String(args.inviteId ?? payload.inviteId ?? ""),
          String(args.invitationToken ?? payload.invitationToken ?? "")) });
        case "leave_target": return JSON.stringify({ status: "left",
          session: leaveDelegateTarget(client, tab, agentId, sessionToken) });
        case "revoke_agent": return JSON.stringify({ status: "revoked",
          session: revokeDelegateAgent(client, tab, agentId, sessionToken, member) });
        case "handover_target": return JSON.stringify({ status: "handed_over",
          session: handoverDelegateTarget(client, tab, agentId, sessionToken, member) });
        case "session_participants": return JSON.stringify({ session: getDelegateParticipation(client, tab, agentId, sessionToken) });
      }
      throw new BrowserTransportError("DELEGATE_CDP_COMMAND_INVALID", "Invalid shared-tab command.");
    });
  }
  if (command === "release_target") {
    if (!agentId) return "control_chrome_cdp failed: Delegate release requires agentId.";
    return withDelegateTargetLock(target.connectionId, target.tabId!, async () => {
      releaseDelegateTarget(target.connectionId, target.tabId!, agentId, sessionToken);
      try { await delegateCdpTransport.detach(target, signal); } catch {}
      return `control_chrome_cdp: released Delegate target ${delegateTargetId(target.connectionId, target.tabId!)} for agent ${agentId}`;
    });
  }

  const write = WRITE_COMMANDS.has(command);
  const expectedRevisionRaw = args.expectedRevision ?? payload.expectedRevision;
  const expectedRevision = expectedRevisionRaw === undefined ? undefined : Number(expectedRevisionRaw);
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    return "control_chrome_cdp failed: expectedRevision must be a non-negative integer.";
  }
  if (command === "activate") {
    return withDelegateTargetLock(target.connectionId, target.tabId!, async () => {
      authorizeDelegateTarget(target.connectionId, target.tabId!, agentId, sessionToken, write, expectedRevision, true);
      const result = await delegateCdpTransport.tabAction(target.connectionId, "activate", { tabId: target.tabId }, signal);
      if (write) noteDelegateWriteSuccess(target.connectionId, target.tabId!, agentId, sessionToken);
      return JSON.stringify({ status: "activated", transport: "delegate", ...result });
    });
  }
  if (command === "close_tab") {
    return withDelegateTargetLock(target.connectionId, target.tabId!, async () => {
      authorizeDelegateTarget(target.connectionId, target.tabId!, agentId, sessionToken, write, expectedRevision, true);
      const result = await delegateCdpTransport.tabAction(target.connectionId, "close_tab", { tabId: target.tabId }, signal);
      if (write) noteDelegateWriteSuccess(target.connectionId, target.tabId!, agentId, sessionToken);
      if (agentId && hasDelegateClaim(target.connectionId, target.tabId!)) {
        try { releaseDelegateTarget(target.connectionId, target.tabId!, agentId, sessionToken); } catch {}
      }
      return JSON.stringify({ status: "closed", transport: "delegate", ...result });
    });
  }

  const operationResult = await withAttached(target, signal, async () => {
    if (command === "list_file_inputs" || command === "upload_file" || command === "handle_file_chooser" || command === "verify_upload") {
      const uploadWorkspace = String(args.__uploadWorkspace || process.cwd());
      if (command === "handle_file_chooser" && payload.arm === true && !payload.triggerSelector) {
        return "control_chrome_cdp failed: Delegate file chooser interception requires a triggerSelector and files in the same call (attachments are released between commands).";
      }
      const delegateSend = (method: string, params: Record<string, unknown> = {}) =>
        delegateCdpTransport.command(target, method, params, signal, {
          trustedGenerated: method === "Runtime.evaluate",
          dangerousApproved: method !== "Runtime.evaluate",
        });
      if (command === "handle_file_chooser" && typeof payload.triggerSelector === "string") {
        await validateUploadPaths(payload, uploadWorkspace);
        await delegateSend("Page.enable", {});
        await delegateSend("Page.setInterceptFileChooserDialog", { enabled: true });
        try {
          const expression = "(() => {const e=document.querySelector(" + JSON.stringify(payload.triggerSelector) + ");if(!e)return false;e.click();return true})()";
          const clicked = await generatedWriteEval(target, expression, signal);
          if (valueFromEvaluate(clicked) !== true) throw new Error("Delegate file chooser trigger element not found.");
          const until = Date.now() + 3000;
          while (Date.now() < until) {
            const events = await delegateCdpTransport.events(target, false, signal);
            if (events.some(e => e.method === "Page.fileChooserOpened" && e.backendNodeId > 0)) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          return await executeFileUploadCommand("handle_file_chooser", delegateSend,
            "delegate:" + target.connectionId + ":" + target.tabId, { ...payload, arm: false }, uploadWorkspace,
            () => delegateCdpTransport.events(target, false, signal));
        } finally {
          await delegateSend("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
        }
      }
      return executeFileUploadCommand(command as FileUploadCommand, delegateSend,
        "delegate:" + target.connectionId + ":" + target.tabId, payload, uploadWorkspace,
        () => delegateCdpTransport.events(target, false, signal));
    }
    if (command === "navigate") {
      const url = String(payload.url || args.url || "");
      if (!url) return 'control_chrome_cdp failed: command \'navigate\' needs a URL.';
      assertDelegateUrlAllowed(url);
      await delegateCdpTransport.command(target, "Page.enable", {}, signal);
      const result = await delegateCdpTransport.command(target, "Page.navigate", { url }, signal);
      return JSON.stringify({ status: "navigated", transport: "delegate", targetId: delegateTargetId(target.connectionId, target.tabId!), url, result });
    }
    if (command === "evaluate") {
      const expression = String(payload.expression || "");
      if (!expression) return "control_chrome_cdp failed: command 'evaluate' needs payload.expression.";
      const result = await delegateCdpTransport.command(target, "Runtime.evaluate", {
        expression, returnByValue: true, awaitPromise: true,
      }, signal, { dangerousApproved: true });
      return "control_chrome_cdp: evaluate result: " + JSON.stringify(valueFromEvaluate(result));
    }
    if (command === "read_page") {
      const expression = `(() => ({title:document.title,url:location.href,text:(document.body?.innerText||"").slice(0,20000),headings:Array.from(document.querySelectorAll("h1,h2,h3")).slice(0,80).map(e=>e.innerText.trim()).filter(Boolean)}))()`;
      const result = await generatedReadEval(target, expression, signal);
      return "control_chrome_cdp: page content (Delegate):\n" + JSON.stringify(valueFromEvaluate(result), null, 2);
    }
    if (command === "snapshot" || command === "shared_snapshot") {
      const expression = `(() => Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[tabindex]')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}).slice(0,250).map((e,i)=>({index:i+1,tag:e.tagName.toLowerCase(),text:(e.innerText||e.getAttribute("aria-label")||e.getAttribute("placeholder")||"").trim().slice(0,180),selector:e.id?"#"+CSS.escape(e.id):null})))()`;
      const result = await generatedReadEval(target, expression, signal);
      return "control_chrome_cdp: Delegate snapshot:\n" + JSON.stringify(valueFromEvaluate(result), null, 2);
    }
    if (command === "extract_links") {
      const pattern = String(payload.pattern || "").toLowerCase();
      const expression = `(() => Array.from(document.querySelectorAll("a[href]")).map(a=>({text:(a.innerText||"").trim().slice(0,240),href:a.href})).filter(x=>!${JSON.stringify(pattern)}||x.text.toLowerCase().includes(${JSON.stringify(pattern)})||x.href.toLowerCase().includes(${JSON.stringify(pattern)})).slice(0,500))()`;
      const result = await generatedReadEval(target, expression, signal);
      return "control_chrome_cdp: Delegate links:\n" + JSON.stringify(valueFromEvaluate(result), null, 2);
    }
    if (command === "click") {
      const selector = String(payload.selector || args.selector || "");
      const index = Number(payload.index ?? args.index ?? 0);
      const expression = selector
        ? `(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return {ok:false,reason:"not_found"};e.scrollIntoView({block:"center"});e.click();return {ok:true,tag:e.tagName.toLowerCase()}})()`
        : `(() => {const xs=Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[tabindex]')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});const e=xs[${Math.max(0,index-1)}];if(!e)return {ok:false,reason:"index_not_found"};e.scrollIntoView({block:"center"});e.click();return {ok:true,tag:e.tagName.toLowerCase()}})()`;
      const result = await generatedWriteEval(target, expression, signal);
      return "control_chrome_cdp: Delegate click: " + JSON.stringify(valueFromEvaluate(result));
    }
    if (command === "type") {
      const selector = String(payload.selector || args.selector || "");
      const index = Number(payload.index ?? args.index ?? 0);
      const text = String(payload.text ?? args.text ?? "");
      const locator = selector
        ? `document.querySelector(${JSON.stringify(selector)})`
        : `Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0})[${Math.max(0,index-1)}]`;
      const expression = `(() => {const e=${locator};if(!e)return {ok:false,reason:"not_found"};e.focus();const v=${JSON.stringify(text)};if(e.isContentEditable)e.textContent=v;else {const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),"value")?.set;setter?setter.call(e,v):e.value=v;}e.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:v}));e.dispatchEvent(new Event("change",{bubbles:true}));return {ok:true,tag:e.tagName.toLowerCase(),length:v.length}})()`;
      const result = await generatedWriteEval(target, expression, signal);
      return "control_chrome_cdp: Delegate type: " + JSON.stringify(valueFromEvaluate(result));
    }
    if (command === "wait_for") {
      const selector = String(payload.selector || args.selector || "");
      const text = String(payload.text || args.text || "");
      const timeout = Math.max(100, Math.min(20_000, Number(payload.timeout_ms ?? payload.wait_ms ?? args.wait_ms ?? 5000)));
      if (!selector && !text) return "control_chrome_cdp failed: wait_for needs selector or text.";
      const deadline = Date.now() + timeout;
      while (Date.now() <= deadline) {
        const expression = selector
          ? `Boolean(document.querySelector(${JSON.stringify(selector)}))`
          : `Boolean((document.body?.innerText||"").includes(${JSON.stringify(text)}))`;
        const result = await generatedReadEval(target, expression, signal);
        if (valueFromEvaluate(result) === true) return "control_chrome_cdp: Delegate wait_for matched.";
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return "control_chrome_cdp: Delegate wait_for timed out.";
    }
    if (command === "screenshot") {
      await delegateCdpTransport.command(target, "Page.enable", {}, signal);
      const result: any = await delegateCdpTransport.command(target, "Page.captureScreenshot", {
        format: String(payload.format || "png"), fromSurface: true, captureBeyondViewport: payload.fullPage === true || payload.full_page === true,
      }, signal);
      const data = String(result?.data || "");
      const bytes = data ? Math.floor(data.length * 3 / 4) : 0;
      return JSON.stringify({ status: "captured", transport: "delegate", format: String(payload.format || "png"), byteSize: bytes, ...(payload.includeImageData === true || payload.include_image_data === true ? { data } : {}) });
    }
    if (command === "get_cursor") {
      const key = `${target.connectionId}:${target.tabId}`;
      return JSON.stringify({ transport: "delegate", ...(delegateCursorPositions.get(key) || { x: 400, y: 300 }) });
    }
    if (command === "move_cursor") {
      const x = Number(payload.x ?? args.x);
      const y = Number(payload.y ?? args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return "control_chrome_cdp failed: Delegate move_cursor requires numeric x and y.";
      }
      await delegateCdpTransport.command(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, signal);
      delegateCursorPositions.set(`${target.connectionId}:${target.tabId}`, { x, y });
      return JSON.stringify({ status: "cursor_moved", transport: "delegate", x, y });
    }
    if (command === "drag_and_drop") {
      const source = payload.source && typeof payload.source === "object" ? payload.source as Record<string, unknown> : {};
      const destination = payload.target && typeof payload.target === "object" ? payload.target as Record<string, unknown> : {};
      const x1 = Number(payload.sourceX ?? payload.source_x ?? source.x);
      const y1 = Number(payload.sourceY ?? payload.source_y ?? source.y);
      const x2 = Number(payload.targetX ?? payload.target_x ?? destination.x);
      const y2 = Number(payload.targetY ?? payload.target_y ?? destination.y);
      if (![x1, y1, x2, y2].every(Number.isFinite)) {
        return "control_chrome_cdp failed: Delegate drag_and_drop currently requires source/target coordinate pairs.";
      }
      await delegateCdpTransport.command(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1 }, signal);
      await delegateCdpTransport.command(target, "Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", clickCount: 1 }, signal);
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const x = x1 + (x2 - x1) * (i / steps);
        const y = y1 + (y2 - y1) * (i / steps);
        await delegateCdpTransport.command(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 }, signal);
      }
      await delegateCdpTransport.command(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1 }, signal);
      delegateCursorPositions.set(`${target.connectionId}:${target.tabId}`, { x: x2, y: y2 });
      return JSON.stringify({ status: "dragged", transport: "delegate", from: { x: x1, y: y1 }, to: { x: x2, y: y2 } });
    }
    if (command === "emulate_device") {
      const presetName = String(payload.preset ?? payload.device ?? "custom").toLowerCase();
      if (presetName === "reset" || payload.reset === true) {
        await delegateCdpTransport.command(target, "Emulation.clearDeviceMetricsOverride", {}, signal);
        await delegateCdpTransport.command(target, "Emulation.setTouchEmulationEnabled", { enabled: false }, signal);
        return JSON.stringify({ status: "emulation_reset", transport: "delegate" });
      }
      const presets: Record<string, { width: number; height: number; deviceScaleFactor: number; mobile: boolean; touch: boolean }> = {
        mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
        iphone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
        android: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true },
        pixel: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true },
        tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
        ipad: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
        desktop: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false },
        laptop: { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, touch: false },
      };
      const base = presets[presetName] || presets.desktop;
      const width = Math.max(200, Math.min(7680, Number(payload.width ?? base.width)));
      const height = Math.max(200, Math.min(4320, Number(payload.height ?? base.height)));
      const deviceScaleFactor = Math.max(0.5, Math.min(5, Number(payload.deviceScaleFactor ?? payload.device_scale_factor ?? base.deviceScaleFactor)));
      const mobile = payload.mobile === undefined ? base.mobile : payload.mobile === true;
      const touch = payload.touch === undefined ? base.touch : payload.touch === true;
      await delegateCdpTransport.command(target, "Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor, mobile,
      }, signal);
      await delegateCdpTransport.command(target, "Emulation.setTouchEmulationEnabled", {
        enabled: touch, maxTouchPoints: touch ? 5 : 1,
      }, signal);
      return JSON.stringify({ status: "emulated", transport: "delegate", preset: presetName, width, height, deviceScaleFactor, mobile, touch });
    }
    if (command === "get_dialogs") {
      await delegateCdpTransport.command(target, "Page.enable", {}, signal);
      const rows = await delegateCdpTransport.events(target, payload.clear === true, signal);
      return JSON.stringify({ transport: "delegate", dialogs: rows.filter(row => row?.method === "Page.javascriptDialogOpening") });
    }
    if (command === "handle_dialog") {
      const result = await delegateCdpTransport.command(target, "Page.handleJavaScriptDialog", {
        accept: payload.accept !== false, promptText: String(payload.promptText ?? payload.prompt_text ?? ""),
      }, signal);
      return JSON.stringify({ status: "dialog_handled", transport: "delegate", result });
    }
    return "control_chrome_cdp failed: DELEGATE_CDP_CAPABILITY_UNSUPPORTED: '" + command + "' is not implemented by Delegate-CDP v1.8.";
  },
  () => authorizeDelegateTarget(target.connectionId, target.tabId!, agentId, sessionToken,
    write, expectedRevision, false, command === "shared_snapshot"),
  result => {
    if (write && typeof result === "string" && !result.startsWith("control_chrome_cdp failed:")) {
      noteDelegateWriteSuccess(target.connectionId, target.tabId!, agentId, sessionToken);
    }
  });
  return operationResult;
}
