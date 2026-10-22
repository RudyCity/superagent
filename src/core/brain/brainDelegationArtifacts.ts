/** Compatibility wrapper for selected, SHA-verified CLI Bridge artifact promotion.
 * Use promoteBrainDelegationBatch for all-or-none multi-artifact processing.
 */
import { promoteBrainDelegationBatch } from "./brainArtifactTransaction.js";
import { getDelegateJob } from "../tools/cliBridgeDelegateJobs.js";
export { promoteBrainDelegationBatch, recoverBrainArtifactPromotion } from "./brainArtifactTransaction.js";

export async function promoteBrainDelegation(
  owner: string, sessionId: string, jobId: string,
  outputName?: string, sourcePath?: string,
) {
  // Preserve the old single-output requirement when a caller uses the legacy
  // method without selecting a source: never silently choose an output.
  if (!sourcePath) {
    const job = await getDelegateJob(jobId);
    if (job?.artifactEvidence?.length !== 1) throw new Error("Select an output source for legacy single-artifact promotion.");
  }
  const result = await promoteBrainDelegationBatch(owner, sessionId, jobId, {
    selectedSource: sourcePath, outputName,
  });
  if (result.files.length !== 1) throw new Error("Select an output source for legacy single-artifact promotion.");
  return {
    sessionId, jobId, filePath: result.files[0].filePath,
    sha256: result.files[0].sha256, bytes: result.files[0].bytes,
    sourceVerified: true,
  };
}
