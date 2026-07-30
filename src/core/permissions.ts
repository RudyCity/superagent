import path from "path";
import type { ToolCall, ToolResult } from "./conversation.js";
import { getRootConfigDir } from "./config.js";
import { agentLocalStorage } from "./agent.js";
import { runEventHooks } from "./tools/dynamicHooks.js";
import { workspaceMode } from "./ssh/workspaceMode.js";
import { workspaceChainManager } from "./workspace/WorkspaceChainManager.js";

export const MODIFYING_TOOLS = [
  "write",
  "write_to_file",
  "edit",
  "replace_file_content",
  "multi_replace_file_content",
  "apply_patch",
];

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+[\/~]/i,
  /rmdir\s+[\/~]/i,
  /mkfs/i,
  /dd\s+if=/i,
  /:{ *:.+}/,
  /chmod\s+-R\s+777/i,
  /(curl|wget).*\|\s*(ba)?sh/i,
  /eval\(/i,
  /base64\s+-(d|-decode).*\|\s*(ba)?sh/i,
  /Invoke-Expression|iex/i,
  /rmdir\s+\/[sS]\s+\/[qQ]\s+[cC]:\\/i,
  /del\s+\/[fF]\s+\/[sS]\s+\/[qQ]\s+[cC]:\\/i,
  /(shutdown|reboot|halt|poweroff)(\s|$)/i,
  /Remove-Item\s+.*-(Recurse|Force)/i,
  /Format-Volume/i,
  /Initialize-Disk/i,
  /Stop-Process\s+.*-Force/i,
  /Stop-Computer/i,
  // Destructive operations gate
  /\bgit\s+(reset|clean|push|commit|rm)\b/i,
  /\bgit\s+checkout\s+.*-f\b/i,
  /\b(npm|pnpm|yarn|bun|pip|cargo)\s+(install|uninstall|add|remove|update|i)\b/i,
  /\b(db:wipe|db:seed|migrate:reset)\b/i,
  /\b(rotate|delete)\s+(secret|key)\b/i,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

function resolveNormalizedPath(fp: string, baseDir?: string): string {
  let normalized = fp;
  if (process.platform === "win32") {
    if (/^\/[a-zA-Z]\//.test(normalized)) {
      normalized = normalized[1] + ":" + normalized.slice(2);
    } else if (/^\/[a-zA-Z]$/.test(normalized)) {
      normalized = normalized[1] + ":/";
    }
  }
  return baseDir ? path.resolve(baseDir, normalized) : path.resolve(normalized);
}

function extractFilePath(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object" && typeof (entry as any).path === "string") {
    return (entry as any).path;
  }
  return undefined;
}

export function normalizeAndCheckSubpath(childPath: string, parentPath: string): boolean {
  let resolvedChild = resolveNormalizedPath(childPath);
  let resolvedParent = resolveNormalizedPath(parentPath);
  if (process.platform === "win32") {
    resolvedChild = resolvedChild.toLowerCase();
    resolvedParent = resolvedParent.toLowerCase();
  }
  return resolvedChild.startsWith(resolvedParent + path.sep) || resolvedChild === resolvedParent;
}

/**
 * Checks whether a file path is inside the given worktree directory.
 */
