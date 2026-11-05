import { delegateBridge } from "./bridge.js";
import { noteDelegateAttachment, forgetDelegateAttachment, touchDelegateAttachment, listDelegateAttachments } from "./cdpAttachmentRegistry.js";
import { assertDelegateCdpMethodAllowed, assertDelegateUrlAllowed } from "../browserTransport/delegateCdpPolicy.js";
import { delegateTargetId, parseBrowserTargetId } from "../browserTransport/targetIdentity.js";
import {
  authorizeDelegateTarget, claimDelegateTarget, hasDelegateClaim, listDelegateSessions, noteDelegateWriteSuccess, releaseDelegateTarget, withDelegateTargetLock,
} from "../browserTransport/sessionCoordinator.js";
import { BrowserTransportError, type BrowserTargetRef, type BrowserTransport } from "../browserTransport/types.js";
import { DELEGATE_V18_COMMANDS, unsupportedBrowserCommand } from "../browserTransport/commandCapabilities.js";

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
  const rawTarget = String(args.targetId ?? payload.targetId ?? "");
  const parsed = rawTarget ? parseBrowserTargetId(rawTarget) : null;
  let clientId = String(args.delegateClientId ?? payload.delegateClientId ?? parsed?.connectionId ?? "");
  let tabId = Number(args.delegateTabId ?? payload.delegateTabId ?? parsed?.tabId ?? 0);
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

async function withAttached<T>(target: BrowserTargetRef, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  return withDelegateTargetLock(target.connectionId, target.tabId!, async () => {
    await delegateCdpTransport.attach(target, signal);
    try { return await fn(); }
    finally {
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
  const clientHint = String(args.delegateClientId ?? payload.delegateClientId ?? "") || undefined;

  if (command === "transport_status") {
    const health = await delegateCdpTransport.health(clientHint, signal);
    return JSON.stringify({ transport: "delegate", health, connections: delegateBridge.listConnections(), attachments: listDelegateAttachments() });
  }
  if (command === "list_targets") {
    const targets = await delegateCdpTransport.listTargets(clientHint, signal);
    if (!targets.length) return "control_chrome_cdp: Delegate connected, but no controllable normal web tabs are open.";
    return targets.map(t => `- id: ${delegateTargetId(t.connectionId, t.tabId!)}\n  title: ${t.title || ""}\n  url: ${t.url || ""}\n  transport: delegate`).join("\n");
  }
  if (command === "list_sessions") return JSON.stringify({ sessions: listDelegateSessions() });
  if (command === "coordinator_status") {
    return JSON.stringify({ transport: "delegate", sessions: listDelegateSessions(), attachments: listDelegateAttachments() });
  }
  if (command === "new_tab") {
    const url = String(payload.url || args.url || "https://example.com/");
    assertDelegateUrlAllowed(url);
    const result = await delegateCdpTransport.tabAction(clientHint, "new_tab", { url, active: true }, signal);
    return JSON.stringify({ status: "opened", transport: "delegate", ...result });
  }

  const target = await resolveTarget(args, payload, signal);
  const agentId = args.agentId !== undefined ? String(args.agentId) : payload.agentId !== undefined ? String(payload.agentId) : undefined;
  const sessionToken = args.sessionToken !== undefined ? String(args.sessionToken) : payload.sessionToken !== undefined ? String(payload.sessionToken) : undefined;

  if (command === "claim_target" || command === "recover_session") {
    if (!agentId) return "control_chrome_cdp failed: Delegate claim requires agentId.";
    return withDelegateTargetLock(target.connectionId, target.tabId!, async () => {
      // Probe debugger ownership, then release it before issuing the logical
      // claim. Normal operations attach only for their bounded duration.
      await delegateCdpTransport.attach(target, signal);
      await delegateCdpTransport.detach(target, signal);
      const session = claimDelegateTarget(target.connectionId, target.tabId!, agentId, sessionToken);
      return JSON.stringify({ status: command === "recover_session" ? "recovered" : "claimed", ...session });
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
  authorizeDelegateTarget(target.connectionId, target.tabId!, agentId, sessionToken, write, expectedRevision);

  if (command === "activate") {
    return withDelegateTargetLock(target.connectionId, target.tabId!, async () => {
      const result = await delegateCdpTransport.tabAction(target.connectionId, "activate", { tabId: target.tabId }, signal);
      if (write) noteDelegateWriteSuccess(target.connectionId, target.tabId!, agentId, sessionToken);
      return JSON.stringify({ status: "activated", transport: "delegate", ...result });
    });
  }
  if (command === "close_tab") {
    return withDelegateTargetLock(target.connectionId, target.tabId!, async () => {
      const result = await delegateCdpTransport.tabAction(target.connectionId, "close_tab", { tabId: target.tabId }, signal);
      if (write) noteDelegateWriteSuccess(target.connectionId, target.tabId!, agentId, sessionToken);
      if (agentId && hasDelegateClaim(target.connectionId, target.tabId!)) {
        try { releaseDelegateTarget(target.connectionId, target.tabId!, agentId, sessionToken); } catch {}
      }
      return JSON.stringify({ status: "closed", transport: "delegate", ...result });
    });
  }

  const operationResult = await withAttached(target, signal, async () => {
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
    if (command === "snapshot") {
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
  });
  if (write && !operationResult.startsWith("control_chrome_cdp failed:")) {
    noteDelegateWriteSuccess(target.connectionId, target.tabId!, agentId, sessionToken);
  }
  return operationResult;
}
