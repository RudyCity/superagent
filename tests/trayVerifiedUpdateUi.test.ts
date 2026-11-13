import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync("apps/superagent-tray/ui/updates.js", "utf8");
const html = fs.readFileSync("apps/superagent-tray/ui/index.html", "utf8");
const main = fs.readFileSync("apps/superagent-tray/ui/app.js", "utf8");
const native = fs.readFileSync("apps/superagent-tray/src-tauri/src/release_updates.rs", "utf8");
const rustHost = fs.readFileSync("apps/superagent-tray/src-tauri/src/main.rs", "utf8");

const sha = "c".repeat(64);
const example = {
  currentVersion: "1.14.82", releaseVersion: "1.14.83", tag: "v1.14.83-rc.2",
  releaseUrl: "https://github.com/RudyCity/superagent/releases/tag/v1.14.83-rc.2",
  platform: "Windows x64", state: "update_available",
  assetName: "SuperAgent_1.14.83_x64-setup.exe", assetSize: 100_000_000,
  sha256: sha, components: ["Windows installer", "Chrome Delegate"],
  downloadSupported: true
};

class FakeElement {
  textContent = "";
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  className = "";
  children: FakeElement[] = [];
  listeners = new Map<string, () => void>();
  addEventListener(event: string, cb: () => void) { this.listeners.set(event, cb); }
  click() { this.listeners.get("click")?.(); }
  replaceChildren() { this.children = []; this.textContent = ""; }
  append(item: FakeElement) { this.children.push(item); }
  get childElementCount() { return this.children.length; }
}
function createHarness(confirmation = true) {
  const elements = new Map<string, FakeElement>();
  const element = (key: string): FakeElement => {
    if (!elements.has(key)) elements.set(key, new FakeElement());
    return elements.get(key)!;
  };
  const calls: Array<{ action: string, args?: any }> = [];
  const window = {
    location: { hash: "#jobs" },
    confirm: (_message: string) => confirmation,
    __TAURI__: { core: { invoke: async (action: string, args?: any) => {
      calls.push({ action, args });
      if (action === "check_release_updates") return { ...example };
      if (action === "download_release_update") return {
        tag: example.tag, sha256: sha, installed: false,
        filePath: "C:\\Users\\tester\\Downloads\\SuperAgent\\updates\\SuperAgent_1.14.83_x64-setup.exe"
      };
      throw new Error("UNEXPECTED_NATIVE_ACTION");
    }}},
    __superagentUpdatesRefresh: undefined as undefined | (() => Promise<void>)
  };
  const document = {
    getElementById: element,
    createElement: (_tag: string) => new FakeElement()
  };
  vm.runInNewContext(script, { window, document, console }, { filename: "updates.js", timeout: 1000 });
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
  return { element, calls, window, settle };
}

describe("Native verified update discovery and manual download", () => {
  it("wires the updates page, menu and command handlers without broad shell permissions", () => {
    for (const fragment of [
      'id="nav-updates"', 'id="page-updates"', 'id="actions-updates"',
      'id="updates-check"', 'id="updates-download"', 'id="updates-feedback"',
      'src="./updates.js"', 'href="https://github.com/RudyCity/superagent/releases"'
    ]) expect(html).toContain(fragment);
    expect(main).toContain('"updates"');
    expect(main).toContain("window.__superagentUpdatesRefresh?.()");
    expect(rustHost).toContain("release_updates::check_release_updates");
    expect(rustHost).toContain("release_updates::download_release_update");
    expect(rustHost).toContain('app.emit("desktop-open-updates"');
    expect(native).toContain("UPDATE_RELEASE_CHANGED_SINCE_REVIEW");
    expect(native).toContain("UPDATE_DOWNLOAD_HASH_OR_SIZE_MISMATCH");
    expect(native).toContain("UPDATE_EXISTING_CHECKSUM_MISMATCH");
    expect(native).not.toContain("Command::new");
  });

  it("checks versions without downloading or executing anything", async () => {
    const h = createHarness();
    expect(h.calls).toHaveLength(0);
    await h.window.__superagentUpdatesRefresh?.();
    expect(h.calls.map(x => x.action)).toEqual(["check_release_updates"]);
    expect(h.element("updates-release-version").textContent).toBe("1.14.83");
    expect(h.element("updates-current-version").textContent).toBe("1.14.82");
    expect(h.element("updates-state").textContent).toBe("Update available");
    expect(h.element("updates-components").children.map(c => c.textContent))
      .toEqual(["Windows installer", "Chrome Delegate"]);
    expect(h.element("updates-download").disabled).toBe(false);
    expect(h.element("updates-downloaded").hidden).toBe(true);
  });

  it("requires a separate explicit user action and confirmation to download", async () => {
    const no = createHarness(false);
    await no.window.__superagentUpdatesRefresh?.();
    no.element("updates-download").click();
    await no.settle();
    expect(no.calls).toHaveLength(1);

    const yes = createHarness(true);
    await yes.window.__superagentUpdatesRefresh?.();
    yes.element("updates-download").click();
    await yes.settle();
    expect(yes.calls.map(x => x.action)).toEqual([
      "check_release_updates", "download_release_update"
    ]);
    expect(yes.calls[1].args).toEqual({ expectedTag: example.tag, expectedSha256: sha });
    expect(yes.element("updates-downloaded").hidden).toBe(false);
    expect(yes.element("updates-downloaded-path").textContent).toContain("Downloads");
    expect(yes.element("updates-feedback").textContent).toContain("Open it manually");
  });
});
