/**
 * Non-interactive target highlighting for headed managed-CDP pages.
 * Changes no page forms, focused elements, or DOM event dispatch behavior.
 * Must be invoked through the existing target write coordinator.
 */
import { cursorColorForAgent } from "./chromeCdpCursor.js";

const markerId = (agentId: string): string =>
  "__superagent_target_highlight__" + encodeURIComponent(agentId);

export function buildHighlightTargetJs(selector: string, agentId = "legacy", ttlMs = 1500): string {
  const color = cursorColorForAgent(agentId);
  const ttl = Math.max(250, Math.min(5000, Math.floor(Number(ttlMs) || 1500)));
  return `(() => {
    let target;
    try { target = document.querySelector(${JSON.stringify(selector)}); }
    catch { return { ok: false, code: 'INVALID_SELECTOR' }; }
    if (!target) return { ok: false, code: 'TARGET_NOT_FOUND' };
    if (target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true')
      return { ok: false, code: 'TARGET_DISABLED' };
    const rect = target.getBoundingClientRect();
    const style = getComputedStyle(target);
    if (!rect || rect.width < 1 || rect.height < 1 || style.display === 'none' ||
        style.visibility === 'hidden' || style.visibility === 'collapse')
      return { ok: false, code: 'TARGET_NOT_VISIBLE' };
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (left >= right || top >= bottom) return { ok: false, code: 'TARGET_OUTSIDE_VIEWPORT' };
    const cx = Math.floor((left + right) / 2);
    const cy = Math.floor((top + bottom) / 2);
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || (!target.contains(hit) && !hit.contains(target)))
      return { ok: false, code: 'TARGET_OCCLUDED' };
    const id = ${JSON.stringify(markerId(agentId))};
    let marker = document.getElementById(id);
    if (!marker) {
      marker = document.createElement('div');
      marker.id = id;
      marker.setAttribute('data-superagent-target-highlight', 'true');
      marker.setAttribute('aria-hidden', 'true');
      marker.style.position = 'fixed';
      marker.style.pointerEvents = 'none';
      marker.style.zIndex = '2147483646';
      marker.style.boxSizing = 'border-box';
      marker.style.borderRadius = '4px';
      marker.style.border = '2px solid ${color}';
      marker.style.boxShadow = '0 0 0 3px rgba(255,255,255,.7)';
      (document.body || document.documentElement).appendChild(marker);
    }
    marker.style.top = rect.top + 'px';
    marker.style.left = rect.left + 'px';
    marker.style.width = rect.width + 'px';
    marker.style.height = rect.height + 'px';
    const nonce = String(Date.now()) + String(Math.random());
    marker.setAttribute('data-highlight-nonce', nonce);
    setTimeout(() => {
      const current = document.getElementById(id);
      if (current && current.getAttribute('data-highlight-nonce') === nonce) current.remove();
    }, ${ttl});
    return {
      ok: true, code: 'TARGET_HIGHLIGHTED',
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      tag: String(target.tagName || '').toLowerCase()
    };
  })()`;
}

export function buildClearHighlightJs(agentId = "legacy"): string {
  return `(() => {
    const marker = document.getElementById(${JSON.stringify(markerId(agentId))});
    if (marker) marker.remove();
    return { ok: true, code: 'TARGET_HIGHLIGHT_CLEARED' };
  })()`;
}

export async function executeTargetHighlightCommand(
  send: (target: any, method: string, params?: any) => Promise<any>,
  target: any,
  command: "highlight_target" | "clear_highlight",
  payload: Record<string, unknown>,
  agentId = "legacy",
): Promise<string> {
  if (command === "highlight_target") {
    const selector = payload.selector;
    if (typeof selector !== "string" || !selector.trim() || selector.length > 1000)
      return "control_chrome_cdp failed: highlight_target requires a CSS selector (1-1000 characters).";
    const result = await send(target, "Runtime.evaluate", {
      expression: buildHighlightTargetJs(selector, agentId, Number(payload.ttlMs ?? 1500)),
      returnByValue: true,
    });
    const value = result?.result?.value;
    if (!value?.ok) return "control_chrome_cdp failed: " + (value?.code || "HIGHLIGHT_UNAVAILABLE");
    return JSON.stringify({ status: "highlighted", tag: value.tag, rect: value.rect });
  }
  await send(target, "Runtime.evaluate", {
    expression: buildClearHighlightJs(agentId),
    returnByValue: true,
  });
  return "control_chrome_cdp: target highlight cleared.";
}
