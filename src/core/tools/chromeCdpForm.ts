/**
 * chromeCdpForm.ts — Form diagnostics and atomic custom dropdown selection for CDP.
 *
 * Provides:
 * 1. executeSelectOptionCommand: Atomically opens, searches, and selects options
 *    in custom headless UI dropdowns (Radix, Shadcn, Select2, React-Select) or native <select>.
 * 2. executeCheckFormCommand: Pre-flight readiness audit identifying unfilled required fields,
 *    validation errors, and submit button status before form submission.
 */

import type { CdpTarget } from "./chromeCdpHelpers.js";
import { resolveActionSelector, parseTimeoutMs, waitForInPage } from "./chromeCdpHelpers.js";

/**
 * Builds the browser-side evaluation script for atomic custom or native dropdown option selection.
 */
export function buildSelectOptionJs(
  selector: string,
  targetOption: string | number,
  exact: boolean = false,
  waitMs: number = 2000
): string {
  const jsonSelector = JSON.stringify(selector);
  const jsonTarget = JSON.stringify(String(targetOption));
  const isTargetNum = typeof targetOption === "number";

  return `(() => {
    return new Promise((resolve) => {
      const trigger = document.querySelector(${jsonSelector});
      if (!trigger) {
        return resolve(JSON.stringify({ ok: false, reason: "Trigger element not found: " + ${jsonSelector} }));
      }

      // 1. Native <select> handling
      if (trigger.tagName.toLowerCase() === "select") {
        const sel = trigger;
        const options = Array.from(sel.options);
        if (options.length === 0) {
          return resolve(JSON.stringify({ ok: false, reason: "Native select element contains 0 options.", availableOptions: [] }));
        }

        let matchIdx = -1;
        ${
          isTargetNum
            ? `matchIdx = ${Number(targetOption)};`
            : `
        const targetStr = ${jsonTarget}.trim().toLowerCase();
        matchIdx = options.findIndex((opt, idx) => {
          const text = (opt.textContent || opt.text || "").trim().toLowerCase();
          const val = (opt.value || "").trim().toLowerCase();
          return ${exact} ? (text === targetStr || val === targetStr) : (text.includes(targetStr) || val.includes(targetStr));
        });
        `
        }

        if (matchIdx >= 0 && matchIdx < options.length) {
          sel.selectedIndex = matchIdx;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return resolve(JSON.stringify({
            ok: true,
            type: "native",
            selected: options[matchIdx].text || options[matchIdx].value,
            selectedIndex: matchIdx,
            availableCount: options.length,
          }));
        }

        return resolve(JSON.stringify({
          ok: false,
          reason: "Option not found in native select: " + ${jsonTarget},
          availableOptions: options.map(o => o.text || o.value).slice(0, 15),
        }));
      }

      // 2. Custom headless / Radix / Shadcn / ARIA dropdown handling
      const isAlreadyExpanded = trigger.getAttribute("aria-expanded") === "true";
      if (!isAlreadyExpanded) {
        trigger.scrollIntoView({ block: "nearest" });
        if (typeof trigger.focus === "function") trigger.focus();
        trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        trigger.click();
      }

      const startTime = Date.now();
      const pollInterval = 100;
      const maxWait = ${waitMs};

      const checkOverlay = () => {
        // Collect candidate options in common overlay containers
        const optionSelectors = [
          '[role="option"]',
          '[role="menuitem"]',
          '[role="menuitemradio"]',
          '[data-radix-collection-item]',
          '[data-radix-select-item]',
          '.select__option',
          '.ant-select-item-option-content',
          'ul[role="listbox"] > li',
          'div[role="listbox"] > div'
        ];

        let items = [];
        for (const s of optionSelectors) {
          const found = Array.from(document.querySelectorAll(s)).filter((el) => {
            const style = window.getComputedStyle(el);
            return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
          });
          if (found.length > 0) {
            items = found;
            break;
          }
        }

        if (items.length > 0) {
          const itemSummaries = items.map((it) => {
            const text = (it.innerText || it.textContent || it.getAttribute("data-value") || it.getAttribute("value") || "").trim();
            const val = (it.getAttribute("data-value") || it.getAttribute("value") || text).trim();
            return { el: it, text, val };
          });

          let matched = null;
          ${
            isTargetNum
              ? `
          const idx = ${Number(targetOption)};
          if (idx >= 0 && idx < itemSummaries.length) {
            matched = itemSummaries[idx];
          }
          `
              : `
          const targetStr = ${jsonTarget}.trim().toLowerCase();
          matched = itemSummaries.find((it) => {
            const t = it.text.toLowerCase();
            const v = it.val.toLowerCase();
            return ${exact} ? (t === targetStr || v === targetStr) : (t.includes(targetStr) || v.includes(targetStr));
          });
          `
          }

          if (matched) {
            matched.el.scrollIntoView({ block: "nearest" });
            matched.el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
            matched.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            matched.el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            matched.el.click();
            return resolve(JSON.stringify({
              ok: true,
              type: "custom",
              selected: matched.text || matched.val,
              availableCount: items.length,
            }));
          }

          // If overlay opened but option didn't match
          return resolve(JSON.stringify({
            ok: false,
            reason: "Option '" + ${jsonTarget} + "' not found in dropdown.",
            availableOptions: itemSummaries.map((i) => i.text).filter(Boolean).slice(0, 20),
            availableCount: itemSummaries.length,
          }));
        }

        if (Date.now() - startTime >= maxWait) {
          return resolve(JSON.stringify({
            ok: false,
            reason: "Dropdown opened but no selectable options appeared within " + maxWait + "ms (empty list or slow render).",
            availableOptions: [],
            availableCount: 0,
          }));
        }

        setTimeout(checkOverlay, pollInterval);
      };

      setTimeout(checkOverlay, 100);
    });
  })()`;
}

