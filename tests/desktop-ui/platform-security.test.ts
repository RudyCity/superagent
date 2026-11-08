import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createMacOsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/macos.js";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";
import type { DesktopProcessRunner, SafeProcessRequest } from "../../src/core/desktopUi/processRunner.js";
import type { NativeDesktopAction } from "../../src/core/desktopUi/types.js";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function fakePng(width = 100, height = 50): Uint8Array {
  const bytes = Buffer.alloc(25);
  Buffer.from(PNG_SIGNATURE).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function decodePowerShell(request: SafeProcessRequest): string {
  const encoded = request.args.at(-1);
  if (!encoded) throw new Error("missing encoded script");
  return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("native platform security contracts", () => {
  it("Windows revalidates HWND PID/root ownership, DPI context, and uses PrintWindow instead of screen-region capture", async () => {
    let captureScript = "";
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request: SafeProcessRequest) => {
        const script = decodePowerShell(request);
        captureScript = script;
        const payload = JSON.parse(request.env?.SUPERAGENT_DESKTOP_UI_PAYLOAD ?? "{}");
        await writeFile(payload.outputPath, fakePng());
        return {
          stdout: JSON.stringify({
            pid: 123,
            nativeId: "456",
            title: "Target",
            active: true,
            scaleFactor: 1,
            bounds: { x: 0, y: 0, width: 100, height: 50 },
          }),
          stderr: "",
          exitCode: 0,
        };
      }),
    };

    await createWindowsDesktopUiAdapter(runner).capture({ pid: 123, nativeId: "456" });

    expect(captureScript).toContain("GetWindowThreadProcessId");
    expect(captureScript).toContain("GetAncestor");
    expect(captureScript).toContain("supplied HWND is not owned by the requested PID");
    expect(captureScript).toContain("SetThreadDpiAwarenessContext");
    expect(captureScript).toContain("PrintWindow");
    expect(captureScript).not.toContain("CopyFromScreen");
  });

  it("Windows recovers WinForms control roles only from verified same-process child HWND classes", async () => {
    let accessibilityScript = "";
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request: SafeProcessRequest) => {
        accessibilityScript = decodePowerShell(request);
        return {
          stdout: JSON.stringify({
            window: { pid: 123, nativeId: "456", title: "Fixture", active: false, bounds: { x: 0, y: 0, width: 200, height: 100 } },
            elements: [],
          }),
          stderr: "",
          exitCode: 0,
        };
      }),
    };
    const capture = {
      image: fakePng(200, 100),
      capturedAt: "2026-11-08T00:00:00.000Z",
      targetWindow: {
        pid: 123,
        nativeId: "456",
        title: "Fixture",
        active: false,
        bounds: { x: 0, y: 0, width: 200, height: 100 },
      },
    };
    await createWindowsDesktopUiAdapter(runner).inspectAccessibility({ pid: 123, nativeId: "456" }, capture);
    expect(accessibilityScript).toContain("GetClassName");
    expect(accessibilityScript).toContain("GetWindowThreadProcessId($nativeHandle");
    expect(accessibilityScript).toContain("IsChild($hwnd, $nativeHandle)");
    expect(accessibilityScript).toContain("WindowsForms10");
    expect(accessibilityScript).toContain('if ($role -eq "Pane"');
    expect(accessibilityScript).toContain("IsOffscreen -and ($actionableRoles -contains $role)");
    expect(accessibilityScript).not.toContain("IsKeyboardFocusable -or");
  });

  it("Windows uses exact SendInput batches with final foreground checks and never treats a focusable pane as actionable", async () => {
    let inputScript = "";
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request: SafeProcessRequest) => {
        inputScript = decodePowerShell(request);
        return { stdout: '{"ok":true}', stderr: "", exitCode: 0 };
      }),
    };
    await createWindowsDesktopUiAdapter(runner).dispatch({
      kind: "key",
      target: { pid: 123, nativeId: "456" },
      key: "TAB",
      modifiers: ["CTRL"],
    });
    expect(inputScript).toContain("SendInput((uint)events.Length");
    expect(inputScript).toContain("GetForegroundWindow() != target");
    expect(inputScript).toContain("KeyChord($hwnd, $vk");
    expect(inputScript).toContain("best-effort modifier release");
    expect(inputScript).not.toContain("keybd_event(");
    expect(inputScript).not.toContain("mouse_event(");
  });

  it("Windows scroll moves and wheels without invoking click or mouse-down/up in the scroll branch", async () => {
    let inputScript = "";
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request: SafeProcessRequest) => {
        inputScript = decodePowerShell(request);
        return { stdout: '{"ok":true}', stderr: "", exitCode: 0 };
      }),
    };
    const action: NativeDesktopAction = {
      kind: "scroll",
      target: { pid: 123, nativeId: "456" },
      point: { x: 20, y: 20 },
      element: {
        id: "a1",
        role: "list",
        label: "Items",
        description: null,
        value: null,
        bounds: { x: 0, y: 0, width: 50, height: 50 },
        center: { x: 20, y: 20 },
        source: "accessibility",
        confidence: 1,
        actionable: true,
      },
      deltaX: 0,
      deltaY: -1,
    };

    await createWindowsDesktopUiAdapter(runner).dispatch(action);

    const scrollBranch = inputScript.match(/"scroll"\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
    expect(scrollBranch).toContain("Move-Point");
    expect(scrollBranch).not.toContain("Click-Point");
    expect(scrollBranch).not.toContain("0x0002");
    expect(scrollBranch).not.toContain("0x0004");
  });

  it("macOS capture uses an unambiguous CoreGraphics window ID and never region capture", async () => {
    const calls: SafeProcessRequest[] = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request: SafeProcessRequest) => {
        calls.push(request);
        if (request.executable.endsWith("osascript")) {
          return {
            stdout: JSON.stringify({
              pid: 77,
              nativeId: "cg:99",
              title: "Target",
              active: true,
              bounds: { x: 10, y: 20, width: 100, height: 50 },
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        const outputPath = request.args.at(-1)!;
        await writeFile(outputPath, fakePng());
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };

    await createMacOsDesktopUiAdapter(runner).capture({ pid: 77, title: "Target" });

    const jxa = calls.find((request) => request.executable.endsWith("osascript"))?.args.at(-1) ?? "";
    const screenshot = calls.find((request) => request.executable.endsWith("screencapture"));
    expect(jxa).toContain("CGWindowListCopyWindowInfo");
    expect(jxa).toContain("AX window selection is absent or ambiguous");
    expect(screenshot?.args).toContain("-l99");
    expect(screenshot?.args.some((arg) => arg.startsWith("-R"))).toBe(false);
  });

  it("macOS input targets the selected application process instead of System Events", async () => {
    let script = "";
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request: SafeProcessRequest) => {
        script = request.args.at(-1) ?? "";
        return { stdout: '{"ok":true}', stderr: "", exitCode: 0 };
      }),
    };

    await createMacOsDesktopUiAdapter(runner).dispatch({
      kind: "click",
      target: { pid: 77, nativeId: "cg:99", title: "Target" },
      point: { x: 20, y: 30 },
      element: {
        id: "a1",
        role: "button",
        label: "Go",
        description: null,
        value: null,
        bounds: { x: 10, y: 20, width: 20, height: 20 },
        center: { x: 20, y: 30 },
        source: "accessibility",
        confidence: 1,
        actionable: true,
      },
    });

    expect(script).toContain("proc.click({ at:");
    expect(script).not.toContain("se.click({ at:");
    expect(script).toContain("win.focused()");
  });
});
