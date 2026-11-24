#!/usr/bin/env bun
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stopRunningTrayBeforeDev } from "../src/core/runtime/trayDevLifecycle.js";

const root = path.resolve(import.meta.dir, "..");
const trayDir = path.join(root, "apps", "superagent-tray");
const cargoBin = path.join(os.homedir(), ".cargo", "bin");

async function main() {
  const env = { ...process.env };
  if (process.platform === "win32") {
    const currentPath = env.PATH || "";
    if (!currentPath.includes(cargoBin)) {
      env.PATH = `${cargoBin};${currentPath}`;
    }
  }

  try {
    const stopped = await stopRunningTrayBeforeDev();
    if (stopped.skipped) {
      console.log("[SuperAgent Tray] Existing-instance replacement is Windows-only; continuing.");
    } else if (stopped.stopped) {
      console.log(`[SuperAgent Tray] Gracefully stopped verified instance (PID ${stopped.pid}).`);
    } else {
      console.log("[SuperAgent Tray] No existing managed instance found.");
    }
  } catch (error) {
    console.error(
      "[SuperAgent Tray] Dev startup blocked; existing Tray state could not be stopped safely:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
    return;
  }

  const result = spawnSync(process.execPath, ["x", "@tauri-apps/cli", "dev"], {
    cwd: trayDir,
    stdio: "inherit",
    env,
  });

  if (result.error) {
    console.error("Failed to run tauri dev:", result.error);
    process.exitCode = 1;
    return;
  }

  process.exit(result.status ?? 1);
}

await main();
