import { describe, expect, it, vi } from "vitest";
import { createMacDesktopAppProvider } from "../../src/core/desktopApp/macos.js";
import { createLinuxDesktopAppProvider } from "../../src/core/desktopApp/linux.js";
import type { DesktopProcessRunner } from "../../src/core/desktopUi/processRunner.js";

describe("cross-platform installed-app launcher boundaries", () => {
  it("macOS opens only an unambiguous installed bundle ID, not an executable path", async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request) => {
        calls.push(request);
        if (request.executable === "/usr/bin/plutil") {
          return { stdout: "com.example.Editor\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const provider = createMacDesktopAppProvider({
      runner,
      scanBundles: async () => [{ bundlePath: "/Applications/Editor.app", name: "Editor" }],
    });
    const found = await provider.listApplications(5);
    expect(found.applications).toEqual([
      expect.objectContaining({ id: "com.example.Editor", launchKind: "macos-bundle-id" }),
    ]);
    await expect(provider.launchVerified("com.example.Editor")).resolves.toMatchObject({ launched: true });
    expect(calls.at(-1)).toEqual({ executable: "/usr/bin/open", args: ["-b", "com.example.Editor"], timeoutMs: 10_000 });
    await expect(provider.launchVerified("/bin/sh")).rejects.toMatchObject({ code: "INVALID_ACTION" });
    await expect(provider.launchVerified("com.example.Unknown")).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    await expect(provider.focusExact({ pid: 7, nativeId: "cg:5" })).rejects.toMatchObject({ code: "PROCESS_FAILED" });
  });

  it("macOS refuses duplicate bundle IDs rather than launching an ambiguous app", async () => {
    const runner: DesktopProcessRunner = {
      run: vi.fn(async () => ({ stdout: "com.example.Same", stderr: "", exitCode: 0 })),
    };
    const provider = createMacDesktopAppProvider({
      runner,
      scanBundles: async () => [
        { bundlePath: "/Applications/One.app", name: "One" },
        { bundlePath: "/Applications/Two.app", name: "Two" },
      ],
    });
    expect((await provider.listApplications(10)).applications).toEqual([]);
    await expect(provider.launchVerified("com.example.Same")).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
  });

  it("Linux runs only gtk-launch for verified visible desktop entry IDs", async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request) => {
        calls.push(request);
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const provider = createLinuxDesktopAppProvider({
      runner,
      scanEntries: async () => [
        { fileName: "org.example.Editor.desktop", contents: "[Desktop Entry]\nType=Application\nName=Editor\nExec=/bin/sh -c dangerous\n" },
        { fileName: "hidden.desktop", contents: "[Desktop Entry]\nType=Application\nName=Hidden\nNoDisplay=true\n" },
      ],
    });
    expect((await provider.listApplications(10)).applications).toEqual([
      expect.objectContaining({ id: "org.example.Editor", launchKind: "linux-desktop-entry" }),
    ]);
    await expect(provider.launchVerified("org.example.Editor")).resolves.toMatchObject({ launched: true });
    expect(calls).toEqual([{ executable: "/usr/bin/gtk-launch", args: ["org.example.Editor"], timeoutMs: 10_000 }]);
    await expect(provider.launchVerified("../../../bin/sh")).rejects.toMatchObject({ code: "INVALID_ACTION" });
    await expect(provider.launchVerified("hidden")).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    await expect(provider.closeExact({ pid: 6, nativeId: "atspi:6:Editor" })).rejects.toMatchObject({ code: "OS_PERMISSION_REQUIRED" });
  });
});
