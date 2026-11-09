import type { DesktopPlatform } from "../desktopUi/types.js";

export type DesktopPackageManager = "winget" | "brew" | "apt" | "dnf";
export type PackageChangeAction = "install" | "uninstall" | "reinstall" | "update";

export interface InstalledApplication {
  id: string;
  name: string;
  platform: DesktopPlatform;
  launchKind: "windows-apps-folder" | "macos-bundle-id" | "linux-desktop-entry";
}

export interface InstalledPackage {
  id: string;
  name: string;
  version?: string;
  manager: DesktopPackageManager;
  source?: string;
}

export interface InstalledProgram {
  name: string;
  version?: string;
  publisher?: string;
}

export interface InstalledInventory {
  applications: InstalledApplication[];
  packages: InstalledPackage[];
  registeredPrograms?: InstalledProgram[];
  registeredProgramsTruncated?: boolean;
  limit: number;
  applicationsTruncated: boolean;
  packagesTruncated: boolean;
  limitations: string[];
}

export interface ExactWindowIdentity {
  pid: number;
  nativeId: string;
}

export interface PackageChangeStep {
  operation: "install" | "uninstall" | "upgrade";
  packageId: string;
  manager: DesktopPackageManager;
  source?: string;
  version?: string;
}

export interface PackageChangePlan {
  action: PackageChangeAction;
  manager: DesktopPackageManager;
  packageId: string;
  source?: string;
  currentVersion?: string;
  requestedVersion?: string;
  destructive: boolean;
  steps: PackageChangeStep[];
  sideEffects: string[];
}

export interface PlannedPackageChange {
  plan: PackageChangePlan;
  operationDigest: string;
  approvalRequestId: string;
  invocationId: string;
  approvalExpiresAt: number;
  approvalRequired: true;
  approvalMechanism: "separate-host-operator";
}

export interface PackageApplyResult {
  manager: DesktopPackageManager;
  packageId: string;
  action: PackageChangeAction;
  applied: true;
  stepsCompleted: number;
}

export interface DesktopAppLifecycleProvider {
  listApplications(limit: number): Promise<{ applications: InstalledApplication[]; truncated: boolean }>;
  listRegisteredPrograms?(limit: number): Promise<{ programs: InstalledProgram[]; truncated: boolean }>;
  launchVerified(appId: string): Promise<{ launched: true; appId: string }>;
  focusExact(target: ExactWindowIdentity): Promise<{ focused: true }>;
  closeExact(target: ExactWindowIdentity): Promise<{ closeRequested: true }>;
  waitUntilClosed(target: ExactWindowIdentity, timeoutMs: number): Promise<boolean>;
}

export interface DesktopPackageProvider {
  readonly manager: DesktopPackageManager;
  listInstalled(limit: number): Promise<{ packages: InstalledPackage[]; truncated: boolean }>;
  apply(plan: PackageChangePlan): Promise<PackageApplyResult>;
}