export function isPathInWorktree(filePath: string, worktreePath: string): boolean {
  const isAbs = path.isAbsolute(filePath) || (process.platform === "win32" && /^\/[a-zA-Z]\//.test(filePath));
  const resolved = isAbs
    ? resolveNormalizedPath(filePath)
    : resolveNormalizedPath(filePath, worktreePath);
  return normalizeAndCheckSubpath(resolved, worktreePath);
}

export function getAllowedWorkspacePaths(basePath: string): string[] {
  const allowed = [basePath];
  try {
    const chain = workspaceChainManager.getActiveChain();
    if (chain && chain.nodes && Array.isArray(chain.nodes)) {
      for (const node of chain.nodes) {
        if (node.path && typeof node.path === "string" && node.path.trim()) {
          allowed.push(node.path.trim());
        }
        if (node.sshConfig && typeof node.sshConfig.remoteCwd === "string" && node.sshConfig.remoteCwd.trim()) {
          allowed.push(node.sshConfig.remoteCwd.trim());
        }
      }
    }
  } catch {
    // Ignore error if workspace chain manager is uninitialized
  }
  return allowed;
}

/**
 * Returns true if a Superagent's tool call targets a file OUTSIDE its worktree.
 * Checked for both modifying and reading/search tools.
 */
export function isSuperagentOutOfBounds(
  toolCall: { name: string; args?: Record<string, unknown> },
  worktreePath: string
): boolean {
  const fileModifyingTools = [
    "write", "write_to_file", "edit", "replace_file_content",
    "multi_replace_file_content", "apply_patch",
  ];
  const fileReadingTools = [
    "read", "grep", "glob", "ripgrep_search",
  ];
  const checkedTools = [...fileModifyingTools, ...fileReadingTools];
  if (!checkedTools.includes(toolCall.name)) return false;

  const args = toolCall.args || {};
  const candidatePaths = [
    args.filePath,
    args.file_path,
    args.TargetFile,
    args.path,
  ].filter((v): v is string => typeof v === "string");

  if (args.filePaths && Array.isArray(args.filePaths)) {
    for (const fp of args.filePaths) {
      const resolvedFp = extractFilePath(fp);
      if (resolvedFp) {
        candidatePaths.push(resolvedFp);
      }
    }
  }

  if (args.edits && Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object" && typeof (edit as any).filePath === "string") {
        candidatePaths.push((edit as any).filePath);
      }
    }
  }

  if (args.files && Array.isArray(args.files)) {
    for (const file of args.files) {
      if (file && typeof file === "object" && typeof (file as any).filePath === "string") {
        candidatePaths.push((file as any).filePath);
      }
    }
  }

  if (args.patches && Array.isArray(args.patches)) {
    for (const patch of args.patches) {
      if (patch && typeof patch === "object" && typeof (patch as any).filePath === "string") {
        candidatePaths.push((patch as any).filePath);
      }
    }
  }

  // If no path is specified for search tools, they default to cwd (which is the worktree)
  if (candidatePaths.length === 0 && ["glob", "grep", "ripgrep_search"].includes(toolCall.name)) {
    return false;
  }

  const rootConfig = resolveNormalizedPath(getRootConfigDir());
  const allowedWorkspaces = getAllowedWorkspacePaths(worktreePath);

  for (const fp of candidatePaths) {
    const isAbs = path.isAbsolute(fp) || (process.platform === "win32" && /^\/[a-zA-Z]\//.test(fp));
    const resolved = isAbs
      ? resolveNormalizedPath(fp)
      : resolveNormalizedPath(fp, worktreePath);

    // Allow read-only access to files inside global configuration directory
    // BUT model-config.json is strictly protected and requires permission confirmation
    if (fileReadingTools.includes(toolCall.name)) {
      const isModelConfig = normalizeAndCheckSubpath(resolved, path.join(rootConfig, "model-config.json"));
      if (normalizeAndCheckSubpath(resolved, rootConfig) && !isModelConfig) {
        continue;
      }
    }

    const inAnyAllowed = allowedWorkspaces.some((wsPath) => isPathInWorktree(fp, wsPath));
    if (!inAnyAllowed) return true;
  }
  return false;
}

/**
 * Returns true if a tool call targets any path outside the active workspace directory or chain nodes,
 * excluding the global ~/.superagent-r config directory.
 */
