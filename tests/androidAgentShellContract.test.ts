import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { assertAndroidShellCommand, isAllowedAndroidLanCommand } from "../src/core/lanRemote/androidCapabilities.js";
import { parseTrayLanAction, dispatchTrayLanAction } from "../src/core/runtime/trayLanBridge.js";
import {
  LAN_MCP_TOOL_CLASSIFICATIONS, LAN_MCP_TOOL_DEFS, dispatchLanMcpTool,
} from "../src/core/mcp/tools/lanMcpTools.js";
import { execAndroidShellCommand } from "../src/core/lanRemote/controller.js";

const base = "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/";
const android = (name: string) => fs.readFileSync(base + name + ".java", "utf8");
const manifest = fs.readFileSync("apps/superagent-lan-android/app/src/main/AndroidManifest.xml", "utf8");
const server = android("LanClientServer");
const activity = android("MainActivity");
const shell = android("LocalAndroidShell");
const controller = fs.readFileSync("src/core/lanRemote/controller.ts", "utf8");
const agent = fs.readFileSync("src/core/tools/lanSupportTool.ts", "utf8");
const mcp = fs.readFileSync("src/core/mcp/tools/lanMcpTools.ts", "utf8");
const uuid = "a0b1c2d3-1234-4abc-9f00-aabbccddeeff";

describe("Agent-controlled Android shell, never unapproved/Tray-only", () => {
  it("exposes separate first-class agent and MCP tools as dangerous capabilities", () => {
    const defs = new Map(LAN_MCP_TOOL_DEFS.map((d) => [d.name, d]));
    for (const name of ["superagent_lan_android_shell", "superagent_device_android_shell"]) {
      const def = defs.get(name);
      expect(def, name).toBeTruthy();
      expect(def?.inputSchema.additionalProperties).toBe(false);
      expect(def?.inputSchema.required).toEqual(["deviceId", "command"]);
      expect(LAN_MCP_TOOL_CLASSIFICATIONS[name]).toBe("dangerous");
    }
    expect(agent).toContain('action === "android_shell"');
    expect(agent).toContain("isFullYoloMode()");
    expect(agent).toContain("isSystemDestructiveCommand(command)");
    expect(agent).toContain("execAndroidShellCommand(id, command)");
    expect(mcp).toContain('action: "android_shell", deviceId: id');
    expect(mcp).toContain('superagent_device_android_shell: "superagent_lan_android_shell"');
  });

  it("requires an exact printable single-line command within 512 chars", () => {
    for (const command of ["id", "pwd", "getprop ro.product.model", "ls -la", "echo test"]) {
      expect(() => assertAndroidShellCommand(command)).not.toThrow();
      expect(parseTrayLanAction({ action: "android_shell", deviceId: uuid, command }))
        .toEqual({ action: "android_shell", args: { action: "android_shell", deviceId: uuid, command } });
    }
    for (const command of ["", " ", " id", "id ", "ls\nrm", "id\r", "\u0000", "a".repeat(513)]) {
      expect(() => assertAndroidShellCommand(command)).toThrow();
      expect(() => parseTrayLanAction({ action: "android_shell", deviceId: uuid, command })).toThrow();
    }
    for (const extras of [{ token: "secret" }, { shell: true }, { cwd: "/system" }, { env: { X: 1 } }]) {
      expect(() => parseTrayLanAction({ action: "android_shell", deviceId: uuid, command: "id", ...extras })).toThrow();
    }
    expect(() => parseTrayLanAction({ action: "android_shell", deviceId: "invalid", command: "id" })).toThrow();
    expect(isAllowedAndroidLanCommand("ls -la")).toBe(false);
  });

  it("fails closed without a paired and active Android session", async () => {
    await expect(execAndroidShellCommand(uuid, "id")).rejects.toThrow(/Full YOLO|Unknown LAN handle/);
    await expect(execAndroidShellCommand(uuid, "ls\npwd")).rejects.toThrow(/512 printable/);
    const mcpResult = await dispatchLanMcpTool("superagent_lan_android_shell", { deviceId: uuid, command: "id" });
    expect(mcpResult?.isError).toBe(true);
    const text = JSON.stringify(mcpResult?.content);
    expect(text).not.toContain("sessionToken");
    expect(text).not.toContain("pairToken");
  });

  it("requires Android per-command owner approval, prevents agent self-approval and revokes promptly", () => {
    expect(server).toContain('if ("shell".equals(op))');
    expect(server).toContain('approval.ask("shell:" + command, owner.label, ip, 90)');
    expect(server).toContain("handleAgentShell(socket, request, ip, owner, active)");
    expect(server).toContain("isStillAuthorized(active, owner, ip)");
    expect(server).toContain("socket.isClosed()");
    expect(server).toContain("RemoteControlPermit.canControl()");
    expect(server).toContain("RemoteControlPermit.canView()");
    expect(server).toContain("ScreenProjectionService.isActive()");
    expect(server).toContain("stopRemoteShell()");
    expect(activity).toContain('kind.startsWith("shell:")');
    expect(activity).toContain("kind.substring(6)");
    expect(activity).toContain("if (target != null) target.stopRemoteShell()");
    expect(activity).toContain('setPositiveButton("APPROVE"');
    expect(activity).toContain('setNegativeButton("DENY"');
    expect(server).not.toContain("new ProcessBuilder(");
    expect(mcp).not.toContain("pairToken: d.pairToken");
  });

  it("executes only as Android app UID with a 10-second and 24-KiB ceiling", () => {
    expect(shell).toContain('new ProcessBuilder("/system/bin/sh", "-c", command)');
    expect(shell).toContain("builder.directory(app.getFilesDir())");
    expect(shell).toContain("MAX_OUTPUT = 24 * 1024");
    expect(shell).toContain("current.waitFor(10, TimeUnit.SECONDS)");
    expect(shell).toContain("stopRequested.get()");
    expect(shell).toContain("lastExitCode = exit");
    expect(shell).toContain("current.destroyForcibly()");
    expect(shell).toContain("log.delete()");
    expect(controller).toContain('op: "shell"');
    expect(controller).toContain("116_000, 44_000");
    expect(controller).toContain("authenticatedAndroid(id)");
    expect(controller).toContain("if (!isFullYoloMode())");
    for (const perm of ["REQUEST_INSTALL_PACKAGES", "WRITE_SECURE_SETTINGS", "MANAGE_EXTERNAL_STORAGE"]) {
      expect(manifest).not.toContain(perm);
    }
  });
});
