/** Normalized outcome explicitly declared by delegated agent reports.
 * Unknown means there is no trustworthy completion claim, not success.
 */
export type DelegationReportOutcome = "completed" | "blocked" | "partial" | "failed" | "cancelled" | "unverified";

export function classifyDelegationReport(report: string): DelegationReportOutcome {
  if (typeof report !== "string" || !report.trim()) return "unverified";
  const statusMatch = report.match(/^\s*(?:[-*]\s*)?(?:\*\*)?Status(?:\*\*)?\s*[:=]\s*(?:\*\*)?([a-z_-]+)/im);
  const status = statusMatch?.[1]?.toLowerCase();
  const failedVerification = /^\s*(?:[-*]\s*)?(?:\*\*)?Verification(?:\*\*)?\s*[:=]\s*(?:\*\*)?(?:false|failed|❌)/im.test(report) ||
    /^\s*(?:[-*]\s*)?(?:\*\*)?Tests(?:\*\*)?\s*[:=]\s*(?:\*\*)?(?:failed|failing)/im.test(report);
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "blocked") return "blocked";
  if (status === "partial" || status === "incomplete") return "partial";
  if (status === "failed" || status === "error") return "failed";
  if (failedVerification) return "failed";
  if (status === "completed" || status === "complete" || status === "success" || status === "succeeded") return "completed";
  return "unverified";
}

export function delegationReportFailed(outcome: DelegationReportOutcome): boolean {
  return outcome === "blocked" || outcome === "partial" || outcome === "failed" || outcome === "cancelled";
}