export function isToolCallOutOfBounds(
  toolCall: { name: string; args?: Record<string, unknown> },
  workspacePath: string
): boolean {
  if (toolCall.name === "cross_workspace_exec" || toolCall.name === "manage_workspace_chain") {
    try {
      if (workspaceChainManager.isChainActive()) {
        return false;
      }
    } catch {}
  }

  const isSsh = workspaceMode.isSsh() || workspacePath.startsWith("ssh://");
  let effectiveWorkspacePath = workspacePath;

  if (isSsh) {
    const sshCfg = workspaceMode.getConfig();
    if (sshCfg?.remoteCwd) {
      effectiveWorkspacePath = sshCfg.remoteCwd;
    } else if (workspacePath.startsWith("ssh://")) {
      const slashIdx = workspacePath.indexOf("/", 6);
      if (slashIdx !== -1) {
        let pPart = workspacePath.slice(slashIdx);
        const qIdx = pPart.indexOf("?");
        if (qIdx !== -1) pPart = pPart.slice(0, qIdx);
        effectiveWorkspacePath = pPart;
      }
    }
  }

  const allowedWorkspaces = getAllowedWorkspacePaths(effectiveWorkspacePath);
  const args = toolCall.args || {};
  const candidatePaths = [
    args.filePath,
    args.file_path,
    args.TargetFile,
    args.path,
    args.cwd,
    args.DirectoryPath,
    args.SearchPath,
    args.AbsolutePath,
    args.targetPath,
    args.sourcePath,
  ].filter((v): v is string => typeof v === "string");

  if (args.filePaths && Array.isArray(args.filePaths)) {
    for (const fp of args.filePaths) {
      const resolvedFp = extractFilePath(fp);
      if (resolvedFp) {
        candidatePaths.push(resolvedFp);
      }
    }
  }

  if (args.edits && Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object" && typeof (edit as any).filePath === "string") {
        candidatePaths.push((edit as any).filePath);
      }
    }
  }

  if (args.files && Array.isArray(args.files)) {
    for (const file of args.files) {
      if (file && typeof file === "object" && typeof (file as any).filePath === "string") {
        candidatePaths.push((file as any).filePath);
      }
    }
  }

  if (args.patches && Array.isArray(args.patches)) {
    for (const patch of args.patches) {
      if (patch && typeof patch === "object" && typeof (patch as any).filePath === "string") {
        candidatePaths.push((patch as any).filePath);
      }
    }
  }

  const rootConfig = resolveNormalizedPath(getRootConfigDir());

  for (const fp of candidatePaths) {
    if (isSsh) {
      const normFp = fp.replace(/\\/g, "/");
      const inAnyWorkspace = allowedWorkspaces.some((wsPath) => {
        const normW = wsPath.replace(/\\/g, "/");
        const normWWithSlash = normW.endsWith("/") ? normW : normW + "/";
        return normFp === normW || normFp.startsWith(normWWithSlash) || (!normFp.startsWith("/") && !normFp.includes(":"));
      });
      if (inAnyWorkspace) {
        continue;
      }
      return true;
    }

    const isAbs = path.isAbsolute(fp) || (process.platform === "win32" && /^\/[a-zA-Z]\//.test(fp));
    const resolved = isAbs
      ? resolveNormalizedPath(fp)
      : resolveNormalizedPath(fp, effectiveWorkspacePath);

    // If it's inside ~/.superagent-r/ or any workspace chain node path, it's allowed without permission prompt
    // BUT model-config.json is strictly protected and requires permission confirmation
    const isModelConfig = normalizeAndCheckSubpath(resolved, path.join(rootConfig, "model-config.json"));
    const inAnyWorkspace = allowedWorkspaces.some((wsPath) => {
      const resolvedWs = resolveNormalizedPath(wsPath);
      return normalizeAndCheckSubpath(resolved, resolvedWs);
    });

    if ((normalizeAndCheckSubpath(resolved, rootConfig) && !isModelConfig) || inAnyWorkspace) {
      continue;
    }
    return true;
  }

  // Check shell commands for relative traversals or absolute paths targeting outside workspace/config
  const shellTools = ["bash", "run_command", "run_background_process"];
  if (shellTools.includes(toolCall.name)) {
    const command = (args.command ?? args.cmd) as string | undefined;
    if (command && typeof command === "string") {
      // Check parent directory traversal patterns
      if (command.includes("..") && (
        command.includes("../") || 
        command.includes("..\\") || 
        command.includes(".. ") || 
        command.endsWith("..")
      )) {
        const cwdArg = (args.cwd as string) || effectiveWorkspacePath;
        const resolvedCwd = resolveNormalizedPath(cwdArg);
        const inAnyWorkspace = allowedWorkspaces.some((wsPath) => normalizeAndCheckSubpath(resolvedCwd, resolveNormalizedPath(wsPath)));
        if (!inAnyWorkspace) {
          return true;
        }
      }

      // Check absolute paths in command (support quoted paths and paths with spaces)
      if (!isSsh) {
        const winAbsPathRegex = /"[a-zA-Z]:\\[^"]+"|'[a-zA-Z]:\\[^']+'|(?:[a-zA-Z]:\\[^\r\n;&|]+)/g;
        let match;
        while ((match = winAbsPathRegex.exec(command)) !== null) {
          let p = match[0].trim();
          if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
            p = p.slice(1, -1);
          }
          const resolved = resolveNormalizedPath(p);
          const isModelConfig = normalizeAndCheckSubpath(resolved, path.join(rootConfig, "model-config.json"));
          const inRootConfig = normalizeAndCheckSubpath(resolved, rootConfig);
          const inAnyWorkspace = allowedWorkspaces.some((wsPath) => normalizeAndCheckSubpath(resolved, resolveNormalizedPath(wsPath)));
          if ((!inRootConfig || isModelConfig) && !inAnyWorkspace) {
            return true;
          }
        }
      }

      const unixAbsPathRegex = /(?:^|[\s"'])(\/[a-zA-Z0-9_\-\.\/]+)/g;
      let match;
      while ((match = unixAbsPathRegex.exec(command)) !== null) {
        const matchIndex = match.index + match[0].indexOf("/");
        if (matchIndex > 0 && command[matchIndex - 1] === "\\") {
          continue;
        }
        const p = match[1];
        if (p.startsWith("/dev/") || p === "/dev/null" || p.startsWith("/bin/") || p.startsWith("/usr/bin/") || p.startsWith("/tmp/")) {
          continue;
        }

        if (isSsh) {
          const inAnyWorkspace = allowedWorkspaces.some((wsPath) => {
            const normW = wsPath.replace(/\\/g, "/");
            const normWWithSlash = normW.endsWith("/") ? normW : normW + "/";
            return p === normW || p.startsWith(normWWithSlash);
          });
          if (inAnyWorkspace) {
            continue;
          }
          return true;
        }

        const resolved = resolveNormalizedPath(p);
        const isModelConfig = normalizeAndCheckSubpath(resolved, path.join(rootConfig, "model-config.json"));
        const inAnyWorkspace = allowedWorkspaces.some((wsPath) => normalizeAndCheckSubpath(resolved, resolveNormalizedPath(wsPath)));
        if ((!normalizeAndCheckSubpath(resolved, rootConfig) || isModelConfig) && !inAnyWorkspace) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Returns true if a tool call (file or shell) targets model-config.json specifically.
 * Used to show a more descriptive permission message.
 */
export function isModelConfigAccess(
  toolCall: { name: string; args?: Record<string, unknown> },
  workspacePath: string
): boolean {
  const args = toolCall.args || {};
  const rootConfig = resolveNormalizedPath(getRootConfigDir());
  const modelConfigPath = path.join(rootConfig, "model-config.json");

  const candidatePaths = [
    args.filePath, args.file_path, args.TargetFile, args.path,
    args.cwd, args.DirectoryPath, args.SearchPath, args.AbsolutePath,
  ].filter((v): v is string => typeof v === "string");

  if (args.filePaths && Array.isArray(args.filePaths)) {
    for (const fp of args.filePaths) {
      const resolvedFp = extractFilePath(fp);
      if (resolvedFp) {
        candidatePaths.push(resolvedFp);
      }
    }
  }

  if (args.edits && Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object" && typeof (edit as any).filePath === "string") {
        candidatePaths.push((edit as any).filePath);
      }
    }
  }

  if (args.files && Array.isArray(args.files)) {
    for (const file of args.files) {
      if (file && typeof file === "object" && typeof (file as any).filePath === "string") {
        candidatePaths.push((file as any).filePath);
      }
    }
  }

  if (args.patches && Array.isArray(args.patches)) {
    for (const patch of args.patches) {
      if (patch && typeof patch === "object" && typeof (patch as any).filePath === "string") {
        candidatePaths.push((patch as any).filePath);
      }
    }
  }

  for (const fp of candidatePaths) {
    const isAbs = path.isAbsolute(fp) || (process.platform === "win32" && /^\/[a-zA-Z]\//.test(fp));
    const resolved = isAbs
      ? resolveNormalizedPath(fp)
      : resolveNormalizedPath(fp, workspacePath);
    if (normalizeAndCheckSubpath(resolved, modelConfigPath)) return true;
  }

  // Also check shell command arguments
  const shellTools = ["bash", "run_command", "run_background_process"];
  if (shellTools.includes(toolCall.name)) {
    const command = (args.command ?? args.cmd) as string | undefined;
    if (command && typeof command === "string") {
      if (command.toLowerCase().includes("model-config.json")) return true;
    }
  }

  return false;
}

/**
 * Matches any filename that is or starts with ".env" (e.g. .env, .env.local,
 * .env.production, .env-staging, .env_test, etc.)
 */
const ENV_FILE_PATTERN = /(?:^|[\\/])\.env([._\-][^\\/]*)?$/i;

/**
 * Returns true if a tool call targets a sensitive .env* file inside the workspace.
 * These files may contain API keys, database credentials, and other secrets.
 * Unlike out-of-bounds checks, this applies even to paths INSIDE the workspace.
 */
export function isSensitiveEnvFileAccess(
  toolCall: { name: string; args?: Record<string, unknown> }
): boolean {
  const args = toolCall.args || {};

  const candidatePaths = [
    args.filePath, args.file_path, args.TargetFile, args.path,
    args.AbsolutePath,
  ].filter((v): v is string => typeof v === "string");

  if (args.filePaths && Array.isArray(args.filePaths)) {
    for (const fp of args.filePaths) {
      const resolvedFp = extractFilePath(fp);
      if (resolvedFp) {
        candidatePaths.push(resolvedFp);
      }
    }
  }

  if (args.edits && Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object" && typeof (edit as any).filePath === "string") {
        candidatePaths.push((edit as any).filePath);
      }
    }
  }

  if (args.files && Array.isArray(args.files)) {
    for (const file of args.files) {
      if (file && typeof file === "object" && typeof (file as any).filePath === "string") {
        candidatePaths.push((file as any).filePath);
      }
    }
  }

  if (args.patches && Array.isArray(args.patches)) {
    for (const patch of args.patches) {
      if (patch && typeof patch === "object" && typeof (patch as any).filePath === "string") {
        candidatePaths.push((patch as any).filePath);
      }
    }
  }

  for (const fp of candidatePaths) {
    const normalized = fp.replace(/\\/g, "/");
    if (ENV_FILE_PATTERN.test(normalized)) return true;
  }

  // Check shell commands for references to .env files
  const shellTools = ["bash", "run_command", "run_background_process"];
  if (shellTools.includes(toolCall.name)) {
    const command = (args.command ?? args.cmd) as string | undefined;
    if (command && typeof command === "string") {
      // Match common operations: cat .env, cp .env, source .env, etc.
      if (ENV_FILE_PATTERN.test(command)) return true;
    }
  }

  return false;
}

/**
 * Shorten a shell command string to a readable one-liner summary.
 * Shows the program name + first meaningful argument, truncated to maxLen chars.
 * Multi-line or chained commands get an ellipsis suffix.
 */
function truncateCommand(cmd: string, maxLen = 80): string {
  // Normalise: collapse all whitespace/newlines to single spaces
  const flat = cmd.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();

  // Parse cd command with optional chained commands:
  // e.g. cd "path" && command
  const cdRegex = /^[cC][dD]\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;&|]+)\s*(?:(&&|;|\||&)\s*(.*))?$/;
  const cdMatch = cdRegex.exec(flat);

  let formatted = flat;
  if (cdMatch) {
    let rawPath = cdMatch[1];
    if ((rawPath.startsWith('"') && rawPath.endsWith('"')) || (rawPath.startsWith("'") && rawPath.endsWith("'"))) {
      rawPath = rawPath.slice(1, -1);
    }
    const normalized = rawPath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    const basename = parts[parts.length - 1] || rawPath;

    const separator = cdMatch[2] ? ` ${cdMatch[2]} ` : "";
    const remaining = cdMatch[3] ? cdMatch[3].trim() : "";

    formatted = `cd ".../${basename}"${separator}${remaining}`;
  }

  // Check if the original command was multi-line or chained
  const isMultiPart = /[\n;&&|]/.test(cmd);
  const truncated = formatted.length > maxLen ? formatted.slice(0, maxLen - 3) + "..." : formatted;
  // If multi-line / chained, always show ellipsis to signal there's more
  if (isMultiPart && !truncated.endsWith("...")) {
    const short = formatted.slice(0, maxLen - 3);
    return short + "...";
  }
  return truncated;
}

