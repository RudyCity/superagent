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
    expect(js).toContain("Native PC remote input is not configured");
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
  it("separates Watch, Request Control, Take Over and Return to Agent",()=>{
    const html=read("apps/superagent-tray/ui/index.html");
    const js=read("apps/superagent-tray/ui/desktop-live-manager.js");
    const rust=read("apps/superagent-tray/src-tauri/src/main.rs");
    const gateway=read("src/core/desktopUi/remoteTrayGatewayHtml.ts");
    const inventory=read("src/core/desktopUi/desktopLiveInventory.ts");
    const access=read("src/core/desktopUi/desktopLiveAccessModes.ts");
    expect(html).toContain('id="desktop-live-view-heading"');
    expect(html).toContain('id="desktop-live-control-heading"');
    expect(html).toContain('id="desktop-live-view-permission"');
    expect(html).toContain('id="desktop-live-controller-permission"');
    expect(html).toContain('id="desktop-live-stream-request-control"');
    expect(html).toContain('id="desktop-live-stream-toggle-control"');
    expect(html).toContain('id="desktop-live-stream-takeover"');
    expect(js).toContain('await invoke("controller-review")');
    expect(js).toContain("stream.controllerScopes[kind]=true");
    expect(html).toContain('id="desktop-live-stream-request-keyboard"');
    expect(html).toContain('id="desktop-live-remote-readiness"');
    expect(js).toContain('await invoke("remote-status")');
    expect(js).toContain('stream.remoteReadiness');
    expect(js).toContain('controllerScopes: {mouse:false,keyboard:false}');

    expect(html).toContain('id="desktop-live-mouse-status"');
    expect(html).toContain('id="desktop-live-keyboard-status"');
    expect(js).toContain("if (accepted?.success !== true || accepted?.result?.ok !== true)");
    expect(js).toContain("result?.inputEnabled!==false");
    expect(js).toContain('item.stopAction==="return-to-agent"?"Return to Agent"');
    expect(js).not.toContain("/api/desktop/live/lan-input");
    expect(rust).toContain('"controller-review" =>');
    expect(rust).toContain('"approved": false');
    expect(rust).toContain('"inputEnabled": false');
    expect(inventory).toContain('stopAction:registration && session && mode==="agent" ? "takeover" :');
    expect(inventory).toContain('mode==="human" ? "return-to-agent"');
    expect(gateway).toContain('item.stopAction==="return-to-agent"?"Return to Agent"');
    expect(access).toContain('independentlyApproved: false');
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
