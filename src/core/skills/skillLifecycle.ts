import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { clearSkillsCache } from "../config/skills.js";
import type { ExtractedWorkflowPatterns, SkillEvidenceMetadata, SkillRiskClassification } from "./synthesizerTypes.js";
import { runSandboxSkillReplay, type SkillReplayExecutor } from "./skillReplay.js";

export type SkillCandidateStatus = "candidate" | "evaluated" | "active" | "failed" | "superseded" | "disabled" | "retired";
export interface SkillEvaluationCheck { id: string; status: "pass" | "warn" | "fail"; detail: string }
export interface SkillEvaluation {
  evaluationVersion: 1; evaluationId: string; skillVersion: string; evaluatedAt: number;
  status: "passed" | "failed"; checks: SkillEvaluationCheck[]; verifiedEvidenceIds: string[]; sourceTaskIds: string[];
}
export interface SkillLifecycleEvent {
  id: string; action: "created" | "evaluated" | "replayed" | "promoted" | "superseded" | "disabled" | "retired";
  at: number; actor: string; reason?: string; fromStatus?: SkillCandidateStatus; toStatus: SkillCandidateStatus;
}
export interface SkillCandidateRecord {
  schemaVersion: 1; workspace: string; name: string; version: string; description: string; category: string;
  status: SkillCandidateStatus; contentSha256: string; metadataSha256?: string; createdAt: number; updatedAt: number;
  sourceEvidenceIds: string[]; sourceTaskIds: string[]; extractedPatterns: ExtractedWorkflowPatterns;
  /** Optional schema-v1 compatible redacted provenance/applicability metadata. */
  metadata?: SkillEvidenceMetadata;
  /** Replay history is version-bound and retained independently from static evaluations. */
  replayRuns?: SkillReplayResult[];
  evaluations: SkillEvaluation[]; latestEvaluationId?: string;
  approval?: { approvedBy: string; approvedAt: number; method: "interactive-cli"; evaluationId: string };
  history: SkillLifecycleEvent[];
}
export interface SkillCandidateArtifact { record: SkillCandidateRecord; markdownContent: string; filePath: string }
export interface CreateSkillCandidateInput {
  name: string; description: string; category: string; markdownContent: string;
  extractedPatterns: ExtractedWorkflowPatterns; sourceEvidenceIds?: string[];
  metadata?: SkillEvidenceMetadata;
}

export const SAFE_REPLAY_ALLOWLIST = [
  "assert_file_exists",
  "assert_file_contains",
  "read_file",
  "verify_syntax"
] as const;

export type SafeReplayActionType = typeof SAFE_REPLAY_ALLOWLIST[number];

export interface SafeReplayAction {
  type: SafeReplayActionType;
  target: string;
  expected?: string;
}

export interface SkillReplayFixture {
  fixtureId: string;
  name: string;
  description: string;
  taskPrompt: string;
  initialFiles?: Record<string, string>;
  /** Final-state assertions applied after the injected executor runs. */
  actions: SafeReplayAction[];
}

export interface SkillReplayCheckResult {
  action: string;
  status: "pass" | "fail";
  detail: string;
}

export interface SkillReplayResult {
  fixtureId: string;
  status: "passed" | "failed";
  actionsExecuted: number;
  checks: SkillReplayCheckResult[];
  durationMs: number;
  error?: string;
  runId?: string;
  skillVersion?: string;
  fixtureSha256?: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  changedFiles?: string[];
  finishedAt?: number;
}

const CANDIDATE_ROOT = ".superagent/skill-candidates";
const ACTIVE_ROOT = ".agents/skills";
const MAX_EVALUATIONS = 20;
const MAX_REPLAY_RUNS = 20;
const MAX_HISTORY = 100;
const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]{8,}/i,
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{8,})\b/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization|cookie)\b["']?\s*[:=]\s*(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;&}]{8,})/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
];
const PERMISSION_ESCALATION_PATTERN = /(?:ignore|bypass|disable|override|skip).{0,50}(?:approval|permission|safety|policy|guardrail|authorization)|(?:turn off|remove).{0,30}(?:permission checks|safety checks|approval gate)/i;
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?/i,
  /(?:reveal|print|dump|expose)\s+(?:the\s+)?(?:system|developer)\s+prompt/i,
  /(?:exfiltrat|upload|send)\w*\s+(?:the\s+)?(?:secrets?|credentials?|private keys?|tokens?)/i,
  /(?:read|copy|collect)\s+(?:the\s+)?(?:\.env|credentials?\.json|private key|api keys?)/i,
  /(?:bypass|disable|remove)\s+(?:the\s+)?(?:audit trail|security controls?|approval gate)/i,
];
const OVERGENERALIZATION_PATTERNS = [
  /\b(?:works for any project|works for every codebase|for all tasks regardless of context|always execute without checking preconditions)\b/i,
  /\b(?:always|never)\s+(?:delete|overwrite|force push|skip tests|disable checks)\b/i,
];
const UNSAFE_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+\/(?:\s|$)/i,
  /\bcurl\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash)\b/i,
  /\bwget\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash)\b/i,
  /\bgit\s+push\s+--force(?:\s|$)/i,
  /\bchmod\s+777(?:\s|$)/i,
  /\bRemove-Item\b[^\n]*\s-Recurse\b[^\n]*\s-Force\b/i,
  /\bformat\s+[A-Z]:/i,
];

