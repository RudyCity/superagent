/**
 * Conservative controller-side mirror of Android target-side command allowlists.
 * The Android app enforces its own rules independently. No arbitrary shell.
 */
export const ANDROID_READONLY_DIAGNOSTICS = [
  "android.info", "android.network", "android.network_details",
  "android.battery", "android.storage", "android.memory", "android.power",
  "android.display", "android.wifi", "android.audio", "android.sensors",
  "android.app", "android.uptime", "android.health", "android.support_status",
  "id", "uname -a",
  "getprop ro.product.model", "getprop ro.build.version.release",
  "getprop ro.build.version.sdk",
] as const;

export const ANDROID_APPROVED_ACTIONS = [
  "android.action.open_wifi_settings",
  "android.action.open_bluetooth_settings",
  "android.action.open_display_settings",
  "android.action.open_battery_settings",
  "android.action.open_storage_settings",
  "android.action.open_app_settings",
  "android.action.open_app_info",
  "android.action.open_date_settings",
  "android.action.volume_up",
  "android.action.volume_down",
] as const;

const allowed = new Set<string>([...ANDROID_READONLY_DIAGNOSTICS, ...ANDROID_APPROVED_ACTIONS]);

export function isAllowedAndroidLanCommand(command: string): boolean {
  return allowed.has(command);
}

export function requiresAndroidOwnerActionApproval(command: string): boolean {
  return (ANDROID_APPROVED_ACTIONS as readonly string[]).includes(command);
}