export function getToolDescription(
  toolCall: ToolCall
): string {
  const args = toolCall.args;
  /** Safely resolve file path from common LLM aliases (filePath, file_path, path, TargetFile, file, AbsolutePath, absolutePath, filePaths) */
  let fp = (args.filePath ?? args.file_path ?? args.path ?? args.TargetFile ?? args.file ?? args.AbsolutePath ?? args.absolutePath) as string | undefined;
  if (!fp && args.filePaths && Array.isArray(args.filePaths) && args.filePaths.length > 0) {
    const firstPath = extractFilePath(args.filePaths[0]) ?? "(invalid)";
    if (args.filePaths.length === 1) {
      fp = firstPath;
    } else {
      fp = `${firstPath} and ${args.filePaths.length - 1} more files`;
    }
  }
  if (!fp && args.edits && Array.isArray(args.edits) && args.edits.length > 0) {
    const uniquePaths = Array.from(new Set(args.edits.map((e: any) => e.filePath ?? e.path).filter(Boolean)));
    if (uniquePaths.length === 1) {
      fp = uniquePaths[0] as string;
    } else if (uniquePaths.length > 1) {
      fp = `${uniquePaths[0]} and ${uniquePaths.length - 1} more files`;
    }
  }
  if (!fp && args.files && Array.isArray(args.files) && args.files.length > 0) {
    const uniquePaths = Array.from(new Set(args.files.map((f: any) => f.filePath ?? f.path).filter(Boolean)));
    if (uniquePaths.length === 1) {
      fp = uniquePaths[0] as string;
    } else if (uniquePaths.length > 1) {
      fp = `${uniquePaths[0]} and ${uniquePaths.length - 1} more files`;
    }
  }
  if (!fp && args.patches && Array.isArray(args.patches) && args.patches.length > 0) {
    const uniquePaths = Array.from(new Set(args.patches.map((p: any) => p.filePath ?? p.path).filter(Boolean)));
    if (uniquePaths.length === 1) {
      fp = uniquePaths[0] as string;
    } else if (uniquePaths.length > 1) {
      fp = `${uniquePaths[0]} and ${args.patches.length - 1} more files`;
    }
  }
  if (!fp) {
    fp = "(missing)";
  }
  /** Safe string fallback helper for description interpolation */
  const s = (v: unknown) => (v !== undefined && v !== null ? String(v) : "(missing)");
  switch (toolCall.name) {
    case "read":
      return `Reading file: ${fp}`;
    case "write":
      return `Writing file: ${fp}`;
    case "edit":
      return `Editing file: ${fp}`;
    case "bash":
      return `Running command: ${truncateCommand(s(args.command ?? args.cmd))}`;
    case "glob":
      return `Finding files matching pattern: ${s(args.pattern)}`;
    case "grep":
      return `Searching for pattern: ${s(args.pattern)}`;
    case "web_search":
      return `Searching web for: ${s(args.query)}`;
    case "fetch_url":
      return `Fetching URL: ${s(args.url)}`;
    case "ripgrep_search":
      return `Searching codebase with ripgrep for: ${s(args.pattern)}`;
    case "run_background_process":
      return `Starting background process: ${truncateCommand(s(args.command ?? args.cmd))}${args.cwd ? ` (in ${args.cwd})` : ""}`;
    case "write_to_file":
      return `Writing file: ${fp}`;
    case "replace_file_content":
      return `Replacing content in file: ${fp}`;
    case "multi_replace_file_content":
      return `Replacing multiple blocks in file: ${fp}`;
    case "run_command":
      return `Running command: ${truncateCommand(s(args.command ?? args.cmd))}${args.cwd ? ` (in ${args.cwd})` : ""}`;
    case "manage_background_process":
      return `Managing background process (${s(args.action)}): ${args.processId || ""}`;
    case "schedule":
      return `Scheduling job: ${s(args.prompt)}`;
    case "define_subagent":
      return `Defining subagent: ${s(args.name)}`;
    case "invoke_subagent": {
      const typeName = args.typeName ?? args.agent_name ?? args.name;
      const role = args.role ?? args.agent_role ?? typeName ?? "subagent";
      return `Invoking subagent (${s(role)}): ${s(typeName)}`;
    }
    case "send_message":
      return `Sending message to subagent: ${s(args.recipientId)}`;
    case "manage_subagents":
      return `Managing subagents (${s(args.action)})`;
    case "invoke_superagent": {
      const role = args.role ?? args.agent_role ?? "superagent";
      const branch = args.branch ?? args.branchName;
      return `Spawning Superagent "${s(role)}" on branch ${s(branch)}`;
    }
    case "await_superagents":
      return `Waiting for all Superagents to finish`;
    case "merge_superagents":
      return `Merging all completed Superagent branches`;
    case "apply_patch":
      return `Applying patch to file: ${fp}`;
    case "git_action":
      return `Running Git action: ${s(args.action)}`;
    case "screenshot":
      return `Capturing desktop screenshot`;
    case "android_cli":
      return `Running Android CLI command: android ${s(args.command)}`;
    case "ask_question":
      return `Asking user: ${s(args.question)}`;
    case "manage_superagents":
      return `Managing Superagents (${s(args.action)})`;
    case "define_superagent":
      return `Defining Superagent: ${s(args.name)}`;
    case "send_message_to_superagent":
      return `Sending message to Superagent "${s(args.name)}"`;
    case "git_worktree":
      return `Running git worktree action: ${s(args.action)}`;
    case "search_history":
      return `Searching history for: ${s(args.query)}`;
    case "load_pinned_session":
      return `Loading pinned session: ${s(args.sessionId)}`;
    case "search_pinned_knowledge":
      return `Searching pinned knowledge: ${s(args.query)}`;
    case "manage_tasks":
      return `Managing tasks (${s(args.action)})`;
    case "list_peer_superagents":
      return `Listing peer superagents`;
    case "manage_plan":
      return `Managing plan (${s(args.action)})`;
    default:
      return `Running tool ${toolCall.name} with parameters ${JSON.stringify(args)}`;
  }
}

