/**
 * Desktop Live operator-facing access summary. This is NOT an authorization
 * token or a grant endpoint. Viewer consent and controller approval are
 * independent, even when they target the same application or paired device.
 *
 * Only the native preview manager can report an active local view; only an
 * independently authenticated controller lease can authorize remote input.
 * RemoteControlAuthority remains fail-closed until an attended host-native
 * controller approval and semantic input adapter are installed.
 */
export type DesktopLiveAccessKind = "native" | "managed-cdp" | "cdp-delegate" | "lan-device";
export type DesktopLiveViewState =
  | "available" | "active" | "device-approval-required" | "not-supported";
export type DesktopLiveControllerState =
  | "native-approval-required" | "device-approval-required"
  | "agent-held" | "human-held" | "not-supported";
export interface DesktopLiveAccessSummary {
  readonly view: DesktopLiveViewState;
  readonly controller: DesktopLiveControllerState;
  /** A status label does not grant any input capability. */
  readonly independentlyApproved: false;
}
export function desktopLiveAccessModes(
  kind: DesktopLiveAccessKind,
  options: { previewActive?: boolean; connected?: boolean; devicePlatform?: "android" | "windows"; ownerMode?: "agent" | "human" | "unknown" } = {},
): DesktopLiveAccessSummary {
  switch (kind) {
    case "native":
      return {
        view: options.previewActive === true ? "active" : "available",
        controller: "native-approval-required",
        independentlyApproved: false,
      };
    case "lan-device": {
      // Only the Android LAN Client implements the verified screen and touch
      // methods today. Do not advertise control for a paired Windows client.
      const supported = options.devicePlatform === "android" && options.connected === true;
      return {
        view: supported ? "device-approval-required" : "not-supported",
        controller: supported ? "device-approval-required" : "not-supported",
        independentlyApproved: false,
      };
    }
    case "managed-cdp":
      return {
        view: "not-supported",
        controller: options.ownerMode === "human" ? "human-held" :
          options.ownerMode === "agent" ? "agent-held" : "not-supported",
        independentlyApproved: false,
      };
    default:
      return { view:"not-supported", controller:"not-supported", independentlyApproved:false };
  }
}
