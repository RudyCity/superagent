import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "node:crypto";
import { getInstalledSkills } from "../config/skills.js";
import { getRootConfigDir, getWorkspaceId } from "../config/paths.js";
import { listSynthesizedSkills } from "./skillSynthesizer.js";

export type SkillExecutionMode = "single" | "multi" | "interactive" | "background" | "unknown";
export type SkillFeedbackSentiment = "positive" | "negative" | "neutral";

export interface SkillTrackingContext {
  /** SHA-256 prefix of the exact skill markdown used for this run. */
  version?: string;
  provider?: string;
  model?: string;
  executionMode?: SkillExecutionMode;
  taskId?: string;
  retryCount?: number;
  /** Metrics are isolated by canonical workspace hash. */
  workspace?: string;
}

export interface SkillVersionMetric {
  version: string;
  executionCount: number;
  successfulRuns: number;
  failedRuns: number;
  totalDurationMs: number;
  retryCount: number;
  validationRuns: number;
  validationPassed: number;
  validationFailed: number;
  positiveFeedback: number;
  negativeFeedback: number;
  neutralFeedback: number;
  feedbackSummaries: Array<{ id?: string; sentiment: SkillFeedbackSentiment; summary: string; at: number }>;
  lastOutcome?: "succeeded" | "failed";
  lastUsed?: number;
  lastProvider?: string;
  lastModel?: string;
  lastExecutionMode?: SkillExecutionMode;
  taskIds?: string[];
}

export interface SkillStatItem {
  name: string;
  type: "installed" | "synthesized";
  category?: string;
  executionCount: number;
  lastUsed?: number;
  lastSynthesized?: number;
  successfulRuns?: number;
  failedRuns?: number;
  totalDurationMs?: number;
  lastOutcome?: "succeeded" | "failed";
  versionMetrics?: SkillVersionMetric[];
  path?: string;
  description: string;
}

interface PersistedSkillMetric {
  executionCount: number;
  lastUsed?: number;
  lastSynthesized?: number;
  successfulRuns?: number;
  failedRuns?: number;
  totalDurationMs?: number;
  lastOutcome?: "succeeded" | "failed";
  versions?: Record<string, SkillVersionMetric>;
}
interface PersistedSkillStats { skills: Record<string, PersistedSkillMetric> }

const MAX_FEEDBACK_SUMMARIES = 20;
const MAX_TASK_IDS = 20;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