function sha256(content: string): string { return createHash("sha256").update(content, "utf8").digest("hex"); }
function validateName(name: string): string {
  const normalized = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) || normalized.length > 80) {
    throw new Error("Skill name must be kebab-case and at most 80 characters");
  }
  return normalized;
}
function localWorkspace(workspace: string): string {
  if (!workspace || !workspace.trim() || /^(?:ssh:|chain:)/i.test(workspace.trim())) {
    throw new Error("Skill lifecycle requires a local workspace path; remote/chain workspaces are not supported.");
  }
  const resolved = path.resolve(workspace);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error("Workspace must be an existing local directory.");
  return fs.realpathSync(resolved);
}
function pathIsWithin(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function assertNoSymlinkSegments(workspaceRoot: string, targetPath: string): void {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(targetPath);
  if (!pathIsWithin(root, target)) throw new Error("Skill lifecycle path escaped the workspace.");
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Skill lifecycle refuses to follow symbolic links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") break;
      throw error;
    }
  }
}
function safeMkdir(workspaceRoot: string, directory: string): void {
  assertNoSymlinkSegments(workspaceRoot, directory);
  let cursor = workspaceRoot;
  for (const segment of path.relative(workspaceRoot, path.resolve(directory)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try { fs.mkdirSync(cursor); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Skill lifecycle path contains a non-directory or symbolic link.");
  }
}
function candidateRoot(root: string): string { return path.join(root, CANDIDATE_ROOT); }
function candidateDir(root: string, name: string, version: string): string {
  if (!/^[a-f0-9]{12}$/.test(version)) throw new Error("Invalid skill candidate version.");
  return path.join(candidateRoot(root), validateName(name), version);
}
function artifactPath(root: string, name: string, version: string): string { return path.join(candidateDir(root, name, version), "SKILL.md"); }
function metadataPath(root: string, name: string, version: string): string { return path.join(candidateDir(root, name, version), "record.json"); }
function atomicWrite(filePath: string, content: string, workspaceRoot: string): void {
  assertNoSymlinkSegments(workspaceRoot, filePath);
  safeMkdir(workspaceRoot, path.dirname(filePath));
  const temporary = path.join(path.dirname(filePath), ".tmp-" + randomUUID());
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, content, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filePath);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function metadataDigest(record: SkillCandidateRecord): string {
  const { metadataSha256: _metadataSha256, ...payload } = record;
  return sha256(JSON.stringify(payload));
}
function writeRecord(root: string, record: SkillCandidateRecord): void {
  record.metadataSha256 = metadataDigest(record);
  atomicWrite(metadataPath(root, record.name, record.version), JSON.stringify(record, null, 2) + "\n", root);
}
function readRecord(root: string, name: string, version: string): SkillCandidateRecord {
  const file = metadataPath(root, name, version);
  assertNoSymlinkSegments(root, file);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as SkillCandidateRecord;
  if (!record || record.schemaVersion !== 1 || record.workspace !== root || record.name !== validateName(name) ||
      record.version !== version || !/^[a-f0-9]{64}$/.test(record.contentSha256) ||
      !Array.isArray(record.history) || !Array.isArray(record.evaluations)) {
    throw new Error("Skill candidate metadata is invalid or belongs to a different workspace.");
  }
  const filePath = artifactPath(root, name, version);
  assertNoSymlinkSegments(root, filePath);
  const content = fs.readFileSync(filePath, "utf8");
  if (sha256(content) !== record.contentSha256 || record.contentSha256.slice(0, 12) !== version) {
    throw new Error("Skill candidate content integrity check failed.");
  }
  if (record.metadataSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(record.metadataSha256) || metadataDigest(record) !== record.metadataSha256) {
      throw new Error("Skill candidate metadata integrity check failed; evaluation, replay history, or approval metadata changed.");
    }
  } else {
    // Backwards-compatible one-time seal for records created before metadata integrity was added.
    // This prevents subsequent tampering but cannot prove an old record was never edited previously.
    writeRecord(root, record);
  }
  return record;
}
function addHistory(record: SkillCandidateRecord, action: SkillLifecycleEvent["action"], status: SkillCandidateStatus, actor: string, reason?: string): void {
  const event: SkillLifecycleEvent = {
    id: randomUUID(), action, at: Date.now(), actor: actor.trim().slice(0, 120) || "system",
    ...(reason ? { reason: reason.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 240) } : {}),
    fromStatus: record.status, toStatus: status,
  };
  record.status = status;
  record.updatedAt = event.at;
  record.history = [...record.history, event].slice(-MAX_HISTORY);
}
function boundedRedactedText(input: unknown, limit: number): string | undefined {
  if (typeof input !== "string") return undefined;
  const singleLine = input.replace(/[\r\n\x00-\x1f\x7f\u0085\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return redactText(singleLine).value.slice(0, limit);
}

function sanitizeMetadata(input?: SkillEvidenceMetadata): SkillEvidenceMetadata | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const modeValues = new Set(["single", "multi", "interactive", "background", "unknown"]);
  const riskValues = new Set<SkillRiskClassification>(["low", "medium", "high"]);
  const cleanList = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const clean = [...new Set(value.slice(0, 10).map(item => boundedRedactedText(item, 240)).filter((item): item is string => Boolean(item)))];
    return clean.length ? clean : undefined;
  };
  const metadata: SkillEvidenceMetadata = {};
  const taskId = boundedRedactedText(input.taskId, 120);
  const provider = boundedRedactedText(input.provider, 80);
  const model = boundedRedactedText(input.model, 100);
  const executionMode = typeof input.executionMode === "string" && modeValues.has(input.executionMode) ? input.executionMode : undefined;
  const errorSummary = boundedRedactedText(input.errorSummary, 600);
  const recoverySummary = boundedRedactedText(input.recoverySummary, 600);
  const applicability = cleanList(input.applicability);
  const preconditions = cleanList(input.preconditions);
  const expectedOutputs = cleanList(input.expectedOutputs);
  const verificationSteps = cleanList(input.verificationSteps);
  const knownLimitations = cleanList(input.knownLimitations);
  if (taskId) metadata.taskId = taskId;
  if (provider) metadata.provider = provider;
  if (model) metadata.model = model;
  if (executionMode) metadata.executionMode = executionMode;
  if (errorSummary) metadata.errorSummary = errorSummary;
  if (recoverySummary) metadata.recoverySummary = recoverySummary;
  if (applicability) metadata.applicability = applicability;
  if (preconditions) metadata.preconditions = preconditions;
  if (expectedOutputs) metadata.expectedOutputs = expectedOutputs;
  if (verificationSteps) metadata.verificationSteps = verificationSteps;
  if (knownLimitations) metadata.knownLimitations = knownLimitations;
  if (typeof input.riskClassification === "string" && riskValues.has(input.riskClassification)) metadata.riskClassification = input.riskClassification;
  if (input.userFeedback && typeof input.userFeedback === "object" && !Array.isArray(input.userFeedback)) {
    const sentiment = input.userFeedback.sentiment;
    const summary = boundedRedactedText(input.userFeedback.summary, 400);
    if (["positive", "negative", "neutral"].includes(String(sentiment)) && summary) {
      metadata.userFeedback = { sentiment: sentiment as "positive" | "negative" | "neutral", summary };
    }
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

function redactText(input: string): { value: string; count: number } {
  let value = input;
  let count = 0;
  const patterns = [
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi,
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie|client[_-]?secret)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi,
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi,
  ];
  for (const pattern of patterns) value = value.replace(pattern, () => { count++; return "[REDACTED]"; });
  return { value: value.slice(0, 12000), count };
}
async function verifyTaskEvidence(root: string, ids: string[]): Promise<{ ok: boolean; errors: string[]; verifiedEvidenceIds: string[]; taskIds: string[] }> {
  if (!ids.length) return { ok: false, errors: ["Provide a persisted completed-task evidence ID."], verifiedEvidenceIds: [], taskIds: [] };
  try {
    const [{ getSelfDevConfig }, { getHistoryDb }, { SelfDevEventStore }] = await Promise.all([
      import("../selfdev/settings.js"), import("../storage/historyDb.js"), import("../selfdev/eventStore.js"),
    ]);
    const config = getSelfDevConfig();
    if (!config.enabled) return { ok: false, errors: ["Selfdev evidence is disabled; evidence verification failed closed."], verifiedEvidenceIds: [], taskIds: [] };
    const store = new SelfDevEventStore({ workspace: root, getDb: () => getHistoryDb() as any, config });
    const verified = new Set<string>();
    const taskIds = new Set<string>();
    const errors: string[] = [];
    let terminalCount = 0;
    for (const id of [...new Set(ids)].slice(0, 20)) {
      const terminal = store.get(id);
      if (!terminal || terminal.workspace !== root) {
        errors.push("Source evidence ID is absent from this exact workspace.");
        continue;
      }
      if (terminal.kind !== "task_completed" || terminal.payload?.outcome !== "task_completed" || typeof terminal.payload?.taskId !== "string") {
        errors.push("Evidence must point to a persisted task_completed terminal event.");
        continue;
      }
      terminalCount++;
      verified.add(terminal.id);
      const taskId = terminal.payload.taskId;
      taskIds.add(taskId);
      let successfulCheck = false;
      for (const linkedId of terminal.evidence.slice(0, 50)) {
        const linked = store.get(linkedId);
        if (!linked || linked.workspace !== root || linked.sessionId !== terminal.sessionId ||
            linked.ts > terminal.ts || linked.payload?.taskId !== taskId || linked.payload?.exitCode !== 0) continue;
        const passed = (linked.kind === "test_result" && linked.payload?.passed === true) ||
          (linked.kind === "build_result" && linked.payload?.success === true);
        if (passed) { successfulCheck = true; verified.add(linked.id); }
      }
      if (!successfulCheck) errors.push("Completed task lacks persisted successful test/build evidence.");
    }
    if (!terminalCount) errors.push("No valid completed-task evidence was found.");
    return { ok: terminalCount > 0 && errors.length === 0, errors: [...new Set(errors)], verifiedEvidenceIds: [...verified], taskIds: [...taskIds] };
  } catch {
    return { ok: false, errors: ["Selfdev evidence store could not be verified; evaluation failed closed."], verifiedEvidenceIds: [], taskIds: [] };
  }
}

export async function createSkillCandidate(workspace: string, input: CreateSkillCandidateInput): Promise<SkillCandidateArtifact> {
  const root = localWorkspace(workspace);
  const name = validateName(input.name);
  const redacted = redactText(input.markdownContent);
  const content = redacted.value;
  const hash = sha256(content);
  const version = hash.slice(0, 12);
  const dir = candidateDir(root, name, version);
  const artifact = artifactPath(root, name, version);
  safeMkdir(root, dir);
  if (fs.existsSync(metadataPath(root, name, version)) || fs.existsSync(artifact)) {
    const old = readRecord(root, name, version);
    if (old.contentSha256 !== hash) throw new Error("Skill version collision detected.");
    return { record: old, markdownContent: fs.readFileSync(artifact, "utf8"), filePath: artifact };
  }
  const sourceEvidenceIds = [...new Set((input.sourceEvidenceIds || [])
    .filter(id => typeof id === "string" && id.trim())
    .map(id => redactText(id.trim()).value.slice(0, 200)))].filter(Boolean).slice(0, 20);
  const now = Date.now();
  const record: SkillCandidateRecord = {
    schemaVersion: 1, workspace: root, name, version,
    description: redactText(input.description).value.slice(0, 240),
    category: input.category.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 80) || "automation",
    status: "candidate", contentSha256: hash, createdAt: now, updatedAt: now,
    sourceEvidenceIds, sourceTaskIds: [],
    extractedPatterns: {
      toolsUsed: [...new Set(input.extractedPatterns.toolsUsed.map(value => redactText(value).value))].slice(0, 50),
      commandPatterns: [...new Set(input.extractedPatterns.commandPatterns.map(value => redactText(value).value))].slice(0, 50),
      recoveredErrors: input.extractedPatterns.recoveredErrors.slice(0, 20).map(v => redactText(v).value.slice(0, 150)),
      keySteps: input.extractedPatterns.keySteps.slice(0, 20).map(v => redactText(v).value.slice(0, 200)),
    },
    ...(sanitizeMetadata(input.metadata) ? { metadata: sanitizeMetadata(input.metadata) } : {}),
    evaluations: [], history: [],
  };
  addHistory(record, "created", "candidate", "synthesizer", redacted.count ? "Sensitive patterns were redacted before persistence." : "Saved as an inactive candidate.");
  atomicWrite(artifact, content, root);
  writeRecord(root, record);
  return { record, markdownContent: content, filePath: artifact };
}
export function listSkillCandidates(workspace: string, status?: SkillCandidateStatus): SkillCandidateRecord[] {
  const root = localWorkspace(workspace);
  const base = candidateRoot(root);
  if (!fs.existsSync(base)) return [];
  assertNoSymlinkSegments(root, base);
  const result: SkillCandidateRecord[] = [];
  for (const skill of fs.readdirSync(base, { withFileTypes: true })) {
    if (!skill.isDirectory() || skill.isSymbolicLink() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) continue;
    const skillDir = path.join(base, skill.name);
    for (const version of fs.readdirSync(skillDir, { withFileTypes: true })) {
      if (!version.isDirectory() || version.isSymbolicLink() || !/^[a-f0-9]{12}$/.test(version.name)) continue;
      try {
        const record = readRecord(root, skill.name, version.name);
        if (status === undefined || record.status === status) result.push(record);
      } catch {
        // Corrupted candidate artifacts remain out of discovery and cannot be promoted.
      }
    }
  }
  return result.sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
}
export function getSkillCandidate(workspace: string, name: string, version: string): SkillCandidateArtifact {
  const root = localWorkspace(workspace);
  const normalized = validateName(name);
  const record = readRecord(root, normalized, version);
  return { record, markdownContent: fs.readFileSync(artifactPath(root, normalized, version), "utf8"), filePath: artifactPath(root, normalized, version) };
}

