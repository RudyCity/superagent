import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";
import type { WindowsDesktopHost } from "../../src/core/desktopUi/adapters/windowsDesktopHost.js";
import type { DesktopProcessRunner, SafeProcessRequest } from "../../src/core/desktopUi/processRunner.js";
import type { NativeCapture } from "../../src/core/desktopUi/types.js";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function fakePng(width = 100, height = 50): Uint8Array {
  const bytes = Buffer.alloc(25);
  Buffer.from(PNG_SIGNATURE).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const TARGET = { pid: 123, nativeId: "456", title: "Target" };
const WINDOW = {
  pid: 123,
  nativeId: "456",
  title: "Target",
  active: true,
  scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 100, height: 50 },
};

function hostCapture(): NativeCapture {
  return { image: fakePng(), capturedAt: "2026-11-28T00:00:00.000Z", targetWindow: WINDOW };
}

/** Fake native host: records calls, never spawns anything. */
function fakeHost(overrides: Partial<Record<"capture" | "inspect", () => Promise<unknown>>> = {}) {
  return {
    capture: vi.fn(overrides.capture ?? (async () => hostCapture())),
    inspect: vi.fn(overrides.inspect ?? (async () => ({
      window: WINDOW,
      elements: [
        {
          role: "button",
          label: "From host",
          description: null,
          value: null,
          bounds: { x: 0, y: 0, width: 40, height: 20 },
          center: { x: 20, y: 10 },
          actionable: true,
        },
      ],
    }))),
    close: vi.fn(),
  } as unknown as WindowsDesktopHost & {
    capture: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

function scriptedRunner(): DesktopProcessRunner & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (request: SafeProcessRequest) => {
    const payload = JSON.parse(request.env?.SUPERAGENT_DESKTOP_UI_PAYLOAD ?? "{}");
    if (typeof payload.outputPath === "string") {
      await writeFile(payload.outputPath, fakePng());
      return { stdout: JSON.stringify(WINDOW), stderr: "", exitCode: 0 };
    }
    if (payload.kind) return { stdout: '{"ok":true}', stderr: "", exitCode: 0 };
    return {
      stdout: JSON.stringify({
        window: WINDOW,
        elements: [
          {
            role: "button",
            label: "From one-shot",
            bounds: { x: 0, y: 0, width: 40, height: 20 },
            enabled: true,
            offscreen: false,
            actionable: true,
          },
          {
            role: "button",
            label: "Offscreen one-shot",
            bounds: { x: 50, y: 0, width: 40, height: 20 },
            enabled: true,
            offscreen: true,
            actionable: true,
          },
        ],
      }),
      stderr: "",
      exitCode: 0,
    };
  });
  return { run } as unknown as DesktopProcessRunner & { run: ReturnType<typeof vi.fn> };
}

describe("Windows adapter native host wiring", () => {
  it("prefers the native host for capture and never runs PowerShell on success", async () => {
    const host = fakeHost();
    const runner = scriptedRunner();
    const capture = await createWindowsDesktopUiAdapter(runner, { desktopHost: host }).capture(TARGET);
    expect(capture.targetWindow.nativeId).toBe("456");
    expect(host.capture).toHaveBeenCalledWith(TARGET);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("falls back to the one-shot PowerShell capture when the native host refuses", async () => {
    const host = fakeHost({
      capture: async () => {
        throw new Error("native host capture refused");
      },
    });
    const runner = scriptedRunner();
    const capture = await createWindowsDesktopUiAdapter(runner, { desktopHost: host }).capture(TARGET);
    expect(host.capture).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(capture.targetWindow.pid).toBe(123);
    expect(capture.image.length).toBeGreaterThan(0);
  });

  it("prefers the native host for inspection and passes the captured reference window", async () => {
    const host = fakeHost();
    const runner = scriptedRunner();
    const capture = hostCapture();
    const snapshot = await createWindowsDesktopUiAdapter(runner, { desktopHost: host })
      .inspectAccessibility(TARGET, capture);
    expect(snapshot.elements[0].label).toBe("From host");
    expect(host.inspect).toHaveBeenCalledWith(
      { pid: 123, nativeId: "456" },
      capture,
    );
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("falls back to the audited one-shot inspection when the native host refuses", async () => {
    const host = fakeHost({
      inspect: async () => {
        throw new Error("native host inspect refused");
      },
    });
    const runner = scriptedRunner();
    const snapshot = await createWindowsDesktopUiAdapter(runner, { desktopHost: host })
      .inspectAccessibility(TARGET, hostCapture());
    expect(host.inspect).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(snapshot.elements.map((element) => element.label)).toEqual(["From one-shot", "Offscreen one-shot"]);
    // The shared normalizer still owns actionability: offscreen is never clickable.
    expect(snapshot.elements[0].actionable).toBe(true);
    expect(snapshot.elements[1].actionable).toBe(false);
  });

  it("keeps today's behaviour when no native host is injected", async () => {
    const runner = scriptedRunner();
    const adapter = createWindowsDesktopUiAdapter(runner);
    const capture = await adapter.capture(TARGET);
    expect(capture.targetWindow.pid).toBe(123);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("falls back on both operations when the native host is unavailable from the start", async () => {
    const host = fakeHost({
      capture: async () => {
        throw new Error("gone");
      },
      inspect: async () => {
        throw new Error("gone");
      },
    });
    const runner = scriptedRunner();
    const adapter = createWindowsDesktopUiAdapter(runner, { desktopHost: host });
    const capture = await adapter.capture(TARGET);
    const snapshot = await adapter.inspectAccessibility(TARGET, capture);
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(snapshot.window.pid).toBe(123);
  });
});
