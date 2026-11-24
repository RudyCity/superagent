import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const trayUi = "apps/superagent-tray/ui";
const manager = fs.readFileSync(path.join(trayUi, "desktop-live-manager.js"), "utf8");
const app = fs.readFileSync(path.join(trayUi, "app.js"), "utf8");
const html = fs.readFileSync(path.join(trayUi, "index.html"), "utf8");
const permissionNavigation = manager.match(
  /function installPermissionNavigation\(\) \{[\s\S]*?\n  \}/,
)?.[0] ?? "";

describe("Desktop Live permission navigation", () => {
  it("adds a direct Access Manager shortcut beside the session refresh action", () => {
    expect(permissionNavigation).toContain('node("a","button secondary","Manage permissions")');
    expect(permissionNavigation).toContain('link.href="#security"');
    expect(permissionNavigation).toContain('header.insertBefore(link,refreshButton)');
    expect(manager).toContain("installPermissionNavigation();");
    expect(html).toContain('id="page-security"');
    expect(app).toContain('window.addEventListener("hashchange"');
    expect(app).toContain("navigateToPage(hash)");
  });

  it("keeps the shortcut navigation-only and does not grant desktop permissions", () => {
    expect(permissionNavigation).not.toContain("invoke(");
    expect(permissionNavigation).not.toContain("trust_desktop_input_window");
    expect(permissionNavigation).not.toContain("set_desktop_input_mode");
  });
});
