import { describe, expect, it, vi } from "vitest";
import { createWindowsDesktopAppProvider } from "../../src/core/desktopApp/windows.js";
import type { DesktopProcessRunner } from "../../src/core/desktopUi/processRunner.js";

describe("Windows installed-program registry inventory", () => {
  it("enumerates only bounded name/version/publisher without returning installer paths", async () => {
    let script = "";
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request) => {
        script = Buffer.from(request.args.at(-1)!, "base64").toString("utf16le");
        return {
          stdout: JSON.stringify({
            programs: [{
              name: "Example App",
              version: "2.5",
              publisher: "Example Publisher",
              uninstallString: "DO_NOT_EXPOSE_UNINSTALL_COMMAND",
            }],
            truncated: true,
          }),
          stderr: "", exitCode: 0,
        };
      }),
    };
    const provider = createWindowsDesktopAppProvider(runner);
    const result = await provider.listRegisteredPrograms!(10);
    expect(result.truncated).toBe(true);
    expect(result.programs).toEqual([{ name: "Example App", version: "2.5", publisher: "Example Publisher" }]);
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPOSE_UNINSTALL_COMMAND");
    expect(script).toContain("HKLM:" + String.fromCharCode(92) + "Software");
    expect(script).toContain("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
    expect(script).toContain("Get-ItemProperty");
    expect(script).not.toContain("Start-Process");
    expect(script).not.toContain("UninstallString");
  });
  it("filters unexpanded installer display-name templates from registered programs", async () => {
    const runner: DesktopProcessRunner = {
      run: vi.fn(async () => ({
        stdout: JSON.stringify({ programs: [
          { name: "${{arpDisplayName}}", publisher: "Unknown" },
          { name: "Real Editor", version: "2.0", publisher: "Verified" },
        ], truncated: false }),
        stderr: "", exitCode: 0,
      })),
    };
    const programs = await createWindowsDesktopAppProvider(runner).listRegisteredPrograms!(10);
    expect(programs.programs).toEqual([{ name: "Real Editor", version: "2.0", publisher: "Verified" }]);
    expect(programs.truncated).toBe(false);
  });
});
