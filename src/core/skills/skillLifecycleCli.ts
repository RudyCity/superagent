import {
  attachSkillCandidateEvidence,
  compareSkillCandidateVersions,
  disableActiveSkill,
  evaluateSkillCandidate,
  getSkillCandidate,
  listSkillCandidates,
  promoteSkillCandidate,
  retireSkillCandidate,
} from "./skillLifecycle.js";

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : undefined;
}
function parseReference(value: string | undefined): { name: string; version: string } {
  if (!value) throw new Error("Expected candidate reference <name>@<version>.");
  const split = value.lastIndexOf("@");
  if (split <= 0 || !/^[a-f0-9]{12}$/.test(value.slice(split + 1))) {
    throw new Error("Candidate reference must be <name>@<12-character-version>.");
  }
  return { name: value.slice(0, split), version: value.slice(split + 1) };
}
async function confirmInTerminal(prompt: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive terminal required. Non-interactive approval is denied.");
  }
  const readline = await import("node:readline/promises");
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(prompt)).trim() === expected; }
  finally { terminal.close(); }
}

export async function handleSkillLifecycleCommand(args: string[]): Promise<boolean> {
  const action = args[0]?.toLowerCase();
  if (!["candidates", "evaluate", "promote", "rollback", "compare", "disable", "retire"].includes(action || "")) return false;
  const workspace = flagValue(args, "--workspace") || process.cwd();
  try {
    if (action === "candidates") {
      const candidates = listSkillCandidates(workspace);
      if (!candidates.length) console.log("No skill candidates found in this workspace.");
      for (const item of candidates) {
        const evaluation = item.evaluations.find(e => e.evaluationId === item.latestEvaluationId);
        console.log("- " + item.name + "@" + item.version + " | " + item.status +
          " | evaluation: " + (evaluation?.status || "not-run") +
          " | evidence: " + item.sourceEvidenceIds.length + " | " + item.description.slice(0, 100));
      }
      return true;
    }
    if (action === "evaluate") {
      const ref = parseReference(args[1]);
      const ids = args.flatMap((v, i) => v === "--evidence-id" && args[i + 1] && !args[i + 1].startsWith("--") ? [args[i + 1]] : []);
      if (ids.length) attachSkillCandidateEvidence(workspace, ref.name, ref.version, ids);
      const result = await evaluateSkillCandidate(workspace, ref.name, ref.version);
      const evaluation = result.record.evaluations.find(e => e.evaluationId === result.record.latestEvaluationId);
      console.log("Candidate: " + ref.name + "@" + ref.version);
      console.log("Evaluation: " + (evaluation?.status || "unknown"));
      for (const check of evaluation?.checks || []) console.log("- [" + check.status.toUpperCase() + "] " + check.id + ": " + check.detail);
      if (evaluation?.status === "passed") console.log("Review the artifact, then run: superagent skill promote " + ref.name + "@" + ref.version);
      else console.log("Not promotable. Attach valid completed-task evidence with --evidence-id and rerun evaluation.");
      return true;
    }
    if (action === "compare") {
      const [name, a, b] = args.slice(1, 4);
      if (!name || !a || !b) throw new Error("Usage: superagent skill compare <name> <versionA> <versionB>");
      const result = compareSkillCandidateVersions(workspace, name, a, b);
      console.log(result.name + ": " + result.versionA + " (" + result.statusA + ") vs " + result.versionB + " (" + result.statusB + ")");
      console.log("Same content: " + result.sameContent + "; lines only in A: " + result.onlyInA.length + "; only in B: " + result.onlyInB.length);
      for (const line of result.onlyInA.slice(0, 20)) console.log("  - " + line);
      for (const line of result.onlyInB.slice(0, 20)) console.log("  + " + line);
      return true;
    }
    if (action === "disable") {
      const name = args[1];
      if (!name || name.includes("@")) throw new Error("Usage: superagent skill disable <active-skill-name>");
      const expected = "disable " + name;
      if (!(await confirmInTerminal("Type exactly '" + expected + "' to disable: ", expected))) {
        console.log("Cancelled; no change made.");
        return true;
      }
      const item = disableActiveSkill(workspace, name, "interactive-cli-owner", "Explicit owner disable.");
      console.log("Disabled " + item.name + "@" + item.version + "; history retained.");
      return true;
    }
    const ref = parseReference(args[1]);
    const candidate = getSkillCandidate(workspace, ref.name, ref.version);
    const evaluation = candidate.record.evaluations.find(e => e.evaluationId === candidate.record.latestEvaluationId);
    if (action === "promote" || action === "rollback") {
      if (!evaluation || evaluation.status !== "passed") throw new Error("Candidate must have a passing latest evaluation before approval.");
      console.log("Review target: " + candidate.filePath);
      console.log("Evaluation: " + evaluation.evaluationId + " (" + evaluation.status + ")");
      console.log("Verified evidence IDs: " + evaluation.verifiedEvidenceIds.length);
      console.log("---- Candidate content for review ----");
      console.log(candidate.markdownContent);
      console.log("---- End candidate content ----");
      const expected = action + " " + ref.name + "@" + ref.version;
      if (!(await confirmInTerminal("Type exactly '" + expected + "' to explicitly approve activation: ", expected))) {
        console.log("Cancelled; candidate remains inactive.");
        return true;
      }
      const promoted = await promoteSkillCandidate(workspace, ref.name, ref.version, {
        approvedBy: "interactive-cli-owner",
        method: "interactive-cli",
        evaluationId: evaluation.evaluationId,
      });
      console.log((action === "rollback" ? "Rollback activated: " : "Promoted: ") + ref.name + "@" + ref.version);
      console.log("Active path: " + promoted.filePath);
      return true;
    }
    if (action === "retire") {
      const reasonIndex = args.indexOf("--reason");
      const reasonParts: string[] = [];
      if (reasonIndex >= 0) {
        for (const value of args.slice(reasonIndex + 1)) {
          if (value.startsWith("--")) break;
          reasonParts.push(value);
        }
      }
      const reason = reasonParts.join(" ").trim();
      if (!reason) throw new Error("Usage: superagent skill retire <name>@<version> --reason <reason>");
      const expected = "retire " + ref.name + "@" + ref.version;
      if (!(await confirmInTerminal("Type exactly '" + expected + "' to retire: ", expected))) {
        console.log("Cancelled; no change made.");
        return true;
      }
      retireSkillCandidate(workspace, ref.name, ref.version, "interactive-cli-owner", reason);
      console.log("Retired " + ref.name + "@" + ref.version + "; history retained.");
      return true;
    }
    return true;
  } catch (error) {
    console.error("Skill lifecycle failed: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
    return true;
  }
}
