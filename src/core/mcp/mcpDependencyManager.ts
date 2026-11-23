/**
 * mcpDependencyManager.ts — Runtime Dependency Manager for SuperAgent MCP tools and actions.
 *
 * Provides action-level dependency tracking, caching, and probing for external runtimes,
 * native binaries, and Python packages (Sharp, Python, Pillow, PyMuPDF, LibreOffice, rembg,
 * Vision helper, Muse WebSocket, Telegram watcher, Chrome CDP).
 */

import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type DependencyName =
  | "sharp"
  | "python"
  | "pillow"
  | "pymupdf"
  | "libreoffice"
  | "rembg"
  | "vision_helper"
  | "muse_ws"
  | "telegram"
  | "chrome";

export interface DependencyStatus {
  name: DependencyName;
  available: boolean;
  version?: string | null;
  path?: string | null;
  error?: string | null;
  lastChecked: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds TTL
const dependencyCache = new Map<DependencyName, DependencyStatus>();

/** Probes Sharp image engine availability */
async function probeSharp(): Promise<DependencyStatus> {
  const now = Date.now();
  try {
    const sharpModule = await import("sharp").catch(() => null);
    if (sharpModule) {
      return {
        name: "sharp",
        available: true,
        version: (sharpModule as any)?.default?.versions?.vips || "available",
        lastChecked: now,
      };
    }
  } catch (err: any) {
    return { name: "sharp", available: false, error: err?.message || String(err), lastChecked: now };
  }
  return { name: "sharp", available: false, error: "sharp package not installed or native binary missing", lastChecked: now };
}

/** Probes Python 3 and its key packages */
async function probePythonAndPackages(): Promise<Record<"python" | "pillow" | "pymupdf" | "rembg", DependencyStatus>> {
  const now = Date.now();
  const defaults: Record<"python" | "pillow" | "pymupdf" | "rembg", DependencyStatus> = {
    python: { name: "python", available: false, lastChecked: now, error: "Python executable not found" },
    pillow: { name: "pillow", available: false, lastChecked: now, error: "Python not available" },
    pymupdf: { name: "pymupdf", available: false, lastChecked: now, error: "Python not available" },
    rembg: { name: "rembg", available: false, lastChecked: now, error: "Python not available" },
  };

  try {
    const probe = await execa(
      "python",
      [
        "-c",
        "import importlib.util,json,sys;print(json.dumps({'version':sys.version.split()[0],'packages':{k:bool(importlib.util.find_spec(v)) for k,v in {'rembg':'rembg','pillow':'PIL','pymupdf':'fitz'}.items()}}))",
      ],
      { reject: false, timeout: 3000, windowsHide: true }
    );

    if (probe.exitCode === 0 && probe.stdout) {
      const data = JSON.parse(probe.stdout);
      defaults.python = { name: "python", available: true, version: data.version, lastChecked: now };
      defaults.pillow = {
        name: "pillow",
        available: Boolean(data.packages?.pillow),
        lastChecked: now,
        error: data.packages?.pillow ? null : "Pillow (PIL) Python module missing",
      };
      defaults.pymupdf = {
        name: "pymupdf",
        available: Boolean(data.packages?.pymupdf),
        lastChecked: now,
        error: data.packages?.pymupdf ? null : "PyMuPDF (fitz) Python module missing",
      };
      defaults.rembg = {
        name: "rembg",
        available: Boolean(data.packages?.rembg),
        lastChecked: now,
        error: data.packages?.rembg ? null : "rembg Python module missing",
      };
    }
  } catch (err: any) {
    defaults.python.error = err?.message || String(err);
  }

  return defaults;
}

/** Probes LibreOffice (soffice) */
async function probeLibreOffice(): Promise<DependencyStatus> {
  const now = Date.now();
  const binary = process.platform === "win32" ? "soffice.exe" : "soffice";
  try {
    const probe = await execa(binary, ["--version"], { reject: false, timeout: 3000, windowsHide: true });
    if (probe.exitCode === 0) {
      return {
        name: "libreoffice",
        available: true,
        version: (probe.stdout || "available").trim().split("\n")[0],
        lastChecked: now,
      };
    }
  } catch {}

  // Common Windows install locations
  if (process.platform === "win32") {
    const standardPaths = [
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    ];
    for (const p of standardPaths) {
      try {
        await fs.access(p);
        return { name: "libreoffice", available: true, path: p, lastChecked: now };
      } catch {}
    }
  }

  return { name: "libreoffice", available: false, error: "LibreOffice (soffice) binary not found", lastChecked: now };
}

/** Probes Vision helper (RacineAI / UI-DETR-1) */
async function probeVisionHelper(): Promise<DependencyStatus> {
  const now = Date.now();
  const scriptPath = path.resolve(process.cwd(), "scripts/vision_server.py");
  try {
    await fs.access(scriptPath);
    // Script exists, check if port 8998 or vision service is listening or python available
    return { name: "vision_helper", available: true, path: scriptPath, lastChecked: now };
  } catch {
    return { name: "vision_helper", available: false, error: "scripts/vision_server.py missing", lastChecked: now };
  }
}

/** Probes Muse WebSocket */
async function probeMuseWs(): Promise<DependencyStatus> {
  const now = Date.now();
  // Check if port 9223 or configured port is reachable or configured
  try {
    const res = await fetch("http://127.0.0.1:9223/status", {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    }).catch(() => null);
    if (res && res.status < 500) {
      return { name: "muse_ws", available: true, lastChecked: now };
    }
  } catch {}
  return { name: "muse_ws", available: false, error: "Muse WebSocket listener not responding on port 9223", lastChecked: now };
}

/** Probes Telegram watcher */
async function probeTelegram(): Promise<DependencyStatus> {
  const now = Date.now();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token && token.length > 10) {
    return { name: "telegram", available: true, lastChecked: now };
  }
  return { name: "telegram", available: false, error: "TELEGRAM_BOT_TOKEN environment variable not set", lastChecked: now };
}