/**
 * Builds the browser-side evaluation script for inspecting form readiness and validation.
 */
export function buildCheckFormJs(formSelector?: string): string {
  const jsonSelector = formSelector ? JSON.stringify(formSelector) : "null";

  return `(() => {
    const root = ${jsonSelector} ? document.querySelector(${jsonSelector}) : document;
    if (!root) {
      return JSON.stringify({ ok: false, reason: "Form root element not found: " + ${jsonSelector} });
    }

    const fieldElements = Array.from(root.querySelectorAll("input, select, textarea, [role='combobox']"));
    const fields = [];
    const missingRequired = [];

    for (const el of fieldElements) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();

      // Skip non-interactive or hidden fields
      if (type === "hidden" || type === "submit" || type === "button" || type === "reset" || type === "image") continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;

      const id = el.id || "";
      const name = el.getAttribute("name") || "";
      let label = "";

      if (id) {
        const lblEl = document.querySelector("label[for='" + CSS.escape(id) + "']");
        if (lblEl) label = (lblEl.innerText || lblEl.textContent || "").trim();
      }
      if (!label && el.closest("label")) {
        label = (el.closest("label").innerText || el.closest("label").textContent || "").trim();
      }
      if (!label) {
        label = el.getAttribute("aria-label") || el.getAttribute("placeholder") || name || id || "";
      }

      const isRequired = Boolean(
        el.required ||
        el.getAttribute("required") !== null ||
        el.getAttribute("aria-required") === "true" ||
        el.getAttribute("data-required") === "true"
      );

      const val = tag === "select"
        ? (el.selectedIndex >= 0 && el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : "")
        : (el.value !== undefined ? String(el.value) : (el.innerText || "").trim());

      const isEmpty = !val || !val.trim();
      const isDisabled = Boolean(el.disabled || el.getAttribute("aria-disabled") === "true");
      const isValid = typeof el.checkValidity === "function" ? el.checkValidity() : (isRequired ? !isEmpty : true);
      const validationMessage = el.validationMessage || (el.getAttribute("aria-invalid") === "true" ? "Invalid value" : "");

      const fieldInfo = {
        tag,
        type: type || (tag === "select" ? "select" : "text"),
        id,
        name,
        label,
        required: isRequired,
        value: val ? (type === "password" ? "••••••••" : val.slice(0, 80)) : "",
        isEmpty,
        isValid,
        disabled: isDisabled,
        validationMessage,
      };

      fields.push(fieldInfo);

      if (isRequired && (isEmpty || !isValid)) {
        missingRequired.push(fieldInfo);
      }
    }

    // Inspect visible validation errors
    const errorSelectors = [
      '[role="alert"]',
      '.error-message',
      '.text-red-500',
      '.text-danger',
      '.invalid-feedback',
      '[data-error]'
    ];
    const visibleErrors = [];
    for (const s of errorSelectors) {
      const errNodes = Array.from(root.querySelectorAll(s));
      for (const en of errNodes) {
        const text = (en.innerText || en.textContent || "").trim();
        if (text && !visibleErrors.includes(text) && text.length < 150) {
          const style = window.getComputedStyle(en);
          if (style.display !== "none" && style.visibility !== "hidden") {
            visibleErrors.push(text);
          }
        }
      }
    }

    // Inspect submit buttons
    const submitBtnCandidates = Array.from(root.querySelectorAll("button[type='submit'], input[type='submit'], button"));
    const submitButtons = [];
    for (const btn of submitBtnCandidates) {
      const text = (btn.innerText || btn.textContent || btn.value || "").trim();
      const isExplicitSubmit = btn.type === "submit";
      const isSubmitKeyword = /submit|kirim|bayar|beli|checkout|lanjut|save|simpan|pesan|register|daftar/i.test(text);

      if (isExplicitSubmit || isSubmitKeyword) {
        const isDisabled = Boolean(btn.disabled || btn.getAttribute("aria-disabled") === "true" || btn.classList.contains("disabled"));
        submitButtons.push({
          text: text || "Submit",
          disabled: isDisabled,
          type: btn.type || "button",
        });
      }
    }

    const readyToSubmit = missingRequired.length === 0 && visibleErrors.length === 0 && submitButtons.some(b => !b.disabled);

    return JSON.stringify({
      ok: true,
      readyToSubmit,
      status: readyToSubmit ? "READY" : "INCOMPLETE",
      fieldCount: fields.length,
      filledCount: fields.filter(f => !f.isEmpty).length,
      missingRequiredCount: missingRequired.length,
      missingRequired,
      visibleErrors,
      submitButtons,
    });
  })()`;
}

