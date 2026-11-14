import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve("apps/superagent-tray/ui/desktop-live.js"), "utf8");
const pid = 4310;
const nativeId = "48512";
const token = "a".repeat(64);

class FakeElement {
  value = "";
  hidden = false;
  disabled = false;
  src = "";
  textContent = "";
  children: FakeElement[] = [];
  private callbacks: Record<string, Array<() => void>> = {};
  addEventListener(name: string, callback: () => void) {
    (this.callbacks[name] ??= []).push(callback);
  }
  click() {
    for (const callback of this.callbacks.click ?? []) callback();
  }
  change() {
    for (const callback of this.callbacks.change ?? []) callback();
  }
  replaceChildren() { this.children = []; }
  append(item: FakeElement) { this.children.push(item); }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
}

async function runPreset(value: string) {
  const ids = [
    "page-desktop-live", "desktop-live-refresh", "desktop-live-start",
    "desktop-live-stop", "desktop-live-target", "desktop-live-quality",
    "desktop-live-image", "desktop-live-placeholder", "desktop-live-status",
  ];
  const elements = new Map(ids.map(id => [id, new FakeElement()]));
  const get = (id: string) => elements.get(id)!;
  get("desktop-live-quality").value = value;
  const framePayloads: Record<string, unknown>[] = [];
  let requests = 0;
  const fakeDocument = {
    readyState: "complete",
    hidden: false,
    getElementById(id: string) { return elements.get(id) ?? null; },
    createElement() { return new FakeElement(); },
    addEventListener() {},
  };
  const fakeWindow = {
    addEventListener() {},
    __TAURI__: { core: { async invoke(_command: string, { action, payload }: {
      action: string; payload: Record<string, unknown> | null;
    }) {
      if (action === "windows") {
        return { success: true, windows: [{
          pid, nativeId, title: "Test fixture", application: "Fixture",
        }] };
      }
      if (action === "start") {
        return { success: true, token, backend: "win32-persistent-exact-hwnd",
          window: { pid, nativeId } };
      }
      if (action === "frame") {
        framePayloads.push({ ...payload });
        requests++;
        if (requests === 1) {
          return { success: true, unchanged: false, format: "jpeg",
            jpeg: "/9j/AAAA", width: 800, height: 600,
            hash: "b".repeat(64), nextPollMs: 250 };
        }
        throw Error("Fixture ends session");
      }
      return { stopped: true };
    } } },
  };
  const context = vm.createContext({
    document: fakeDocument, window: fakeWindow,
    performance: { now: () => 1000 },
    setTimeout: (callback: () => void, _delay: number) => setTimeout(callback, 0),
  });
  vm.runInContext(source, context);
  await (fakeWindow as any).__superagentDesktopLiveRefresh();
  get("desktop-live-target").value = "0";
  get("desktop-live-start").click();
  await new Promise(resolve => setTimeout(resolve, 35));
  const width = framePayloads[0]?.maxWidth;
  const quality = framePayloads[0]?.quality;
  get("desktop-live-stop").click();
  return { width, quality, requests };
}

describe("local Desktop Live quality controls", () => {
  it.each([
    ["save", 768, 50],
    ["balanced", 1280, 65],
    ["detail", 1920, 75],
  ] as const)("%s requests bounded resolution %i and quality %i", async (preset, width, quality) => {
    const outcome = await runPreset(preset);
    expect(outcome.width).toBe(width);
    expect(outcome.quality).toBe(quality);
    expect(outcome.requests).toBeGreaterThanOrEqual(1);
  });
});
