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
  const historyDir = path.join(dir, "history");
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }
  const singleDir = path.join(historyDir, "single");
  if (!fs.existsSync(singleDir)) {
    fs.mkdirSync(singleDir, { recursive: true });
  }
  const multiDir = path.join(historyDir, "multi");
  if (!fs.existsSync(multiDir)) {
    fs.mkdirSync(multiDir, { recursive: true });
  }
  const checkpointsDir = path.join(dir, "checkpoints");
  if (!fs.existsSync(checkpointsDir)) {
    fs.mkdirSync(checkpointsDir, { recursive: true });
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

/**
 * Returns a short, stable hash of the current working directory.
 * Used to namespace background tasks per workspace to prevent
 * cross-project task bleeding.
 */
export function getWorkspaceId(): string {
  const cwd = process.cwd();
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
