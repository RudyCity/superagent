import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_HOST_DEFAULT_MAX_LIFETIME_MS,
  DESKTOP_HOST_DEFAULT_MAX_REQUESTS,
  DESKTOP_HOST_MAX_LIFETIME_CEILING_MS,
  DESKTOP_HOST_MAX_LIFETIME_MS_ENV,
  DESKTOP_HOST_MAX_REQUESTS_CEILING,
  DESKTOP_HOST_MAX_REQUESTS_ENV,
  DESKTOP_HOST_NONCE_ENV,
  WindowsDesktopHost,
  parseHostErrorCode,
  parseRotationLine,
  resolveDesktopHostBudget,
  type DesktopHostChild,
  type DesktopHostRotationReason,
} from "../../src/core/desktopUi/adapters/windowsDesktopHost.js";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";
import { DesktopUiError } from "../../src/core/desktopUi/errors.js";
import type { DesktopProcessRunner, SafeProcessRequest } from "../../src/core/desktopUi/processRunner.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const TARGET = { pid: 123, nativeId: "456", title: "Target" };
const WINDOW = {
  pid: 123,
  nativeId: "456",
  title: "Target",
  active: false,
  scaleFactor: 1,
  bounds: { x: 10, y: 20, width: 100, height: 50 },
};
const PNG_BYTES = (() => {
  const bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  return bytes;
})();
const FRAME_LINE = JSON.stringify({ type: "frame", png: PNG_BYTES.toString("base64"), window: WINDOW });

function rotationLine(reason: Exclude<DesktopHostRotationReason, "unknown">, served = 0): string {
  return JSON.stringify({ type: "rotating", reason, served });
}

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
}

interface Harness {
  host: WindowsDesktopHost;
  children: FakeChild[];
  envs: NodeJS.ProcessEnv[];
}

