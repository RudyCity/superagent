import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const base="apps/superagent-tray";
const html=readFileSync(base+"/ui/index.html","utf8");
const app=readFileSync(base+"/ui/app.js","utf8");
const js=readFileSync(base+"/ui/recordings.js","utf8");
const live=readFileSync(base+"/ui/desktop-live-manager.js","utf8");
const rust=readFileSync(base+"/src-tauri/src/main.rs","utf8");
const routes=readFileSync("src/serverRoutes.ts","utf8");

describe("native Recording Manager",()=>{
  it("wires a routable sidebar panel and native IPC without injected HTML",()=>{
    expect(html).toContain('data-page="recordings"');
    expect(html).toContain('id="page-recordings"');
    expect(html).toContain('src="./recordings.js"');
    expect(html).toContain('href="./recordings.css"');
    expect(app).toContain('window.__superagentRecordingsRefresh?.()');
    expect(rust).toContain("recordings_action,");
    expect(js).toContain('invoke("recordings_action"');
    expect(js).toContain("n.textContent=String(text)");
    expect(js).not.toMatch(/innerHTML|eval\(|fetch\(/);
    expect(()=>new Script(js)).not.toThrow();
  });
  it("exposes independent native recording controls after approved preview",()=>{
    expect(html).toContain('id="desktop-live-stream-record"');
    expect(html).toContain('id="desktop-live-record-preset"');
    expect(live).toContain('action:"start-native"');
    expect(live).toContain('action:"stop"');
    expect(live).toContain('stream.recordingPending');
    expect(live).toContain('window.__TAURI__?.core?.invoke');
    expect(rust).toContain('desktop_recording_native_approval_proof');
    expect(rust).toContain('Another native approval is pending');
    expect(routes).toContain('body.action==="native-challenge"');
    expect(routes).toContain('body.action==="start-native"');
    expect(js).toContain('actionButton("Export ZIP","export-zip",r)');
    expect(()=>new Script(live)).not.toThrow();
  });
  it("keeps playback local and requires native delete confirmation",()=>{
    expect(rust).toContain('core_request(Method::POST,"/api/desktop/cdp/recordings"');
    expect(rust).toContain("MessageDialogButtons::OkCancel");
    expect(rust).toContain('window.label() != "main"');
    expect(routes).toContain("CDP_RECORDINGS_LOCAL_OPERATOR_REQUIRED");
    expect(js).not.toMatch(/Authorization|Bearer/);
  });
});
