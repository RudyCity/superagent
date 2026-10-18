import path from "node:path";
import { SshProxyService } from "../../ssh/sshProxy.js";
import { workspaceMode, type SshWorkspaceConfig } from "../../ssh/workspaceMode.js";
import { getProject, type RegisteredProject } from "../../project/projectRegistry.js";
import { isFullYoloMode, isSystemDestructiveCommand } from "../../permissions.js";
import type { McpToolResult } from "../types.js";

interface SshProjectConnection {
  target: string;
  config: SshWorkspaceConfig;
  proxy: SshProxyService;
}
function result(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}
function escapeShell(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
function getRemotePath(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "ssh:") throw new Error("Expected an ssh:// target.");
    return path.posix.normalize(decodeURIComponent(parsed.pathname || "/"));
  } catch (error) {
    throw new Error("Invalid standalone SSH workspace target: " + (error instanceof Error ? error.message : String(error)));
  }
}
function isWithinRemoteRoot(candidate: string, root: string): boolean {
  const relative = path.posix.relative(path.posix.normalize(root), path.posix.normalize(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative));
}
function normalizeRemoteCandidate(input: string | undefined, currentPath: string, root: string): string {
  const raw = (input || ".").trim().replace(/\\/g, "/");
  const resolved = path.posix.normalize(raw.startsWith("/") ? raw : path.posix.join(currentPath, raw));
  if (resolved === ".." || resolved.startsWith("../") || !isWithinRemoteRoot(resolved, root)) {
    throw new Error("Remote path escapes registered SSH project root: " + (input || "."));
  }
  return resolved;
}
function getEntry(args: Record<string, any>, targetWorkspace: string, projectId?: string | null): { project: RegisteredProject; uri: string } {
  const id = projectId || (typeof args.projectId === "string" ? args.projectId : "");
  if (!id) throw new Error("Standalone SSH operations require a registered SSH projectId.");
  const project = getProject(id);
  if (!project || !project.enabled) throw new Error("SSH project is not registered or is disabled: " + id);
  if (project.type !== "ssh" || !project.target) throw new Error("Project " + id + " is not a standalone SSH project.");
  const uri = /^ssh:/i.test(targetWorkspace) ? targetWorkspace : project.target;
  const expected = new URL(project.target);
  const actual = new URL(uri);
  if (actual.protocol !== "ssh:" || actual.password || actual.search || actual.hash
    || actual.hostname.toLowerCase() !== expected.hostname.toLowerCase()
    || actual.username !== expected.username || (actual.port || "22") !== (expected.port || "22")) {
    throw new Error("SSH target does not match registered project " + id + ".");
  }
  const root = path.posix.normalize(decodeURIComponent(expected.pathname || "/"));
  const requested = path.posix.normalize(decodeURIComponent(actual.pathname || root));
  if (!isWithinRemoteRoot(requested, root)) throw new Error("SSH workspace escapes registered project root: " + requested);
  return { project, uri };
}

/** One SSH/SFTP client per registered project keeps connections and caches isolated. */
export class StandaloneSshProjectProvider {
  private connections = new Map<string, SshProjectConnection>();

  private getConnection(project: RegisteredProject): SshProjectConnection {
    if (project.type !== "ssh" || !project.target) throw new Error("Project must be a registered standalone SSH project.");
    const existing = this.connections.get(project.id);
    if (existing && existing.target === project.target) return existing;
    if (existing) {
      void existing.proxy.disconnect();
      existing.proxy.clearCache();
      this.connections.delete(project.id);
    }
    const config = workspaceMode.parseSshTarget(project.target);
    if (!config) throw new Error("Could not parse SSH target for project " + project.id + ". Use ssh://user@host[:port]/absolute/remote/root.");
    const connection: SshProjectConnection = { target: project.target, config, proxy: new SshProxyService({ trackGlobalToolOutput: false, allowInteractiveAuth: false }) };
    this.connections.set(project.id, connection);
    return connection;
  }

