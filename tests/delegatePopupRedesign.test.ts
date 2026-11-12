import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const root = "chrome-extension-delegate/";
const html = readFileSync(root + "popup.html", "utf8");
const css = readFileSync(root + "popup.css", "utf8");
const js = readFileSync(root + "popup.js", "utf8");
const manifest = JSON.parse(readFileSync(root + "manifest.json", "utf8"));

describe("SuperAgent Delegate compact popup redesign", () => {
  it("preserves all original controls and introduces accessible three-view navigation", () => {
    const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "enabled", "cdp-enabled", "status-dot", "status-pill", "status-heading",
      "status-description", "reconnect", "error-info", "action-note",
      "profile-label", "save-label", "pairing-key", "save-pairing", "auth-state",
      "tab-list", "open-chat-tab", "connections", "connection-count", "tab-status",
      "request-status", "client-id", "last-connected", "extension-version",
      "tab-count", "cdp-count", "profile-summary",
    ]) expect(ids).toContain(id);

    for (const view of ["overview", "tabs", "settings"]) {
      expect(html).toContain('id="tab-' + view + '"');
      expect(html).toContain('aria-controls="panel-' + view + '"');
      expect(html).toContain('id="panel-' + view + '" role="tabpanel"');
      expect(js).toContain('const VIEWS = ["overview", "tabs", "settings"]');
    }
    expect(html).toContain('role="tablist"');
    expect(js).toContain('button.setAttribute("aria-selected", String(active))');
    expect(js).toContain('event.key === "ArrowRight"');
    expect(js).toContain('event.key === "ArrowLeft"');
    expect(js).toContain('event.key === "Home"');
    expect(js).toContain('event.key === "End"');
  });

  it("separates status, tabs and settings without widening permissions or navigating automatically", () => {
    expect(html).toContain('id="status-heading"');
    expect(html).toContain('id="cdp-status"');
    expect(html).toContain('id="tab-status"');
    expect(js).toContain('$("tab-count").textContent = String(checked.length)');
    expect(js).toContain('$("cdp-count").textContent');
    expect(js).toContain('renderExtensionVersion()');
    expect(js).toContain('chrome.runtime.getManifest().version');
    expect(manifest.version).toBe("1.10.1");
    expect(manifest.host_permissions).toEqual(["https://chatgpt.com/*", "http://127.0.0.1/*"]);
    expect(manifest.permissions).toEqual(["tabs", "alarms", "storage", "scripting", "debugger"]);
    const viewCode = js.slice(js.indexOf("function activateView("), js.indexOf("function displayTime("));
    expect(viewCode).not.toMatch(/chrome\.(tabs|runtime|debugger)/);
    expect(viewCode).not.toMatch(/window\.location|reload\(/);
  });

  it("keeps the existing optional Ko-fi donation link visible but unobtrusive", () => {
    const tray = readFileSync("apps/superagent-tray/ui/index.html", "utf8");
    expect(tray).toContain('href="https://ko-fi.com/rudycity"');
    expect(html).toContain('id="delegate-donate-link"');
    expect(html).toContain('href="https://ko-fi.com/rudycity"');
    expect(html).toMatch(/id="delegate-donate-link"[\s\S]*?target="_blank" rel="noopener noreferrer"/);
    expect(css).toContain(".donate-link:focus-visible");
    expect(css).toContain(".footer-bottom");
  });

  it("uses consistent dark tokens, focus and bounded popup scrolling", () => {
    expect(css).toContain("--canvas:");
    expect(css).toContain("--accent:");
    expect(css).toContain("--font-ui:");
    // Chrome's action-popup measures an intrinsic width. During bootstrap its
    // viewport may start at just ~56px; 100vw media rules collapse the popup.
    expect(css).toMatch(/html, body\s*\{[^}]*width:\s*392px;[^}]*min-width:\s*392px;[^}]*max-width:\s*392px;/s);
    expect(css).not.toContain("width: 100vw");
    expect(css).not.toMatch(/@media\s*\(max-width:\s*375px\)/);
    expect(css).toContain("overflow-x: clip");
    expect(css).toContain("max-height: 590px");
    expect(css).toContain(".page-content { flex: 1; min-height: 0; overflow-y: auto");
    expect(css).toContain("button:focus-visible");
    expect(css).toContain("input:focus-visible");
    expect(css).toContain("[hidden] { display: none !important; }");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
    expect(css).not.toMatch(/@import/);
  });
});