export async function evaluateSkillCandidate(workspace: string, name: string, version: string): Promise<SkillCandidateArtifact> {
  const root = localWorkspace(workspace);
  const candidate = getSkillCandidate(root, name, version);
  const content = candidate.markdownContent;
  const { validateSkillMarkdown } = await import("./skillSynthesizer.js");
  const validation = validateSkillMarkdown(content);
  const checks: SkillEvaluationCheck[] = [];
  const frontmatterName = content.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  checks.push({ id: "markdown-structure", status: validation.valid ? "pass" : "fail", detail: validation.valid ? "Required frontmatter and workflow sections exist." : validation.errors.join("; ").slice(0, 300) });
  checks.push({ id: "candidate-identity", status: frontmatterName === candidate.record.name ? "pass" : "fail", detail: frontmatterName === candidate.record.name ? "Frontmatter name matches candidate identity." : "Frontmatter name does not match candidate identity." });
  const hasSecret = SECRET_PATTERNS.some(pattern => pattern.test(content));
  checks.push({ id: "secret-scan", status: hasSecret ? "fail" : "pass", detail: hasSecret ? "Potential credential/private-key material detected; revise before promotion." : "No known high-confidence credential pattern detected." });
  const bypass = PERMISSION_ESCALATION_PATTERN.test(content);
  checks.push({ id: "permission-boundaries", status: bypass ? "fail" : "pass", detail: bypass ? "Candidate appears to bypass permission or approval controls." : "No explicit permission/approval bypass instruction detected." });
  const dangerous = UNSAFE_COMMAND_PATTERNS.some(pattern => pattern.test(content));
  checks.push({ id: "command-safety", status: dangerous ? "fail" : "pass", detail: dangerous ? "Destructive or unsafe command pattern detected; replace with bounded steps." : "No known high-risk command pattern detected." });
  const injection = PROMPT_INJECTION_PATTERNS.some(pattern => pattern.test(content));
  checks.push({ id: "prompt-injection", status: injection ? "fail" : "pass", detail: injection ? "Candidate contains instructions to disclose secrets, ignore higher-priority instructions, or bypass controls." : "No known direct prompt-injection/exfiltration pattern detected." });
  const overgeneralized = OVERGENERALIZATION_PATTERNS.some(pattern => pattern.test(content));
  checks.push({ id: "generalization-boundaries", status: overgeneralized ? "warn" : "pass", detail: overgeneralized ? "Potentially overgeneralized workflow instruction detected; tighten applicability and preconditions." : "No high-confidence overgeneralization phrase detected." });
  const risk = candidate.record.metadata?.riskClassification;
  checks.push({ id: "risk-classification", status: risk === "high" ? "fail" : risk === "medium" ? "warn" : "pass", detail: risk === "high" ? "High-risk candidate requires a separately reviewed policy path and is not eligible for normal promotion." : risk === "medium" ? "Medium-risk candidate needs careful owner review before activation." : "Low or unclassified risk; normal explicit approval gate still applies." });
    const paths = ((content.includes("Users") || content.includes("Windows") || content.includes("Program Files")) && content.includes(":")) || content.includes("/home/") || content.includes("/Users/") || content.includes("/root/") || content.includes("/tmp/");
  checks.push({ id: "path-portability", status: paths ? "warn" : "pass", detail: paths ? "Machine-specific path detected; review portability." : "No common machine-specific absolute path detected." });
  const activePath = path.join(root, ACTIVE_ROOT, candidate.record.name, "SKILL.md");
  let conflict = false;
  try {
    assertNoSymlinkSegments(root, activePath);
    if (fs.existsSync(activePath)) conflict = sha256(fs.readFileSync(activePath, "utf8")) !== candidate.record.contentSha256;
  } catch { conflict = true; }
  checks.push({ id: "active-name-conflict", status: conflict ? "warn" : "pass", detail: conflict ? "A different skill uses this name; promotion will refuse unmanaged overwrite." : "No different active skill content detected." });

  const replay = (candidate.record.replayRuns || [])
    .filter(run => run.skillVersion === candidate.record.version).slice(-1)[0];
  checks.push({
    id: "sandboxed-replay",
    status: !replay ? "warn" : replay.status === "passed" ? "pass" : "fail",
    detail: !replay
      ? "No sandbox replay recorded; static checks do not execute generated instructions."
      : replay.status === "passed"
        ? "Latest sandbox replay passed for this exact candidate version."
        : "Latest sandbox replay failed; inspect the recorded failure and refine the candidate before re-evaluation.",
  });
  const evidence = await verifyTaskEvidence(root, candidate.record.sourceEvidenceIds);
  checks.push({ id: "verified-task-evidence", status: evidence.ok ? "pass" : "fail", detail: evidence.ok ? "Persisted completed-task and successful test/build evidence verified." : evidence.errors.join(" ").slice(0, 300) });
  const declaredTaskId = candidate.record.metadata?.taskId;
  const taskIdMatches = !declaredTaskId || evidence.taskIds.includes(declaredTaskId);
  checks.push({ id: "task-provenance", status: taskIdMatches ? "pass" : "fail", detail: taskIdMatches ? "Declared task provenance is absent or matches verified source evidence." : "Declared taskId does not match the verified task evidence." });
  const evaluation: SkillEvaluation = {
    evaluationVersion: 1, evaluationId: randomUUID(), skillVersion: candidate.record.version,
    evaluatedAt: Date.now(), status: checks.some(c => c.status === "fail") ? "failed" : "passed",
    checks, verifiedEvidenceIds: evidence.verifiedEvidenceIds, sourceTaskIds: evidence.taskIds,
  };
  const record = candidate.record;
  record.evaluations = [...record.evaluations, evaluation].slice(-MAX_EVALUATIONS);
  record.latestEvaluationId = evaluation.evaluationId;
  // Keep only submitted terminal-event IDs as the re-verifiable source pointers.
  // The expanded evaluation evidence also contains linked test/build event IDs.
  record.sourceTaskIds = evidence.taskIds;
  if (evaluation.status === "failed" && record.status !== "active") addHistory(record, "evaluated", "failed", "evaluator", "Evaluation failed; candidate remains inactive.");
  else if (evaluation.status === "passed" && record.status !== "active") addHistory(record, "evaluated", "evaluated", "evidence-check", "Versioned checks and persisted evidence passed.");
  else record.updatedAt = Date.now();
  writeRecord(root, record);
  return { record, markdownContent: content, filePath: candidate.filePath };
}

