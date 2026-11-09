import crypto from "node:crypto";
import { DesktopUiError } from "../desktopUi/errors.js";
import type { DesktopWindowTarget } from "../desktopUi/types.js";
import {
  desktopPackageApprovalManager,
  type DesktopHumanApprovalManager,
} from "../desktopSecurity/approval.js";
import { createDesktopPackageProvider } from "./packages.js";
import { createHostPackageApprovalPrompt, type HostPackageApprovalPrompt } from "../desktopSecurity/hostApproval.js";
import type {
  DesktopAppLifecycleProvider,
  DesktopPackageProvider,
  ExactWindowIdentity,
  InstalledInventory,
  PackageApplyResult,
  PackageChangeAction,
  PackageChangePlan,
  PlannedPackageChange,
} from "./types.js";
import { createWindowsDesktopAppProvider } from "./windows.js";
import { createMacDesktopAppProvider } from "./macos.js";
import { createLinuxDesktopAppProvider } from "./linux.js";

const MAX_PACKAGE_PLANS = 64;
const PACKAGE_PLAN_TTL_MS = 15 * 60 * 1000;

function requireId(value: unknown, field: string, maxLength = 128): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9@._+\-]*$/.test(normalized)) {
    throw new DesktopUiError("INVALID_ACTION", `${field} must be a bounded package identifier, not a path, URL, or command.`);
  }
  return normalized;
}

function requireAppId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    !normalized
    || normalized.length > 512
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || /[\\/]/.test(normalized)
    || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
  ) {
    throw new DesktopUiError("INVALID_ACTION", "appId must be a bounded installed application identifier, not a path, URL, or command.");
  }
  return normalized;
}

function optionalToken(value: unknown, field: string, maxLength = 128): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._+:\-]*$/.test(normalized)) {
    throw new DesktopUiError("INVALID_ACTION", `${field} contains unsupported characters.`);
  }
  return normalized;
}

function requireAction(value: unknown): PackageChangeAction {
  if (value === "install" || value === "uninstall" || value === "reinstall" || value === "update") return value;
  throw new DesktopUiError("INVALID_ACTION", "packageAction must be install, uninstall, reinstall, or update.");
}

function canonicalPlan(plan: PackageChangePlan): string {
  return JSON.stringify({
    action: plan.action,
    manager: plan.manager,
    packageId: plan.packageId,
    source: plan.source ?? null,
    currentVersion: plan.currentVersion ?? null,
    requestedVersion: plan.requestedVersion ?? null,
    destructive: plan.destructive,
    steps: plan.steps.map((step) => ({
      operation: step.operation,
      packageId: step.packageId,
      manager: step.manager,
      source: step.source ?? null,
      version: step.version ?? null,
    })),
    sideEffects: plan.sideEffects,
  });
}

function digestPlan(plan: PackageChangePlan): string {
  return crypto.createHash("sha256").update(canonicalPlan(plan)).digest("hex");
}

function planSteps(plan: Omit<PackageChangePlan, "steps" | "sideEffects" | "destructive">): PackageChangePlan {
  const base = { packageId: plan.packageId, manager: plan.manager, source: plan.source, version: plan.requestedVersion };
  switch (plan.action) {
    case "install":
      return {
        ...plan,
        destructive: false,
        steps: [{ ...base, operation: "install" }],
        sideEffects: ["Downloads and installs package content using the selected package manager.", "The installer may present an OS permission prompt that only a human may approve."],
      };
    case "uninstall":
      return {
        ...plan,
        destructive: true,
        steps: [{ ...base, operation: "uninstall", version: undefined }],
        sideEffects: ["Removes the selected package.", "Application data may remain or be removed according to the package's own uninstaller."],
      };
    case "update":
      return {
        ...plan,
        destructive: false,
        steps: [{ ...base, operation: "upgrade" }],
        sideEffects: ["Changes the installed package version.", "The package manager may download content and an installer may request OS permission."],
      };
    case "reinstall":
      return {
        ...plan,
        destructive: true,
        steps: [
          { ...base, operation: "uninstall", version: undefined },
          { ...base, operation: "install" },
        ],
        sideEffects: ["Performs a destructive uninstall before installing again.", "If the install step fails after uninstall succeeds, the package can remain absent."],
      };
  }
}

export interface DesktopAppManagerOptions {
  platform?: NodeJS.Platform;
  appProvider?: DesktopAppLifecycleProvider;
  packageProvider?: DesktopPackageProvider;
  approvalManager?: DesktopHumanApprovalManager;
  hostApprovalPrompt?: HostPackageApprovalPrompt;
  consentVerifier?: (target: DesktopWindowTarget) => boolean;
}

