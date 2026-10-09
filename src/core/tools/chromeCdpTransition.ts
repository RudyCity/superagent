/**
 * UI Transition Detection and Action Verification for Chrome CDP.
 *
 * Eliminates false-positive audit errors where full-page form view transitions,
 * drawer panels, or URL query mutations are misdiagnosed as unresponsive
 * simply because no popup modal dialog ([role="dialog"]) appeared.
 */

import {
  SnapshotEntry,
  formatSnapshotEntry,
  snapshotStore,
  snapshotPrevStore,
  SNAPSHOT_JS,
  resolveActionSelector,
  parseTimeoutMs,
  waitForInPage,
  buildClickJs,
  parseActionResult,
} from "./chromeCdpHelpers.js";

export type UiTransitionType =
  | "modal_dialog"
  | "full_page_form"
  | "drawer_panel"
  | "navigation"
  | "query_change"
  | "toast_notification"
  | "table_update"
  | "none";

export interface DomStateSnapshot {
  url: string;
  pathname: string;
  search: string;
  title: string;
  viewMode: "form_view" | "table_list_view" | "modal_view" | "drawer_view" | "general_view";
  hasModal: boolean;
  modalTitle?: string;
  hasDrawer: boolean;
  hasForm: boolean;
  formInputsCount: number;
  formFields: string[];
  hasTable: boolean;
  tableRowsCount: number;
  headings: string[];
  alerts: string[];
}

export interface TransitionDiff {
  type: UiTransitionType;
  description: string;
  urlChanged: boolean;
  beforeUrl: string;
  afterUrl: string;
  viewModeBefore: string;
  viewModeAfter: string;
  modalOpened: boolean;
  modalTitle?: string;
  formOpened: boolean;
  formFields: string[];
  alerts: string[];
}

/**
 * In-page JavaScript snippet that captures a lightweight, comprehensive
 * structural fingerprint of the page layout, forms, tables, modals, and views.
 */
export const CAPTURE_DOM_STATE_JS = `/*cdp-capture-dom-state*/(() => {
  const url = window.location.href;
  const pathname = window.location.pathname;
  const search = window.location.search;
  const title = document.title;

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const r = el.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
    } catch (e) {}
    return true;
  }

  // 1. Modal / Dialog detection (Radix, Tailwind overlay, HTML5 dialog, ARIA dialog)
  let hasModal = false;
  let modalTitle = "";
  const modalCandidates = Array.from(document.querySelectorAll(
    '[role="dialog"], dialog[open], [class*="modal" i]:not(body), div.fixed.inset-0:not(#__next):not(#root), [data-state="open"][role="dialog"]'
  ));
  for (const el of modalCandidates) {
    if (isVisible(el)) {
      hasModal = true;
      const heading = el.querySelector('h1, h2, h3, h4, [role="heading"], [class*="title" i]');
      modalTitle = (heading ? heading.innerText : el.innerText || "").slice(0, 80).replace(/\\s+/g, " ").trim();
      break;
    }
  }

  // 2. Drawer / Slide-over sheet detection
  let hasDrawer = false;
  const drawerCandidates = Array.from(document.querySelectorAll(
    '[role="region"][class*="drawer" i], [class*="slide-over" i], aside.fixed, div.fixed.right-0:not(.inset-0), div.fixed.left-0:not(.inset-0)'
  ));
  for (const el of drawerCandidates) {
    if (isVisible(el)) {
      const r = el.getBoundingClientRect();
      if (r.width > 120 && r.height > 150) {
        hasDrawer = true;
        break;
      }
    }
  }

  // 3. Form fields and Full-Page Form detection
  const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="search"]), select, textarea'));
  const visibleInputs = allInputs.filter(isVisible);
  const formInputsCount = visibleInputs.length;
  const formFields = visibleInputs.slice(0, 10).map(el => {
    const labelEl = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    const labelText = labelEl ? labelEl.innerText : "";
    const name = el.getAttribute('name') || el.id || el.getAttribute('placeholder') || el.getAttribute('aria-label') || labelText || "";
    const tag = el.tagName.toLowerCase();
    const cleanName = name.slice(0, 40).replace(/\\s+/g, " ").trim();
    return cleanName ? (tag + ':' + cleanName) : tag;
  });

  const formTag = document.querySelector('form, [data-form], #form');
  const hasForm = (formInputsCount >= 2 && !hasModal) || Boolean(formTag && isVisible(formTag));

  // 4. Table detection
  const tables = Array.from(document.querySelectorAll('table, [role="table"], [role="grid"], tbody'));
  let hasTable = false;
  let tableRowsCount = 0;
  for (const t of tables) {
    if (isVisible(t)) {
      const rows = t.querySelectorAll('tr, [role="row"]');
      if (rows.length > 0) {
        hasTable = true;
        tableRowsCount = rows.length;
        break;
      }
    }
  }

  // 5. Headings and alerts
  const headings = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'))
    .map(h => (h.innerText || '').replace(/\\s+/g, ' ').trim())
    .filter(t => t.length > 0 && t.length < 100)
    .slice(0, 5);

  const alerts = Array.from(document.querySelectorAll('[role="alert"], [aria-live], .alert, .toast, [class*="toast" i]'))
    .map(a => (a.innerText || '').replace(/\\s+/g, ' ').trim())
    .filter(t => t.length > 0 && t.length < 150)
    .slice(0, 3);

  // 6. View Mode classification
  let viewMode = 'general_view';
  if (hasModal) viewMode = 'modal_view';
  else if (hasDrawer) viewMode = 'drawer_view';
  else if (hasForm && (!hasTable || formInputsCount >= 3)) viewMode = 'form_view';
  else if (hasTable) viewMode = 'table_list_view';

  return {
    url,
    pathname,
    search,
    title,
    viewMode,
    hasModal,
    modalTitle: modalTitle || undefined,
    hasDrawer,
    hasForm,
    formInputsCount,
    formFields,
    hasTable,
    tableRowsCount,
    headings,
    alerts
  };
})()`;