/**
 * Run a version-bound candidate through a caller-supplied trusted executor whose
 * only workspace capability is the restricted tool API in a disposable sandbox.
 * The caller must not expose shell/network/general filesystem tools to that executor.
 */
export async function replaySkillCandidate(
  workspace: string,
  name: string,
  version: string,
  fixture: SkillReplayFixture,
  executor: SkillReplayExecutor,
  options: { timeoutMs?: number; actor?: string } = {},
): Promise<SkillReplayResult> {
  const root = localWorkspace(workspace);
  const preflight = await evaluateSkillCandidate(root, name, version);
  const preflightEvaluation = preflight.record.evaluations.find(item => item.evaluationId === preflight.record.latestEvaluationId);
  const blockingChecks = (preflightEvaluation?.checks || []).filter(check => check.id !== "sandboxed-replay" && check.status === "fail");
  if (!preflightEvaluation || blockingChecks.length > 0) {
    throw new Error("Replay is blocked until static checks and verified task evidence pass. Failed checks: " +
      blockingChecks.map(check => check.id).slice(0, 8).join(", "));
  }
  const candidate = getSkillCandidate(root, name, version);
  const result = await runSandboxSkillReplay({
    name: candidate.record.name,
    version: candidate.record.version,
    markdownContent: candidate.markdownContent,
  }, fixture, executor, { timeoutMs: options.timeoutMs });
  const current = readRecord(root, name, version);
  current.replayRuns = [...(current.replayRuns || []), result].slice(-MAX_REPLAY_RUNS);
  addHistory(current, "replayed", current.status, options.actor || "sandbox-replay", result.status === "passed"
    ? "Sandbox replay passed for fixture " + result.fixtureId + "."
    : "Sandbox replay failed for fixture " + result.fixtureId + ".");
  writeRecord(root, current);
  // Re-evaluate after replay so the latest evaluation explicitly reflects the
  // exact-version replay result; a failed replay then blocks normal promotion.
  await evaluateSkillCandidate(root, name, version);
  try {
    const { recordSkillValidation } = await import("./skillTracker.js");
    recordSkillValidation(name, version, result.status === "passed", {
      taskId: candidate.record.metadata?.taskId,
      provider: result.provider || candidate.record.metadata?.provider,
      model: result.model || candidate.record.metadata?.model,
      executionMode: candidate.record.metadata?.executionMode,
      workspace: root,
    });
  } catch {
    // Candidate replay/audit is authoritative; metrics must never undo replay persistence.
  }
  return result;
}