export class DesktopAppManager {
  private readonly platform: NodeJS.Platform;
  private readonly appProvider?: DesktopAppLifecycleProvider;
  private readonly packageProvider: DesktopPackageProvider;
  private readonly approvalManager: DesktopHumanApprovalManager;
  private readonly hostApprovalPrompt: HostPackageApprovalPrompt;
  private readonly consentVerifier: (target: DesktopWindowTarget) => boolean;
  private readonly plans = new Map<string, { plan: PackageChangePlan; expiresAt: number }>();

  constructor(options: DesktopAppManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.appProvider = options.appProvider ?? (
      this.platform === "win32" ? createWindowsDesktopAppProvider()
        : this.platform === "darwin" ? createMacDesktopAppProvider()
          : this.platform === "linux" ? createLinuxDesktopAppProvider() : undefined
    );
    this.packageProvider = options.packageProvider ?? createDesktopPackageProvider({ platform: this.platform });
    this.approvalManager = options.approvalManager ?? desktopPackageApprovalManager;
    this.hostApprovalPrompt = options.hostApprovalPrompt ?? createHostPackageApprovalPrompt({ platform: this.platform });
    this.consentVerifier = options.consentVerifier ?? (() => false);
  }

  private requireAppProvider(): DesktopAppLifecycleProvider {
    if (!this.appProvider) {
      throw new DesktopUiError(
        "PLATFORM_UNSUPPORTED",
        "Safe installed-application launch/focus/close/restart is currently implemented only for Windows. Package inventory and planning remain available on this platform.",
      );
    }
    return this.appProvider;
  }

  private requireHostConsent(target: ExactWindowIdentity): void {
    if (!this.consentVerifier(target)) {
      throw new DesktopUiError(
        "INPUT_DISABLED",
        "This application lifecycle action requires exact host consent for the pid/nativeId target.",
      );
    }
  }

  private prunePlans(): void {
    const now = Date.now();
    for (const [digest, entry] of this.plans.entries()) {
      if (entry.expiresAt <= now) this.plans.delete(digest);
    }
  }

