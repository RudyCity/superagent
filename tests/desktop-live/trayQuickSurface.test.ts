import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const read=(p:string)=>readFileSync(resolve(process.cwd(),p),"utf8");

describe("Quick Tunnel is a separate Tray UI mode and not MCP reuse",()=>{
  it("shows Named/Quick selection, ephemeral link and an origin port without frame controls",()=>{
    const html=read("apps/superagent-tray/ui/index.html");
    const ui=read("apps/superagent-tray/ui/tray-access-password.js");
    expect(html).toContain('id="tray-remote-mode"');
    expect(html).toContain('<option value="quick">');
    expect(html).toContain('<option value="named">');
    expect(html).toContain('id="tray-remote-public-url"');
    expect(ui).toContain('"gateway-start-quick"');
    expect(ui).toContain('payload={publicOrigin:normalized,originPort:port}');
    expect(ui).toContain('payload={originPort:port}');
    expect(ui).not.toContain("captureJpeg");
  });
  it("only allows exact native Tray IPC to the local management API",()=>{
    const rust=read("apps/superagent-tray/src-tauri/src/main.rs");
    const core=read("src/serverRoutes.ts");
    const quick=read("src/core/desktopUi/trayQuickTunnel.ts");
    expect(rust).toContain('"gateway-start-quick" => {');
    expect(rust).toContain('"/api/desktop/tray-remote/start-quick"');
    expect(core).toContain('pathname === "/api/desktop/tray-remote/start-quick"');
    expect(core).toContain('"./core/desktopUi/trayRemoteRuntime.js"');
    expect(quick).toContain("http://127.0.0.1:");
    expect(quick).not.toContain("taskkill");
    expect(quick).not.toContain("stopQuickTunnel");
  });
});
