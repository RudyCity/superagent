import { describe, expect, it, vi } from "vitest";
import { DesktopAppManager } from "../../src/core/desktopApp/service.js";
import { DesktopUiError } from "../../src/core/desktopUi/errors.js";
import type { DesktopAppLifecycleProvider, DesktopPackageProvider } from "../../src/core/desktopApp/types.js";

describe("application inventory remains useful without a package manager", () => {
  for (const platform of ["darwin", "linux"] as const) {
    it(platform + " returns launchable apps when the package-manager binary is unavailable", async () => {
      const appProvider: DesktopAppLifecycleProvider = {
        listApplications: async () => ({
          applications: [{
            id: "example.Test",
            name: "Example Test",
            platform,
            launchKind: platform === "darwin" ? "macos-bundle-id" : "linux-desktop-entry",
          }],
          truncated: false,
        }),
        launchVerified: async (appId) => ({ launched: true, appId }),
        focusExact: vi.fn(async () => ({ focused: true })),
        closeExact: vi.fn(async () => ({ closeRequested: true })),
        waitUntilClosed: vi.fn(async () => true),
      };
      const packageProvider: DesktopPackageProvider = {
        manager: platform === "darwin" ? "brew" : "apt",
        listInstalled: async () => {
          throw new DesktopUiError("DEPENDENCY_REQUIRED", "Package manager missing");
        },
        apply: vi.fn(async () => {
          throw new Error("Never called");
        }),
      };
      const manager = new DesktopAppManager({ platform, appProvider, packageProvider });
      const result = await manager.listInstalledApps(10);
      expect(result.applications).toEqual([expect.objectContaining({ id: "example.Test" })]);
      expect(result.packages).toEqual([]);
      expect(result.limitations.join(" ")).toContain("Package-manager inventory is unavailable");
    });
  }
});
