#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fg from "fast-glob";

const root = process.cwd();
const runDir = path.join(os.tmpdir(), "superagent-test-health-20261014");
const manifestPath = path.join(runDir, "manifest.json");
const resultsPath = path.join(runDir, "results.json");
const args = process.argv.slice(2);
const command = args[0] || "list";

function getArg(name, fallback) {
  const prefix = "--" + name + "=";
  const entry = args.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : fallback;
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function inventory() {
  return fg.sync([
    "tests/**/*.test.ts"
  ], {
    cwd: root,
    onlyFiles: true,
    dot: false,
    ignore: [
      "**/node_modules/**", "**/.git/**", "**/dist/**", "**/coverage/**",
      "**/.turbo/**", "**/.next/**", "**/out/**", "**/release/**",
      "**/.test-results/**", "**/test-results/**"
    ]
  }).sort((a, b) => a.localeCompare(b));
}

function initialize() {
  const size = Number(getArg("size", "10"));
  if (!Number.isInteger(size) || size < 1 || size > 25) throw new Error("Batch size must be 1–25");
  fs.mkdirSync(runDir, { recursive: true });
  const files = inventory();
  const batches = [];
  for (let i = 0; i < files.length; i += size) batches.push(files.slice(i, i + size));
  const manifest = {
    root,
    createdAt: new Date().toISOString(),
    batchSize: size,
    fileCount: files.length,
    files,
    batches
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(resultsPath, JSON.stringify({ startedAt: new Date().toISOString(), batches: {} }, null, 2));
  console.log("Inventory created: " + files.length + " test files, " + batches.length + " batches of up to " + size);
  batches.forEach((batch, index) => {
    console.log(String(index).padStart(3, "0") + " | " + batch.length + " files | " + batch[0] + (batch.length > 1 ? " ... " + batch[batch.length - 1] : ""));
  });
  console.log("Manifest: " + manifestPath);
  console.log("Results: " + resultsPath);
}

function runBatch(batchIndex) {
  const manifest = loadJson(manifestPath, null);
  if (!manifest) throw new Error("Run init first: node scripts/test-health-batches.mjs init");
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= manifest.batches.length) {
    throw new Error("Batch index out of range. Valid range: 0.." + (manifest.batches.length - 1));
  }
  const files = manifest.batches[batchIndex];
  const timeoutMs = Number(getArg("timeout-ms", "85000"));
  const start = Date.now();
  console.log("Running batch " + batchIndex + "/" + (manifest.batches.length - 1) + " (" + files.length + " files)");
  const output = spawnSync("bun", ["x", "vitest", "run", "--reporter=dot", ...files], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
  const combined = (output.stdout || "") + "\n" + (output.stderr || "");
  const clean = stripAnsi(combined);
  const logPath = path.join(runDir, "batch-" + String(batchIndex).padStart(3, "0") + ".log");
  fs.writeFileSync(logPath, combined, "utf8");
  const timedOut = !!output.error && (output.error.code === "ETIMEDOUT" || output.error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  const passed = output.status === 0 && !timedOut;
  const durationMs = Date.now() - start;
  const result = {
    batch: batchIndex,
    files,
    exitCode: output.status,
    signal: output.signal || null,
    timedOut,
    durationMs,
    passed,
    logPath,
    summary: (clean.match(/Test Files[\s\S]{0,240}/g) || []).slice(-1)[0]?.trim() || clean.trim().slice(-900)
  };
  const results = loadJson(resultsPath, { startedAt: new Date().toISOString(), batches: {} });
  results.batches[String(batchIndex)] = result;
  results.updatedAt = new Date().toISOString();
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log((passed ? "PASS " : "FAIL ") + "batch " + batchIndex + " | " + durationMs + " ms | exit " + output.status + (timedOut ? " | TIMEOUT" : ""));
  console.log(result.summary);
  console.log("Log: " + logPath);
  if (!passed) process.exitCode = 1;
}

function summarize() {
  const manifest = loadJson(manifestPath, null);
  const results = loadJson(resultsPath, null);
  if (!manifest || !results) throw new Error("Run init first");
  const completed = Object.values(results.batches || {});
  const passed = completed.filter((item) => item.passed).length;
  const failed = completed.filter((item) => !item.passed).length;
  console.log("Inventory: " + manifest.fileCount + " files across " + manifest.batches.length + " batches");
  console.log("Recorded: " + completed.length + "/" + manifest.batches.length + " | pass: " + passed + " | fail/timeout: " + failed);
  const unrun = manifest.batches.map((_, index) => index).filter((index) => !results.batches[String(index)]);
  if (unrun.length) console.log("Not run: " + unrun.join(", "));
  for (const result of completed.filter((item) => !item.passed).sort((a, b) => a.batch - b.batch)) {
    console.log("FAIL batch " + result.batch + " | exit=" + result.exitCode + " | timeout=" + result.timedOut + " | files: " + result.files.join(", "));
    console.log(result.summary);
  }
}

try {
  if (command === "init" || command === "list") initialize();
  else if (command === "batch") runBatch(Number(args[1]));
  else if (command === "summary") summarize();
  else throw new Error("Use: init [--size=10] | batch <index> [--timeout-ms=85000] | summary");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
