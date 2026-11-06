#!/usr/bin/env bun
/** Build a native Windows standalone portable LAN support executable. */
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dir, "..");
const outDir = path.join(root, "artifacts", "lan-client");
mkdirSync(outDir, { recursive: true });
const output = path.join(outDir, "superagent-lan-client.exe");
const build = spawnSync(process.execPath, ["build", "--compile", "--target=bun-windows-x64",
  "src/lanClient.ts", "--outfile", output], {
  cwd: root, stdio: "inherit", timeout: 300_000,
});
if (build.error || build.status !== 0) throw new Error("Standalone LAN client build failed: " + (build.error?.message || String(build.status)));
const size = statSync(output).size;
if (size < 100_000) throw new Error("Invalid Windows executable output.");
console.log("LAN client compiled: " + output + " (" + size + " bytes)");