function getStatsFilePath(workspace: string = process.cwd()): string {
  return path.join(getRootConfigDir(), "workspaces", getWorkspaceId(workspace), "skill-stats.json");
}
function readPersistedStats(workspace: string = process.cwd()): PersistedSkillStats {
  const filePath = getStatsFilePath(workspace);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PersistedSkillStats;
      if (parsed && parsed.skills && typeof parsed.skills === "object" && !Array.isArray(parsed.skills)) return parsed;
    }
  } catch {}
  return { skills: {} };
}
function savePersistedStats(data: PersistedSkillStats, workspace: string = process.cwd()): void {
  const filePath = getStatsFilePath(workspace);
  const tempPath = filePath + "." + process.pid + ".tmp";
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
    try {
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EEXIST" || code === "EPERM")) {
        fs.rmSync(filePath, { force: true });
        fs.renameSync(tempPath, filePath);
      } else throw error;
    }
  } catch {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
  }
}
function normalizedName(skillName: string): string {
  return typeof skillName === "string" ? skillName.trim().toLowerCase().slice(0, 120) : "";
}
function versionKey(version?: string): string {
  return typeof version === "string" && /^[a-f0-9]{12}$/.test(version) ? version : "unversioned";
}
function safeLabel(value: unknown, limit = 100): string | undefined {
  if (typeof value !== "string") return undefined;
  let result = value.replace(/[\r\n\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  const patterns = [
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi,
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi,
  ];
  for (const pattern of patterns) result = result.replace(pattern, "[REDACTED]");
  return result || undefined;
}
function safeFeedbackSummary(value: string): string | undefined {
  return safeLabel(value, 400);
}
function getVersionMetric(entry: PersistedSkillMetric, context: SkillTrackingContext = {}): SkillVersionMetric {
  const key = versionKey(context.version);
  entry.versions ??= {};
  const existing = entry.versions[key];
  if (existing) {
    existing.feedbackSummaries ??= [];
    existing.taskIds ??= [];
    return existing;
  }
  const created: SkillVersionMetric = {
    version: key,
    executionCount: 0, successfulRuns: 0, failedRuns: 0, totalDurationMs: 0, retryCount: 0,
    validationRuns: 0, validationPassed: 0, validationFailed: 0,
    positiveFeedback: 0, negativeFeedback: 0, neutralFeedback: 0,
    feedbackSummaries: [], taskIds: [],
  };
  entry.versions[key] = created;
  return created;
}
function applyContext(metric: SkillVersionMetric, context: SkillTrackingContext): void {
  const provider = safeLabel(context.provider, 80);
  const model = safeLabel(context.model, 100);
  if (provider) metric.lastProvider = provider;
  if (model) metric.lastModel = model;
  if (context.executionMode && ["single", "multi", "interactive", "background", "unknown"].includes(context.executionMode)) {
    metric.lastExecutionMode = context.executionMode;
  }
  const taskId = safeLabel(context.taskId, 120);
  if (taskId) {
    const ids = metric.taskIds ?? (metric.taskIds = []);
    if (!ids.includes(taskId)) ids.push(taskId);
    metric.taskIds = ids.slice(-MAX_TASK_IDS);
  }
}

/** SHA-256 prefix used to correlate stats with the exact immutable markdown version. */
export function getSkillVersionId(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
}

export function recordSkillExecution(skillName: string, context: SkillTrackingContext = {}): void {
  const normalized = normalizedName(skillName);
  if (!normalized) return;
  const workspace = context.workspace || process.cwd();
  const data = readPersistedStats(workspace);
  const existing = data.skills[normalized] || { executionCount: 0 };
  existing.executionCount = (existing.executionCount || 0) + 1;
  existing.lastUsed = Date.now();
  const version = getVersionMetric(existing, context);
  version.executionCount++;
  version.lastUsed = existing.lastUsed;
  version.retryCount += Math.max(0, Math.min(100, Math.floor(context.retryCount || 0)));
  applyContext(version, context);
  data.skills[normalized] = existing;
  savePersistedStats(data, workspace);
}

export function recordSkillOutcome(
  skillName: string,
  outcome: "succeeded" | "failed",
  durationMs: number,
  context: SkillTrackingContext = {}
): void {
  const normalized = normalizedName(skillName);
  if (!normalized) return;
  const workspace = context.workspace || process.cwd();
  const data = readPersistedStats(workspace);
  const existing = data.skills[normalized] || { executionCount: 0 };
  if (outcome === "succeeded") existing.successfulRuns = (existing.successfulRuns || 0) + 1;
  else existing.failedRuns = (existing.failedRuns || 0) + 1;
  existing.totalDurationMs = (existing.totalDurationMs || 0) + Math.max(0, Math.min(MAX_DURATION_MS, Math.floor(durationMs) || 0));
  existing.lastOutcome = outcome;
  const version = getVersionMetric(existing, context);
  if (outcome === "succeeded") version.successfulRuns++;
  else version.failedRuns++;
  version.totalDurationMs += Math.max(0, Math.min(MAX_DURATION_MS, Math.floor(durationMs) || 0));
  version.lastOutcome = outcome;
  version.lastUsed = existing.lastUsed ?? Date.now();
  applyContext(version, context);
  data.skills[normalized] = existing;
  savePersistedStats(data, workspace);
}

/** Record independent validation results against the exact skill version. */
export function recordSkillValidation(skillName: string, versionId: string, passed: boolean, context: Omit<SkillTrackingContext, "version"> = {}): void {
  const normalized = normalizedName(skillName);
  if (!normalized) return;
  const workspace = context.workspace || process.cwd();
  const data = readPersistedStats(workspace);
  const existing = data.skills[normalized] || { executionCount: 0 };
  const version = getVersionMetric(existing, { ...context, version: versionId });
  version.validationRuns++;
  if (passed) version.validationPassed++;
  else version.validationFailed++;
  applyContext(version, { ...context, version: versionId });
  data.skills[normalized] = existing;
  savePersistedStats(data, workspace);
}

/** Explicit user feedback is bounded, redacted, and never changes activation/approval state. */
export function recordSkillFeedback(
  skillName: string,
  sentiment: SkillFeedbackSentiment,
  summary: string,
  context: SkillTrackingContext = {}
): string | undefined {
  const normalized = normalizedName(skillName);
  if (!normalized || !["positive", "negative", "neutral"].includes(sentiment)) return;
  const cleanSummary = safeFeedbackSummary(summary);
  if (!cleanSummary) return;
  const workspace = context.workspace || process.cwd();
  const data = readPersistedStats(workspace);
  const existing = data.skills[normalized] || { executionCount: 0 };
  const version = getVersionMetric(existing, context);
  if (sentiment === "positive") version.positiveFeedback++;
  else if (sentiment === "negative") version.negativeFeedback++;
  else version.neutralFeedback++;
  const feedbackId = "skill-feedback-" + randomUUID();
  version.feedbackSummaries = [...version.feedbackSummaries, { id: feedbackId, sentiment, summary: cleanSummary, at: Date.now() }].slice(-MAX_FEEDBACK_SUMMARIES);
  applyContext(version, context);
  data.skills[normalized] = existing;
  savePersistedStats(data, workspace);
  // The legacy stats writer intentionally does not throw. Do not issue an
  // evidence ID unless the exact feedback entry can be read back from disk.
  const persisted = readPersistedStats(workspace).skills[normalized]?.versions?.[versionKey(context.version)];
  return persisted?.feedbackSummaries.some(item => item.id === feedbackId) ? feedbackId : undefined;
}

export function recordSkillSynthesized(skillName: string, versionId?: string, workspace: string = process.cwd()): void {
  const normalized = normalizedName(skillName);
  if (!normalized) return;
  const data = readPersistedStats(workspace);
  const existing = data.skills[normalized] || { executionCount: 0 };
  existing.lastSynthesized = Date.now();
  if (versionId) getVersionMetric(existing, { version: versionId });
  data.skills[normalized] = existing;
  savePersistedStats(data, workspace);
}

export function getSkillStats(workspace: string = process.cwd()): SkillStatItem[] {
  const persisted = readPersistedStats(workspace);
  const results: Map<string, SkillStatItem> = new Map();

  try {
    const installed = getInstalledSkills();
    for (const skill of installed) {
      const entry = persisted.skills[skill.name.toLowerCase()];
      results.set(skill.name.toLowerCase(), {
        name: skill.name, type: "installed", category: skill.category || "standard",
        executionCount: entry?.executionCount || 0, lastUsed: entry?.lastUsed, lastSynthesized: entry?.lastSynthesized,
        path: skill.path, description: skill.description || "",
      });
    }
  } catch {}

  try {
    const synthesized = listSynthesizedSkills(workspace);
    for (const skill of synthesized) {
      const key = skill.name.toLowerCase();
      const entry = persisted.skills[key];
      const existing = results.get(key);
      if (existing) {
        existing.type = "synthesized"; existing.path = skill.path; existing.description = skill.description;
        existing.lastSynthesized = entry?.lastSynthesized || skill.createdAt;
      } else {
        results.set(key, {
          name: skill.name, type: "synthesized", category: "custom",
          executionCount: entry?.executionCount || 0, lastUsed: entry?.lastUsed,
          lastSynthesized: entry?.lastSynthesized || skill.createdAt, path: skill.path, description: skill.description,
        });
      }
    }
  } catch {}

  for (const [key, entry] of Object.entries(persisted.skills)) {
    if (!results.has(key)) {
      results.set(key, {
        name: key, type: "synthesized", category: "custom", executionCount: entry.executionCount || 0,
        lastUsed: entry.lastUsed, lastSynthesized: entry.lastSynthesized, description: "Recorded skill",
      });
    }
  }

  for (const item of results.values()) {
    const entry = persisted.skills[item.name.toLowerCase()];
    item.successfulRuns = entry?.successfulRuns || 0;
    item.failedRuns = entry?.failedRuns || 0;
    item.totalDurationMs = entry?.totalDurationMs || 0;
    item.lastOutcome = entry?.lastOutcome;
    item.versionMetrics = Object.values(entry?.versions || {}).sort((a, b) => b.executionCount - a.executionCount || a.version.localeCompare(b.version));
  }

  return Array.from(results.values()).sort((a, b) => {
    if (b.executionCount !== a.executionCount) return b.executionCount - a.executionCount;
    return a.name.localeCompare(b.name);
  });
}

export interface SkillVersionEffectivenessSummary {
  version: string;
  invocations: number;
  completedRuns: number;
  successRate: number | null;
  averageDurationMs: number | null;
  retryCount: number;
  validationRuns: number;
  validationPassRate: number | null;
  positiveFeedback: number;
  negativeFeedback: number;
  neutralFeedback: number;
}

export interface SkillVersionEffectivenessComparison {
  skillName: string;
  versionA: SkillVersionEffectivenessSummary | null;
  versionB: SkillVersionEffectivenessSummary | null;
  confidence: "insufficient-data" | "comparable";
  regressions: string[];
  improvements: string[];
  notes: string[];
}

function summarizeVersionMetric(metric?: SkillVersionMetric): SkillVersionEffectivenessSummary | null {
  if (!metric) return null;
  const completedRuns = metric.successfulRuns + metric.failedRuns;
  return {
    version: metric.version,
    invocations: metric.executionCount,
    completedRuns,
    successRate: completedRuns > 0 ? metric.successfulRuns / completedRuns : null,
    averageDurationMs: completedRuns > 0 ? metric.totalDurationMs / completedRuns : null,
    retryCount: metric.retryCount,
    validationRuns: metric.validationRuns,
    validationPassRate: metric.validationRuns > 0 ? metric.validationPassed / metric.validationRuns : null,
    positiveFeedback: metric.positiveFeedback,
    negativeFeedback: metric.negativeFeedback,
    neutralFeedback: metric.neutralFeedback,
  };
}

/**
 * Conservative, descriptive comparison of two immutable skill versions.
 * It reports possible regressions only when both versions have at least three
 * completed runs; small samples remain explicitly inconclusive.
 */
export function compareSkillVersionEffectiveness(
  skillName: string,
  versionA: string,
  versionB: string,
  workspace: string = process.cwd(),
): SkillVersionEffectivenessComparison {
  const normalized = normalizedName(skillName);
  const item = getSkillStats(workspace).find(skill => skill.name.toLowerCase() === normalized);
  const metricA = item?.versionMetrics?.find(metric => metric.version === versionKey(versionA));
  const metricB = item?.versionMetrics?.find(metric => metric.version === versionKey(versionB));
  const a = summarizeVersionMetric(metricA);
  const b = summarizeVersionMetric(metricB);
  const regressions: string[] = [];
  const improvements: string[] = [];
  const notes: string[] = [];

  if (!a || !b) {
    notes.push("One or both versions have no persisted metrics; no effectiveness conclusion is possible.");
    return { skillName: normalized, versionA: a, versionB: b, confidence: "insufficient-data", regressions, improvements, notes };
  }
  if (a.completedRuns < 3 || b.completedRuns < 3) {
    notes.push("Fewer than three completed runs for at least one version; comparisons are descriptive only.");
    return { skillName: normalized, versionA: a, versionB: b, confidence: "insufficient-data", regressions, improvements, notes };
  }

  if (a.successRate !== null && b.successRate !== null) {
    const delta = b.successRate - a.successRate;
    if (delta <= -0.2) regressions.push("Success rate fell by at least 20 percentage points.");
    if (delta >= 0.2) improvements.push("Success rate increased by at least 20 percentage points.");
  }
  if (a.validationRuns >= 3 && b.validationRuns >= 3 && a.validationPassRate !== null && b.validationPassRate !== null) {
    const delta = b.validationPassRate - a.validationPassRate;
    if (delta <= -0.15) regressions.push("Independent validation pass rate fell by at least 15 percentage points.");
    if (delta >= 0.15) improvements.push("Independent validation pass rate increased by at least 15 percentage points.");
  } else {
    notes.push("Independent validation sample is too small for a validation-regression conclusion.");
  }
  if (a.averageDurationMs !== null && b.averageDurationMs !== null && a.averageDurationMs > 0 &&
      b.averageDurationMs >= a.averageDurationMs * 1.25 && (b.successRate ?? 0) <= (a.successRate ?? 0)) {
    regressions.push("Average duration increased by at least 25% without a success-rate improvement.");
  }
  const retryRateA = a.retryCount / Math.max(1, a.invocations);
  const retryRateB = b.retryCount / Math.max(1, b.invocations);
  if (retryRateB - retryRateA >= 0.5 && (b.successRate ?? 0) <= (a.successRate ?? 0)) {
    regressions.push("Retries per invocation increased by at least 0.5 without a success-rate improvement.");
  }
  const feedbackA = a.positiveFeedback + a.negativeFeedback + a.neutralFeedback;
  const feedbackB = b.positiveFeedback + b.negativeFeedback + b.neutralFeedback;
  if (feedbackA >= 3 && feedbackB >= 3) {
    const negativeRateA = a.negativeFeedback / feedbackA;
    const negativeRateB = b.negativeFeedback / feedbackB;
    const positiveRateA = a.positiveFeedback / feedbackA;
    const positiveRateB = b.positiveFeedback / feedbackB;
    if (negativeRateB - negativeRateA >= 0.2 && positiveRateB <= positiveRateA) {
      regressions.push("Negative feedback share increased by at least 20 percentage points without a positive-feedback improvement.");
    }
    if (positiveRateB - positiveRateA >= 0.2 && negativeRateB <= negativeRateA) {
      improvements.push("Positive feedback share increased by at least 20 percentage points without a negative-feedback increase.");
    }
  } else {
    notes.push("Feedback sample is too small for a feedback-regression conclusion.");
  }
  if (regressions.length === 0 && improvements.length === 0) {
    notes.push("No configured regression/improvement threshold was crossed; this is not proof of equivalence.");
  }
  return { skillName: normalized, versionA: a, versionB: b, confidence: "comparable", regressions, improvements, notes };
}
