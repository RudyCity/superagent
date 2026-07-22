import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";

export function getRootConfigDir(): string {
  const override = process.env.SUPERAGENT_CONFIG_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".superagent-r");
}

export function getGlobalConfigDir(): string {
  const root = getRootConfigDir();
  if (process.env.SUPERAGENT_SESSION_ID) {
    return path.join(root, "sessions", process.env.SUPERAGENT_SESSION_ID);
  }
  return root;
}

export function ensureGlobalConfigDir(): void {
  const rootDir = getRootConfigDir();
  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }
  const dir = getGlobalConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getModelConfigPath(): string {
  return path.join(getRootConfigDir(), "model-config.json");
}

export function getPackageRootDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "..", "..", "..");
}

export function getSuperAgentVersion(): string {
  try {
    const pkgPath = path.join(getPackageRootDir(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const content = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(content);
      return pkg.version || "1.2.520";
    }
  } catch {}
  return "1.2.520";
}

/**
 * Returns a short, stable hash of the current working directory.
 * Used to namespace background tasks per workspace to prevent
 * cross-project task bleeding.
 */
export function getWorkspaceId(dirPath?: string): string {
  const cwd = path.resolve(dirPath || process.cwd());
  return crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

/**
 * Returns the path to background-tasks.json scoped to the current workspace.
 * Each project/CWD gets its own isolated task file under:
 *   ~/.superagent-r/workspaces/<cwd-hash>/background-tasks.json
 */
export function getWorkspaceTasksFilePath(): string {
  const root = getRootConfigDir();
  const wsId = getWorkspaceId();
  const wsDir = path.join(root, "workspaces", wsId);
  if (!fs.existsSync(wsDir)) {
    fs.mkdirSync(wsDir, { recursive: true });
  }
  return path.join(wsDir, "background-tasks.json");
}

/**
 * Returns the directory for task log files scoped to the current workspace.
 * Each project/CWD gets its own isolated log directory under:
 *   ~/.superagent-r/workspaces/<cwd-hash>/tasks/
 * This prevents log files from different projects mixing in a shared directory.
 */
export function getWorkspaceTasksLogDir(): string {
  const root = getRootConfigDir();
  const wsId = getWorkspaceId();
  const logDir = path.join(root, "workspaces", wsId, "tasks");
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

/**
 * Returns the path to the input history file scoped to the current workspace.
 * Stored under ~/.superagent-r/workspaces/<cwd-hash>/input-history.json so that
 * arrow-key command history from project A never pollutes autocomplete in project B.
 */
export function getWorkspaceInputHistoryPath(): string {
  const root = getRootConfigDir();
  const wsId = getWorkspaceId();
  const wsDir = path.join(root, "workspaces", wsId);
  if (!fs.existsSync(wsDir)) {
    fs.mkdirSync(wsDir, { recursive: true });
  }
  return path.join(wsDir, "input-history.json");
}

/**
 * Ensures that a URL has a protocol prefix (http:// or https://).
 * Defaults to http:// for localhost/loopback, and https:// for others.
 */
export function ensureProtocol(url: string | undefined): string | undefined {
  if (!url) return url;
  const trimmed = url.trim();
  if (trimmed === "") return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed;
  }
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(trimmed);
  if (isLocal) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

