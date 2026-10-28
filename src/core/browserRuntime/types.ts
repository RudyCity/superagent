/**
 * SuperAgent Browser Runtime Types (Milestones M0 + M1 + M2)
 *
 * Defines explicit browser runtime modes, launch options, health diagnostics,
 * virtual display configuration, and process ownership records for headless
 * and virtual-desktop Chromium automation.
 */

export type BrowserRuntimeMode = "auto" | "headless" | "headed" | "virtual-display";

export type ResolvedBrowserMode = "headless" | "headed" | "virtual-display";

export interface DisplayEnvironment {
  hasDisplay: boolean;
  displayType: "x11" | "wayland" | "none";
  displayVar: string | null;
  waylandVar: string | null;
}

export interface BrowserExecutableCandidate {
  name: string;
  path: string;
  exists: boolean;
  source: "env" | "path" | "standard_dir";
}

export interface ExecutableDiscoveryResult {
  executable: string;
  found: boolean;
  candidatesProbed: string[];
  platform: NodeJS.Platform;
  error?: string;
}

export interface VirtualDisplayConfig {
  /** Screen width in pixels (default: 1280) */
  width?: number;
  /** Screen height in pixels (default: 800) */
  height?: number;
  /** Color depth in bits (default: 24) */
  depth?: number;
  /** DPI (default: 96) */
  dpi?: number;
  /** Explicit display number. If omitted, dynamically allocated (:99 to :199) */
  displayNumber?: number;
  /** Window manager to use (probes openbox, fluxbox, matchbox-window-manager, twm) */
  windowManager?: string;
  /** Opt-in local-only VNC bound strictly to 127.0.0.1 (disabled by default) */
  enableLocalVnc?: boolean;
  /** Local VNC port (default: 5900 + display offset) */
  vncPort?: number;
  /** Opt-in local-only noVNC websockify bound strictly to 127.0.0.1 (disabled by default) */
  enableLocalNoVnc?: boolean;
  /** Local noVNC port (default: 6080) */
  noVncPort?: number;
}

export interface VirtualDisplayProcessInfo {
  pid: number;
  creationIdentity: string | null;
  executable: string;
  recordId?: string;
}

export interface VirtualDisplayInstance {
  displayNumber: number;
  displayStr: string;
  lockFilePath: string;
  xSocketPath: string;
  xvfbProcess: VirtualDisplayProcessInfo;
  wmProcess?: VirtualDisplayProcessInfo;
  vncProcess?: VirtualDisplayProcessInfo;
  noVncProcess?: VirtualDisplayProcessInfo;
  geometry: string;
  allocatedAt: number;
  vncPort?: number;
  vncPassword?: string;
  vncPasswordFile?: string;
  noVncPort?: number;
  vncLocalOnly: boolean;
}

export interface VirtualDisplayHealth {
  display: string;
  displayNumber: number;
  xSocketActive: boolean;
  xvfbRunning: boolean;
  wmRunning: boolean;
  wmName?: string;
  vncRunning?: boolean;
  vncPort?: number;
  noVncRunning?: boolean;
  noVncPort?: number;
  boundToLoopbackOnly: boolean;
}

export interface BrowserLaunchConfig {
  mode?: BrowserRuntimeMode;
  port?: number;
  host?: string;
  userDataDir?: string;
  profileName?: string;
  url?: string;
  executablePath?: string;
  autoSelectDesktopCaptureSource?: string;
  useFakeMediaUi?: boolean;
  additionalFlags?: string[];
  timeoutMs?: number;
  /** Configuration for virtual-display mode */
  virtualDisplay?: VirtualDisplayConfig;
  /** If true, auto mode on displayless Linux selects virtual-display instead of headless */
  preferVirtualDisplay?: boolean;
}

export interface BrowserInstanceRecord {
  recordId: string;
  pid: number;
  creationIdentity: string | null;
  port: number;
  host: string;
  mode: BrowserRuntimeMode;
  resolvedMode: ResolvedBrowserMode;
  executable: string;
  userDataDir: string;
  profileName: string;
  browserFingerprint: string | null;
  launchedAt: number;
  generation: string;
  /** Populated when resolvedMode === "virtual-display" */
  virtualDisplay?: VirtualDisplayInstance;
}

export interface BrowserRuntimeHealth {
  status: "healthy" | "unhealthy" | "stopped" | "unknown";
  listening: boolean;
  port: number;
  host: string;
  mode?: BrowserRuntimeMode;
  resolvedMode?: ResolvedBrowserMode;
  pid?: number | null;
  recordId?: string | null;
  executable?: string | null;
  browserVersion?: string;
  protocolVersion?: string;
  userAgent?: string;
  targetCount?: number;
  browserFingerprint?: string;
  uptimeMs?: number;
  error?: string;
  /** Populated when virtual display is active */
  virtualDisplay?: VirtualDisplayHealth;
}

export interface BrowserStopResult {
  success: boolean;
  pid: number | null;
  reason: string;
  graceful: boolean;
  virtualDisplayStopped?: boolean;
}
