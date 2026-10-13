import { describe, it, expect, afterEach } from "vitest";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";

describe("workspaceMode async request context", () => {
  afterEach(() => {
    workspaceMode.setLocalMode();
  });

  it("isolates concurrent local and SSH contexts", async () => {
    const sshConfig = {
      host: "ssh-a.example.test",
      port: 22,
      username: "tester",
      remoteCwd: "/srv/project-a",
    };

    const [sshResult, localResult] = await Promise.all([
      workspaceMode.runWithWorkspaceConfig(sshConfig, async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          isSsh: workspaceMode.isSsh(),
          host: workspaceMode.getConfig()?.host,
          cwd: workspaceMode.getConfig()?.remoteCwd,
        };
      }),
      workspaceMode.runWithWorkspaceConfig(undefined, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          isSsh: workspaceMode.isSsh(),
          config: workspaceMode.getConfig(),
        };
      }),
    ]);

    expect(sshResult).toEqual({
      isSsh: true,
      host: "ssh-a.example.test",
      cwd: "/srv/project-a",
    });
    expect(localResult).toEqual({ isSsh: false, config: undefined });
    expect(workspaceMode.isSsh()).toBe(false);
  });

  it("keeps mutations inside a request context", async () => {
    await workspaceMode.runWithWorkspaceConfig(undefined, async () => {
      workspaceMode.setSshMode({
        host: "ssh-b.example.test",
        port: 22,
        username: "tester",
        remoteCwd: "/srv/project-b",
      });
      expect(workspaceMode.isSsh()).toBe(true);
      expect(workspaceMode.getConfig()?.host).toBe("ssh-b.example.test");
    });

    expect(workspaceMode.isSsh()).toBe(false);
  });
});
