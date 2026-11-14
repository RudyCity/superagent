import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { openVerifiedWindowsRemoteSemanticNative } from "../../src/core/desktopUi/adapters/windowsRemoteSemanticNative.js";
import type { RemoteHostScope } from "../../src/core/desktopUi/remoteControlAuthority.js";

/**
 * Opt-in physical Windows smoke. Only this temporary WinForms child can be
 * touched; it automatically closes, no existing user applications selected.
 * SUPERAGENT_RUN_NATIVE_WINFORMS_E2E=1 bun vitest run ...
 */
describe("Windows UIA native disposable control host smoke", () => {
  const enabled = process.platform === "win32" &&
    process.env.SUPERAGENT_RUN_NATIVE_WINFORMS_E2E === "1";
  it.skipIf(!enabled)("executes one InvokePattern only on its own temporary WinForms button", async () => {
    const native = await openVerifiedWindowsRemoteSemanticNative();
    expect(native, "Verified x64 native DLL must already exist").not.toBeNull();
    if (!native) throw new Error("No trusted native DLL");
    const script = path.join(process.cwd(), "native", "desktop-live-windows-input", "disposableWinFormsFixture.ps1");
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    ], { shell: false, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
    let readBuffer = "";
    let foundReady = false;
    let resolveReady!: (value: any) => void;
    let rejectReady!: (err: Error) => void;
    let resolveClick!: (value: string) => void;
    const ready = new Promise<any>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const clicked = new Promise<string>(resolve => { resolveClick = resolve; });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
    child.stdout?.on("data", chunk => {
      readBuffer += chunk.toString("utf8");
      while (readBuffer.includes("\n")) {
        const index = readBuffer.indexOf("\n");
        const line = readBuffer.slice(0, index).trim();
        readBuffer = readBuffer.slice(index + 1);
        if (line.startsWith("CLICKED:")) resolveClick(line);
        else if (line.startsWith("{") && !foundReady) {
          try { foundReady = true; resolveReady(JSON.parse(line)); }
          catch (err) { rejectReady(err as Error); }
        }
      }
    });
    child.on("error", rejectReady);
    child.on("exit", code => {
      if (!foundReady) rejectReady(new Error("Dedicated WinForms child exited " + code + ": " + stderr));
    });
    try {
      const timeout = <T>(work: Promise<T>, label: string): Promise<T> =>
        Promise.race([work, new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for " + label + ": " + stderr)), 8000))]);
      const descriptor = await timeout(ready, "dedicated HWND");
      const scope: RemoteHostScope = {
        ...descriptor, platform: "win32",
        hostGeneration: 1, viewSessionId: "local-native-smoke-only",
      };
      expect(scope.nativeId).toMatch(/^[0-9]+$/);
      expect(scope.processBirthId).toMatch(/^filetime:\d+$/);
      // MCP-launched PowerShell may not own foreground. An attending human can
      // select only the disposable fixture; never steal focus or use SendInput.
      const statuses = new Set<number>();
      const until = Date.now() + 12_000;
      let observation = native.inspect(scope, descriptor.nativeRef);
      statuses.add(native.lastStatus());
      while (!observation && native.lastStatus() === -356 &&
          child.exitCode === null && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 200));
        observation = native.inspect(scope, descriptor.nativeRef);
        statuses.add(native.lastStatus());
      }
      expect(observation,
        "ATTENDED_FOREGROUND_BLOCKED: exact disposable HWND must be foreground " +
        "on the Default input desktop; nativeStatus=" + native.lastStatus() +
        ", statusHistory=" + [...statuses].join(",") +
        ", foregroundAtShown=" + descriptor.foregroundAtShown +
        ", defaultInputDesktopAtShown=" + descriptor.defaultInputDesktopAtShown +
        ". No focus takeover, SendInput, or app fallback attempted.").not.toBeNull();
      if (!observation) throw new Error("No verified native UIA control");
      expect(observation.element.role).toBe("button");
      expect(observation.element.patterns.invoke).toBe(true);
      let calls = 0;
      const success = native.act(scope, descriptor.nativeRef, "click",
        observation.proof, "", 0, 0, () => { calls++; });
      expect(success).toBe(true);
      expect(calls).toBe(1);
      expect(await timeout(clicked, "native WinForms InvokePattern")).toBe("CLICKED:1");
    } finally {
      native.close();
      child.kill(); // Only the test-owned disposable child, never an existing app.
    }
  }, 45000);
});
