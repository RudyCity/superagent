import { delegateCdpTransport } from "./cdpTransport.js";
import type { BrowserTargetRef } from "../browserTransport/types.js";

export type DelegateReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type DelegateChatConfigRequest = Readonly<{
  model?: string;
  effort?: DelegateReasoningEffort;
}>;

export type DelegateChatConfigResult = Readonly<{
  requested_model: string | null;
  requested_effort: DelegateReasoningEffort | null;
  applied_model: string | null;
  applied_effort: string | null;
  model_control: string | null;
  effort_control: string | null;
}>;

const CONFIG_SCRIPT = String.raw`async (request) => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const norm = value => String(value || "")
    .normalize("NFKC").toLowerCase()
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[^a-z0-9.+-]+/g, " ")
    .replace(/\s+/g, " ").trim();
  const label = node => String(
    node?.getAttribute?.("aria-label") ||
    node?.getAttribute?.("data-testid") ||
    node?.getAttribute?.("title") ||
    node?.innerText || node?.textContent || ""
  ).replace(/\s+/g, " ").trim();
  const visible = node => {
    if (!(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" ||
        Number(style.opacity || 1) === 0) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const controls = () => Array.from(document.querySelectorAll(
    'button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="radio"]'
  )).filter(visible);
  const openSurfaces = () => Array.from(document.querySelectorAll(
    '[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper],'+
    '[data-headlessui-state~="open"],[data-state="open"]'
  )).filter(visible);
  const surfaceControls = () => {
    const surfaces = openSurfaces();
    if (!surfaces.length) return controls();
    const seen = new Set();
    const out = [];
    for (const surface of surfaces) {
      for (const node of surface.querySelectorAll(
        'button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="radio"]'
      )) {
        if (visible(node) && !seen.has(node)) { seen.add(node); out.push(node); }
      }
    }
    return out;
  };
  const click = node => {
    node.scrollIntoView({ block: "center", inline: "nearest" });
    node.click();
  };
  const waitFor = async (fn, timeout = 3500) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = fn();
      if (value) return value;
      await sleep(80);
    }
    return null;
  };
  const modelTrigger = () => {
    const direct = document.querySelector(
      '[data-testid="model-switcher-dropdown-button"],'+
      '[data-testid*="model-switcher" i],button[aria-label*="model" i],'+
      '[role="button"][aria-label*="model" i]'
    );
    if (direct && visible(direct)) return direct;
    return controls().find(node => {
      const text = norm(label(node));
      return /^(gpt|chatgpt|o[0-9]|auto)(\s|-|\.)/.test(text) &&
        !/(send|stop|retry|new chat)/.test(text);
    }) || null;
  };
  const effortTrigger = () => {
    const direct = document.querySelector(
      '[data-testid*="effort" i],[data-testid*="reasoning" i],'+
      'button[aria-label*="effort" i],button[aria-label*="reasoning" i],'+
      '[role="button"][aria-label*="effort" i],[role="button"][aria-label*="reasoning" i]'
    );
    if (direct && visible(direct)) return direct;
    const exact = new Set(["low","medium","high","extra high","xhigh","thinking","thinking time"]);
    return controls().find(node => {
      const compact = norm(label(node));
      const full = norm(String(node?.innerText || node?.textContent || ""));
      return exact.has(compact) ||
        compact.includes("thinking effort") || full.includes("thinking effort") ||
        compact.includes("reasoning effort") || full.includes("reasoning effort");
    }) || null;
  };
  const effortState = requested => {
    const q = norm(requested);
    const rows = controls().map(node => ({
      node,
      full: norm(String(node?.innerText || node?.textContent || "")),
      raw: String(node?.innerText || node?.textContent || label(node) || "").replace(/\s+/g, " ").trim(),
    }));
    const row = rows.find(item =>
      item.full.includes("thinking effort") || item.full.includes("reasoning effort"));
    if (!row) return null;
    const text = row.full;
    const matched = q === "xhigh"
      ? /(^| )(extra high|xhigh)( |$)/.test(text)
      : q === "high"
        ? /(^| )high( |$)/.test(text) && !/(^| )extra high( |$)/.test(text)
        : q === "medium"
          ? /(^| )medium( |$)/.test(text)
          : /(^| )low( |$)/.test(text);
    return matched ? { node: row.node, raw: row.raw || q } : null;
  };
  const openEffortSubmenu = async () => {
    const outer = modelTrigger();
    if (!outer) return false;
    if (outer.getAttribute?.("aria-expanded") !== "true") {
      click(outer);
      await sleep(220);
      await waitFor(() => openSurfaces().length > 0, 2500);
    }
    const directEffort = surfaceControls().some(node => {
      const text = norm(label(node));
      return ["low","medium","high","extra high","xhigh"].includes(text);
    });
    if (directEffort) return true;
    const menuRows = surfaceControls();
    const nested = menuRows.find(node => {
      const aria = norm(node.getAttribute?.("aria-label"));
      const text = norm(String(node?.innerText || node?.textContent || ""));
      return text === "power" ||
        aria.includes("effort") || aria.includes("reasoning") || aria.includes("thinking") ||
        text.includes("thinking effort") || text.includes("reasoning effort");
    }) || menuRows.find(node => {
      const aria = norm(node.getAttribute?.("aria-label"));
      const text = norm(String(node?.innerText || node?.textContent || ""));
      return aria === "select model" ||
        (aria.includes("select model") &&
          /(^| )(low|medium|high|extra high)( |$)/.test(text));
    });
    if (!nested) return false;
    const effortOptionsVisible = () => {
      const labels = surfaceControls().map(node => norm(label(node)));
      return labels.some(text =>
        ["low","medium","high","extra high","xhigh"].includes(text));
    };
    try {
      nested.scrollIntoView({ block: "center", inline: "nearest" });
      nested.focus?.();
      for (const type of ["pointerover","mouseover","pointermove"]) {
        const EventCtor = type.startsWith("pointer") && typeof PointerEvent === "function"
          ? PointerEvent : MouseEvent;
        nested.dispatchEvent(new EventCtor(type, {
          bubbles: true, cancelable: true, composed: true,
          clientX: nested.getBoundingClientRect().left + 4,
          clientY: nested.getBoundingClientRect().top + 4,
        }));
      }
    } catch {}
    await sleep(220);
    if (effortOptionsVisible()) return true;
    try {
      nested.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowRight", code: "ArrowRight", bubbles: true, cancelable: true,
      }));
      nested.dispatchEvent(new KeyboardEvent("keyup", {
        key: "ArrowRight", code: "ArrowRight", bubbles: true, cancelable: true,
      }));
    } catch {}
    await sleep(220);
    if (effortOptionsVisible()) return true;
    click(nested);
    await sleep(260);
    return Boolean(await waitFor(() => effortOptionsVisible(), 2500));
  };
  const choose = async (requested, kind) => {
    const q = norm(requested);
    const aliases = kind === "effort" && q === "xhigh"
      ? new Set(["xhigh","extra high","extra-high"])
      : new Set([q]);
    const candidates = surfaceControls().map(node => ({
      node, raw: label(node), normalized: norm(label(node)),
    })).filter(row => row.raw && row.raw.length <= 160);
    let matches = candidates.filter(row => aliases.has(row.normalized));
    if (!matches.length && kind === "model") {
      matches = candidates.filter(row => {
        if (q.length < 4) return false;
        return row.normalized === q ||
          row.normalized.startsWith(q + " ") ||
          row.normalized.endsWith(" " + q);
      });
    }
    const unique = [];
    const seen = new Set();
    for (const row of matches) {
      if (!seen.has(row.raw)) { seen.add(row.raw); unique.push(row); }
    }
    if (unique.length !== 1) {
      return {
        ok: false,
        code: unique.length > 1 ? "CHATGPT_CONFIG_OPTION_AMBIGUOUS" : "CHATGPT_CONFIG_OPTION_NOT_FOUND",
        requested,
        available: [...new Set(candidates.map(row => row.raw))].slice(0, 40),
      };
    }
    click(unique[0].node);
    await sleep(180);
    return { ok: true, selected: unique[0].raw };
  };

  const result = {
    requested_model: request.model || null,
    requested_effort: request.effort || null,
    applied_model: null,
    applied_effort: null,
    model_control: null,
    effort_control: null,
  };

  if (request.model) {
    const trigger = await waitFor(() => modelTrigger(), 15_000);
    if (!trigger) return {
      ok:false, code:"CHATGPT_MODEL_CONTROL_NOT_FOUND", result,
      available: controls().map(label).filter(Boolean).slice(0, 40),
    };
    result.model_control = label(trigger);
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      if (trigger.getAttribute?.("aria-expanded") !== "true") {
        click(trigger);
      }
      await sleep(260 + attempt * 140);
      opened = Boolean(await waitFor(() => openSurfaces().length > 0, 3500));
      if (!opened) await sleep(450);
    }
    if (!opened) return { ok:false, code:"CHATGPT_MODEL_MENU_NOT_OPEN", result };
    const chosen = await choose(request.model, "model");
    if (!chosen.ok) return { ...chosen, result };
    result.applied_model = chosen.selected;
  }

  if (request.effort) {
    const outer = await waitFor(() => effortTrigger(), 2500);
    if (!outer) return { ok:false, code:"CHATGPT_EFFORT_CONTROL_NOT_FOUND", result };
    if (outer.getAttribute?.("aria-expanded") !== "true") {
      click(outer);
      await sleep(220);
    }
    const powerControl = await waitFor(() => surfaceControls().find(node => {
      const compact = norm(label(node));
      const full = norm(String(node?.innerText || node?.textContent || ""));
      return compact === "power" || full === "power";
    }), 2500);
    if (!powerControl) return { ok:false, code:"CHATGPT_EFFORT_POWER_CONTROL_NOT_FOUND", result };

    const readScale = () => {
      const status = Array.from(document.querySelectorAll('[role="status"]'))
        .filter(visible)
        .map(node => String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())
        .find(text => /\d+\s+of\s+\d+/i.test(text));
      const match = status?.match(/(\d+)\s+of\s+(\d+)/i);
      return match ? { current:Number(match[1]), max:Number(match[2]), status } : null;
    };
    const scale = readScale();
    if (!scale) return { ok:false, code:"CHATGPT_EFFORT_SCALE_NOT_FOUND", result };
    const target = request.effort === "low" ? 1
      : request.effort === "medium" ? 2
      : request.effort === "high" ? 3 : 4;
    if (target > scale.max) return {
      ok:false, code:"CHATGPT_EFFORT_OPTION_NOT_AVAILABLE", result,
      available:[scale.status],
    };

    if (target === scale.current) {
      result.effort_control = "power-keyboard";
      result.applied_effort = scale.status;
      if (outer.getAttribute?.("aria-expanded") === "true") click(outer);
    } else {
      powerControl.focus();
      return {
        ok:false,
        code:"CHATGPT_EFFORT_NATIVE_REQUIRED",
        result,
        native_effort:{
          current:scale.current,
          max:scale.max,
          target,
          key:target > scale.current ? "ArrowRight" : "ArrowLeft",
          steps:Math.abs(target - scale.current),
        },
      };
    }
  }

  return { ok:true, result };
}`;

