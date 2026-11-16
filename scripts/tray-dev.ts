#!/usr/bin/env bun
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dir, "..");
const trayDir = path.join(root, "apps", "superagent-tray");
const cargoBin = path.join(os.homedir(), ".cargo", "bin");

const env = { ...process.env };
if (process.platform === "win32") {
  const currentPath = env.PATH || "";
  if (!currentPath.includes(cargoBin)) {
    env.PATH = `${cargoBin};${currentPath}`;
  }
  try {
    spawnSync("taskkill", ["/F", "/IM", "superagent-tray.exe"], { stdio: "ignore" });
  } catch {}
}

const result = spawnSync(process.execPath, ["x", "@tauri-apps/cli", "dev"], {
  cwd: trayDir,
  stdio: "inherit",
  env,
});

if (result.error) {
  console.error("Failed to run tauri dev:", result.error);
  process.exit(1);
}

process.exit(result.status ?? 0);