function latestEvaluation(record: SkillCandidateRecord): SkillEvaluation | undefined {
  return record.evaluations.find(e => e.evaluationId === record.latestEvaluationId && e.skillVersion === record.version);
}
export async function promoteSkillCandidate(
  workspace: string, name: string, version: string,
  approval: { approvedBy: string; method: "interactive-cli"; evaluationId?: string },
): Promise<SkillCandidateArtifact> {
  const root = localWorkspace(workspace);
  const candidate = getSkillCandidate(root, name, version);
  const record = candidate.record;
  const evaluation = latestEvaluation(record);
  if (!evaluation || evaluation.status !== "passed" || record.status === "retired") {
    throw new Error("Only a non-retired candidate with a passing latest evaluation can be promoted.");
  }
  const latestReplay = (record.replayRuns || [])
    .filter(run => run.skillVersion === record.version).slice(-1)[0];
  if (!latestReplay || latestReplay.status !== "passed" ||
      !/^[a-f0-9]{64}$/.test(latestReplay.fixtureSha256 || "") ||
      !/^[0-9a-f-]{36}$/i.test(latestReplay.runId || "")) {
    throw new Error("A passing sandbox replay for this exact immutable version is required before activation.");
  }
  if (approval.method !== "interactive-cli" || !approval.approvedBy.trim()) {
    throw new Error("Activation requires explicit interactive CLI approval.");
  }
  if (approval.evaluationId && approval.evaluationId !== evaluation.evaluationId) {
    throw new Error("Evaluation changed; review this candidate again before approval.");
  }
  const evidence = await verifyTaskEvidence(root, record.sourceEvidenceIds);
  if (!evidence.ok) throw new Error("Source evidence is no longer valid; evaluate again before activation.");

  const activeDir = path.join(root, ACTIVE_ROOT, record.name);
  const activePath = path.join(activeDir, "SKILL.md");
  safeMkdir(root, activeDir);
  let activeHash: string | undefined;
  try {
    assertNoSymlinkSegments(root, activePath);
    if (fs.existsSync(activePath)) activeHash = sha256(fs.readFileSync(activePath, "utf8"));
  } catch {
    throw new Error("Refusing promotion: active skill path is unsafe or uses a symbolic link.");
  }
  const previous = listSkillCandidates(root).find(item => item.name === record.name && item.status === "active");
  if (activeHash && activeHash !== record.contentSha256 && (!previous || previous.contentSha256 !== activeHash)) {
    throw new Error("An unmanaged skill already occupies this name; refusing to overwrite it.");
  }

  if (activeHash !== record.contentSha256) {
    atomicWrite(activePath, candidate.markdownContent, root);
    if (previous && previous.version !== record.version) {
      const priorRecord = readRecord(root, previous.name, previous.version);
      addHistory(priorRecord, "superseded", "superseded", approval.approvedBy, "Replaced by version " + record.version + ".");
      writeRecord(root, priorRecord);
    }
  }
  record.approval = {
    approvedBy: approval.approvedBy.trim().slice(0, 120),
    approvedAt: Date.now(),
    method: "interactive-cli",
    evaluationId: evaluation.evaluationId,
  };
  addHistory(record, "promoted", "active", approval.approvedBy, "Approved evaluation " + evaluation.evaluationId + ".");
  writeRecord(root, record);
  clearSkillsCache();
  return { record, markdownContent: candidate.markdownContent, filePath: activePath };
}

