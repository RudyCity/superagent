import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Script } from "node:vm";

const ui = path.resolve("apps/superagent-lan-windows/ui");
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const js = fs.readFileSync(path.join(ui, "app.js"), "utf8");
const css = fs.readFileSync(path.join(ui, "styles.css"), "utf8");
const rust = fs.readFileSync(path.resolve("apps/superagent-lan-windows/src-tauri/src/main.rs"), "utf8");
const engine = fs.readFileSync(path.resolve("src/lanClientGui.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.resolve("apps/superagent-lan-windows/src-tauri/tauri.conf.json"), "utf8"));

describe("Native Windows LAN Client", () => {
  it("exposes every expected GUI action and uses accessible modal consent", () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const match of js.matchAll(/\$\("([a-z][a-z0-9-]+)"\)/g)) {
      expect(ids, "Referenced UI control missing: " + match[1]).toContain(match[1]);
    }
    for (const id of ["camera-btn", "qr-file", "connect-btn", "approve", "deny",
      "share-file", "share-folder", "stop", "revoke", "disconnect"]) {
      expect(ids).toContain(id);
    }
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-live="polite"');
    expect(js).toContain('event.key === "Escape"');
  });
  it("does not auto-run receiver and only invokes fixed Rust permissions", () => {
    expect(() => new Script(js)).not.toThrow();
    expect(js).toContain('addEventListener("click"');
    expect(js).toContain('invoke("start_client"');
    expect(js).toContain('invoke("scan_qr_frame"');
    expect(js).toContain('invoke("select_share"');
    expect(rust).toContain('command.arg("--tauri-receiver")');
    expect(rust).toContain('ref mut old');
    expect(rust).toContain('scan_qr_frame');
    expect(rust).toContain('terminate_owned(&mut child)');
    expect(rust).toContain('client_path(&app)');
    expect(engine).toContain('requireUnprivileged()');
    expect(engine).toContain('!process.argv.includes("--tauri-receiver")');
    expect(engine).toContain('--list-adapters');
    expect(rust).toContain('JobGuard::attach(&mut child)');
    expect(rust).toContain('SUPERAGENT_LAN_BINARY_SHA256');
    expect(rust).toContain('tauri_plugin_notification::init()');
    expect(engine).toContain('Approval no longer pending.');
    expect(engine).toContain('approval_expired');
    expect(engine).not.toContain("execSync(");
  });
  it("packages a private local WebView and Windows Bun receiver executable", () => {
    expect(manifest.identifier).toBe("click.superagent.lanclient");
    expect(manifest.build.frontendDist).toBe("../ui");
    expect(manifest.bundle.resources["resources/superagent-lan-client.exe"])
      .toBe("binaries/superagent-lan-client.exe");
    expect(manifest.bundle.targets).toContain("nsis");
    const capabilities = JSON.parse(fs.readFileSync(path.resolve("apps/superagent-lan-windows/src-tauri/capabilities/default.json"), "utf8"));
    expect(capabilities.permissions).not.toContain("shell:default");
    expect(capabilities.permissions).not.toContain("fs:default");
    expect(capabilities.permissions).toContain("core:event:allow-listen");
    expect(manifest.app.security.csp).not.toContain("unsafe-eval");
  });
  it("has valid responsive CSS with reduced motion-independent button states", async () => {
    const { transform } = await import("lightningcss");
    const checked = transform({
      filename: "windows-gui.css", code: Buffer.from(css),
      minify: true, targets: { chrome: 120 << 16 },
    });
    expect(checked.warnings).toEqual([]);
    expect(css).toContain("@media(max-width:900px)");
    expect(css).toContain(":focus-visible");
    expect(css).toContain(":disabled");
    expect(css).toContain(".consent-overlay");
  });
});
