import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getProject } from "../projectRegistry.js";
import { isFullYoloMode, isModelConfigAccess, isSensitiveEnvFileAccess } from "../../permissions.js";
import { handleReadFiles, handleListFiles, handleGrepSearch, handleFindFiles, handleWriteFiles, handleExecCommand } from "../../mcp/tools/workspaceTools.js";
import { handleGitAction } from "../../mcp/tools/networkContentMcpTools.js";
import { runWithMcpWorkspace } from "../../mcp/tools/workspaceContext.js";
import type { ProjectProvider, ProjectOperation, ProjectWorkspaceInfo, ProjectHealthReport, ProjectHealthOptions, ProjectHealthCheck, ProjectOperationResult, ProjectToolArguments, ResolvedProjectContext } from "./types.js";

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(pathKey(parent), pathKey(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Capability-aware local adapter for shared project operations and read-only health diagnostics. */
export class LocalProjectProvider implements ProjectProvider {
  readonly kind = "local" as const;

  supports(operation: ProjectOperation): boolean {
    return ["workspace_info", "health_check", "read_files", "list_files", "grep_search", "find_files", "write_files", "exec_command", "git_action"].includes(operation);
  }

  private async invokeLocalHandler(
    context: ResolvedProjectContext,
    name: string,
    args: ProjectToolArguments,
    handler: (args: any) => Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>,
  ): Promise<ProjectOperationResult> {
    let info: ProjectWorkspaceInfo;
    try {
      info = await this.getWorkspaceInfo(context);
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
    const normalizedArgs = { ...args, cwd: info.workspace, workspace: info.workspace };
    if (!isFullYoloMode() && isSensitiveEnvFileAccess({ name, args: normalizedArgs })) {
      return { text: "MCP access to .env files is blocked unless Full YOLO is enabled locally.", isError: true };
    }
    if (!isFullYoloMode() && isModelConfigAccess({ name, args: normalizedArgs }, info.workspace)) {
      return { text: "Error: model-config.json is protected and cannot be read through MCP without Full YOLO.", isError: true };
    }
    const result = await runWithMcpWorkspace(info.workspace, () => handler(normalizedArgs));
    return {
      text: (result.content || []).map((part) => part.type === "text" ? part.text || "" : "").filter(Boolean).join(String.fromCharCode(10)),
      ...(result.isError ? { isError: true } : {}),
    };
  }

  async readFiles(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult> {
    return this.invokeLocalHandler(context, "superagent_read_files", args, handleReadFiles);
  }

  async listFiles(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult> {
    return this.invokeLocalHandler(context, "superagent_list_files", args, handleListFiles);
  }

  async grepSearch(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult> {
    return this.invokeLocalHandler(context, "superagent_grep_search", args, handleGrepSearch);
  }

  async findFiles(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult> {
    return this.invokeLocalHandler(context, "superagent_find_files", args, handleFindFiles);
  }

  async writeFiles(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult> {
    return this.invokeLocalHandler(context, "superagent_write_files", args, handleWriteFiles);
  }

  async execCommand(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult> {
    return this.invokeLocalHandler(context, "superagent_exec_command", args, handleExecCommand);
  }

  async gitAction(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult> {
    return this.invokeLocalHandler(context, "superagent_git_action", args, handleGitAction);
  }

  async getWorkspaceInfo(context: ResolvedProjectContext): Promise<ProjectWorkspaceInfo> {
    const project = getProject(context.projectId);
    if (!project || context.providerKind !== this.kind || project.type !== "local" || !project.root
      || project.id !== context.projectId || !project.enabled) {
      throw new Error("Resolved context is not an enabled registered local project.");
    }
    if (project.root !== context.project.root) {
      throw new Error("Project configuration changed after target resolution; resolve the project again before retrying.");
    }

    const root = fs.realpathSync(project.root);
    const workspace = fs.realpathSync(context.workspace);
    if (!isWithin(workspace, root)) {
      throw new Error(`Workspace is outside registered project ${project.id}: ${workspace}`);
    }
    if (!fs.statSync(workspace).isDirectory()) {
      throw new Error(`Workspace is not a directory: ${workspace}`);
    }

    let gitBranch: string | undefined;
    try {
      gitBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: workspace,
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      }).trim() || undefined;
    } catch {
      // A non-Git directory is valid as a project workspace.
    }

    return {
      projectId: project.id,
      providerKind: this.kind,
      workspace,
      root,
      remote: false,
      exists: true,
      ...(gitBranch ? { gitBranch } : {}),
    };
  }

  async checkHealth(context: ResolvedProjectContext, options: ProjectHealthOptions = {}): Promise<ProjectHealthReport> {
    const startedAt = Date.now();
    const project = getProject(context.projectId);
    if (!project || context.providerKind !== this.kind || project.type !== "local"
      || project.id !== context.projectId || !project.enabled || !project.root) {
      throw new Error("Resolved context is not an enabled registered local project.");
    }
    if (project.root !== context.project.root) {
      throw new Error("Project configuration changed after target resolution; resolve the project again before retrying.");
    }

    const checks: ProjectHealthCheck[] = [];
    const addCheck = (name: string, status: ProjectHealthCheck["status"], message: string, started: number) => {
      checks.push({ name, status, message, durationMs: Math.max(0, Date.now() - started) });
    };

    const rootCheckAt = Date.now();
    let rootExists = false;
    let root = path.resolve(project.root);
    try {
      rootExists = fs.existsSync(root) && fs.statSync(root).isDirectory();
      if (rootExists) root = fs.realpathSync(root);
      addCheck("root_exists", rootExists ? "passed" : "failed", rootExists ? "Registered root exists and is a directory." : "Registered project root is missing or is not a directory.", rootCheckAt);
    } catch {
      rootExists = false;
      addCheck("root_exists", "failed", "Registered project root could not be inspected.", rootCheckAt);
    }

    if (!rootExists) {
      const now = Date.now();
      for (const name of ["workspace_boundary", "git_repository", "project_manifest"]) {
        checks.push({ name, status: "skipped", message: "Skipped because the registered root is unavailable.", durationMs: 0 });
      }
      return {
        projectId: project.id,
        providerKind: this.kind,
        status: "unavailable",
        checkedAt: new Date(now).toISOString(),
        durationMs: Math.max(0, now - startedAt),
        checks,
        remediationHints: ["Verify the registered root path and restore or re-register the project directory."],
      };
    }

    const workspaceCheckAt = Date.now();
    let workspaceOk = false;
    try {
      const workspace = fs.realpathSync(context.workspace);
      workspaceOk = isWithin(workspace, root) && fs.statSync(workspace).isDirectory();
      addCheck("workspace_boundary", workspaceOk ? "passed" : "failed", workspaceOk ? "Selected workspace is an existing directory under the registered root." : "Selected workspace is missing or outside the registered root.", workspaceCheckAt);
    } catch {
      addCheck("workspace_boundary", "failed", "Selected workspace is missing or could not be inspected.", workspaceCheckAt);
    }

    const gitCheckAt = Date.now();
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: root,
        encoding: "utf8",
        timeout: Math.max(250, Math.min(5000, options.timeoutMs ?? 2000)),
        stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      });
      addCheck("git_repository", "passed", "Git repository detected.", gitCheckAt);
    } catch {
      addCheck("git_repository", "skipped", "No Git repository detected, or Git metadata could not be read within the probe timeout.", gitCheckAt);
    }

    const manifestCheckAt = Date.now();
    const manifestNames = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "composer.json", "Gemfile", "pom.xml", "build.gradle", "Makefile"];
    let manifests: string[] = [];
    try {
      manifests = manifestNames.filter((name) => {
        const manifestPath = path.join(root, name);
        return fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile();
      });
      addCheck("project_manifest", manifests.length ? "passed" : "skipped", manifests.length ? "Found project manifest(s): " + manifests.join(", ") + "." : "No common project manifest detected; this is informational, not a failure.", manifestCheckAt);
    } catch {
      addCheck("project_manifest", "skipped", "Project manifests could not be inspected; this is informational, not a failure.", manifestCheckAt);
    }

    const now = Date.now();
    const status = workspaceOk ? "healthy" : "degraded";
    return {
      projectId: project.id,
      providerKind: this.kind,
      status,
      checkedAt: new Date(now).toISOString(),
      durationMs: Math.max(0, now - startedAt),
      checks,
      remediationHints: workspaceOk ? [] : ["Choose an existing subdirectory inside the registered project root, or update the project registration."],
    };
  }

  async closeProject(_projectId: string): Promise<void> {
    // The local adapter owns no per-project resources.
  }
}
