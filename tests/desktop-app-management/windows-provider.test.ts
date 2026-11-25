import { describe, expect, it, vi } from "vitest";
import { createWindowsDesktopAppProvider } from "../../src/core/desktopApp/windows.js";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";
import type { DesktopProcessRunner, SafeProcessRequest } from "../../src/core/desktopUi/processRunner.js";

function decodedPowerShell(request: SafeProcessRequest): string {
  const encoded = request.args.at(-1);
  if (!encoded) return "";
  return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("Windows desktop application provider", () => {
  it("discovers Start apps and launches only an exact freshly verified AppsFolder ID", async () => {
    const calls: SafeProcessRequest[] = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request) => {
        calls.push(request);
        if (request.executable.toLowerCase().endsWith("explorer.exe")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        const script = decodedPowerShell(request);
        expect(script).toContain("Get-StartApps");
        return {
          stdout: JSON.stringify({
            applications: [
              { id: "Contoso.App_abc!App", name: "Contoso" },
              { id: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", name: "Terminal" },
            ],
            truncated: false,
          }),
          stderr: "",
          exitCode: 0,
        };
      }),
    };

    const provider = createWindowsDesktopAppProvider(runner);
    const inventory = await provider.listApplications(10);
    expect(inventory.applications.map((app) => app.id)).toEqual([
      "Contoso.App_abc!App",
      "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App",
    ]);

    await expect(provider.launchVerified("Contoso.App_abc!App")).resolves.toEqual({
      launched: true,
      appId: "Contoso.App_abc!App",
    });
    const launch = calls.find((call) => call.executable.toLowerCase().endsWith("explorer.exe"));
    expect(launch?.args).toEqual(["shell:AppsFolder\\Contoso.App_abc!App"]);

    const beforeUnknown = calls.length;
    await expect(provider.launchVerified("Missing.App!App")).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(calls.slice(beforeUnknown).some((call) => call.executable.toLowerCase().endsWith("explorer.exe"))).toBe(false);
  });

  it("rejects path, URL, control-character and oversized application IDs before launch", async () => {
    const runner: DesktopProcessRunner = {
      run: vi.fn(async () => ({ stdout: "{}", stderr: "", exitCode: 0 })),
    };
    const provider = createWindowsDesktopAppProvider(runner);

    for (const id of [
      "C:\\Windows\\System32\\calc.exe",
      "https://example.test/app",
      "file:calc.exe",
      "bad\nid",
      "x".repeat(513),
    ]) {
      await expect(provider.launchVerified(id)).rejects.toMatchObject({ code: "INVALID_ACTION" });
    }
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("focuses and gracefully closes only an exact PID/HWND identity without process-kill commands", async () => {
    const scripts: string[] = [];
    const payloads: unknown[] = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request) => {
        scripts.push(decodedPowerShell(request));
        payloads.push(JSON.parse(request.env?.SUPERAGENT_DESKTOP_APP_PAYLOAD ?? "{}"));
        return { stdout: JSON.stringify({ ok: true }), stderr: "", exitCode: 0 };
      }),
    };
    const provider = createWindowsDesktopAppProvider(runner);

    await expect(provider.focusExact({ pid: 4242, nativeId: "123456" })).resolves.toEqual({ focused: true });
    await expect(provider.closeExact({ pid: 4242, nativeId: "123456" })).resolves.toEqual({ closeRequested: true });

    expect(payloads).toEqual([
      { pid: 4242, nativeId: "123456", action: "focus" },
      { pid: 4242, nativeId: "123456", action: "close" },
    ]);
    expect(scripts.join("\n")).toContain("GetWindowThreadProcessId");
    expect(scripts.join("\n")).toContain("SetForegroundWindow");
    expect(scripts.join("\n")).toContain("PostMessage");
    expect(scripts.join("\n")).not.toMatch(/Stop-Process|taskkill|TerminateProcess/i);

    await expect(provider.closeExact({ pid: 4242, nativeId: "123;Remove-Item" })).rejects.toMatchObject({
      code: "INVALID_ACTION",
    });
  });

  it("discovers active monitors via ToArray() without PowerShell PSCustomObject ArgumentException", async () => {
    let capturedScript = "";
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request) => {
        capturedScript = decodedPowerShell(request);
        return {
          stdout: JSON.stringify({
            monitors: [
              {
                index: 0,
                deviceName: "\\\\.\\DISPLAY1",
                primary: true,
                bitsPerPixel: 32,
                bounds: { x: 0, y: 0, width: 1920, height: 1080 },
                workingArea: { x: 0, y: 0, width: 1920, height: 1032 },
              },
              {
                index: 1,
                deviceName: "\\\\.\\DISPLAY2",
                primary: false,
                bitsPerPixel: 32,
                bounds: { x: 1920, y: 0, width: 1280, height: 720 },
                workingArea: { x: 1920, y: 0, width: 1280, height: 720 },
              },
            ],
            count: 2,
          }),
          stderr: "",
          exitCode: 0,
        };
      }),
    };

    const adapter = createWindowsDesktopUiAdapter(runner);
    const result = await adapter.listMonitors!();

    expect(capturedScript).toContain("$monitorArray = $monitors.ToArray()");
    expect(capturedScript).not.toContain("monitors = @($monitors)");
    expect(result).toEqual({
      count: 2,
      monitors: [
        {
          index: 0,
          deviceName: "\\\\.\\DISPLAY1",
          primary: true,
          bitsPerPixel: 32,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workingArea: { x: 0, y: 0, width: 1920, height: 1032 },
        },
        {
          index: 1,
          deviceName: "\\\\.\\DISPLAY2",
          primary: false,
          bitsPerPixel: 32,
          bounds: { x: 1920, y: 0, width: 1280, height: 720 },
          workingArea: { x: 1920, y: 0, width: 1280, height: 720 },
        },
      ],
    });
  });
});