function validModel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 2 && value.trim().length <= 80;
}
function validEffort(value: unknown): value is DelegateReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

export function validateDelegateChatConfig(input: DelegateChatConfigRequest): void {
  if (input.model !== undefined && !validModel(input.model))
    throw new Error("DELEGATE_INVALID_MODEL");
  if (input.effort !== undefined && !validEffort(input.effort))
    throw new Error("DELEGATE_INVALID_EFFORT");
  if (input.model === undefined && input.effort === undefined)
    throw new Error("DELEGATE_CHAT_CONFIG_REQUIRED");
}

export async function configureDelegateChatOnLockedTarget(
  clientId: string,
  tabId: number,
  input: DelegateChatConfigRequest,
  signal?: AbortSignal,
): Promise<DelegateChatConfigResult> {
  validateDelegateChatConfig(input);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(clientId) ||
      !Number.isSafeInteger(tabId) || tabId < 1)
    throw new Error("DELEGATE_CONFIG_TARGET_INVALID");

  const target: BrowserTargetRef = {
    kind: "delegate", connectionId: clientId, targetId: "tab:" + tabId, tabId,
  };
  await delegateCdpTransport.attach(target, signal);
  try {
    const evaluated: any = await delegateCdpTransport.command(
      target,
      "Runtime.evaluate",
      {
        expression: "(" + CONFIG_SCRIPT + ")(" + JSON.stringify({
          ...(input.model ? { model: input.model.trim() } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        }) + ")",
        returnByValue: true,
        awaitPromise: true,
      },
      signal,
      { dangerousApproved: true },
    );
    if (evaluated?.exceptionDetails) throw new Error("CHATGPT_CONFIG_EVALUATE_FAILED");
    const value = evaluated?.result?.value;
    if (!value || typeof value !== "object") throw new Error("CHATGPT_CONFIG_INVALID_RESPONSE");
    if (value.ok !== true) {
      if (value.code === "CHATGPT_EFFORT_NATIVE_REQUIRED" &&
          input.effort && value.native_effort &&
          Number.isSafeInteger(value.native_effort.current) &&
          Number.isSafeInteger(value.native_effort.max) &&
          Number.isSafeInteger(value.native_effort.target) &&
          Number.isSafeInteger(value.native_effort.steps) &&
          value.native_effort.steps >= 1 && value.native_effort.steps <= 7 &&
          (value.native_effort.key === "ArrowRight" ||
           value.native_effort.key === "ArrowLeft")) {
        const key = value.native_effort.key as "ArrowRight" | "ArrowLeft";
        const vk = key === "ArrowRight" ? 39 : 37;
        for (let i = 0; i < value.native_effort.steps; i++) {
          await delegateCdpTransport.command(
            target,
            "Input.dispatchKeyEvent",
            {
              type: "rawKeyDown",
              key,
              code: key,
              windowsVirtualKeyCode: vk,
              nativeVirtualKeyCode: vk,
            },
            signal,
            { dangerousApproved: true },
          );
          await delegateCdpTransport.command(
            target,
            "Input.dispatchKeyEvent",
            {
              type: "keyUp",
              key,
              code: key,
              windowsVirtualKeyCode: vk,
              nativeVirtualKeyCode: vk,
            },
            signal,
            { dangerousApproved: true },
          );
          await new Promise(resolve => setTimeout(resolve, 160));
        }

        const verifyExpression =
          "(() => {" +
          "const vis=n=>{if(!(n instanceof Element))return false;const s=getComputedStyle(n),r=n.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};" +
          "const clean=v=>String(v||'').replace(/\s+/g,' ').trim();" +
          "const st=Array.from(document.querySelectorAll('[role=status]')).filter(vis).map(n=>clean(n.innerText||n.textContent)).find(t=>/\d+\s+of\s+\d+/i.test(t));" +
          "const m=st&&st.match(/(\d+)\s+of\s+(\d+)/i);" +
          "const out=Array.from(document.querySelectorAll('button,[role=button]')).filter(vis).find(n=>clean(n.getAttribute('aria-label')).toLowerCase().includes('select chatgpt model')||clean(n.innerText||n.textContent).toLowerCase().includes('thinking effort'));" +
          "if(out?.getAttribute('aria-expanded')==='true')out.click();" +
          "return {current:m?Number(m[1]):null,max:m?Number(m[2]):null,label:out?clean(out.innerText||out.textContent):null,status:st||null};" +
          "})()";
        let post: any = null;
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const verified: any = await delegateCdpTransport.command(
            target,
            "Runtime.evaluate",
            { expression: verifyExpression, returnByValue: true, awaitPromise: false },
            signal,
            { dangerousApproved: true },
          );
          const candidate = verified?.result?.value;
          if (candidate?.current === value.native_effort.target &&
              Number.isSafeInteger(candidate?.max) &&
              Number(candidate.max) >= value.native_effort.target) {
            post = candidate;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 120));
        }
        if (!post) throw new Error("CHATGPT_EFFORT_POSTCONDITION_FAILED");
        return {
          ...(value.result as DelegateChatConfigResult),
          requested_effort: input.effort,
          applied_effort: String(post.status || post.label || input.effort),
          effort_control: "power-keyboard",
        };
      }
      const code = typeof value.code === "string" && /^[A-Z0-9_]+$/.test(value.code)
        ? value.code : "CHATGPT_CONFIG_FAILED";
      const available = Array.isArray(value.available)
        ? " available=" + value.available.slice(0, 12).join(" | ") : "";
      throw new Error(code + available);
    }
    return value.result as DelegateChatConfigResult;
  } finally {
    try { await delegateCdpTransport.detach(target, signal); } catch {}
  }
}

