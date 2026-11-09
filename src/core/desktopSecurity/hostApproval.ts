import path from "node:path";
import { DesktopUiError } from "../desktopUi/errors.js";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "../desktopUi/processRunner.js";
import type { PackageChangePlan } from "../desktopApp/types.js";

export interface HostPackageApprovalPresentation {
  principalId: string;
  operationDigest: string;
  expiresAt: number;
  plan: PackageChangePlan;
}

export interface HostPackageApprovalPrompt {
  confirm(presentation: HostPackageApprovalPresentation): Promise<boolean>;
}

const WINDOWS_POWERSHELL = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);
const WINDOWS_DIALOG = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$payload = ConvertFrom-Json $env:SUPERAGENT_PACKAGE_APPROVAL_PAYLOAD",
  "$answer = [System.Windows.Forms.MessageBox]::Show(",
  "  [string]$payload.message,",
  "  'SuperAgent: local package approval',",
  "  [System.Windows.Forms.MessageBoxButtons]::YesNo,",
  "  [System.Windows.Forms.MessageBoxIcon]::Warning,",
  "  [System.Windows.Forms.MessageBoxDefaultButton]::Button2",
  ")",
  "if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {",
  "  [Console]::Out.Write('{\"approved\":true}')",
  "} else {",
  "  [Console]::Out.Write('{\"approved\":false}')",
  "}",
].join("\n");
const MACOS_OSASCRIPT = "/usr/bin/osascript";
const MACOS_DIALOG = [
  'ObjC.import("stdlib");',
  'const msg = ObjC.unwrap($.getenv("SUPERAGENT_PACKAGE_APPROVAL_MESSAGE"));',
  "const app = Application.currentApplication();",
  "app.includeStandardAdditions = true;",
  "let approved = false;",
  "try {",
  "  const response = app.displayDialog(msg, {",
  '    withTitle: "SuperAgent package approval",',
  '    buttons: ["Deny", "Approve"],',
  '    defaultButton: "Deny",',
  '    withIcon: "caution",',
  "    givingUpAfter: 45",
  "  });",
  '  approved = Boolean(response.buttonReturned === "Approve" && !response.gaveUp);',
  "} catch (_) {}",
  "JSON.stringify({ approved });",
].join("\n");
const LINUX_ZENITY = "/usr/bin/zenity";
let hostDialogActive = false;

function describePlan(input: HostPackageApprovalPresentation): string {
  if (!/^[0-9a-f]{64}$/.test(input.operationDigest)) {
    throw new DesktopUiError("INVALID_ACTION", "Operator approval requires a SHA-256 plan digest.");
  }
  if (input.expiresAt <= Date.now()) {
    throw new DesktopUiError("INPUT_DISABLED", "Operator approval expired.");
  }
  const plan = input.plan;
  return [
    "Approve this exact SuperAgent package operation?",
    "",
    "Action: " + plan.action,
    "Package: " + plan.packageId,
    "Manager: " + plan.manager,
    "Source: " + (plan.source ?? "(manager default)"),
    "Version: " + (plan.requestedVersion ?? "(manager default)"),
    "Principal: " + input.principalId,
    "Operation SHA-256: " + input.operationDigest,
    "Step(s): " + plan.steps.map((step) => step.operation).join(" -> "),
    "Potential impact: " + plan.sideEffects.join(" "),
    "",
    "Only approve if YOU requested this change. Any administrator/UAC",
    "prompt must still be approved separately on the OS secure desktop.",
  ].join("\n").slice(0, 3500);
}

export function createHostPackageApprovalPrompt(options: {
  platform?: NodeJS.Platform;
  runner?: DesktopProcessRunner;
} = {}): HostPackageApprovalPrompt {
  const platform = options.platform ?? process.platform;
  const executable = platform === "win32"
    ? WINDOWS_POWERSHELL : platform === "darwin" ? MACOS_OSASCRIPT : LINUX_ZENITY;
  const runner = options.runner ?? createRestrictedProcessRunner([executable]);

  return {
    async confirm(presentation) {
      const message = describePlan(presentation);
      if (platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !options.runner) {
        throw new DesktopUiError("INPUT_DISABLED", "No interactive desktop display for human package approval.");
      }
      if (hostDialogActive) {
        throw new DesktopUiError("INPUT_DISABLED", "Another host-operator confirmation is already active.");
      }
      hostDialogActive = true;
      try {
        if (platform === "win32") {
          const result = await runner.run({
            executable: WINDOWS_POWERSHELL,
            args: ["-NoProfile", "-NonInteractive", "-STA",
              "-EncodedCommand", Buffer.from(WINDOWS_DIALOG, "utf16le").toString("base64")],
            env: { SUPERAGENT_PACKAGE_APPROVAL_PAYLOAD: JSON.stringify({ message }) },
            timeoutMs: 50_000,
          });
          return JSON.parse(result.stdout.trim()).approved === true;
        }
        if (platform === "darwin") {
          const result = await runner.run({
            executable: MACOS_OSASCRIPT,
            args: ["-l", "JavaScript", "-e", MACOS_DIALOG],
            env: { SUPERAGENT_PACKAGE_APPROVAL_MESSAGE: message },
            timeoutMs: 50_000,
          });
          return JSON.parse(result.stdout.trim()).approved === true;
        }
        if (platform === "linux") {
          await runner.run({
            executable: LINUX_ZENITY,
            args: [
              "--question", "--title=SuperAgent package approval",
              "--text=" + message, "--ok-label=Approve", "--cancel-label=Deny",
              "--timeout=45",
            ],
            timeoutMs: 50_000,
          });
          return true;
        }
        throw new DesktopUiError("PLATFORM_UNSUPPORTED", "No host-local approval dialog for this platform.");
      } catch {
        return false;
      } finally {
        hostDialogActive = false;
      }
    },
  };
}
