import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_HOST_NONCE_ENV,
  WindowsDesktopHost,
  createWindowsDesktopHost,
  extractHostLines,
  parseElementsResponse,
  parseFrameResponse,
  validateReadyLine,
  type DesktopHostChild,
} from "../../src/core/desktopUi/adapters/windowsDesktopHost.js";
import { DesktopUiError } from "../../src/core/desktopUi/errors.js";
import type { NativeCapture } from "../../src/core/desktopUi/types.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const TARGET = { pid: 123, nativeId: "456", title: "Target" };
const WINDOW = {
  pid: 123,
  nativeId: "456",
  title: "Target",
  active: false,
  scaleFactor: 1.25,
  bounds: { x: 10, y: 20, width: 100, height: 50 },
};
const PNG_BYTES = (() => {
  const bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  return bytes;
})();
const FRAME_LINE = JSON.stringify({ type: "frame", png: PNG_BYTES.toString("base64"), window: WINDOW });

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectRejection(action: Promise<unknown>, pattern: RegExp): Promise<DesktopUiError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopUiError);
    expect((error as Error).message).toMatch(pattern);
    return error as DesktopUiError;
  }
  throw new Error("expected the native desktop host client to reject");
}

/** Scripted stand-in for the native process; never executes the binary. */
class FakeChild implements DesktopHostChild {
  readonly stdin = {
    write: (chunk: string) => {
      this.input += chunk;
      this.onCommand?.(chunk);
      return true;
    },
  };
  readonly stdout = new EventEmitter();
  readonly stderr = { resume: () => undefined };
  input = "";
  killed = false;
  onCommand?: (chunk: string) => void;
  private readonly events = new EventEmitter();

  kill(): boolean {
    if (!this.killed) {
      this.killed = true;
      this.events.emit("exit", null, null);
    }
    return true;
  }

  on(event: string, listener: (...args: any[]) => void): unknown {
    this.events.on(event, listener);
    return this;
  }

  emitData(chunk: string): void {
    this.stdout.emit("data", Buffer.from(chunk));
  }

  emitExit(): void {
    this.events.emit("exit", null, null);
  }
}

function createHarness(options: {
  handler?: (command: any, child: FakeChild) => void;
  readyNonce?: string;
  readyLine?: (child: FakeChild) => void;
  hostOptions?: ConstructorParameters<typeof WindowsDesktopHost>[1];
} = {}) {
  const children: FakeChild[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const executables: string[] = [];
  const host = new WindowsDesktopHost("C:\\fixed\\desktop-host.exe", {
    createNonce: () => NONCE,
    spawnChild: (executable, env) => {
      executables.push(executable);
      envs.push(env);
      const child = new FakeChild();
      children.push(child);
      setTimeout(() => {
        if (child.killed) return;
        if (options.readyLine) {
          options.readyLine(child);
          return;
        }
        child.emitData(`${JSON.stringify({ type: "ready", nonce: options.readyNonce ?? NONCE })}\n`);
      }, 0);
      child.onCommand = (chunk) => {
        for (const line of chunk.split("\n")) {
          if (line.trim().length === 0) continue;
          options.handler?.(JSON.parse(line), child);
        }
      };
      return child;
    },
    ...options.hostOptions,
  });
  return { host, children, envs, executables };
}

describe("desktop host protocol framing", () => {
  it("splits complete lines, keeps the partial tail, and drops empty control lines", () => {
    expect(extractHostLines('{"a":1}\n{"b":2}\n{"c"')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c"',
    });
    expect(extractHostLines("\r\n{\"ok\":true}\n\n")).toEqual({ lines: ['{"ok":true}'], rest: "" });
    expect(extractHostLines("no-newline-yet")).toEqual({ lines: [], rest: "no-newline-yet" });
  });

  it("accepts a ready line only when the echoed nonce matches the Core secret", () => {
    expect(() => validateReadyLine(`{"type":"ready","nonce":"${NONCE}"}`, NONCE)).not.toThrow();
    expect(() => validateReadyLine(`{"type":"ready","nonce":"other"}`, NONCE)).toThrow(/nonce mismatch/);
    expect(() => validateReadyLine(`{"type":"ready"}`, NONCE)).toThrow(/nonce mismatch/);
    expect(() => validateReadyLine(`{"type":"elements"}`, NONCE)).toThrow(/did not announce readiness/);
    expect(() => validateReadyLine("not json", NONCE)).toThrow(/not valid JSON/);
    expect(() => validateReadyLine(`{"type":"ready","nonce":"${NONCE}"}`, "short")).toThrow(/not provisioned/);
  });
});