export type DelegateChatConfigInspection = Readonly<{
  controls: Array<Readonly<{
    text: string;
    aria: string | null;
    testid: string | null;
    title: string | null;
  }>>;
  model_candidates: string[];
  effort_candidates: string[];
  effort_menu_candidates?: string[];
  effort_surface_debug?: Array<Readonly<{
    tag: string;
    role: string | null;
    aria: string | null;
    text: string;
    state: string | null;
  }>>;
  effort_status_path?: Array<Readonly<{
    tag: string;
    role: string | null;
    aria: string | null;
    text: string;
    tabindex: string | null;
  }>>;
}>;

const INSPECT_CONFIG_SCRIPT = String.raw`(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = node => {
    if (!(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" ||
        Number(style.opacity || 1) === 0) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const clean = value => String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const selectors =
    'button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="radio"]';
  const rows = () => Array.from(document.querySelectorAll(selectors))
    .filter(visible).slice(0, 180).map(node => ({
      text: clean(node.innerText || node.textContent),
      aria: node.getAttribute("aria-label"),
      testid: node.getAttribute("data-testid"),
      title: node.getAttribute("title"),
      role: node.getAttribute("role"),
      expanded: node.getAttribute("aria-expanded"),
    }));
  const label = row => clean(row.aria || row.testid || row.title || row.text);
  const before = rows();
  const liveNodes = () => Array.from(document.querySelectorAll(selectors)).filter(visible);
  const modelNode = liveNodes().find(node => {
    const full = clean(node.innerText || node.textContent).toLowerCase();
    const aria = clean(node.getAttribute("aria-label")).toLowerCase();
    return aria.includes("select chatgpt model") ||
      full.includes("thinking effort") || full.includes("reasoning effort");
  });
  let effortMenu = [];
  if (modelNode) {
    if (modelNode.getAttribute("aria-expanded") !== "true") {
      modelNode.click();
      await sleep(220);
    }
    const nested = liveNodes().find(node => {
      const aria = clean(node.getAttribute("aria-label")).toLowerCase();
      const full = clean(node.innerText || node.textContent).toLowerCase();
      return aria === "select model" ||
        (node.getAttribute("role") === "menuitem" &&
         /(^|\s)(low|medium|high|extra high|xhigh)(\s|$)/i.test(full));
    });
    if (nested) {
      nested.click();
      await sleep(260);
      effortMenu = rows()
        .filter(row => ["menuitem","menuitemradio","option","radio"].includes(String(row.role)))
        .map(label)
        .filter(Boolean);
    }
    if (modelNode.getAttribute("aria-expanded") === "true") {
      modelNode.click();
      await sleep(80);
    }
  }
  const statusNode = Array.from(document.querySelectorAll('[role="status"]'))
    .filter(visible).find(node =>
      /\d+\s+of\s+\d+/i.test(clean(node.innerText || node.textContent)));
  const effortStatusPath = [];
  let cursor = statusNode;
  for (let depth = 0; cursor && depth < 7; depth++, cursor = cursor.parentElement) {
    effortStatusPath.push({
      tag: cursor.tagName.toLowerCase(),
      role: cursor.getAttribute("role"),
      aria: cursor.getAttribute("aria-label"),
      text: clean(cursor.innerText || cursor.textContent).slice(0, 180),
      tabindex: cursor.getAttribute("tabindex"),
    });
  }
  const effortSurfaceDebug = Array.from(document.querySelectorAll(
    '[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper],'+
    '[data-headlessui-state~="open"],[data-state="open"]'
  )).filter(visible).flatMap(surface =>
    Array.from(surface.querySelectorAll('*')).filter(node =>
      visible(node) && clean(node.innerText || node.textContent).length > 0 &&
      clean(node.innerText || node.textContent).length <= 120
    ).slice(0, 80).map(node => ({
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute("role"),
      aria: node.getAttribute("aria-label"),
      text: clean(node.innerText || node.textContent),
      state: node.getAttribute("data-state"),
    }))
  ).slice(0, 160);
  return {
    controls: before,
    model_candidates: before.map(label).filter(text =>
      /(model|gpt|chatgpt|instant|thinking|pro|auto|work)/i.test(text)).slice(0, 100),
    effort_candidates: before.map(label).filter(text =>
      /(effort|reasoning|thinking|low|medium|high|extra high|xhigh)/i.test(text)).slice(0, 100),
    effort_menu_candidates: [...new Set(effortMenu)].slice(0, 80),
    effort_surface_debug: effortSurfaceDebug,
    effort_status_path: effortStatusPath,
  };
})()`;

export async function inspectDelegateChatConfigurationOnLockedTarget(
  clientId: string,
  tabId: number,
  signal?: AbortSignal,
): Promise<DelegateChatConfigInspection> {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(clientId) ||
      !Number.isSafeInteger(tabId) || tabId < 1)
    throw new Error("DELEGATE_CONFIG_TARGET_INVALID");
  const target: BrowserTargetRef = {
    kind: "delegate", connectionId: clientId, targetId: "tab:" + tabId, tabId,
  };
  await delegateCdpTransport.attach(target, signal);
  try {
    const evaluated: any = await delegateCdpTransport.command(
      target,
      "Runtime.evaluate",
      {
        expression: INSPECT_CONFIG_SCRIPT,
        returnByValue: true,
        awaitPromise: true,
      },
      signal,
      { trustedGenerated: true },
    );
    if (evaluated?.exceptionDetails) throw new Error("CHATGPT_CONFIG_INSPECT_FAILED");
    const value = evaluated?.result?.value;
    if (!value || typeof value !== "object") throw new Error("CHATGPT_CONFIG_INSPECT_INVALID_RESPONSE");
    return value as DelegateChatConfigInspection;
  } finally {
    try { await delegateCdpTransport.detach(target, signal); } catch {}
  }
}
