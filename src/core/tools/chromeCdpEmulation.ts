/**
 * Chrome Remote Debugging (CDP) Device & Viewport Emulation Engine.
 *
 * Configures responsive viewports, screen orientations, touch emulation,
 * and user-agent strings for mobile, tablet, and desktop testing via CDP.
 */
import type { CdpTarget } from "./chromeCdpHelpers.js";

export interface DevicePresetConfig {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  userAgent?: string;
  platform?: string;
  description?: string;
}

export const DEVICE_PRESETS: Record<string, DevicePresetConfig> = {
  mobile: {
    name: "mobile",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    description: "Modern Smartphone (iPhone 14/15/16, 390x844 @3x, touch)",
  },
  iphone: {
    name: "iphone",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    description: "Apple iPhone (390x844 @3x, touch)",
  },
  android: {
    name: "android",
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
    description: "Android Device (Google Pixel 8 / Galaxy, 412x915 @2.6x, touch)",
  },
  pixel: {
    name: "pixel",
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
    description: "Google Pixel (412x915 @2.6x, touch)",
  },
  tablet: {
    name: "tablet",
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    platform: "iPad",
    description: "Tablet (iPad Air / Pro 11, 820x1180 @2x, touch)",
  },
  ipad: {
    name: "ipad",
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    platform: "iPad",
    description: "Apple iPad (820x1180 @2x, touch)",
  },
  desktop: {
    name: "desktop",
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    platform: "Win32",
    description: "Desktop 1080p (1920x1080 @1x, mouse/keyboard)",
  },
  laptop: {
    name: "laptop",
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    platform: "Win32",
    description: "Compact Laptop / 720p (1366x768 @1x)",
  },
};

export function listDevicePresets(): string[] {
  return Object.keys(DEVICE_PRESETS);
}

export function getDevicePreset(name: string): DevicePresetConfig | undefined {
  if (!name) return undefined;
  const key = String(name).trim().toLowerCase();
  return DEVICE_PRESETS[key];
}

export function formatPresetsHelp(): string {
  const lines = Object.entries(DEVICE_PRESETS).map(
    ([key, p]) => `  - ${key.padEnd(10)}: ${p.description || `${p.width}x${p.height}`}`
  );
  return `Available device presets:\n${lines.join("\n")}\n  - reset     : Restore native desktop viewport and clear overrides`;
}

/**
 * Execute CDP device and viewport emulation on the target tab.
 */
export async function executeDeviceEmulationCommand(
  cdpSend: (target: CdpTarget, method: string, params: any) => Promise<any>,
  target: CdpTarget,
  payload: any
): Promise<string> {
  const rawPreset = String(payload.preset || payload.device || payload.mode || "").trim().toLowerCase();

  if (payload.list_presets || payload.listPresets || rawPreset === "list" || rawPreset === "help") {
    return formatPresetsHelp();
  }

  // Handle reset to default host window
  if (rawPreset === "reset" || rawPreset === "default" || rawPreset === "clear" || rawPreset === "desktop_reset") {
    await cdpSend(target, "Emulation.clearDeviceMetricsOverride", {});
    await cdpSend(target, "Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdpSend(target, "Emulation.setUserAgentOverride", { userAgent: "" });

    let domReport = "";
    try {
      const chk: any = await cdpSend(target, "Runtime.evaluate", {
        expression: "JSON.stringify({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio })",
        returnByValue: true,
      });
      const val = chk && chk.result && chk.result.value ? JSON.parse(chk.result.value) : null;
      if (val) {
        domReport = ` (DOM reported viewport: ${val.innerWidth}x${val.innerHeight} @${val.dpr}x)`;
      }
    } catch {}

    return `control_chrome_cdp: device emulation cleared. Restored host desktop viewport and native user-agent${domReport}.`;
  }

  // Resolve preset configuration or custom dimensions
  const presetConfig = getDevicePreset(rawPreset);

  let width = Number(payload.width || presetConfig?.width || 1920);
  let height = Number(payload.height || presetConfig?.height || 1080);
  const scale = Number(payload.scale || payload.deviceScaleFactor || presetConfig?.deviceScaleFactor || 1);
  const mobile = payload.mobile !== undefined ? Boolean(payload.mobile) : Boolean(presetConfig?.mobile);
  const touch = payload.touch !== undefined ? Boolean(payload.touch) : Boolean(presetConfig?.touch);
  const userAgent = payload.userAgent !== undefined ? String(payload.userAgent) : (presetConfig?.userAgent || "");
  const platform = payload.platform !== undefined ? String(payload.platform) : (presetConfig?.platform || "");

  const orientation = String(payload.orientation || payload.screenOrientation || "portrait").toLowerCase();

  const metricsParams: any = {
    width,
    height,
    deviceScaleFactor: scale,
    mobile,
  };

  if (orientation === "landscape") {
    if (metricsParams.width < metricsParams.height) {
      const tmp = metricsParams.width;
      metricsParams.width = metricsParams.height;
      metricsParams.height = tmp;
    }
    metricsParams.screenOrientation = { angle: 90, type: "landscapePrimary" };
  } else if (orientation === "portrait") {
    if (metricsParams.width > metricsParams.height && mobile) {
      const tmp = metricsParams.width;
      metricsParams.width = metricsParams.height;
      metricsParams.height = tmp;
    }
    metricsParams.screenOrientation = { angle: 0, type: "portraitPrimary" };
  }

  // 1. Dispatch Device Metrics
  await cdpSend(target, "Emulation.setDeviceMetricsOverride", metricsParams);

  // 2. Dispatch Touch Emulation
  await cdpSend(target, "Emulation.setTouchEmulationEnabled", {
    enabled: touch,
    maxTouchPoints: touch ? 5 : 0,
  });

  // 3. Dispatch User Agent Override if provided
  if (userAgent) {
    await cdpSend(target, "Emulation.setUserAgentOverride", {
      userAgent,
      platform,
    });
  }

  // 4. Inspect resulting DOM dimensions for verification
  let domVerified = "";
  try {
    const chk: any = await cdpSend(target, "Runtime.evaluate", {
      expression: "JSON.stringify({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, mobile: /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent) })",
      returnByValue: true,
    });
    const val = chk && chk.result && chk.result.value ? JSON.parse(chk.result.value) : null;
    if (val) {
      domVerified = `\nDOM In-Page Viewport: ${val.innerWidth}x${val.innerHeight} @${val.dpr}x (mobile: ${Boolean(val.mobile)})`;
    }
  } catch {}

  const deviceLabel = presetConfig ? presetConfig.name : (rawPreset || "custom");
  return (
    `control_chrome_cdp: device emulation set to '${deviceLabel}' ` +
    `(${metricsParams.width}x${metricsParams.height} @${scale}x, mobile: ${mobile}, touch: ${touch}, orientation: ${orientation}).` +
    domVerified
  );
}