function isErrorLikeToolResult(result: string): boolean {
  const trimmed = result.trim();
  return (
    /^Error(?:\b|:)/i.test(trimmed) ||
    /^Error reading file:/i.test(trimmed) ||
    /^Git worktree error:/i.test(trimmed) ||
    /^Exit code:\s*[1-9]\d*/i.test(trimmed)
  );
}
export async function executeToolCall(
  toolCall: ToolCall,
  cwd: string,
  signal?: AbortSignal
): Promise<ToolResult> {
  const { getToolByName } = await import("./tools.js");
  const tool = getToolByName(toolCall.name);
  const currentAgent = agentLocalStorage.getStore();
  const tier = currentAgent ? currentAgent.tier : "unknown";
  const depth = currentAgent ? currentAgent.delegationDepth : 0;
  if (!tool) {
    try {
      const { appendMasterLog, appendToolsErrorLog } = await import("./tools/state.js");
      appendMasterLog(`[ERROR] Unknown tool called: ${toolCall.name}`);
      appendToolsErrorLog(tier, depth, toolCall.name, `Unknown tool called: ${toolCall.name}`);
    } catch {}
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: `Error: Unknown tool "${toolCall.name}"`,
      isError: true,
    };
  }

  // Tier-level tool access validation (Layer 2 business logic guard)
  if (currentAgent) {
    try {
      const activeTools = await currentAgent.getActiveTools();
      const isAllowed = activeTools.some((t: any) => t.name === toolCall.name);
      if (!isAllowed) {
        try {
          const { appendMasterLog, appendToolsErrorLog } = await import("./tools/state.js");
          const subTypeSuffix = currentAgent.subagentType ? ` / ${currentAgent.subagentType}` : "";
          appendMasterLog(`[ERROR] Unauthorized tool called by ${tier}${subTypeSuffix}: ${toolCall.name}`);
          appendToolsErrorLog(tier, depth, toolCall.name, `Unauthorized tool called: ${toolCall.name}`);
        } catch {}
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          result: `Error: Tool "${toolCall.name}" is not available for this agent's tier (${tier}${currentAgent.subagentType ? ` / ${currentAgent.subagentType}` : ""}).`,
          isError: true,
        };
      }
    } catch (err) {
      // Fallback: if resolution fails, continue execution to avoid deadlock/blocker
    }
  }

  try {
    await runEventHooks("pre_tool", { toolName: toolCall.name, args: toolCall.args, cwd });
    const result = await tool.execute(toolCall.args, cwd, signal);
    await runEventHooks("post_tool", { toolName: toolCall.name, args: toolCall.args, result, cwd });
    const isError = isErrorLikeToolResult(result);
    if (isError) {
      try {
        const { appendMasterLog, appendToolsErrorLog } = await import("./tools/state.js");
        appendMasterLog(`[ERROR] Tool returned error: ${toolCall.name} | ${String(result).slice(0, 2000)}`);
        appendToolsErrorLog(tier, depth, toolCall.name, String(result).slice(0, 2000), { cwd });
      } catch {}
    }
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result,
      ...(isError ? { isError: true } : {}),
    };
  } catch (err: unknown) {
    // Re-throw AbortError so it propagates up to the agent loop's finally block,
    // which resets isRunning=false and emits the "done" event.
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    try {
      const { appendMasterLog, appendToolsErrorLog } = await import("./tools/state.js");
      appendMasterLog(`[ERROR] Tool execution failed: ${toolCall.name} | ${message}`);
      appendToolsErrorLog(tier, depth, toolCall.name, message, { cwd });
    } catch {}
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: `Error: ${message}`,
      isError: true,
    };
  }
}
