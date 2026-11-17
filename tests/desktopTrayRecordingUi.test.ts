import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const base="apps/superagent-tray";
const html=readFileSync(base+"/ui/index.html","utf8");
const app=readFileSync(base+"/ui/app.js","utf8");
const js=readFileSync(base+"/ui/recordings.js","utf8");
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
  it("keeps playback local and requires native delete confirmation",()=>{
    expect(rust).toContain('core_request(Method::POST,"/api/desktop/cdp/recordings"');
    expect(rust).toContain("MessageDialogButtons::OkCancel");
    expect(rust).toContain('window.label() != "main"');
    expect(routes).toContain("CDP_RECORDINGS_LOCAL_OPERATOR_REQUIRED");
    expect(js).not.toMatch(/Authorization|Bearer/);
  });
});