  async closeProject(projectId: string): Promise<void> {
    const entry = this.connections.get(projectId);
    if (!entry) return;
    this.connections.delete(projectId);
    entry.proxy.clearCache();
    await entry.proxy.disconnect();
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.closeProject(id)));
  }

  async dispatch(name: string, args: Record<string, any>, targetWorkspace: string, projectId?: string | null): Promise<McpToolResult | null> {
    if (!/^ssh:/i.test(targetWorkspace)) return null;
    const allowed = new Set([
      "superagent_get_workspace", "superagent_exec_command", "superagent_read_files", "superagent_write_files",
      "superagent_list_files", "superagent_grep_search", "superagent_find_files", "superagent_git_action",
    ]);
    if (!allowed.has(name)) {
      return result("Tool '" + name + "' is not implemented for standalone SSH projects yet. The request was not executed locally. Supported tools: "
        + [...allowed].join(", ") + ". Workspace Chain remains optional and is only needed for cross-node workflows.", true);
    }

    try {
      const resolved = getEntry(args, targetWorkspace, projectId);
      const project = resolved.project;
      const entry = this.getConnection(project);
      const selectedPath = getRemotePath(resolved.uri);
      const registeredRoot = getRemotePath(project.target!);
      return await workspaceMode.runWithWorkspaceConfig(entry.config, async () => {
        const canonicalRoot = path.posix.normalize(await entry.proxy.realPath(registeredRoot));
        const selectedCanonical = path.posix.normalize(await entry.proxy.realPath(selectedPath));
        if (!isWithinRemoteRoot(selectedCanonical, canonicalRoot)) {
          throw new Error("Selected SSH workspace resolves outside the registered project's remote root.");
        }
        const guardedPath = async (raw: string | undefined, write: boolean): Promise<string> => {
          const candidate = normalizeRemoteCandidate(raw, selectedPath, registeredRoot);
          if (!write) {
            const real = path.posix.normalize(await entry.proxy.realPath(candidate));
            if (!isWithinRemoteRoot(real, canonicalRoot)) throw new Error("Remote symlink escapes registered project root: " + (raw || "."));
            return candidate;
          }
          let ancestor = candidate;
          while (true) {
            try {
              const real = path.posix.normalize(await entry.proxy.realPath(ancestor));
              if (!isWithinRemoteRoot(real, canonicalRoot)) throw new Error("Remote symlink escapes registered project root: " + (raw || "."));
              break;
            } catch (error) {
              if (error instanceof Error && error.message.includes("symlink escapes")) throw error;
              const parent = path.posix.dirname(ancestor);
              if (parent === ancestor || parent === "/") {
                const realRoot = path.posix.normalize(await entry.proxy.realPath(registeredRoot));
                if (!isWithinRemoteRoot(realRoot, canonicalRoot)) throw new Error("Registered SSH root resolves outside its canonical root.");
                break;
              }
              ancestor = parent;
            }
          }
          return candidate;
        };

        if (name === "superagent_get_workspace") {
          const response = await entry.proxy.exec("pwd && (git branch --show-current 2>/dev/null || true)", selectedPath, 15000);
          return result(JSON.stringify({ projectId: project.id, type: "ssh", workspace: selectedPath, remote: true, details: response.stdout.trim(), exitCode: response.exitCode }, null, 2), response.exitCode !== 0);
        }

        if (name === "superagent_exec_command") {
          const command = typeof args.command === "string" ? args.command : "";
          if (!command.trim()) return result("Error: 'command' is required.", true);
          if (!isFullYoloMode() && isSystemDestructiveCommand(command)) {
            return result("Remote command blocked by the destructive-command safety policy. Enable Full YOLO locally only when this system-level operation is intentional.", true);
          }
          const cwd = await guardedPath(typeof args.cwd === "string" && !/^ssh:/i.test(args.cwd) ? args.cwd : selectedPath, false);
          const timeoutMs = typeof args.timeoutMs === "number" ? Math.max(1000, Math.min(args.timeoutMs, 600000)) : 30000;
          const response = await entry.proxy.exec(command, cwd, timeoutMs);
          return result("[project=" + project.id + " remoteCwd=" + cwd + " exitCode=" + response.exitCode + "]\n"
            + response.stdout + (response.stderr ? "\nSTDERR:\n" + response.stderr : ""), response.exitCode !== 0);
        }

        if (name === "superagent_read_files") {
          const input = args.files ?? args.filePaths;
          if (!Array.isArray(input) || input.length === 0 || input.length > 50) return result("Error: files/filePaths must contain 1-50 paths.", true);
          const sections: string[] = [];
          for (const item of input) {
            const raw = typeof item === "string" ? item : String(item?.filePath ?? item?.path ?? "");
            if (!raw) { sections.push("Error: each read item needs filePath."); continue; }
            try {
              const file = await guardedPath(raw, false);
              const content = await entry.proxy.readFile(file);
              const lines = content.split(/\r?\n/);
              const start = typeof item === "object" && typeof item.startLine === "number" ? Math.max(1, item.startLine)
                : (typeof args.startLine === "number" ? Math.max(1, args.startLine) : 1);
              const end = typeof item === "object" && typeof item.endLine === "number" ? item.endLine : args.endLine;
              sections.push("=== File: " + file + " (Lines " + start + "-" + (end || lines.length) + "/" + lines.length + ") ===\n"
                + lines.slice(start - 1, end ? Math.max(start - 1, end) : undefined).map((line, index) => (start + index) + ": " + line).join("\n"));
            } catch (error) {
              sections.push("=== " + raw + " ===\nError: " + (error instanceof Error ? error.message : String(error)));
            }
          }
          const failures = sections.filter((section) => section.includes("\nError:")).length;
          return result("Remote read files: " + (input.length - failures) + " succeeded, " + failures + " failed.\n\n" + sections.join("\n\n---\n\n"), failures === input.length);
        }

        if (name === "superagent_write_files") {
          const input = args.files;
          if (!Array.isArray(input) || input.length === 0 || input.length > 50) return result("Error: files must contain 1-50 file entries.", true);
          const seen = new Set<string>();
          const lines: string[] = [];
          for (const item of input) {
            const raw = String(item?.filePath ?? item?.path ?? "");
            if (!raw || typeof item?.content !== "string") { lines.push("Error: each entry needs filePath and string content."); continue; }
            try {
              const file = await guardedPath(raw, true);
              if (seen.has(file)) throw new Error("Duplicate target in write batch: " + file);
              seen.add(file);
              if (item.overwrite === false || args.overwrite === false) {
                try { await entry.proxy.stat(file); throw new Error("File already exists: " + file); }
                catch (error) { if (error instanceof Error && error.message.startsWith("File already exists:")) throw error; }
              }
              await entry.proxy.writeFile(file, item.content);
              lines.push("Wrote remote file: " + file);
            } catch (error) {
              lines.push("Error writing " + raw + ": " + (error instanceof Error ? error.message : String(error)));
            }
          }
          const failures = lines.filter((line) => line.startsWith("Error")).length;
          return result("Remote write files: " + (input.length - failures) + " succeeded, " + failures + " failed.\n" + lines.join("\n"), failures === input.length);
        }

        if (name === "superagent_list_files") {
          const dir = await guardedPath(typeof args.dirPath === "string" ? args.dirPath : selectedPath, false);
          const entries = await entry.proxy.listFiles(dir);
          return result(JSON.stringify({ projectId: project.id, directory: dir, count: entries.length, entries }, null, 2));
        }

        if (name === "superagent_grep_search") {
          const query = typeof args.query === "string" ? args.query : "";
          if (!query) return result("Error: 'query' is required.", true);
          const dir = await guardedPath(typeof args.path === "string" ? args.path : selectedPath, false);
          let command = "grep -rnE -- " + escapeShell(query) + " " + escapeShell(dir);
          if (typeof args.include === "string" && args.include) command = "grep -rnE --include=" + escapeShell(args.include) + " -- " + escapeShell(query) + " " + escapeShell(dir);
          if (typeof args.exclude === "string" && args.exclude) command += " --exclude=" + escapeShell(args.exclude);
          command += " 2>/dev/null | head -n 200";
          const response = await entry.proxy.exec(command, selectedPath, 60000);
          if (response.exitCode === 1 && !response.stdout.trim()) return result("No matches found.");
          return result(response.stdout || response.stderr || "No matches found.", response.exitCode !== 0 && response.exitCode !== 1);
        }

        if (name === "superagent_find_files") {
          const dir = await guardedPath(typeof args.path === "string" ? args.path : selectedPath, false);
          const maxDepth = typeof args.maxDepth === "number" ? Math.max(1, Math.min(12, Math.floor(args.maxDepth))) : 6;
          const pattern = typeof args.pattern === "string" && args.pattern ? args.pattern : "*";
          const command = "find " + escapeShell(dir) + " -maxdepth " + maxDepth + " -type f -name " + escapeShell(pattern) + " 2>/dev/null | head -n 500";
          const response = await entry.proxy.exec(command, selectedPath, 60000);
          return result(response.stdout || (response.exitCode === 0 ? "No files found." : response.stderr), response.exitCode !== 0 && !response.stdout);
        }

        if (name === "superagent_git_action") {
          const action = String(args.action || "");
          const files = Array.isArray(args.files) ? args.files : [];
          const checkedFiles: string[] = [];
          for (const raw of files) checkedFiles.push(await guardedPath(String(raw), action === "add" || action === "restore" || action === "clean"));
          let command: string;
          switch (action) {
            case "status": command = "git status --short --branch"; break;
            case "diff": command = "git diff --" + (checkedFiles.length ? " " + checkedFiles.map(escapeShell).join(" ") : ""); break;
            case "log": command = "git --no-pager log -n " + Math.max(1, Math.min(50, Number(args.limit) || 5)) + " --oneline"; break;
            case "add":
              if (!checkedFiles.length) return result("Error: git add requires files.", true);
              command = "git add -- " + checkedFiles.map(escapeShell).join(" "); break;
            case "commit":
              if (typeof args.message !== "string" || !args.message.trim()) return result("Error: git commit requires a non-empty message.", true);
              command = "git commit -m " + escapeShell(args.message); break;
            case "restore":
              if (!checkedFiles.length) return result("Error: git restore requires files.", true);
              command = "git restore -- " + checkedFiles.map(escapeShell).join(" "); break;
            case "clean":
              if (!checkedFiles.length) return result("Error: git clean requires explicit files; refusing an unscoped clean.", true);
              command = "git clean -fd -- " + checkedFiles.map(escapeShell).join(" "); break;
            default: return result("Unsupported git action: " + action, true);
          }
          const response = await entry.proxy.exec(command, selectedPath, 60000);
          return result("[project=" + project.id + " action=" + action + " exitCode=" + response.exitCode + "]\n"
            + response.stdout + (response.stderr ? "\nSTDERR:\n" + response.stderr : ""), response.exitCode !== 0);
        }
        return null;
      });
    } catch (error) {
      return result(error instanceof Error ? error.message : String(error), true);
    }
  }
}

export const standaloneSshProjectProvider = new StandaloneSshProjectProvider();
