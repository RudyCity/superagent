import { execa } from "execa";
import { DesktopUiError } from "./errors.js";

export interface SafeProcessRequest {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SafeProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DesktopProcessRunner {
  run(request: SafeProcessRequest): Promise<SafeProcessResult>;
}

function normalizeExecutable(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+/g, "/").toLowerCase();
}

export function createRestrictedProcessRunner(allowedExecutables: readonly string[]): DesktopProcessRunner {
  const allowed = new Set(allowedExecutables.map(normalizeExecutable));

  return {
    async run(request) {
      const normalized = normalizeExecutable(request.executable);
      if (!allowed.has(normalized)) {
        throw new DesktopUiError(
          "PROCESS_FAILED",
          `Executable '${request.executable}' is not allowed by the desktop UI adapter.`,
        );
      }

      try {
        const result = await execa(request.executable, request.args, {
          shell: false,
          windowsHide: true,
          reject: false,
          timeout: request.timeoutMs ?? 10_000,
          env: request.env,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        });
        if (result.exitCode !== 0) {
          throw new DesktopUiError(
            "PROCESS_FAILED",
            `${request.executable} exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
          );
        }
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode ?? 0,
        };
      } catch (error) {
        if (error instanceof DesktopUiError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new DesktopUiError("PROCESS_FAILED", `${request.executable} failed: ${message}`);
      }
    },
  };
}