describe("desktop host client lifecycle", () => {
  it("passes the nonce through the environment, frames the command, and validates the frame", async () => {
    const commands: any[] = [];
    const harness = createHarness({
      handler: (command, child) => {
        commands.push(command);
        child.emitData(`${FRAME_LINE}\n`);
      },
    });
    const capture = await harness.host.capture(TARGET);
    expect(commands).toEqual([{ cmd: "capture", pid: 123, hwnd: "456" }]);
    expect(harness.envs[0][DESKTOP_HOST_NONCE_ENV]).toBe(NONCE);
    expect(harness.executables[0]).toBe("C:\\fixed\\desktop-host.exe");
    expect(capture.image.length).toBe(PNG_BYTES.length);
    expect(capture.targetWindow).toMatchObject({ pid: 123, nativeId: "456", title: "Target" });
    expect(harness.children[0].killed).toBe(false);
    harness.host.close();
    expect(harness.children[0].killed).toBe(true);
  });

  it("assembles the ready handshake and a frame delivered in partial chunks", async () => {
    const ready = JSON.stringify({ type: "ready", nonce: NONCE });
    const harness = createHarness({
      readyLine: (child) => {
        child.emitData(ready.slice(0, 10));
        setTimeout(() => child.emitData(`${ready.slice(10)}\n`), 5);
      },
      handler: (command, child) => {
        expect(command.cmd).toBe("capture");
        child.emitData(FRAME_LINE.slice(0, 25));
        setTimeout(() => child.emitData(`${FRAME_LINE.slice(25)}\n`), 5);
      },
    });
    const capture = await harness.host.capture(TARGET);
    expect(Buffer.from(capture.image).subarray(0, 8).equals(PNG_BYTES.subarray(0, 8))).toBe(true);
    harness.host.close();
  });

  it("refuses a nonce mismatch permanently instead of restarting into an unknown process", async () => {
    const harness = createHarness({ readyNonce: "f".repeat(32) });
    await expectRejection(harness.host.capture(TARGET), /nonce mismatch/);
    expect(harness.children[0].killed).toBe(true);
    await expectRejection(harness.host.capture(TARGET), /unavailable/);
    expect(harness.children).toHaveLength(1);
    expect(harness.host.available).toBe(false);
  });

  it("rejects a frame whose PID/HWND does not describe the requested target", async () => {
    const harness = createHarness({
      handler: (_command, child) => {
        child.emitData(`${JSON.stringify({ type: "frame", png: PNG_BYTES.toString("base64"), window: { ...WINDOW, nativeId: "999" } })}\n`);
      },
    });
    await expectRejection(harness.host.capture(TARGET), /capture was rejected/);
    // Identity refusal is not a protocol violation: the carrier stays warm.
    expect(harness.children[0].killed).toBe(false);
    expect(harness.host.available).toBe(true);
    harness.host.close();
  });

  it("restarts exactly once after a malformed response and then permanently fails", async () => {
    let answered = 0;
    const harness = createHarness({
      handler: (command: any, child) => {
        if (command.cmd !== "capture") return;
        answered += 1;
        if (answered === 1) {
          child.emitData("this-is-not-json\n");
          return;
        }
        child.emitData(`${FRAME_LINE}\n`);
      },
    });
    await expectRejection(harness.host.capture(TARGET), /not valid JSON/);
    expect(harness.host.available).toBe(true);
    const capture = await harness.host.capture(TARGET);
    expect(capture.targetWindow.nativeId).toBe("456");
    expect(harness.children).toHaveLength(2);
    harness.host.close();
  });

  it("fails permanently after two crashes and never pays spawn cost again", async () => {
    const harness = createHarness({
      handler: () => {
        harness.children.at(-1)!.emitExit();
      },
    });
    await expectRejection(harness.host.capture(TARGET), /stopped serving|not running/);
    await expectRejection(harness.host.capture(TARGET), /stopped serving|not running/);
    await expectRejection(harness.host.capture(TARGET), /unavailable/);
    expect(harness.children).toHaveLength(2);
    expect(harness.host.available).toBe(false);
  });

  it("times out a silent request and kills the carrier", async () => {
    const harness = createHarness({ handler: () => undefined, hostOptions: { requestTimeoutMs: 40 } });
    await expectRejection(harness.host.capture(TARGET), /stopped serving/);
    expect(harness.children[0].killed).toBe(true);
  });

  it("closes an idle carrier without consuming the restart budget", async () => {
    const harness = createHarness({
      handler: (_command, child) => child.emitData(`${FRAME_LINE}\n`),
      hostOptions: { idleCloseMs: 25 },
    });
    await harness.host.capture(TARGET);
    await delay(80);
    expect(harness.children[0].killed).toBe(true);
    await harness.host.capture(TARGET);
    expect(harness.children).toHaveLength(2);
    harness.host.close();
  });

  it("returns null when the optional artifact cannot be located", () => {
    expect(createWindowsDesktopHost({ locateArtifact: () => null })).toBeNull();
    expect(createWindowsDesktopHost({ locateArtifact: () => { throw new Error("bad pair"); } })).toBeNull();
  });
});

