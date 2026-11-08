import { DesktopUiError } from "./errors.js";
import type { DesktopProcessRunner } from "./processRunner.js";
import { createLinuxDesktopUiAdapter } from "./adapters/linux.js";
import { createMacOsDesktopUiAdapter } from "./adapters/macos.js";
import { createWindowsDesktopUiAdapter } from "./adapters/windows.js";
import type { DesktopUiAdapter } from "./types.js";

export interface NativeDesktopUiAdapterOptions {
  platform?: NodeJS.Platform;
  runner?: DesktopProcessRunner;
}

export function createNativeDesktopUiAdapter(
  options: NativeDesktopUiAdapterOptions = {},
): DesktopUiAdapter {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return createWindowsDesktopUiAdapter(options.runner);
  if (platform === "darwin") return createMacOsDesktopUiAdapter(options.runner);
  if (platform === "linux") return createLinuxDesktopUiAdapter(options.runner);
  throw new DesktopUiError(
    "PLATFORM_UNSUPPORTED",
    `Native desktop UI automation is unsupported on platform '${platform}'.`,
  );
}