/**
 * Executes the 'select_option' command via CDP.
 */
export async function executeSelectOptionCommand(
  cdpSend: (target: CdpTarget, method: string, params?: Record<string, unknown>) => Promise<unknown>,
  target: CdpTarget,
  payload: Record<string, unknown>
): Promise<string> {
  const resolved = resolveActionSelector(payload, target.id);
  if ("error" in resolved) return resolved.error;

  const rawOption = payload.option ?? payload.value ?? payload.optionText ?? payload.text ?? payload.optionIndex;
  if (rawOption === undefined || rawOption === "") {
    return 'control_chrome_cdp failed: command \'select_option\' needs "option" or "value" (e.g. {"index": 5, "option": "Paket Basic"}).';
  }

  const exact = Boolean(payload.exact);
  const waitMs = parseTimeoutMs(payload.timeout_ms || payload.wait_ms, 3000);

  const res: any = await cdpSend(target, "Runtime.evaluate", {
    expression: buildSelectOptionJs(resolved.selector, rawOption as any, exact, waitMs),
    returnByValue: true,
    awaitPromise: true,
  });

  const val = res && res.result ? res.result.value : undefined;
  let parsed: any = null;
  try {
    parsed = typeof val === "string" ? JSON.parse(val) : val;
  } catch {
    return `control_chrome_cdp: select_option returned unparseable result: ${String(val)}`;
  }

  if (!parsed || !parsed.ok) {
    let msg = `control_chrome_cdp: select_option failed — ${parsed?.reason || "unknown reason"}.`;
    if (parsed?.availableOptions && Array.isArray(parsed.availableOptions) && parsed.availableOptions.length > 0) {
      msg += `\nAvailable options: ${parsed.availableOptions.map((o: string) => `"${o}"`).join(", ")}`;
    }
    return msg;
  }

  return `control_chrome_cdp: selected option "${parsed.selected}" via ${parsed.type} dropdown (${parsed.availableCount} options available).`;
}

/**
 * Executes the 'check_form' command via CDP.
 */
export async function executeCheckFormCommand(
  cdpSend: (target: CdpTarget, method: string, params?: Record<string, unknown>) => Promise<unknown>,
  target: CdpTarget,
  payload: Record<string, unknown>
): Promise<string> {
  const formSelector = payload.selector ? String(payload.selector) : undefined;

  const res: any = await cdpSend(target, "Runtime.evaluate", {
    expression: buildCheckFormJs(formSelector),
    returnByValue: true,
  });

  const val = res && res.result ? res.result.value : undefined;
  let parsed: any = null;
  try {
    parsed = typeof val === "string" ? JSON.parse(val) : val;
  } catch {
    return `control_chrome_cdp: check_form returned unparseable result: ${String(val)}`;
  }

  if (!parsed || !parsed.ok) {
    return `control_chrome_cdp: check_form failed — ${parsed?.reason || "unknown reason"}.`;
  }

  const lines: string[] = [
    `[Form Readiness Check] Status: ${parsed.status} (${parsed.filledCount}/${parsed.fieldCount} fields filled)`,
  ];

  if (parsed.missingRequired && parsed.missingRequired.length > 0) {
    lines.push(`\nUnfilled / Invalid Required Fields (${parsed.missingRequired.length}):`);
    for (const f of parsed.missingRequired) {
      const identifier = f.label || f.name || f.id || `<${f.tag}>`;
      const issue = f.validationMessage ? `INVALID (${f.validationMessage})` : "EMPTY";
      lines.push(`  - <${f.tag} type="${f.type}"> "${identifier}": ${issue}`);
    }
  } else {
    lines.push("\nAll required fields are completed.");
  }

  if (parsed.visibleErrors && parsed.visibleErrors.length > 0) {
    lines.push(`\nVisible Page Validation Errors:`);
    for (const err of parsed.visibleErrors) {
      lines.push(`  - "${err}"`);
    }
  }

  if (parsed.submitButtons && parsed.submitButtons.length > 0) {
    lines.push(`\nSubmit Button Status:`);
    for (const btn of parsed.submitButtons) {
      lines.push(`  - "${btn.text}": ${btn.disabled ? "DISABLED" : "ENABLED (Ready to click)"}`);
    }
  }

  if (parsed.readyToSubmit) {
    lines.push(`\nVerdict: Form is completely filled and ready for submission.`);
  } else {
    lines.push(`\nVerdict: Form is not ready. Complete the missing required fields before clicking submit.`);
  }

  return lines.join("\n");
}
