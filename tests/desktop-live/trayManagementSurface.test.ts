import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
const read=(p:string)=>readFileSync(path.resolve(process.cwd(),p),"utf8");

describe("Desktop Live restored to Tray as a per-handle session manager",()=>{
  it("mounts separate native/CDP/Delegate filters, stop controls and no screenshot surface",()=>{
    const html=read("apps/superagent-tray/ui/index.html");
    const js=read("apps/superagent-tray/ui/desktop-live-manager.js");
    expect(html).toContain('id="nav-desktop-live"');
    expect(html).toContain('id="page-desktop-live"');
    for(const kind of ["native","managed-cdp","cdp-delegate"])
      expect(html).toContain('id="desktop-live-filter-'+kind+'"');
    expect(html).toContain('id="desktop-live-manager-refresh"');
    expect(html).not.toContain('id="desktop-live-image"');
    expect(html).not.toContain('src="./desktop-live.js"');
    expect(js).toContain('invoke("stop-handle"');
    expect(js).toContain("expectedRevision");
    expect(js).toContain("stop-delegate-tab");
  });
  it("routes native takeover only through Tray, never preview bearer input",()=>{
    const js=read("apps/superagent-tray/ui/desktop-live-manager.js");
    const rust=read("apps/superagent-tray/src-tauri/src/main.rs");
    const inventory=read("src/core/desktopUi/desktopLiveInventory.ts");
    const routes=read("src/serverRoutes.ts");
    expect(js).toContain('await invoke("stop-handle", { id })');
    expect(js).toContain("Native previews are view-only");
    expect(js).not.toContain("/api/desktop/live/lan-input");
    expect(js).not.toContain("/api/desktop/live/lan-takeover");
    expect(js).not.toContain("/api/desktop/live/lan-preview");
    expect(rust).toContain('"profile:", "lan:"');
    expect(inventory).toContain('if(row.kind==="lan-device" && row.stopAction==="stop-session")');
    expect(inventory.indexOf('if(row.kind==="lan-device" && row.stopAction==="stop-session")'))
      .toBeLessThan(inventory.indexOf('if(row.stopAction==="stop-session")'));
    expect(inventory).toContain('const m=/^delegate:([A-Za-z0-9_-]{8,80}):(\\d+)$/.exec(row.id)');
    expect(routes).toContain("SEPARATE_NATIVE_CONTROLLER_APPROVAL_REQUIRED");
    expect(routes).toContain('const privatePeer = peer === "127.0.0.1" || peer === "::1";');
  });
  it("has native password settings and remote management controls, not VNC exposure",()=>{
    const html=read("apps/superagent-tray/ui/index.html");
    const pw=read("apps/superagent-tray/ui/tray-access-password.js");
    const runtime=read("src/core/desktopUi/remoteTrayGateway.ts");
    expect(html).toContain('id="tray-access-password-new"');
    expect(html).toContain('id="tray-access-password-confirm"');
    expect(html).toContain('id="tray-remote-start"');
    expect(html).toContain('id="tray-remote-stop"');
    expect(pw).toContain('invoke("password-set"');
    expect(pw).toContain('action="gateway-start"');
    expect(pw).toContain('action="gateway-start-quick"');
    expect(runtime).not.toContain('"/api/desktop/live/frame"');
    expect(runtime).not.toContain("getDisplayMedia");
    expect(runtime).not.toContain("captureJpeg");
    expect(existsSync(path.resolve("src/core/desktopUi/remoteTunnelViewer.ts"))).toBe(false);
  });
});
