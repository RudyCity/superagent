import fs from "fs";
import path from "path";
import os from "os";

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

export function getTrustedPaths(): string[] {
  const filePath = path.join(getRootConfigDir(), "trusted-paths.json");
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    // ignore
  }
  return [];
}

export function isPathTrusted(dir: string): boolean {
  const paths = getTrustedPaths();
  const normalized = path.resolve(dir).toLowerCase();
  return paths.some(p => path.resolve(p).toLowerCase() === normalized);
}

export function addTrustedPath(dir: string): void {
  const filePath = path.join(getRootConfigDir(), "trusted-paths.json");
  try {
    const paths = getTrustedPaths();
    const normalized = path.resolve(dir);
    const normalizedLower = normalized.toLowerCase();
    
    const alreadyExists = paths.some(p => path.resolve(p).toLowerCase() === normalizedLower);
    if (!alreadyExists) {
      paths.push(normalized);
      const configDir = getRootConfigDir();
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(paths, null, 2), "utf-8");
    }
  } catch (err) {
    // ignore
  }
}

