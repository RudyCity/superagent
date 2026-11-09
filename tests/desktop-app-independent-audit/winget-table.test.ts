import { describe, expect, it, vi } from "vitest";
import { createDesktopPackageProvider } from "../../src/core/desktopApp/packages.js";
import type { DesktopProcessRunner } from "../../src/core/desktopUi/processRunner.js";

describe("Windows installed-package table parsing", () => {
  it("accepts winget's continuous-dash table separator and bounded installed rows", async () => {
    const output = [
      "Name                         Id                          Version       Available Source",
      "--------------------------------------------------------------------------------------",
      "Example App                  Example.App                 1.0.0         1.1.0     winget",
      "Other Application            Example.Other               5.0           5.1       winget",
    ].join("\r\n");
    const runner: DesktopProcessRunner = {
      run: vi.fn(async () => ({
        stdout: JSON.stringify({ exitCode: 0, output }),
        stderr: "",
        exitCode: 0,
      })),
    };
    const provider = createDesktopPackageProvider({ platform: "win32", runner, allowPotentialNetworkInventory: true });
    const inventory = await provider.listInstalled(1);
    expect(inventory.packages).toEqual([
      expect.objectContaining({ id: "Example.App", name: "Example App", manager: "winget" }),
    ]);
    expect(inventory.truncated).toBe(true);
  });
});
