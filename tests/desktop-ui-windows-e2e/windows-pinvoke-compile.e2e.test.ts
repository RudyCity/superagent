import { execa } from "execa";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";
import type { DesktopProcessRunner, SafeProcessRequest } from "../../src/core/desktopUi/processRunner.js";

const enabled = process.platform === "win32"
  && process.env.SUPERAGENT_DESKTOP_UI_READONLY_E2E === "1";
const hostTest = enabled ? it : it.skip;

hostTest("Windows host compiles native SendInput wrappers without sending any input", async () => {
  let script = "";
  const runner: DesktopProcessRunner = {
    run: vi.fn(async (request: SafeProcessRequest) => {
      script = Buffer.from(request.args.at(-1) || "", "base64").toString("utf16le");
      return { stdout: '{"ok":true}', stderr: "", exitCode: 0 };
    }),
  };
  await createWindowsDesktopUiAdapter(runner).dispatch({
    kind: "key",
    target: { pid: 123, nativeId: "456" },
    key: "TAB",
    modifiers: ["CTRL"],
  });

  const classBlocks = [...script.matchAll(/Add-Type @"\r?\n[\s\S]*?\r?\n"@/g)].map((match) => match[0]);
  expect(classBlocks).toHaveLength(2);
  expect(classBlocks[1]).toContain("SendInput");
  const compileOnly = classBlocks.join("\n") + '\n"COMPILE_OK"\n';
  const executable = path.win32.join(
    process.env.SystemRoot || "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  const result = await execa(executable, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(compileOnly, "utf16le").toString("base64"),
  ], { reject: false, timeout: 20000 });

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("COMPILE_OK");
}, 25000);