/**
 * Computes semantic structural difference between two DOM states.
 */
export function computeTransitionDiff(
  before: DomStateSnapshot,
  after: DomStateSnapshot
): TransitionDiff {
  const urlChanged = before.url !== after.url;
  const pathChanged = before.pathname !== after.pathname;
  const searchChanged = before.search !== after.search;
  const modalOpened = !before.hasModal && after.hasModal;
  const drawerOpened = !before.hasDrawer && after.hasDrawer;
  const formOpened =
    (!before.hasForm && after.hasForm) ||
    (before.viewMode === "table_list_view" && after.viewMode === "form_view") ||
    (!before.hasModal && after.formInputsCount > before.formInputsCount + 1);

  let type: UiTransitionType = "none";
  let description = "no visible view transition detected";

  if (modalOpened) {
    type = "modal_dialog";
    description = `modal dialog opened${after.modalTitle ? ` ("${after.modalTitle}")` : ""}`;
  } else if (formOpened) {
    type = "full_page_form";
    const fieldSummary = after.formFields.length > 0 ? ` (${after.formFields.slice(0, 4).join(", ")})` : "";
    description = `full-page form view rendered with ${after.formInputsCount} editable field(s)${fieldSummary}`;
  } else if (drawerOpened) {
    type = "drawer_panel";
    description = "slide-over drawer panel opened";
  } else if (pathChanged) {
    type = "navigation";
    description = `route navigated from '${before.pathname}' to '${after.pathname}'`;
  } else if (searchChanged) {
    type = "query_change";
    description = `URL search query changed to '${after.search || "(empty)"}'`;
  } else if (after.alerts.length > before.alerts.length) {
    type = "toast_notification";
    description = `notification/toast displayed: "${after.alerts[0]}"`;
  } else if (before.hasTable && after.hasTable && before.tableRowsCount !== after.tableRowsCount) {
    type = "table_update";
    description = `table updated (rows changed from ${before.tableRowsCount} to ${after.tableRowsCount})`;
  } else if (urlChanged) {
    type = "query_change";
    description = `URL updated to '${after.url}'`;
  }

  return {
    type,
    description,
    urlChanged,
    beforeUrl: before.url,
    afterUrl: after.url,
    viewModeBefore: before.viewMode,
    viewModeAfter: after.viewMode,
    modalOpened,
    modalTitle: after.modalTitle,
    formOpened,
    formFields: after.formFields,
    alerts: after.alerts,
  };
}

/**
 * Formats a transition diff into a concise, telegraphic summary.
 */
export function formatTransitionSummary(diff: TransitionDiff): string {
  const parts: string[] = [];
  parts.push(`Transition: [${diff.type.toUpperCase()}] ${diff.description}`);

  if (diff.urlChanged) {
    parts.push(`URL: ${diff.beforeUrl} -> ${diff.afterUrl}`);
  }

  if (diff.viewModeBefore !== diff.viewModeAfter) {
    parts.push(`View Mode: ${diff.viewModeBefore} -> ${diff.viewModeAfter}`);
  }

  if (diff.formOpened && diff.formFields.length > 0) {
    parts.push(`Form Fields: ${diff.formFields.join(", ")}`);
  }

  if (diff.alerts.length > 0) {
    parts.push(`Alerts: ${diff.alerts.join(" | ")}`);
  }

  return parts.join("\n");
}

