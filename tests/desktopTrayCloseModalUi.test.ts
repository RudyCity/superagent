import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

describe("SuperAgent Tray Close Options Modal", () => {
  it("includes modal stylesheet and script in index.html", () => {
    const html = readFileSync("apps/superagent-tray/ui/index.html", "utf8");

    expect(html).toContain('<link rel="stylesheet" href="./close-modal.css" />');
    expect(html).toContain('<script src="./close-modal.js" defer></script>');
  });

  it("contains the close options modal markup with both choices and cancel", () => {
    const html = readFileSync("apps/superagent-tray/ui/index.html", "utf8");

    // Modal dialog structure
    expect(html).toContain('id="close-options-dialog"');
    expect(html).toContain('class="modal-dialog close-options-modal"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('id="close-options-title"');
    expect(html).toContain("Close SuperAgent");

    // Option 1: Close Tray Only
    expect(html).toContain('id="close-option-tray-card"');
    expect(html).toContain('id="btn-close-tray"');
    expect(html).toContain("Close Tray Only");

    // Option 2: Close Complete All Daemon
    expect(html).toContain('id="close-option-daemon-card"');
    expect(html).toContain('id="btn-close-complete-daemon"');
    expect(html).toContain("Close Complete All Daemon");

    // Progress and Cancel
    expect(html).toContain('id="close-options-progress"');
    expect(html).toContain('id="close-options-status-text"');
    expect(html).toContain('id="close-options-cancel"');
    expect(html).toContain('id="close-options-dismiss"');
  });

  it("provides anti-slop cyberpunk HUD styling in close-modal.css", () => {
    expect(existsSync("apps/superagent-tray/ui/close-modal.css")).toBe(true);
    const css = readFileSync("apps/superagent-tray/ui/close-modal.css", "utf8");

    expect(css).toContain(".close-options-modal");
    expect(css).toContain(".close-options-grid");
    expect(css).toContain(".close-option-card.close-option-tray");
    expect(css).toContain(".close-option-card.close-option-daemon");
    expect(css).toContain(".close-btn-secondary");
    expect(css).toContain(".close-btn-danger");
    expect(css).toContain(".close-options-spinner");
    expect(css).toContain("@keyframes closeSpin");
  });

  it("implements modal controller logic in close-modal.js", () => {
    expect(existsSync("apps/superagent-tray/ui/close-modal.js")).toBe(true);
    const js = readFileSync("apps/superagent-tray/ui/close-modal.js", "utf8");

    expect(js).toContain("window.__superagentOpenCloseModal = open;");
    expect(js).toContain("window.__superagentCloseCloseModal = close;");
    expect(js).toContain("desktop-request-close-modal");
    expect(js).toContain("drain_all_services");
    expect(js).toContain("quit-app");
    expect(js).toContain("executeCloseTray");
    expect(js).toContain("executeCloseCompleteDaemon");
  });

  it("intercepts titlebar close button in titlebar.js to show modal", () => {
    const titlebarJs = readFileSync("apps/superagent-tray/ui/titlebar.js", "utf8");

    expect(titlebarJs).toContain("__superagentOpenCloseModal");
  });

  it("supports quit-app and hide in main.rs tray_window_action", () => {
    const mainRs = readFileSync("apps/superagent-tray/src-tauri/src/main.rs", "utf8");

    expect(mainRs).toContain('"quit-app" =>');
    expect(mainRs).toContain('"hide" =>');
  });
});
