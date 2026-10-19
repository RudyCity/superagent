import { createSkillCandidate, getSkillCandidate } from "./skillLifecycle.js";
import { getSkillStats } from "./skillTracker.js";

export interface GuidedSkillRevisionInput {
  workspace: string;
  name: string;
  version: string;
  feedbackId: string;
}

/**
 * Generate only an inactive, immutable review candidate. This is a guided
 * revision stub, not autonomous code rewriting or skill activation.
 * Untrusted feedback text remains metadata and is never executable guidance.
 */
export async function createGuidedSkillRevision(input: GuidedSkillRevisionInput) {
  if (!/^skill-feedback-[a-f0-9-]{36}$/.test(input.feedbackId)) {
    throw new Error("Revision requires a persisted skill feedback ID.");
  }
  const parent = getSkillCandidate(input.workspace, input.name, input.version);
  if (parent.record.status !== "active" && parent.record.status !== "evaluated") {
    throw new Error("Only active or evaluated skill versions can be revision parents.");
  }
  const metric = getSkillStats(input.workspace)
    .find(item => item.name.toLowerCase() === parent.record.name)
    ?.versionMetrics?.find(item => item.version === parent.record.version);
  const feedback = metric?.feedbackSummaries.find(
    item => item.id === input.feedbackId && item.sentiment === "negative",
  );
  if (!feedback) {
    throw new Error("Negative feedback ID not found for this exact skill version and workspace.");
  }
  const content = parent.markdownContent.trimEnd() +
    "\n\n## Proposed Revision Review\n\n" +
    "- Source feedback ID: `" + input.feedbackId + "`.\n" +
    "- Before activation, reproduce the reported failure in a bounded sandbox.\n" +
    "- Review preconditions, error handling, and verification steps against this evidence.\n" +
    "- Update the workflow deliberately; then complete static evaluation, replay, and explicit owner approval.\n";

  return createSkillCandidate(input.workspace, {
    name: parent.record.name,
    description: parent.record.description,
    category: parent.record.category,
    markdownContent: content,
    extractedPatterns: parent.record.extractedPatterns,
    sourceEvidenceIds: parent.record.sourceEvidenceIds,
    parentVersion: parent.record.version,
    sourceFeedbackId: input.feedbackId,
    metadata: {
      ...(parent.record.metadata ?? {}),
      userFeedback: { sentiment: "negative", summary: feedback.summary },
      knownLimitations: [
        ...(parent.record.metadata?.knownLimitations ?? []).slice(0, 8),
        "Revision requires new evaluation, sandbox replay, and owner approval.",
      ],
    },
  });
}
