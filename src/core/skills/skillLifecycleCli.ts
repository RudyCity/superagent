import fs from "node:fs";
import path from "node:path";
import {
  attachSkillCandidateEvidence,
  compareSkillCandidateVersions,
  disableActiveSkill,
  evaluateSkillCandidate,
  getSkillCandidate,
  listSkillCandidates,
  promoteSkillCandidate,
  replaySkillCandidate,
  retireSkillCandidate,
  type SkillReplayFixture,
} from "./skillLifecycle.js";
import { createSkillReplayAgentExecutor } from "./skillReplayAgent.js";
import { compareSkillVersionEffectiveness, recordSkillFeedback } from "./skillTracker.js";

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
export function loadSkillReplayFixture(workspace: string, relativeFixturePath: string): SkillReplayFixture {
  if (!relativeFixturePath || relativeFixturePath.length > 240 || path.isAbsolute(relativeFixturePath) ||
      /^[a-z]:/i.test(relativeFixturePath) || relativeFixturePath.includes("\0")) {
    throw new Error("Replay fixture must be a short relative JSON path within the workspace.");
  }
  const normalized = relativeFixturePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new Error("Replay fixture path contains an unsupported path segment.");
  }
  const root = fs.realpathSync(workspace);
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("Replay fixture path refuses symbolic links.");
  }
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Replay fixture must resolve to a file inside the workspace.");
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 500_000 || path.extname(target).toLowerCase() !== ".json") {
    throw new Error("Replay fixture must be a regular .json file no larger than 500 KB.");
  }
  try {
    return JSON.parse(fs.readFileSync(target, "utf8")) as SkillReplayFixture;
  } catch {
    throw new Error("Replay fixture is not valid JSON.");
  }
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
  if (!["candidates", "evaluate", "replay", "promote", "rollback", "compare", "disable", "retire", "feedback", "revise"].includes(action || "")) return false;
  const workspace = flagValue(args, "--workspace") || process.cwd();
  try {
    if (action === "candidates") {
      const candidates = listSkillCandidates(workspace);
      if (!candidates.length) console.log("No skill candidates found in this workspace.");
      for (const item of candidates) {
        const evaluation = item.evaluations.find(e => e.evaluationId === item.latestEvaluationId);
        const replay = (item.replayRuns || []).filter(run => run.skillVersion === item.version).slice(-1)[0];
        console.log("- " + item.name + "@" + item.version + " | " + item.status +
          " | evaluation: " + (evaluation?.status || "not-run") +
          " | replay: " + (replay?.status || "not-run") +
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
    if (action === "replay") {
      const ref = parseReference(args[1]);
      const fixturePath = flagValue(args, "--fixture");
      if (!fixturePath) throw new Error("Usage: superagent skill replay <name>@<12-char-version> --fixture <relative.json> --workspace <path> [--timeout-ms 120000]");
      const fixture = loadSkillReplayFixture(workspace, fixturePath);
      const rawTimeout = flagValue(args, "--timeout-ms");
      const timeoutMs = rawTimeout === undefined ? 120_000 : Number(rawTimeout);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
        throw new Error("--timeout-ms must be an integer from 1000 to 600000 (10 minutes).");
      }

      const initial = await evaluateSkillCandidate(workspace, ref.name, ref.version);
      const initialEvaluation = initial.record.evaluations.find(item => item.evaluationId === initial.record.latestEvaluationId);
      console.log("Pre-replay static evaluation: " + (initialEvaluation?.status || "unknown"));
      for (const check of initialEvaluation?.checks || []) {
        console.log("- [" + check.status.toUpperCase() + "] " + check.id + ": " + check.detail);
      }
      const staticFailures = (initialEvaluation?.checks || [])
        .filter(check => check.id !== "sandboxed-replay" && check.status === "fail");
      if (!initialEvaluation || staticFailures.length > 0) {
        throw new Error("Model replay is blocked until static evaluation and verified task evidence pass. Fix the candidate/evidence and evaluate again. Failed checks: " +
          staticFailures.map(check => check.id).slice(0, 8).join(", "));
      }

      const result = await replaySkillCandidate(workspace, ref.name, ref.version, fixture, createSkillReplayAgentExecutor(), {
        timeoutMs,
        actor: "superagent-model-replay",
      });
      console.log("Replay: " + result.status + " | run=" + result.runId + " | version=" + result.skillVersion);
      console.log("Fixture: " + result.fixtureId + " | sha256=" + result.fixtureSha256 + " | duration-ms=" + result.durationMs);
      if (result.error) console.log("Executor error: " + result.error);
      for (const check of result.checks) {
        console.log("- [" + check.status.toUpperCase() + "] " + check.action + ": " + check.detail);
      }
      const refreshed = getSkillCandidate(workspace, ref.name, ref.version);
      const finalEvaluation = refreshed.record.evaluations.find(item => item.evaluationId === refreshed.record.latestEvaluationId);
      console.log("Evaluation after replay: " + (finalEvaluation?.status || "unknown"));
      if (result.status !== "passed" || finalEvaluation?.status !== "passed") {
        process.exitCode = 1;
        console.log("Candidate remains ineligible for activation; inspect the fixture/output and refine this immutable version or create a new one.");
      } else {
        console.log("Replay passed. Explicit owner approval is still required before activation.");
      }
      return true;
    }
    if (action === "feedback") {
      const ref = parseReference(args[1]);
      const sentiment = args[2];
      if (!["positive", "negative", "neutral"].includes(String(sentiment))) {
        throw new Error("Usage: superagent skill feedback <name>@<version> <positive|negative|neutral> --summary <text>");
      }
      const summaryIndex = args.indexOf("--summary");
      const summaryParts: string[] = [];
      if (summaryIndex >= 0) {
        for (const value of args.slice(summaryIndex + 1)) {
          if (value.startsWith("--")) break;
          summaryParts.push(value);
        }
      }
      const summary = summaryParts.join(" ").trim();
      if (!summary) throw new Error("Feedback requires a non-empty --summary value.");
      const existing = getSkillCandidate(workspace, ref.name, ref.version);
      const feedbackId = recordSkillFeedback(ref.name, sentiment as "positive" | "negative" | "neutral", summary, {
        version: ref.version,
        taskId: existing.record.metadata?.taskId,
        executionMode: existing.record.metadata?.executionMode,
        provider: existing.record.metadata?.provider,
        model: existing.record.metadata?.model,
        workspace,
      });
      console.log("Recorded " + sentiment + " feedback for " + ref.name + "@" + ref.version + ". Feedback does not change evaluation or activation state.");
      if (sentiment === "negative" && feedbackId) {
        try {
          const { bridgeNegativeSkillFeedback } = await import("./skillLearningBridge.js");
          const advisory = await bridgeNegativeSkillFeedback({
            skillName: ref.name, skillVersion: ref.version, workspacePath: workspace, feedbackId,
          });
          if (advisory.status === "created") {
            console.log("Created a quarantined, owner-review-only RMemory advisory linked to feedback ID " + feedbackId + ".");
          }
        } catch {
          console.log("RMemory learning advisory unavailable; feedback remains recorded in versioned metrics.");
        }
      }
      return true;
    }
    if (action === "revise") {
      const ref = parseReference(args[1]);
      const feedbackId = flagValue(args, "--feedback-id");
      if (!feedbackId) {
        throw new Error("Usage: superagent skill revise <name>@<version> --feedback-id <persisted-negative-feedback-id> [--workspace <path>]");
      }
      const { createGuidedSkillRevision } = await import("./skillRevision.js");
      const revision = await createGuidedSkillRevision({
        workspace, name: ref.name, version: ref.version, feedbackId,
      });
      console.log("Created inactive revision candidate: " + revision.record.name + "@" + revision.record.version);
      console.log("Parent: " + revision.record.name + "@" + revision.record.parentVersion);
      console.log("Feedback evidence ID: " + revision.record.sourceFeedbackId);
      console.log("Path: " + revision.filePath);
      console.log("Review/edit the candidate, evaluate it, replay in sandbox, then seek explicit owner approval.");
      return true;
    }
    if (action === "compare") {
      const [name, a, b] = args.slice(1, 4);
      if (!name || !a || !b) throw new Error("Usage: superagent skill compare <name> <versionA> <versionB>");
      const result = compareSkillCandidateVersions(workspace, name, a, b);
      console.log(result.name + ": " + result.versionA + " (" + result.statusA + ") vs " + result.versionB + " (" + result.statusB + ")");
      console.log("Same content: " + result.sameContent + "; lines only in A: " + result.onlyInA.length + "; only in B: " + result.onlyInB.length);
      const effectiveness = compareSkillVersionEffectiveness(result.name, a, b, workspace);
      console.log("Effectiveness confidence: " + effectiveness.confidence);
      if (effectiveness.versionA && effectiveness.versionB) {
        const formatRate = (rate: number | null) => rate === null ? "n/a" : (rate * 100).toFixed(1) + "%";
        console.log("Version A: runs=" + effectiveness.versionA.completedRuns + "/" + effectiveness.versionA.invocations +
          "; success=" + formatRate(effectiveness.versionA.successRate) +
          "; avg-duration-ms=" + (effectiveness.versionA.averageDurationMs === null ? "n/a" : Math.round(effectiveness.versionA.averageDurationMs)) +
          "; validation=" + formatRate(effectiveness.versionA.validationPassRate) +
          "; retries=" + effectiveness.versionA.retryCount +
          "; feedback +/−/~=" + effectiveness.versionA.positiveFeedback + "/" + effectiveness.versionA.negativeFeedback + "/" + effectiveness.versionA.neutralFeedback);
        console.log("Version B: runs=" + effectiveness.versionB.completedRuns + "/" + effectiveness.versionB.invocations +
          "; success=" + formatRate(effectiveness.versionB.successRate) +
          "; avg-duration-ms=" + (effectiveness.versionB.averageDurationMs === null ? "n/a" : Math.round(effectiveness.versionB.averageDurationMs)) +
          "; validation=" + formatRate(effectiveness.versionB.validationPassRate) +
          "; retries=" + effectiveness.versionB.retryCount +
          "; feedback +/−/~=" + effectiveness.versionB.positiveFeedback + "/" + effectiveness.versionB.negativeFeedback + "/" + effectiveness.versionB.neutralFeedback);
      }
      for (const note of effectiveness.notes) console.log("Note: " + note);
      for (const regression of effectiveness.regressions) console.log("Potential regression: " + regression);
      for (const improvement of effectiveness.improvements) console.log("Potential improvement: " + improvement);
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