export function disableActiveSkill(workspace: string, name: string, actor: string, reason = "Disabled by owner"): SkillCandidateRecord {
  const root = localWorkspace(workspace);
  const normalized = validateName(name);
  const active = listSkillCandidates(root, "active").find(item => item.name === normalized);
  if (!active) throw new Error("No managed active skill found for " + normalized + ".");
  const activePath = path.join(root, ACTIVE_ROOT, normalized, "SKILL.md");
  assertNoSymlinkSegments(root, activePath);
  if (!fs.existsSync(activePath) || sha256(fs.readFileSync(activePath, "utf8")) !== active.contentSha256) {
    throw new Error("Active skill changed outside lifecycle manager; refusing to delete it.");
  }
  fs.unlinkSync(activePath);
  try { fs.rmdirSync(path.dirname(activePath)); } catch {}
  const updated = readRecord(root, normalized, active.version);
  addHistory(updated, "disabled", "disabled", actor, reason);
  writeRecord(root, updated);
  clearSkillsCache();
  return updated;
}
export function retireSkillCandidate(workspace: string, name: string, version: string, actor: string, reason: string): SkillCandidateRecord {
  const root = localWorkspace(workspace);
  const current = getSkillCandidate(root, name, version);
  if (!reason.trim()) throw new Error("A retirement reason is required.");
  if (current.record.status === "active") disableActiveSkill(root, name, actor, "Retired: " + reason);
  const updated = readRecord(root, name, version);
  addHistory(updated, "retired", "retired", actor, reason);
  writeRecord(root, updated);
  return updated;
}
export function compareSkillCandidateVersions(workspace: string, name: string, versionA: string, versionB: string) {
  const a = getSkillCandidate(workspace, name, versionA);
  const b = getSkillCandidate(workspace, name, versionB);
  const linesA = new Set(a.markdownContent.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  const linesB = new Set(b.markdownContent.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  return {
    name: a.record.name, versionA, versionB,
    sameContent: a.record.contentSha256 === b.record.contentSha256,
    onlyInA: [...linesA].filter(line => !linesB.has(line)).slice(0, 100),
    onlyInB: [...linesB].filter(line => !linesA.has(line)).slice(0, 100),
    statusA: a.record.status, statusB: b.record.status,
  };
}
export function attachSkillCandidateEvidence(workspace: string, name: string, version: string, evidenceIds: string[]): SkillCandidateRecord {
  const root = localWorkspace(workspace);
  if (!Array.isArray(evidenceIds) || evidenceIds.length < 1 || evidenceIds.length > 20 ||
      evidenceIds.some(id => typeof id !== "string" || !id.trim() || id.length > 200)) {
    throw new Error("Provide between 1 and 20 valid evidence IDs.");
  }
  const candidate = getSkillCandidate(root, name, version);
  if (candidate.record.status === "active" || candidate.record.status === "retired") {
    throw new Error("Evidence can only be attached to a non-active, non-retired candidate.");
  }
  candidate.record.sourceEvidenceIds = [...new Set([...candidate.record.sourceEvidenceIds, ...evidenceIds.map(id => id.trim())])].slice(0, 20);
  candidate.record.latestEvaluationId = undefined;
  candidate.record.updatedAt = Date.now();
  if (candidate.record.status === "evaluated" || candidate.record.status === "failed") {
    addHistory(candidate.record, "evaluated", "candidate", "evidence-editor", "Source evidence updated; previous evaluation must be rerun.");
  }
  writeRecord(root, candidate.record);
  return candidate.record;
}
export function getSkillCandidateReference(name: string, version: string): string {
  return validateName(name) + "@" + version;
}