  async listInstalledApps(limit = 50): Promise<InstalledInventory> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DesktopUiError("INVALID_ACTION", "limit must be an integer between 1 and 100.");
    }
    const apps = this.appProvider
      ? await this.appProvider.listApplications(limit)
      : { applications: [], truncated: false };
    const limitations: string[] = [];
    let packages: Awaited<ReturnType<DesktopPackageProvider["listInstalled"]>>;
    try {
      packages = await this.packageProvider.listInstalled(limit);
    } catch (error) {
      if (!(error instanceof DesktopUiError) || error.code !== "DEPENDENCY_REQUIRED") {
        throw error;
      }
      packages = { packages: [], truncated: false };
      limitations.push(this.platform === "win32"
        ? "Windows package-manager inventory is disabled under strict-offline policy because the WinGet CLI does not provide a hard no-network installed-only mode."
        : "Package-manager inventory is unavailable; launchable installed applications remain discoverable independently.");
    }
    if (!this.appProvider) {
      limitations.push("Application launcher discovery is not yet enabled on this platform; no guessed executable paths are returned.");
    }
    let registeredPrograms: Awaited<ReturnType<NonNullable<DesktopAppLifecycleProvider["listRegisteredPrograms"]>>> | undefined;
    if (this.appProvider?.listRegisteredPrograms) {
      try {
        registeredPrograms = await this.appProvider.listRegisteredPrograms(limit);
      } catch {
        limitations.push("Read-only Windows registered-program inventory is unavailable in this session.");
      }
    }
    return {
      applications: apps.applications,
      packages: packages.packages,
      ...(registeredPrograms ? {
        registeredPrograms: registeredPrograms.programs,
        registeredProgramsTruncated: registeredPrograms.truncated,
      } : {}),
      limit,
      applicationsTruncated: apps.truncated,
      packagesTruncated: packages.truncated,
      limitations,
    };
  }

  async launchApp(appId: unknown) {
    return this.requireAppProvider().launchVerified(requireAppId(appId));
  }

  async focusWindow(target: ExactWindowIdentity) {
    this.requireHostConsent(target);
    return this.requireAppProvider().focusExact(target);
  }

  async closeApp(target: ExactWindowIdentity) {
    this.requireHostConsent(target);
    return this.requireAppProvider().closeExact(target);
  }

  async restartApp(appId: unknown, target: ExactWindowIdentity) {
    this.requireHostConsent(target);
    const provider = this.requireAppProvider();
    await provider.closeExact(target);
    if (!await provider.waitUntilClosed(target, 5_000)) {
      throw new DesktopUiError("PROCESS_FAILED", "Graceful close did not complete; restart aborted without killing the process.");
    }
    return provider.launchVerified(requireAppId(appId));
  }

  async planPackageChange(input: {
    principalId: string;
    packageAction: unknown;
    packageId: unknown;
    source?: unknown;
    version?: unknown;
  }): Promise<PlannedPackageChange> {
    this.prunePlans();
    if (this.plans.size >= MAX_PACKAGE_PLANS) {
      throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Too many pending package plans.");
    }
    const action = requireAction(input.packageAction);
    const packageId = requireId(input.packageId, "packageId");
    const source = optionalToken(input.source, "source", 64);
    const requestedVersion = optionalToken(input.version, "version", 128);
    let installed: InstalledInventory["packages"][number] | undefined;
    let inventoryUnavailable = false;
    try {
      const inventory = await this.packageProvider.listInstalled(200);
      installed = inventory.packages.find((item) => item.id === packageId);
    } catch (error) {
      if (this.platform !== "win32" || !(error instanceof DesktopUiError) || error.code !== "DEPENDENCY_REQUIRED") {
        throw error;
      }
      inventoryUnavailable = true;
    }
    if (!inventoryUnavailable && (action === "uninstall" || action === "update" || action === "reinstall") && !installed) {
      throw new DesktopUiError("TARGET_NOT_FOUND", "Requested package is not present in the local installed-package inventory.");
    }
    const plan = planSteps({
      action,
      manager: this.packageProvider.manager,
      packageId,
      source,
      currentVersion: installed?.version,
      requestedVersion,
    });
    if (inventoryUnavailable) {
      plan.sideEffects.push(
        "Strict-offline Windows inventory could not verify the current installed version; apply still uses the exact package ID and fails rather than selecting an ambiguous target.",
      );
    }
    const operationDigest = digestPlan(plan);
    this.plans.set(operationDigest, { plan, expiresAt: Date.now() + PACKAGE_PLAN_TTL_MS });
    const approval = this.approvalManager.createRequest({
      operationDigest,
      principalId: input.principalId,
      target: `${plan.manager}:${plan.packageId}:${plan.action}`,
    });
    return {
      plan,
      operationDigest,
      approvalRequestId: approval.requestId,
      invocationId: approval.invocationId,
      approvalExpiresAt: approval.expiresAt,
      approvalRequired: true,
      approvalMechanism: "separate-host-operator",
    };
  }

  async applyPackageChange(input: {
    principalId: string;
    approvalRequestId: unknown;
    operationDigest: unknown;
    invocationId: unknown;
  }): Promise<PackageApplyResult> {
    this.prunePlans();
    const operationDigest = typeof input.operationDigest === "string" ? input.operationDigest.trim().toLowerCase() : "";
    if (!/^[a-f0-9]{64}$/.test(operationDigest)) {
      throw new DesktopUiError("INVALID_ACTION", "operationDigest must be a SHA-256 hexadecimal digest.");
    }
    const entry = this.plans.get(operationDigest);
    if (!entry) throw new DesktopUiError("TARGET_NOT_FOUND", "Package plan is missing or expired.");
    const plan = entry.plan;
    const approvalRequestId = typeof input.approvalRequestId === "string" ? input.approvalRequestId : "";
    const invocationId = typeof input.invocationId === "string" ? input.invocationId : "";
    const target = [plan.manager, plan.packageId, plan.action].join(":");
    const prior = this.approvalManager.getRequest(approvalRequestId);
    if (!prior || prior.operationDigest !== operationDigest
      || prior.principalId !== input.principalId || prior.target !== target
      || prior.invocationId !== invocationId) {
      throw new DesktopUiError("INPUT_DISABLED", "Missing or mismatched host approval binding.");
    }
    if (!prior.approvedAt) {
      let accepted = false;
      try {
        accepted = await this.hostApprovalPrompt.confirm({
          principalId: input.principalId,
          operationDigest,
          expiresAt: prior.expiresAt,
          plan,
        });
      } catch {}
      if (!accepted) {
        this.plans.delete(operationDigest);
        this.approvalManager.cancelRequest(approvalRequestId);
        throw new DesktopUiError("INPUT_DISABLED", "Host operator declined or could not confirm this change.");
      }
      this.approvalManager.approveHostRequest({
        requestId: approvalRequestId,
        operationDigest,
        operatorId: "native-host-confirmation",
      });
    }
    this.approvalManager.consumeApprovedRequest({
      requestId: typeof input.approvalRequestId === "string" ? input.approvalRequestId : "",
      invocationId: typeof input.invocationId === "string" ? input.invocationId : "",
      operationDigest,
      principalId: input.principalId,
      target: `${plan.manager}:${plan.packageId}:${plan.action}`,
    });
    this.plans.delete(operationDigest);
    return this.packageProvider.apply(plan);
  }
}
