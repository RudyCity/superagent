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
  it("has native password settings and remote management controls, not VNC exposure",()=>{
    const html=read("apps/superagent-tray/ui/index.html");
    const pw=read("apps/superagent-tray/ui/tray-access-password.js");
    const runtime=read("src/core/desktopUi/remoteTrayGateway.ts");
    expect(html).toContain('id="tray-access-password-new"');
    expect(html).toContain('id="tray-access-password-confirm"');
    expect(html).toContain('id="tray-remote-start"');
    expect(html).toContain('id="tray-remote-stop"');
    expect(pw).toContain('invoke("password-set"');
    expect(pw).toContain('invoke("gateway-start"');
    expect(runtime).not.toContain('"/api/desktop/live/frame"');
    expect(runtime).not.toContain("getDisplayMedia");
    expect(runtime).not.toContain("captureJpeg");
    expect(existsSync(path.resolve("src/core/desktopUi/remoteTunnelViewer.ts"))).toBe(false);
  });
});
