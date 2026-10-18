import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { getRootConfigDir } from "../src/core/config/paths.js";
import { registerProject, removeProject, getProject, updateProject } from "../src/core/project/projectRegistry.js";
import { SshProxyService } from "../src/core/ssh/sshProxy.js";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";
import { setFullYoloMode } from "../src/core/permissions.js";
import { StandaloneSshProjectProvider } from "../src/core/mcp/tools/standaloneSshProjectTools.js";

describe("standalone SSH project provider", () => {
  it("advertises read-only workspace and health checks through the provider contract", () => {
    const provider = new StandaloneSshProjectProvider();
    expect(provider.supports("workspace_info")).toBe(true);
    expect(provider.supports("health_check")).toBe(true);
  });

  it("returns an explicit capability error for unsupported tools rather than falling back to local execution", async () => {
    const provider = new StandaloneSshProjectProvider();
    const result = await provider.dispatch("superagent_manage_plan", {}, "ssh://deploy@example.test/srv/app", "remote-app");
    expect(result?.isError).toBe(true);
    const text = (result?.content ?? []).map((part: any) => part.text ?? "").join("\n");
    expect(text).toMatch(/not implemented for standalone SSH projects/i);
    expect(text).toMatch(/request was not executed locally/i);
    expect(text).toMatch(/Workspace Chain remains optional/i);
  });

  it("isolates concurrent workspace metadata calls across distinct SSH project connections", async () => {
    const provider = new StandaloneSshProjectProvider();
    const projectAId = `ssh-provider-a-${process.pid}`;
    const projectBId = `ssh-provider-b-${process.pid}`;
    registerProject({ id: projectAId, name: "SSH Provider A", type: "ssh", target: "ssh://deploy@host-a.test/srv/a" });
    registerProject({ id: projectBId, name: "SSH Provider B", type: "ssh", target: "ssh://deploy@host-b.test/srv/b" });
    const observed: Array<{ host: string | undefined; cwd: string; delayMs: number }> = [];
    const realPathSpy = vi.spyOn(SshProxyService.prototype, "realPath").mockImplementation(async function (remotePath: string) {
      return remotePath;
    });
    const execSpy = vi.spyOn(SshProxyService.prototype, "exec").mockImplementation(async function (_command: string, cwd: string) {
      const host = workspaceMode.getConfig()?.host;
      const delayMs = host === "host-a.test" ? 25 : 5;
      observed.push({ host, cwd, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { stdout: `${cwd}
${host}-main`, stderr: "", exitCode: 0 } as any;
    });
    vi.spyOn(SshProxyService.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SshProxyService.prototype, "clearCache").mockImplementation(() => {});

    const projectA = getProject(projectAId)!;
    const projectB = getProject(projectBId)!;
    const contextA: any = { projectId: projectAId, providerKind: "ssh", project: projectA, workspace: projectA.target, selectionSource: "projectId", explicit: true };
    const contextB: any = { projectId: projectBId, providerKind: "ssh", project: projectB, workspace: projectB.target, selectionSource: "projectId", explicit: true };
    try {
      const [infoA, infoB] = await Promise.all([
        provider.getWorkspaceInfo(contextA),
        provider.getWorkspaceInfo(contextB),
      ]);

      expect(infoA).toMatchObject({ projectId: projectAId, providerKind: "ssh", root: "/srv/a", workspace: "/srv/a", gitBranch: "host-a.test-main" });
      expect(infoB).toMatchObject({ projectId: projectBId, providerKind: "ssh", root: "/srv/b", workspace: "/srv/b", gitBranch: "host-b.test-main" });
      expect(observed.map((entry) => entry.host).sort()).toEqual(["host-a.test", "host-b.test"]);
      expect(execSpy).toHaveBeenCalledTimes(2);
      expect(realPathSpy).toHaveBeenCalledTimes(4);
    } finally {
      await provider.closeAll();
      removeProject(projectAId);
      removeProject(projectBId);
      vi.restoreAllMocks();
    }
  });

  it("defers SSH connection cleanup until its active operation releases the connection", async () => {
    const provider = new StandaloneSshProjectProvider();
    const projectId = `ssh-provider-drain-${process.pid}`;
    registerProject({ id: projectId, name: "SSH Drain Fixture", type: "ssh", target: "ssh://deploy@drain-host.test/srv/app" });
    vi.spyOn(SshProxyService.prototype, "realPath").mockImplementation(async (remotePath: string) => remotePath);

    let markStarted!: () => void;
    let resolveExec!: (value: { stdout: string; stderr: string; exitCode: number }) => void;
    const execStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const disconnectSpy = vi.spyOn(SshProxyService.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SshProxyService.prototype, "clearCache").mockImplementation(() => {});
    vi.spyOn(SshProxyService.prototype, "exec").mockImplementation(async () => {
      markStarted();
      return await new Promise((resolve) => { resolveExec = resolve; }) as any;
    });

    const project = getProject(projectId)!;
    const context: any = { projectId, providerKind: "ssh", project, workspace: project.target, selectionSource: "projectId", explicit: true };
    try {
      const operation = provider.getWorkspaceInfo(context);
      await execStarted;
      let closeFinished = false;
      const closing = provider.closeProject(projectId).then(() => { closeFinished = true; });
      await Promise.resolve();

      expect(disconnectSpy).not.toHaveBeenCalled();
      expect(closeFinished).toBe(false);

      resolveExec({ stdout: "/srv/app" + String.fromCharCode(10) + "main", stderr: "", exitCode: 0 });
      await expect(operation).resolves.toMatchObject({ projectId, gitBranch: "main" });
      await closing;
      expect(closeFinished).toBe(true);
      expect(disconnectSpy).toHaveBeenCalledOnce();
    } finally {
      await provider.closeAll();
      removeProject(projectId);
      vi.restoreAllMocks();
    }
  });

  it("times out an SSH health probe without disconnecting a shared project connection", async () => {
    const provider = new StandaloneSshProjectProvider();
    const projectId = `ssh-health-timeout-${process.pid}`;
    registerProject({ id: projectId, name: "SSH Health Timeout", type: "ssh", target: "ssh://deploy@health-host.test/srv/app" });
    const disconnected: object[] = [];
    const realPathSpy = vi.spyOn(SshProxyService.prototype, "realPath").mockImplementation(async function (this: object, remotePath: string) {
      return remotePath;
    });
    const execSpy = vi.spyOn(SshProxyService.prototype, "exec").mockImplementation(async function (_command: string, cwd: string) {
      return { stdout: `${cwd}${String.fromCharCode(10)}main`, stderr: "", exitCode: 0 } as any;
    });
    vi.spyOn(SshProxyService.prototype, "disconnect").mockImplementation(async function (this: object) {
      disconnected.push(this);
    });
    vi.spyOn(SshProxyService.prototype, "clearCache").mockImplementation(() => {});

    const project = getProject(projectId)!;
    const context: any = { projectId, providerKind: "ssh", project, workspace: project.target, selectionSource: "projectId", explicit: true };
    try {
      await provider.getWorkspaceInfo(context);
      const sharedProxy = (provider as any).connections.get(projectId).proxy as object;
      realPathSpy.mockImplementation(async function (this: object, remotePath: string) {
        if (this !== sharedProxy) return await new Promise<string>(() => {});
        return remotePath;
      });
      execSpy.mockImplementation(async function (this: object, _command: string, cwd: string) {
        if (this !== sharedProxy) return await new Promise<any>(() => {});
        return { stdout: `${cwd}${String.fromCharCode(10)}main`, stderr: "", exitCode: 0 } as any;
      });

      const report = await provider.checkHealth(context, { timeoutMs: 1000 });
      expect(report.status).toBe("unavailable");
      expect(report.checks[0].message).toMatch(/exceeded its deadline/i);
      expect(disconnected.length).toBe(1);
      expect(disconnected[0]).not.toBe(sharedProxy);
    } finally {
      await provider.closeAll();
      removeProject(projectId);
      vi.restoreAllMocks();
    }
  });

  it("routes remote write, command, and Git operations through the SSH provider with destructive-command protection", async () => {
    const provider = new StandaloneSshProjectProvider();
    const projectId = `ssh-provider-mutations-${process.pid}`;
    registerProject({ id: projectId, name: "SSH Mutations", type: "ssh", target: "ssh://deploy@mutations-host.test/srv/app" });
    const writes: Array<{ file: string; content: string }> = [];
    const commands: string[] = [];
    vi.spyOn(SshProxyService.prototype, "realPath").mockImplementation(async (remotePath: string) => remotePath);
    vi.spyOn(SshProxyService.prototype, "writeFile").mockImplementation(async (file: string, content: string) => {
      writes.push({ file, content });
    });
    vi.spyOn(SshProxyService.prototype, "exec").mockImplementation(async (command: string, cwd: string) => {
      commands.push(command);
      return { stdout: command.includes("git status") ? "## main" : `remote-command-ok:${cwd}`, stderr: "", exitCode: 0 } as any;
    });
    vi.spyOn(SshProxyService.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SshProxyService.prototype, "clearCache").mockImplementation(() => {});
    setFullYoloMode(false);

    const project = getProject(projectId)!;
    const context: any = { projectId, providerKind: "ssh", project, workspace: project.target, selectionSource: "projectId", explicit: true };
    try {
      expect(provider.supports("write_files")).toBe(true);
      expect(provider.supports("exec_command")).toBe(true);
      expect(provider.supports("git_action")).toBe(true);

      const write = await provider.writeFiles(context, { files: [{ filePath: "new.txt", content: "remote-write-marker" }] });
      expect(write.isError).toBeUndefined();
      expect(writes).toEqual([{ file: "/srv/app/new.txt", content: "remote-write-marker" }]);

      const blockedEnv = await provider.writeFiles(context, { files: [{ filePath: ".env", content: "REMOTE_SECRET=blocked" }] });
      expect(blockedEnv.isError).toBe(true);
      expect(blockedEnv.text).toContain("MCP access to .env files is blocked");
      expect(writes).toHaveLength(1);

      const blockedModelConfig = await provider.readFiles(context, { filePaths: [path.join(getRootConfigDir(), "model-config.json")] });
      expect(blockedModelConfig.isError).toBe(true);
      expect(blockedModelConfig.text).toContain("model-config.json is blocked");

      const exec = await provider.execCommand(context, { command: "echo provider-remote-ok" });
      expect(exec.isError).toBeUndefined();
      expect(exec.text).toContain("remote-command-ok:/srv/app");

      const git = await provider.gitAction(context, { action: "status" });
      expect(git.isError).toBeUndefined();
      expect(git.text).toContain("## main");

      const beforeDangerous = commands.length;
      const dangerous = await provider.execCommand(context, { command: "rm -rf /tmp/superagent-remote-never-created" });
      expect(dangerous.isError).toBe(true);
      expect(dangerous.text).toMatch(/blocked by the destructive-command safety policy/i);
      expect(commands).toHaveLength(beforeDangerous);
    } finally {
      setFullYoloMode(false);
      await provider.closeAll();
      removeProject(projectId);
      vi.restoreAllMocks();
    }
  });

  it("rejects stale SSH provider contexts after target retargeting and closes the old cached connection", async () => {
    const provider = new StandaloneSshProjectProvider();
    const projectId = `ssh-provider-retarget-${process.pid}`;
    registerProject({ id: projectId, name: "SSH Retarget", type: "ssh", target: "ssh://deploy@old-host.test/srv/app" });
    const disconnected: object[] = [];
    vi.spyOn(SshProxyService.prototype, "realPath").mockImplementation(async (remotePath: string) => remotePath);
    vi.spyOn(SshProxyService.prototype, "exec").mockResolvedValue({ stdout: "/srv/app" + String.fromCharCode(10) + "main", stderr: "", exitCode: 0 } as any);
    vi.spyOn(SshProxyService.prototype, "disconnect").mockImplementation(async function (this: object) { disconnected.push(this); });
    vi.spyOn(SshProxyService.prototype, "clearCache").mockImplementation(() => {});
    const project = getProject(projectId)!;
    const staleContext: any = { projectId, providerKind: "ssh", project, workspace: project.target, selectionSource: "projectId", explicit: true };
    try {
      await provider.getWorkspaceInfo(staleContext);
      const cachedProxy = (provider as any).connections.get(projectId).proxy as object;
      updateProject(projectId, { target: "ssh://deploy@new-host.test/srv/app" });
      await expect(provider.checkHealth(staleContext)).rejects.toThrow(/configuration changed/i);
      expect(disconnected).toContain(cachedProxy);
      expect((provider as any).connections.has(projectId)).toBe(false);
    } finally {
      await provider.closeAll();
      removeProject(projectId);
      vi.restoreAllMocks();
    }
  });

  it("rejects supported SSH operations without an explicit registered project ID before opening a connection", async () => {
    const provider = new StandaloneSshProjectProvider();
    const result = await provider.dispatch("superagent_list_files", {}, "ssh://deploy@example.test/srv/app");
    expect(result?.isError).toBe(true);
    const text = (result?.content ?? []).map((part: any) => part.text ?? "").join("\n");
    expect(text).toMatch(/registered SSH projectId/i);
  });
});
