import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const dir = dirname(fileURLToPath(import.meta.url));
const css = await readFile(join(dir, "content.css"), "utf8");
const policy = await readFile(join(dir, "policy.js"), "utf8");
const content = await readFile(join(dir, "content.js"), "utf8");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const turns = Array.from({ length: 60 }, (_, i) =>
    '<article data-testid="conversation-turn-' + i + '" style="min-height:520px;padding:16px;border-bottom:1px solid #ddd">' +
    '<div class="message">Chat message ' + i + '</div></article>'
  ).join("");
  await page.setContent('<!doctype html><html><body><main id="conversation">' + turns + '</main></body></html>');
  await page.evaluate(() => {
    Object.defineProperty(window, "chrome", {
      configurable: true,
      value: {
        runtime: { id: "render-test", onMessage: {
          addListener(fn) { window.__optimizerProbe = fn; },
        } },
        storage: {
          local: { async get() {
            return { superagentChatGPTLiteSettings: { enabled: true, mode: "render", keepLast: 24 } };
          } },
          onChanged: { addListener(fn) { window.__optimizerSettings = fn; } },
        },
      },
    });
  });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: policy });
  await page.addScriptTag({ content });
  await page.waitForFunction(() => document.querySelectorAll('[data-sg-lite-render="1"]').length === 56);
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const initial = await page.evaluate(() => {
    let result;
    window.__optimizerProbe(
      { scope: "superagent-chatgpt-lite-v1", action: "status" },
      { id: "render-test" }, (value) => { result = value; }
    );
    const targets = [...document.querySelectorAll('[data-sg-lite-render="1"]')];
    const actual = targets.map((node) => ({
      css: getComputedStyle(node).contentVisibility,
      // Content-visibility:auto can preserve the element's own layout box.
      // Query a child to detect whether the subtree was skipped offscreen.
      skipped: !!node.firstElementChild &&
        typeof node.firstElementChild.checkVisibility === "function" &&
        !node.firstElementChild.checkVisibility({ contentVisibilityAuto: true }),
    }));
    return {
      state: result.state,
      targets: targets.length,
      cssAuto: actual.filter((item) => item.css === "auto").length,
      skipped: actual.filter((item) => item.skipped).length,
      lastFourProtected: [...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
        .slice(-4).every((node) => !node.hasAttribute("data-sg-lite-render")),
    };
  });
  assert.equal(initial.state.renderState, "verified");
  assert.ok(initial.state.skippedSamples > 0,
    "Diagnostic should report real offscreen skips in Chromium");
  assert.equal(initial.targets, 56);
  assert.equal(initial.cssAuto, 56);
  assert.ok(initial.skipped > 0, "At least one offscreen turn should be skipped by Chromium");
  assert.equal(initial.lastFourProtected, true);
  const afterPolling = await page.evaluate(() => {
    for (let i = 0; i < 12; i++) {
      window.__optimizerProbe(
        { scope: "superagent-chatgpt-lite-v1", action: "status" },
        { id: "render-test" }, () => {}
      );
    }
    return [...document.querySelectorAll('[data-sg-lite-render="1"]')].length;
  });
  assert.equal(afterPolling, 56);

  await page.evaluate(() => {
    const last = document.querySelector('[data-testid="conversation-turn-59"]');
    for (let i = 0; i < 100; i++) {
      const part = document.createElement("span");
      part.textContent = " stream";
      last.append(part);
    }
  });
  await page.waitForTimeout(820);
  const streamingCount = await page.evaluate(() => {
    let response;
    window.__optimizerProbe(
      { scope: "superagent-chatgpt-lite-v1", action: "status" },
      { id: "render-test" }, (value) => { response = value; }
    );
    return response.state.scanCount;
  });
  assert.equal(streamingCount, initial.state.scanCount,
    "Streaming inline spans must not rescan the entire chat");

  await page.evaluate(() => {
    const fresh = document.createElement("article");
    fresh.setAttribute("data-testid", "conversation-turn-60");
    fresh.textContent = "New ChatGPT message";
    document.getElementById("conversation").append(fresh);
  });
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-sg-lite-render="1"]').length === 57,
    null, { timeout: 5000 });
  const afterNewTurn = await page.evaluate(() => {
    let response;
    window.__optimizerProbe(
      { scope: "superagent-chatgpt-lite-v1", action: "status" },
      { id: "render-test" }, (value) => { response = value; }
    );
    return response.state;
  });
  assert.equal(afterNewTurn.total, 61);
  assert.equal(afterNewTurn.optimized, 57);

  await page.evaluate(() => {
    window.__optimizerSettings({
      superagentChatGPTLiteSettings: {
        newValue: { enabled: false, mode: "render" },
      },
    }, "local");
  });
  const remaining = await page.locator('[data-sg-lite-render="1"], [data-sg-lite-hidden="1"]').count();
  assert.equal(remaining, 0, "Disable should remove all optimization attributes");
  assert.equal(await page.locator('[data-testid^="conversation-turn-"]').count(), 61,
    "No React-owned DOM turns should be deleted");

  console.log(JSON.stringify({
    chromium: browser.version(),
    initial: { optimized: initial.targets, cssAuto: initial.cssAuto,
      offscreenSkipped: initial.skipped, scanCount: initial.state.scanCount },
    streaming: { scanCount: streamingCount },
    afterNewTurn: { optimized: afterNewTurn.optimized, total: afterNewTurn.total },
    disabled: { staleAttributes: remaining, retainedTurns: 61 },
    result: "PASS",
  }, null, 2));
} finally {
  await browser.close();
}