/** Probes Chrome CDP port 9222 */
async function probeChromeCdp(): Promise<DependencyStatus> {
  const now = Date.now();
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version", {
      signal: AbortSignal.timeout(1200),
      redirect: "error",
    }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      return {
        name: "chrome",
        available: true,
        version: data?.Browser || "Chrome CDP available",
        lastChecked: now,
      };
    }
  } catch {}
  return { name: "chrome", available: false, error: "Chrome CDP not reachable on port 9222", lastChecked: now };
}

/** Checks a single dependency with cache support */
export async function checkDependency(name: DependencyName, forceRefresh = false): Promise<DependencyStatus> {
  const cached = dependencyCache.get(name);
  if (!forceRefresh && cached && Date.now() - cached.lastChecked < CACHE_TTL_MS) {
    return cached;
  }

  let status: DependencyStatus;
  switch (name) {
    case "sharp":
      status = await probeSharp();
      break;
    case "python":
    case "pillow":
    case "pymupdf":
    case "rembg": {
      const all = await probePythonAndPackages();
      for (const [k, v] of Object.entries(all)) {
        dependencyCache.set(k as DependencyName, v);
      }
      return all[name];
    }
    case "libreoffice":
      status = await probeLibreOffice();
      break;
    case "vision_helper":
      status = await probeVisionHelper();
      break;
    case "muse_ws":
      status = await probeMuseWs();
      break;
    case "telegram":
      status = await probeTelegram();
      break;
    case "chrome":
      status = await probeChromeCdp();
      break;
    default:
      status = { name, available: false, error: `Unknown dependency: ${name}`, lastChecked: Date.now() };
  }

  dependencyCache.set(name, status);
  return status;
}

/** Checks an array of dependencies and returns missing ones */
export async function checkDependencies(names: string[]): Promise<{
  allSatisfied: boolean;
  available: string[];
  missing: Array<{ name: string; error?: string | null; remediation?: string }>;
}> {
  const available: string[] = [];
  const missing: Array<{ name: string; error?: string | null; remediation?: string }> = [];

  for (const rawName of names) {
    const depName = rawName.toLowerCase() as DependencyName;
    const res = await checkDependency(depName);
    if (res.available) {
      available.push(rawName);
    } else {
      missing.push({
        name: rawName,
        error: res.error,
        remediation: getDependencyRemediation(depName),
      });
    }
  }

  return {
    allSatisfied: missing.length === 0,
    available,
    missing,
  };
}

export function getDependencyRemediation(dep: DependencyName): string {
  switch (dep) {
    case "sharp":
      return "Install sharp via 'bun add sharp' or ensure native vips binaries are present.";
    case "python":
      return "Install Python 3.10+ and ensure 'python' is accessible on your system PATH.";
    case "pillow":
      return "Install Pillow via 'pip install Pillow'.";
    case "pymupdf":
      return "Install PyMuPDF via 'pip install pymupdf'.";
    case "rembg":
      return "Install rembg and download u2net models via 'pip install rembg'.";
    case "libreoffice":
      return "Install LibreOffice (soffice) from https://www.libreoffice.org and ensure soffice is on PATH.";
    case "vision_helper":
      return "Ensure scripts/vision_server.py is present and PyTorch dependencies are installed.";
    case "muse_ws":
      return "Start Muse WebSocket listener on port 9223 before dispatching Muse agent commands.";
    case "telegram":
      return "Configure TELEGRAM_BOT_TOKEN in environment or .env file.";
    case "chrome":
      return "Start Chrome with remote debugging: chrome.exe --remote-debugging-port=9222.";
    default:
      return `Install or configure prerequisite ${dep}.`;
  }
}
