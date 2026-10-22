/**
 * Optional real CLI acceptance test. Does not run in CI by default.
 * Runs only in an isolated Brain scratch, never the SuperAgent repository.
 * bun scripts/brain-live-cli-acceptance.ts agy
 * bun scripts/brain-live-cli-acceptance.ts claude
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createBrainSession } from "../src/core/brain/brainWorkspace.js";
import { cliBridgeTool } from "../src/core/tools/cliBridgeTool.js";
import { getDelegateJob } from "../src/core/tools/cliBridgeDelegateJobs.js";
import { promoteBrainDelegation } from "../src/core/brain/brainDelegationArtifacts.js";

const cli = process.argv[2];
if (cli !== "agy" && cli !== "claude") throw new Error("Usage: bun scripts/brain-live-cli-acceptance.ts agy|claude");
const id = "smoke_" + crypto.randomBytes(7).toString("hex");
const brain = createBrainSession("local-cli", id);
const file = "proof-" + cli + ".txt";
console.log("Brain session:", id);
console.log("Isolation:", brain.scratchPath);
const response = String(await cliBridgeTool.execute({
  action: "delegate.start",
  cli,
  prompt: "Write exactly BRAIN_DELEGATE_SMOKE_OK followed by a newline into the file " + file +
    " in your current working directory, which is a temporary scratch directory. Do not modify any other file or project. Then stop.",
  expectedArtifacts: [file],
  skillAutoDetect: false,
  injectArtifacts: false,
  permissionMode: "accept-edits",
  timeoutMs: 60000,
}, brain.scratchPath));
const match = response.match(/Started background CLI delegation:\s*(clj_\d+_[a-f0-9]{8,32})/);
if (!match) throw new Error("CLI Bridge failed to start task: " + response.slice(0, 300));
const jobId = match[1];
console.log("Delegate:", cli, jobId);
let final: Awaited<ReturnType<typeof getDelegateJob>> = null;
const deadline = Date.now() + 65000;
while (Date.now() < deadline) {
  const job = await getDelegateJob(jobId);
  if (job && ["succeeded", "failed", "cancelled", "timed_out"].includes(job.status)) { final = job; break; }
  await Bun.sleep(1000);
}
if (!final) {
  console.log(String(await cliBridgeTool.execute({ action: "delegate.cancel", jobId }, brain.scratchPath)).slice(0, 400));
  throw new Error("CLI task did not terminate within the bounded acceptance window; cancellation requested.");
}
console.log("CLI status:", final.status, "proof:", final.completionState, "exit:", final.exitCode);
if (final.status !== "succeeded" || final.completionState !== "artifacts_verified") {
  throw new Error("Real CLI failed verified-artifact acceptance. Review the job's redacted local logs using delegate.tail.");
}
const promotion = await promoteBrainDelegation("local-cli", id, jobId);
const outputPath = path.join(brain.artifactsPath, path.basename(promotion.filePath));
if (fs.readFileSync(outputPath, "utf8").trim() !== "BRAIN_DELEGATE_SMOKE_OK") {
  throw new Error("CLI produced unexpected proof content.");
}
console.log("PASS:", cli, "verified artifact SHA256:", promotion.sha256, "session:", id);
