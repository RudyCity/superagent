/**
 * An attended OS dialog, distinct from any model argument, to grant one
 * exact-window, short-lived input session. No global auto-approval fallback.
 */
import path from "node:path";
import { DesktopUiError } from "./errors.js";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "./processRunner.js";

export interface TrustedInputPromptRequest {
  principal: string;
  application: string;
  title: string;
  pid: number;
  nativeId: string;
  expiresAt: number;
}
export interface TrustedInputPrompt {
  confirm(request: TrustedInputPromptRequest): Promise<boolean>;
}
const WINDOWS_POWERSHELL = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$message=$env:SUPERAGENT_TRUSTED_INPUT_PROMPT",
  "$answer=[System.Windows.Forms.MessageBox]::Show($message,",
  " 'SuperAgent: desktop input approval',",
  " [System.Windows.Forms.MessageBoxButtons]::YesNo,",
  " [System.Windows.Forms.MessageBoxIcon]::Warning,",
  " [System.Windows.Forms.MessageBoxDefaultButton]::Button2)",
  "if($answer -eq [System.Windows.Forms.DialogResult]::Yes){",
  " [Console]::Out.Write('{\"approved\":true}')",
  "}else{",
  " [Console]::Out.Write('{\"approved\":false}')",
  "}",
].join("\n");
const MAC_OSASCRIPT = "/usr/bin/osascript";
const MAC_DIALOG = [
  'ObjC.import("stdlib");',
  'const msg=ObjC.unwrap($.getenv("SUPERAGENT_TRUSTED_INPUT_PROMPT"));',
  "const app=Application.currentApplication();app.includeStandardAdditions=true;",
  "let allowed=false;try{",
  'const reply=app.displayDialog(msg,{withTitle:"SuperAgent desktop input",',
  'buttons:["Deny","Allow once"],defaultButton:"Deny",givingUpAfter:30});',
  'allowed=reply.buttonReturned==="Allow once"&&!reply.gaveUp;',
  "}catch(_){}",
  "JSON.stringify({approved:allowed});",
].join("\n");
let promptActive = false;

function safeText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}
export function createTrustedInputPrompt(options: {
  platform?: NodeJS.Platform;
  runner?: DesktopProcessRunner;
} = {}): TrustedInputPrompt {
  const platform = options.platform ?? process.platform;
  const executable = platform === "win32" ? WINDOWS_POWERSHELL :
    platform === "darwin" ? MAC_OSASCRIPT : "/usr/bin/zenity";
  const runner = options.runner ?? createRestrictedProcessRunner([executable]);
  return {
    async confirm(request) {
      if (request.expiresAt <= Date.now() || !Number.isSafeInteger(request.pid) ||
        request.pid <= 0 || !request.nativeId || promptActive) return false;
      if (platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !options.runner) return false;
      const message = [
        "Allow native mouse/keyboard input for ONE SuperAgent session?",
        "",
        "Application: " + safeText(request.application, 100),
        "Window: " + safeText(request.title, 160),
        "PID / native window: " + request.pid + " / " + safeText(request.nativeId, 128),
        "Requester: " + safeText(request.principal, 100),
        "Expires: " + new Date(request.expiresAt).toISOString(),
        "",
        "The Trusted list only allowed this request to appear. It did not",
        "grant input. You can revoke this window from Security Approval Manager.",
        "Deny unless you are physically present and expecting this action.",
      ].join("\n");
      promptActive = true;
      try {
        if (platform === "win32") {
          const result = await runner.run({
            executable: WINDOWS_POWERSHELL,
            args: ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
              Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64")],
            env: { SUPERAGENT_TRUSTED_INPUT_PROMPT: message },
            timeoutMs: 35_000,
          });
          return JSON.parse(result.stdout.trim()).approved === true;
        }
        if (platform === "darwin") {
          const result = await runner.run({
            executable: MAC_OSASCRIPT,
            args: ["-l", "JavaScript", "-e", MAC_DIALOG],
            env: { SUPERAGENT_TRUSTED_INPUT_PROMPT: message },
            timeoutMs: 35_000,
          });
          return JSON.parse(result.stdout.trim()).approved === true;
        }
        if (platform === "linux") {
          await runner.run({
            executable: "/usr/bin/zenity",
            args: ["--question", "--title=SuperAgent desktop input",
              "--text=" + message, "--ok-label=Allow once",
              "--cancel-label=Deny", "--timeout=30"],
            timeoutMs: 35_000,
          });
          return true;
        }
        throw new DesktopUiError("PLATFORM_UNSUPPORTED", "No local desktop input prompt available");
      } catch {
        return false;
      } finally {
        promptActive = false;
      }
    },
  };
}
