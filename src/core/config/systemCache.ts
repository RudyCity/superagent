import fs from "fs";
import path from "path";
import { getRootConfigDir } from "./paths.js";

export interface SystemCheckCache {
  rg?: boolean;
  curl?: boolean;
  androidCli?: boolean;
  uv?: boolean;
  python?: boolean;
  paddleOcr?: boolean;
  officeCli?: boolean;
  rmemory?: boolean;
  lastChecked?: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getSystemCheckCache(): SystemCheckCache | null {
  try {
    const cacheFile = path.join(getRootConfigDir(), "system-cache.json");
    if (fs.existsSync(cacheFile)) {
      const data: SystemCheckCache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      if (data.lastChecked && Date.now() - data.lastChecked < CACHE_TTL_MS) {
        return data;
      }
    }
  } catch {}
  return null;
}

export function updateSystemCheckCache(updates: Partial<SystemCheckCache>): void {
  try {
    const cacheFile = path.join(getRootConfigDir(), "system-cache.json");
    let current: SystemCheckCache = {};
    if (fs.existsSync(cacheFile)) {
      try {
        current = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      } catch {}
    }
    const merged: SystemCheckCache = {
      ...current,
      ...updates,
      lastChecked: Date.now()
    };
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(merged, null, 2), "utf-8");
  } catch {}
}

export function clearSystemCheckCache(): void {
  try {
    const cacheFile = path.join(getRootConfigDir(), "system-cache.json");
    if (fs.existsSync(cacheFile)) {
      fs.unlinkSync(cacheFile);
    }
  } catch {}
}
