import { acquireCrossProcessArtifactClaims, releaseCrossProcessArtifactClaims } from "../../src/core/tools/cliBridgeCrossProcessClaims.ts";
import { startDelegateJob, getDelegateJob } from "../../src/core/tools/cliBridgeDelegateJobs.ts";

const [mode, identity, jobId, configDir] = process.argv.slice(2);
async function run() {
  if (mode === "claim") {
    const claims = await acquireCrossProcessArtifactClaims([identity], jobId);
    process.stdout.write("CLAIM " + JSON.stringify(claims) + "\n");
    process.stdin.resume();
    let finished = false;
    process.stdin.on("data", async chunk => {
      if (finished || !String(chunk).includes("release")) return;
      finished = true;
      try {
        await releaseCrossProcessArtifactClaims(claims);
        process.stdout.write("RELEASED\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write(String(err));
        process.exit(1);
      }
    });
    return;
  }

  if (mode === "shared-metadata") {
    if (configDir) process.env.SUPERAGENT_CONFIG_DIR = configDir;
    const workspace = identity;
    const script = 'setTimeout(() => console.log("distinct-writer-finished"), 1100)';
    const job = await startDelegateJob({
      cliAlias: "shared-metadata-test", binary: process.execPath,
      prompt: "Persist independent metadata", cwd: workspace, workspaceRoot: workspace,
      args: ["-e", script], timeoutMs: 6000,
    });
    process.stdout.write("JOB " + JSON.stringify({ jobId: job.jobId }) + "\n");
    while (true) {
      const current = await getDelegateJob(job.jobId);
      if (current && !["starting", "running", "cancelling"].includes(current.status)) {
        process.stdout.write("TERMINAL " + JSON.stringify({
          jobId: current.jobId, status: current.status, proof: current.completionState,
        }) + "\n");
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  if (mode === "delegation") {
    if (configDir) process.env.SUPERAGENT_CONFIG_DIR = configDir;
    const workspace = identity;
    const childScript = 'setTimeout(() => { require("fs").writeFileSync("output.txt", "worker-output"); }, 1900)';
    const job = await startDelegateJob({
      cliAlias: "cross-process-test", binary: process.execPath, prompt: "write expected output",
      cwd: workspace, workspaceRoot: workspace, expectedArtifacts: ["output.txt"],
      args: ["-e", childScript], timeoutMs: 6000,
    });
    process.stdout.write("JOB " + JSON.stringify({ jobId: job.jobId, status: job.status }) + "\n");
    while (true) {
      const record = await getDelegateJob(job.jobId);
      if (record && !["starting", "running", "cancelling"].includes(record.status)) {
        process.stdout.write("TERMINAL " + JSON.stringify({
          status: record.status, completionState: record.completionState,
        }) + "\n");
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return;
  }
  throw new Error("Unknown worker mode");
}
run().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