describe("desktop host inspection", () => {
  const reference: Pick<NativeCapture, "targetWindow"> = { targetWindow: WINDOW };

  function elementsLine(elements: unknown[]): string {
    return JSON.stringify({ type: "elements", window: WINDOW, elements, warnings: [] });
  }

  function inspectHarness(elements: unknown[], referenceCapture?: Pick<NativeCapture, "targetWindow">) {
    return createHarness({
      handler: (command, child) => {
        expect(command).toEqual({ cmd: "inspect", pid: 123, hwnd: "456" });
        child.emitData(`${elementsLine(elements)}\n`);
      },
    });
  }

  it("normalizes raw UIA signals with the shared authority and keeps the security rules", async () => {
    const bounds = { x: 10, y: 20, width: 40, height: 20 };
    const harness = inspectHarness([
      { role: "button", label: "Save", bounds, enabled: true, offscreen: false, focused: true, automationId: "save" },
      { role: "button", label: "Hidden", bounds: { x: 60, y: 20, width: 20, height: 20 }, enabled: true, offscreen: true },
      { role: "group", label: null, description: null, value: null, bounds, enabled: true, offscreen: true },
      { role: "button", label: "Zero", bounds: { x: 0, y: 0, width: 0, height: 0 }, enabled: true, offscreen: false },
      { role: "button", label: "Save", bounds, enabled: true, offscreen: false, automationId: "save" },
      { role: "text", label: "Body", bounds, enabled: true, offscreen: false },
    ]);
    const snapshot = await harness.host.inspect(TARGET, reference);
    expect(snapshot.window).toMatchObject({ pid: 123, nativeId: "456" });
    expect(snapshot.elements).toHaveLength(3);
    const save = snapshot.elements[0];
    expect(save).toMatchObject({ role: "button", actionable: true, focused: true, nativeRef: "automationId:save" });
    expect(save.center).toEqual({ x: 30, y: 30 });
    const hidden = snapshot.elements[1];
    expect(hidden).toMatchObject({ role: "button", actionable: false });
    expect(snapshot.elements[2]).toMatchObject({ role: "text", actionable: false });
    harness.host.close();
  });

  it("rejects an element frame whose geometry is not DPI-equivalent to the capture", async () => {
    const harness = inspectHarness(
      [{ role: "button", label: "Save", bounds: { x: 0, y: 0, width: 10, height: 10 }, enabled: true, offscreen: false }],
    );
    const mismatched: Pick<NativeCapture, "targetWindow"> = {
      targetWindow: { ...WINDOW, bounds: { x: 500, y: 500, width: 100, height: 50 } },
    };
    await expectRejection(harness.host.inspect(TARGET, mismatched), /inspection was rejected/);
    expect(harness.children[0].killed).toBe(false);
    expect(harness.host.available).toBe(true);
    harness.host.close();
  });

  it("accepts DPI-equivalent element geometry within the two pixel tolerance", async () => {
    const harness = inspectHarness(
      [{ role: "button", label: "Save", bounds: { x: 10, y: 20, width: 40, height: 40 }, enabled: true, offscreen: false }],
    );
    const physicallyScaled: Pick<NativeCapture, "targetWindow"> = {
      targetWindow: { ...WINDOW, bounds: { x: 12, y: 25, width: 125, height: 63 } },
    };
    const snapshot = await harness.host.inspect(TARGET, physicallyScaled);
    expect(snapshot.elements).toHaveLength(1);
    harness.host.close();
  });

  it("rejects a host error line as an inspection failure without trusting its payload", async () => {
    const harness = createHarness({
      handler: (_command, child) => {
        child.emitData(`${JSON.stringify({ type: "error", code: "TARGET_NOT_FOUND", message: "gone" })}\n`);
      },
    });
    const error = await expectRejection(harness.host.inspect(TARGET, reference), /refused the request/);
    expect(error.code).toBe("ACCESSIBILITY_UNAVAILABLE");
    harness.host.close();
  });
});

describe("desktop host response parsers", () => {
  it("rejects a frame payload that is not a bounded base64 PNG", () => {
    const target = { pid: 123, nativeId: "456" };
    expect(() => parseFrameResponse(JSON.stringify({ type: "frame", png: "!!!", window: WINDOW }), target))
      .toThrow(/invalid frame payload/);
    expect(() => parseFrameResponse(JSON.stringify({ type: "frame", png: Buffer.alloc(32, 7).toString("base64"), window: WINDOW }), target))
      .toThrow(/not a PNG image/);
    expect(() =>
      parseFrameResponse(
        JSON.stringify({ type: "frame", png: PNG_BYTES.toString("base64"), window: { ...WINDOW, pid: 7 } }),
        target,
      ),
    ).toThrow(/capture was rejected/);
  });

  it("rejects an elements payload with a non-array element list", () => {
    const target = { pid: 123, nativeId: "456" };
    expect(() => parseElementsResponse(JSON.stringify({ type: "elements", window: WINDOW, elements: {} }), target))
      .toThrow(/invalid element list/);
    expect(() => parseElementsResponse(JSON.stringify({ type: "frame", window: WINDOW }), target))
      .toThrow(/inspection was rejected/);
  });
});