/**
 * Captures current DOM structural state via CDP Runtime.evaluate.
 */
export async function captureDomState(
  cdpSend: (target: any, method: string, params?: Record<string, unknown>) => Promise<any>,
  target: any
): Promise<DomStateSnapshot> {
  const res: any = await cdpSend(target, "Runtime.evaluate", {
    expression: CAPTURE_DOM_STATE_JS,
    returnByValue: true,
  });
  const val = res && res.result ? res.result.value : undefined;
  if (val && typeof val === "object") {
    return val as DomStateSnapshot;
  }
  return {
    url: target.url || "",
    pathname: "",
    search: "",
    title: target.title || "",
    viewMode: "general_view",
    hasModal: false,
    hasDrawer: false,
    hasForm: false,
    formInputsCount: 0,
    formFields: [],
    hasTable: false,
    tableRowsCount: 0,
    headings: [],
    alerts: [],
  };
}

/**
 * Executes an action (e.g. click) and observes post-action DOM transition with debounce.
 */
export async function observeActionTransition(
  cdpSend: (target: any, method: string, params?: Record<string, unknown>) => Promise<any>,
  target: any,
  beforeState: DomStateSnapshot,
  debounceMs: number = 200
): Promise<TransitionDiff> {
  if (debounceMs > 0) {
    await new Promise((r) => setTimeout(r, debounceMs));
  }
  const afterState = await captureDomState(cdpSend, target);
  return computeTransitionDiff(beforeState, afterState);
}

/**
 * Handles the verify_action command: executes click, observes UI transition,
 * automatically refreshes the snapshot cache, and returns structured verification.
 */
export async function executeVerifyAction(
  cdpSend: (target: any, method: string, params?: Record<string, unknown>) => Promise<any>,
  target: any,
  payload: Record<string, unknown>,
  attachScreenshotIfRequested: (
    cdpSend: any,
    target: any,
    payload: any,
    baseResult: string,
    isNav: boolean
  ) => Promise<string>
): Promise<string> {
  const resolved = resolveActionSelector(payload, target.id);
  if ("error" in resolved) return resolved.error;

  const waitMs = parseTimeoutMs(payload.timeout_ms, 10000);
  if (waitMs > 0) {
    const w = await waitForInPage(cdpSend, target, { selector: resolved.selector, timeoutMs: waitMs });
    if (!w.ok) {
      return (
        `control_chrome_cdp: verify_action timed out after ${waitMs}ms waiting for '${resolved.selector}' to appear and become visible. ` +
        `Run 'snapshot' to refresh the element list, or 'wait_for' with a longer timeout.`
      );
    }
  }

  // 1. Capture before state
  const beforeState = await captureDomState(cdpSend, target);

  // 2. Perform click
  const res: any = await cdpSend(target, "Runtime.evaluate", {
    expression: buildClickJs(resolved.selector),
    returnByValue: true,
  });
  const value = res && res.result ? res.result.value : undefined;
  const parsed = parseActionResult(typeof value === "string" ? value : JSON.stringify(value));
  if (!parsed.ok) {
    return `control_chrome_cdp: verify_action click failed - ${parsed.reason || "unknown reason"}.`;
  }

  // 3. Settle and observe transition
  const debounceMs = parseTimeoutMs(payload.debounce_ms, 250);
  const diff = await observeActionTransition(cdpSend, target, beforeState, debounceMs);

  // 4. Refresh snapshot store so subsequent interactions by index are immediate
  try {
    const sRes: any = await cdpSend(target, "Runtime.evaluate", { expression: SNAPSHOT_JS, returnByValue: true });
    const sVal = sRes && sRes.result ? sRes.result.value : undefined;
    let fresh: SnapshotEntry[] = [];
    if (Array.isArray(sVal)) {
      fresh = sVal;
    } else if (sVal && typeof sVal === "object" && Array.isArray((sVal as any).elements)) {
      fresh = (sVal as any).elements;
    }
    if (fresh.length > 0) {
      snapshotPrevStore.set(target.id, snapshotStore.get(target.id) ?? []);
      snapshotStore.set(target.id, fresh);
    }
  } catch {}

  const textStr = parsed.text ? ` "${parsed.text}"` : "";
  const header = `control_chrome_cdp: verified action on <${parsed.tag}>${textStr} with selector '${resolved.selector}'.`;
  const summary = formatTransitionSummary(diff);
  const fullResult = `${header}\n\n${summary}\n\nInteractive elements updated (${snapshotStore.get(target.id)?.length ?? 0} available).`;

  return await attachScreenshotIfRequested(cdpSend, target, payload, fullResult, false);
}