function createHarness(options: {
  ready?: (child: FakeChild, childIndex: number) => void;
  onCommand?: (command: any, child: FakeChild, childIndex: number) => void;
  hostOptions?: ConstructorParameters<typeof WindowsDesktopHost>[1];
} = {}): Harness {
  const children: FakeChild[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const host = new WindowsDesktopHost("C:\\fixed\\desktop-host.exe", {
    createNonce: () => NONCE,
    spawnChild: (_executable, env) => {
      envs.push(env);
      const child = new FakeChild();
      const childIndex = children.push(child) - 1;
      setTimeout(() => {
        if (child.killed) return;
        if (options.ready) {
          options.ready(child, childIndex);
          return;
        }
        child.emitData(`${JSON.stringify({ type: "ready", nonce: NONCE })}\n`);
      }, 0);
      child.onCommand = (chunk) => {
        for (const line of chunk.split("\n")) {
          if (line.trim().length === 0) continue;
          options.onCommand?.(JSON.parse(line), child, childIndex);
        }
      };
      return child;
    },
    ...options.hostOptions,
  });
  return { host, children, envs };
}

function perChildRequestCap(cap: number): (command: any, child: FakeChild) => void {
  const served = new Map<FakeChild, number>();
  return (_command, child) => {
    const count = served.get(child) ?? 0;
    if (count >= cap) {
      child.emitData(`${rotationLine("request-cap", count)}\n`);
      return;
    }
    served.set(child, count + 1);
    child.emitData(`${FRAME_LINE}\n`);
  };
}

describe("bounded lifetime budget resolution", () => {
  it("defaults to 500 requests and 10 minutes", () => {
    expect(resolveDesktopHostBudget({})).toEqual({
      maxRequests: DESKTOP_HOST_DEFAULT_MAX_REQUESTS,
      maxLifetimeMs: DESKTOP_HOST_DEFAULT_MAX_LIFETIME_MS,
    });
    expect(DESKTOP_HOST_DEFAULT_MAX_REQUESTS).toBe(500);
    expect(DESKTOP_HOST_DEFAULT_MAX_LIFETIME_MS).toBe(600_000);
  });

  it("reads positive integers from the environment and ignores malformed values", () => {
    expect(
      resolveDesktopHostBudget({
        [DESKTOP_HOST_MAX_REQUESTS_ENV]: "3",
        [DESKTOP_HOST_MAX_LIFETIME_MS_ENV]: "2500",
      }),
    ).toEqual({ maxRequests: 3, maxLifetimeMs: 2500 });
    const malformed = resolveDesktopHostBudget({
      [DESKTOP_HOST_MAX_REQUESTS_ENV]: "0",
      [DESKTOP_HOST_MAX_LIFETIME_MS_ENV]: "-5",
    });
    expect(malformed).toEqual({
      maxRequests: DESKTOP_HOST_DEFAULT_MAX_REQUESTS,
      maxLifetimeMs: DESKTOP_HOST_DEFAULT_MAX_LIFETIME_MS,
    });
    expect(
      resolveDesktopHostBudget({
        [DESKTOP_HOST_MAX_REQUESTS_ENV]: " 4 ",
        [DESKTOP_HOST_MAX_LIFETIME_MS_ENV]: "not-a-number",
      }),
    ).toEqual({ maxRequests: 4, maxLifetimeMs: DESKTOP_HOST_DEFAULT_MAX_LIFETIME_MS });
    expect(
      resolveDesktopHostBudget({
        [DESKTOP_HOST_MAX_REQUESTS_ENV]: String(DESKTOP_HOST_MAX_REQUESTS_CEILING + 1),
        [DESKTOP_HOST_MAX_LIFETIME_MS_ENV]: String(DESKTOP_HOST_MAX_LIFETIME_CEILING_MS + 1),
      }),
    ).toEqual({
      maxRequests: DESKTOP_HOST_DEFAULT_MAX_REQUESTS,
      maxLifetimeMs: DESKTOP_HOST_DEFAULT_MAX_LIFETIME_MS,
    });
  });

  it("lets explicit options override the environment and rejects bad overrides", () => {
    expect(
      resolveDesktopHostBudget(
        { [DESKTOP_HOST_MAX_REQUESTS_ENV]: "100", [DESKTOP_HOST_MAX_LIFETIME_MS_ENV]: "1000" },
        { maxRequests: 2, maxLifetimeMs: 50 },
      ),
    ).toEqual({ maxRequests: 2, maxLifetimeMs: 50 });
    expect(resolveDesktopHostBudget({}, { maxRequests: 0, maxLifetimeMs: -1 })).toEqual({
      maxRequests: DESKTOP_HOST_DEFAULT_MAX_REQUESTS,
      maxLifetimeMs: DESKTOP_HOST_DEFAULT_MAX_LIFETIME_MS,
    });
  });
});

describe("rotation line parsing", () => {
  it("recognizes the two announced reasons and preserves unknown ones as a rotation", () => {
    expect(parseRotationLine(rotationLine("request-cap"))).toBe("request-cap");
    expect(parseRotationLine(rotationLine("lifetime"))).toBe("lifetime");
    expect(parseRotationLine(JSON.stringify({ type: "rotating", reason: "future-reason" }))).toBe("unknown");
    expect(parseRotationLine(JSON.stringify({ type: "rotating" }))).toBe("unknown");
  });

  it("never treats a frame, an error or malformed JSON as a rotation", () => {
    expect(parseRotationLine(FRAME_LINE)).toBeNull();
    expect(parseRotationLine(JSON.stringify({ type: "error", code: "TARGET_NOT_FOUND" }))).toBeNull();
    expect(parseRotationLine("not json")).toBeNull();
  });

  it("extracts typed startup refusal codes", () => {
    expect(parseHostErrorCode(JSON.stringify({ type: "error", code: "ELEVATED_TOKEN", message: "no" }))).toBe(
      "ELEVATED_TOKEN",
    );
    expect(parseHostErrorCode(JSON.stringify({ type: "error", code: "PRIVILEGE_HARDENING_FAILED" }))).toBe(
      "PRIVILEGE_HARDENING_FAILED",
    );
    expect(parseHostErrorCode(JSON.stringify({ type: "ready", nonce: NONCE }))).toBeNull();
    expect(parseHostErrorCode(JSON.stringify({ type: "frame", code: "ELEVATED_TOKEN" }))).toBeNull();
  });
});

describe("request-cap rotation without request loss", () => {
  it("serves the capped request on the replacement host and counts the rotation", async () => {
    const hooks = {
      onFrame: vi.fn(),
      onRotation: vi.fn(),
      onRestart: vi.fn(),
      onFallback: vi.fn(),
    };
    const harness = createHarness({
      onCommand: perChildRequestCap(2),
      hostOptions: { hooks, maxRequests: 2, maxLifetimeMs: 60_000 },
    });
    const captures = [];
    for (let index = 0; index < 3; index++) captures.push(await harness.host.capture(TARGET));
    // Each host serves two commands; the third is re-issued to a fresh host.
    expect(captures).toHaveLength(3);
    expect(captures.every((capture) => capture.targetWindow.nativeId === "456")).toBe(true);
    expect(harness.children).toHaveLength(2);
    expect(harness.host.rotationCount).toBe(1);
    expect(harness.host.servedRequestCount).toBe(3);
    expect(hooks.onFrame).toHaveBeenCalledTimes(3);
    expect(hooks.onRotation).toHaveBeenCalledWith("request-cap");
    expect(hooks.onRestart).not.toHaveBeenCalled();
    expect(hooks.onFallback).not.toHaveBeenCalled();
    expect(harness.host.available).toBe(true);
    harness.host.close();
  });

  it("forwards the sanitized budget to every child environment", async () => {
    const harness = createHarness({
      onCommand: perChildRequestCap(2),
      hostOptions: { maxRequests: 2, maxLifetimeMs: 50_000 },
    });
    await harness.host.capture(TARGET);
    await harness.host.capture(TARGET);
    await harness.host.capture(TARGET);
    expect(harness.envs).toHaveLength(2);
    for (const env of harness.envs) {
      expect(env[DESKTOP_HOST_NONCE_ENV]).toBe(NONCE);
      expect(env[DESKTOP_HOST_MAX_REQUESTS_ENV]).toBe("2");
      expect(env[DESKTOP_HOST_MAX_LIFETIME_MS_ENV]).toBe("50000");
    }
    harness.host.close();
  });

  it("re-issues a lifetime rotation exactly once and reports the reason", async () => {
    const hooks = { onRotation: vi.fn() };
    const harness = createHarness({
      onCommand: (_command, child, childIndex) => {
        if (childIndex === 0) {
          child.emitData(`${rotationLine("lifetime")}\n`);
          return;
        }
        child.emitData(`${FRAME_LINE}\n`);
      },
      hostOptions: { hooks },
    });
    const capture = await harness.host.capture(TARGET);
    expect(capture.targetWindow.pid).toBe(123);
    expect(hooks.onRotation.mock.calls).toEqual([["lifetime"]]);
    expect(harness.children).toHaveLength(2);
    expect(harness.host.servedRequestCount).toBe(1);
    harness.host.close();
  });
});

describe("rotation arrives outside a pending request", () => {
  it("rotates between requests without spending the crash budget or failing", async () => {
    const hooks = { onRotation: vi.fn(), onRestart: vi.fn(), onFallback: vi.fn() };
    const harness = createHarness({
      onCommand: (_command, child) => {
        child.emitData(`${FRAME_LINE}\n`);
      },
      hostOptions: { hooks, maxRequests: 5, maxLifetimeMs: 60_000 },
    });
    await harness.host.capture(TARGET);
    // The idle watchdog path: the host exits on its own between requests.
    harness.children[0].emitData(`${rotationLine("lifetime")}\n`);
    await delay(30);
    expect(harness.host.rotationCount).toBe(1);
    expect(hooks.onRotation).toHaveBeenCalledWith("lifetime");
    expect(hooks.onRestart).not.toHaveBeenCalled();
    const second = await harness.host.capture(TARGET);
    expect(second.targetWindow.nativeId).toBe("456");
    expect(harness.children).toHaveLength(2);
    expect(harness.host.available).toBe(true);
    harness.host.close();
  });
});

describe("rotation failure and fallback", () => {
  it("fails permanently after two rotations in a row and reports the fallback", async () => {
    const hooks = { onRotation: vi.fn(), onFallback: vi.fn(), onRestart: vi.fn() };
    const harness = createHarness({
      onCommand: (_command, child) => {
        child.emitData(`${rotationLine("lifetime")}\n`);
      },
      hostOptions: { hooks },
    });
    await expectRejection(harness.host.capture(TARGET), /rotated twice/);
    expect(harness.children).toHaveLength(2);
    expect(harness.host.rotationCount).toBe(2);
    expect(harness.host.available).toBe(false);
    expect(hooks.onFallback).toHaveBeenCalledWith(expect.stringContaining("rotated twice"));
    expect(hooks.onRestart).not.toHaveBeenCalled();
    await expectRejection(harness.host.capture(TARGET), /unavailable/);
    expect(harness.children).toHaveLength(2);
  });

  it("lets the Windows adapter fall back to PowerShell when rotation fails", async () => {
    const harness = createHarness({
      onCommand: (_command, child) => {
        child.emitData(`${rotationLine("request-cap")}\n`);
      },
    });
    const runner = scriptedRunner();
    const adapter = createWindowsDesktopUiAdapter(runner, { desktopHost: harness.host });
    const capture = await adapter.capture(TARGET);
    expect(capture.targetWindow.pid).toBe(123);
    expect(harness.host.available).toBe(false);
    expect(runner.run).toHaveBeenCalledTimes(1);
    // Both native operations fell through to the audited PowerShell paths.
    const snapshot = await adapter.inspectAccessibility(TARGET, capture);
    expect(snapshot.window.pid).toBe(123);
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(harness.host.rotationCount).toBe(2);
  });
});

describe("typed startup refusal without executing the binary", () => {
  it("treats an elevated-token refusal as fatal and never retries into it", async () => {
    const hooks = { onFallback: vi.fn(), onRestart: vi.fn(), onRotation: vi.fn() };
    const harness = createHarness({
      ready: (child) => {
        child.emitData(
          `${JSON.stringify({ type: "error", code: "ELEVATED_TOKEN", message: "elevated helper refused" })}\n`,
        );
      },
      hostOptions: { hooks },
    });
    const error = await expectRejection(harness.host.capture(TARGET), /ELEVATED_TOKEN/);
    expect(error.code).toBe("DESKTOP_UI_UNAVAILABLE");
    expect(harness.children).toHaveLength(1);
    expect(harness.host.available).toBe(false);
    expect(hooks.onFallback).toHaveBeenCalledWith(expect.stringContaining("ELEVATED_TOKEN"));
    expect(hooks.onRestart).not.toHaveBeenCalled();
    expect(hooks.onRotation).not.toHaveBeenCalled();
  });

  it("treats a privilege-hardening refusal as fatal and falls back to PowerShell", async () => {
    const harness = createHarness({
      ready: (child) => {
        child.emitData(
          `${JSON.stringify({ type: "error", code: "PRIVILEGE_HARDENING_FAILED", message: "SeDebugPrivilege" })}\n`,
        );
      },
    });
    const runner = scriptedRunner();
    const adapter = createWindowsDesktopUiAdapter(runner, { desktopHost: harness.host });
    const capture = await adapter.capture(TARGET);
    expect(capture.targetWindow.pid).toBe(123);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(harness.host.available).toBe(false);
  });
});

function fakePng(): Uint8Array {
  const bytes = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(100, 16);
  bytes.writeUInt32BE(50, 20);
  return bytes;
}

/** Scripted PowerShell fallback runner: records calls, writes a fake frame. */
function scriptedRunner(): DesktopProcessRunner & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (request: SafeProcessRequest) => {
    const payload = JSON.parse(request.env?.SUPERAGENT_DESKTOP_UI_PAYLOAD ?? "{}");
    if (typeof payload.outputPath === "string") {
      await writeFile(payload.outputPath, fakePng());
      return { stdout: JSON.stringify(WINDOW), stderr: "", exitCode: 0 };
    }
    return { stdout: JSON.stringify({ window: WINDOW, elements: [] }), stderr: "", exitCode: 0 };
  });
  return { run } as unknown as DesktopProcessRunner & { run: ReturnType<typeof vi.fn> };
}
