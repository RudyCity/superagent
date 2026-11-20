/**
 * Private, opt-in Core Guardian watchdog entry point.
 * Attach ONLY to an already-supervised Core, never start/take over Core.
 * Authenticated loopback control stops the watchdog, not its Core worker.
 */
import fs from "node:fs";
import path from "node:path";
import { getPackageRootDir } from "../config/paths.js";
import { runCoreGuardian } from "./coreGuardian.js";
import {
  managedGuardianOwnerPath,
  readManagedGuardianOwner,
  startManagedGuardianControlServer,
  type ManagedGuardianOwner,
} from "./managedGuardianServer.js";

export type Owner = ManagedGuardianOwner;
export {
  managedGuardianOwnerPath,
  readManagedGuardianOwner,
  startManagedGuardianControlServer,
  type ManagedGuardianOwner,
};

export async function runManagedGuardianEntry(port: number): Promise<void> {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("MANAGED_GUARDIAN_INVALID_CORE_PORT");
  }
  if (readManagedGuardianOwner(port)) {
    throw new Error("MANAGED_GUARDIAN_ALREADY_REGISTERED");
  }
  const root = getPackageRootDir();
  const source = path.join(root, "src", "cli.tsx"), compiled = path.join(root, "dist", "cli.js");
  const entry = fs.existsSync(source) ? source : compiled;
  if (!fs.existsSync(entry) || fs.lstatSync(entry).isSymbolicLink()) {
    throw new Error("MANAGED_GUARDIAN_TRUSTED_CLI_UNAVAILABLE");
  }

  const controller = new AbortController();
  const result = await runCoreGuardian({
    port,
    adoptRunning: true,
    clientMode: "tline",
    entry,
    signal: controller.signal,
    enableManaged: true,
  });
  if (result.reason !== "stopped") {
    throw new Error("MANAGED_GUARDIAN_START_REFUSED: " + result.reason);
  }
}

if (import.meta.main) {
  const port = Number(process.argv[2]);
  await runManagedGuardianEntry(port);
}
