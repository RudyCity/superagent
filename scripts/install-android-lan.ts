#!/usr/bin/env bun
/**
 * Safe, one-attempt local ADB installation of a SuperAgent Android development APK.
 * No remote LAN feature or unattended installation capability is exposed.
 *
 * bun scripts/install-android-lan.ts --variant=lite [--serial=SERIAL] [--dry-run] [--force]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { installAndroidApk, type AdbResult, type AdbRunner } from "../src/core/android/adbInstall.js";

const root = path.resolve(import.meta.dir, "..");
function argument(name: string): string | undefined {
  const values = process.argv.slice(2).filter((item) => item.startsWith(name + "="));
  if (values.length > 1) throw new Error("Duplicate argument: " + name);
  return values.length ? values[0].slice(name.length + 1) : undefined;
}
function has(name: string): boolean {
  return process.argv.slice(2).includes(name);
}
async function runCommand(args: readonly string[], timeoutMs: number): Promise<AdbResult> {
  return await new Promise((resolve) => {
    const child = spawn("adb", [...args], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, finished = false;
    const append = (previous: string, chunk: Buffer) =>
      (previous + chunk.toString("utf8")).slice(-32_768);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on("error", (error) => {
      stderr = append(stderr, Buffer.from(error.message));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
async function main() {
  const allowed = new Set(["--dry-run", "--force", "--help"]);
  for (const item of process.argv.slice(2)) {
    if (!allowed.has(item) && !/^--(serial|variant|timeout-ms)=/.test(item))
      throw new Error("Unknown option: " + item);
  }
  if (has("--help")) {
    console.log("Usage: bun scripts/install-android-lan.ts --variant=lite|debug [--serial=DEVICE] [--timeout-ms=120000] [--dry-run] [--force]");
    return;
  }
  const variant = argument("--variant") ?? "lite";
  if (variant !== "lite" && variant !== "debug") throw new Error("Variant must be lite or debug.");
  const outputDir = path.join(root, "apps", "superagent-lan-android", "app", "build", "outputs", "apk", variant);
  const metadataPath = path.join(outputDir, "output-metadata.json");
  if (!existsSync(metadataPath)) throw new Error("Build APK first: " + metadataPath);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
    applicationId?: string;
    variantName?: string;
    elements?: Array<{ outputFile?: string; versionCode?: number; versionName?: string }>;
  };
  const element = metadata.elements?.[0];
  if (metadata.variantName !== variant || !metadata.applicationId ||
      !element?.outputFile || !Number.isInteger(element.versionCode) || !element.versionName)
    throw new Error("Unrecognized Android APK build metadata.");
  const expectedPackage = "click.superagent.lanclient" + (variant === "lite" ? ".lite" : "");
  if (metadata.applicationId !== expectedPackage ||
      !/^app-(lite|debug)\.apk$/.test(element.outputFile))
    throw new Error("Build metadata does not match requested SuperAgent variant.");
  const apkPath = path.join(outputDir, element.outputFile);
  if (!existsSync(apkPath) || statSync(apkPath).size < 100_000)
    throw new Error("APK is missing or unexpectedly small: " + apkPath);
  const timeoutString = argument("--timeout-ms");
  const timeoutMs = timeoutString === undefined ? 120_000 : Number(timeoutString);
  const serial = argument("--serial");
  console.log("Target: " + metadata.applicationId + "@" + element.versionName);
  console.log("Owner action: unlock the device and respond to any Play Protect/ColorOS verification prompts.");
  const outcome = await installAndroidApk({
    apkPath,
    packageName: metadata.applicationId,
    versionCode: element.versionCode!,
    versionName: element.versionName,
    ...(serial ? { serial } : {}),
    timeoutMs,
    force: has("--force"),
    dryRun: has("--dry-run"),
  }, runCommand as AdbRunner);
  console.log(JSON.stringify(outcome, null, 2));
  if (!["installed", "installed-after-timeout", "already-installed", "dry-run"].includes(outcome.status))
    process.exitCode = 1;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
