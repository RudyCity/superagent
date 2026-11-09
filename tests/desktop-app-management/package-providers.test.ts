import { describe, expect, it, vi } from "vitest";
import { createDesktopPackageProvider } from "../../src/core/desktopApp/packages.js";
import type { DesktopProcessRunner, SafeProcessRequest } from "../../src/core/desktopUi/processRunner.js";
import type { PackageChangePlan } from "../../src/core/desktopApp/types.js";

describe("desktop package providers", () => {
  it("uses bounded non-interactive winget list arguments and exact package IDs", async () => {
    const payloads: Array<{ args: string[] }> = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request: SafeProcessRequest) => {
        const payload = JSON.parse(request.env?.SUPERAGENT_DESKTOP_PACKAGE_PAYLOAD ?? "{}");
        payloads.push(payload);
        const output = [
          "Name       Id        Version    Source",
          "---------  --------  ---------  ------",
          "Git        Git.Git   2.51.0     winget",
          "Node.js    OpenJS.NodeJS  24.0.0  winget",
          "Extra      Extra.App  1.0.0      winget",
        ].join("\n");
        return { stdout: JSON.stringify({ exitCode: 0, output }), stderr: "", exitCode: 0 };
      }),
    };
    const provider = createDesktopPackageProvider({
      platform: "win32",
      runner,
      allowPotentialNetworkInventory: true,
    });

    const result = await provider.listInstalled(2);
    expect(result.packages.map((pkg) => pkg.id)).toEqual(["Git.Git", "OpenJS.NodeJS"]);
    expect(result.truncated).toBe(true);
    expect(payloads[0].args).toEqual(["list", "--disable-interactivity", "--count", "3"]);
    expect(payloads[0].args.join(" ")).not.toMatch(/--accept-|--silent/i);

    const plan: PackageChangePlan = {
      action: "update",
      manager: "winget",
      packageId: "Git.Git",
      requestedVersion: "2.52.0",
      destructive: false,
      steps: [{ operation: "upgrade", manager: "winget", packageId: "Git.Git", version: "2.52.0" }],
      sideEffects: [],
    };
    await provider.apply(plan);
    expect(payloads.at(-1)?.args).toEqual([
      "upgrade", "--id", "Git.Git", "--exact", "--disable-interactivity", "--version", "2.52.0",
    ]);
    expect(payloads.at(-1)?.args.join(" ")).not.toMatch(/--accept-|--silent/i);
  });

  it("fails closed before WinGet inventory when strict-offline policy is active", async () => {
    const runner: DesktopProcessRunner = {
      run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    };
    const provider = createDesktopPackageProvider({ platform: "win32", runner });
    await expect(provider.listInstalled(10)).rejects.toMatchObject({ code: "DEPENDENCY_REQUIRED" });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("uses trusted Homebrew paths and local brew list for macOS inventory", async () => {
    const calls: SafeProcessRequest[] = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request) => {
        calls.push(request);
        if (request.args.includes("--formula")) {
          return { stdout: "git 2.51.0\nnode 24.0.0\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "visual-studio-code 1.100.0\n", stderr: "", exitCode: 0 };
      }),
    };
    const provider = createDesktopPackageProvider({
      platform: "darwin",
      runner,
      pathExists: async (candidate) => candidate === "/opt/homebrew/bin/brew",
    });

    const result = await provider.listInstalled(10);
    expect(result.packages.map((pkg) => pkg.id)).toEqual(["git", "node", "visual-studio-code"]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.executable === "/opt/homebrew/bin/brew")).toBe(true);
    expect(calls.every((call) => call.args[0] === "list")).toBe(true);
  });

  it("enumerates apt locally and fails closed for Linux package mutation without sudo or pkexec", async () => {
    const calls: SafeProcessRequest[] = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request) => {
        calls.push(request);
        return {
          stdout: "Listing... Done\ncurl/stable,now 8.0 amd64 [installed]\ngit/stable,now 2.45 amd64 [installed]\n",
          stderr: "",
          exitCode: 0,
        };
      }),
    };
    const provider = createDesktopPackageProvider({
      platform: "linux",
      runner,
      pathExists: async (candidate) => candidate === "/usr/bin/apt",
    });
    const inventory = await provider.listInstalled(10);
    expect(inventory.packages.map((pkg) => pkg.id)).toEqual(["curl", "git"]);
    expect(calls[0]).toMatchObject({ executable: "/usr/bin/apt", args: ["list", "--installed"] });

    await expect(provider.apply({
      action: "install",
      manager: "apt",
      packageId: "curl",
      destructive: false,
      steps: [{ operation: "install", manager: "apt", packageId: "curl" }],
      sideEffects: [],
    })).rejects.toMatchObject({ code: "OS_PERMISSION_REQUIRED" });
    expect(calls.some((call) => /sudo|pkexec/i.test([call.executable, ...call.args].join(" ")))).toBe(false);
  });

  it("enumerates dnf from cache only when apt is unavailable", async () => {
    const calls: SafeProcessRequest[] = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (request) => {
        calls.push(request);
        return {
          stdout: "Installed Packages\ngit.x86_64 2.45.0 @System\ncurl.x86_64 8.0.0 @System\n",
          stderr: "",
          exitCode: 0,
        };
      }),
    };
    const provider = createDesktopPackageProvider({
      platform: "linux",
      runner,
      pathExists: async (candidate) => candidate === "/usr/bin/dnf",
    });
    const inventory = await provider.listInstalled(10);
    expect(inventory.packages.map((pkg) => pkg.id)).toEqual(["git", "curl"]);
    expect(calls[0]).toMatchObject({
      executable: "/usr/bin/dnf",
      args: ["list", "--installed", "--cacheonly"],
    });
  });
});
