import { SELFDEV_LIMITS, type SelfDevEvent, type SelfDevLesson, type SelfDevLessonInput } from "./types.js";
import { type CandidateStore } from "./candidateStore.js";

const ESCALATION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous\s+)?(?:instructions|rules|prompts)/i,
  /disregard\s+(?:all\s+)?(?:system|developer)\s+instructions/i,
  /bypass\s+(?:approval|security|guardrails?|review)/i,
  /grant\s+(?:all\s+)?(?:permissions?|tools?|privileges?)/i,
  /disable\s+(?:security|validation|locks?|guardrails?)/i,
  /you\s+are\s+now\s+(?:an?\s+)?(?:admin|administrator|root|system)/i,
];

const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi,
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi,
];

function sanitize(text: string): string {
  let cleaned = text;
  for (const pat of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pat, "[REDACTED]");
  }
  return cleaned.trim();
}

function hasEscalation(text: string): boolean {
  return ESCALATION_PATTERNS.some(pat => pat.test(text));
}

function normalizeStatement(statement: string): string {
  return statement.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function contentTokens(statement: string): Set<string> {
  const stopWords = new Set([
    "about", "after", "again", "also", "always", "before", "from", "into", "only",
    "should", "that", "their", "then", "there", "these", "this", "with", "when",
    "where", "which", "while", "will", "would", "your", "must", "need", "than",
  ]);
  return new Set(
    statement.toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(token => token.length > 2 && !stopWords.has(token))
  );
}

const NEGATION_PATTERN = /\b(?:never|not|avoid|do not|don\x27t|mustn\x27t|cannot|without|no|disable|delete|remove|reject|deny|retire|discard|drop|stop|disallow|forbid|prevent)\b/i;
export function scoreNearDuplicateSimilarity(left: string, right: string): number {
  if (NEGATION_PATTERN.test(left) !== NEGATION_PATTERN.test(right)) return 0;
  return tokenJaccard(contentTokens(left), contentTokens(right));
}
function tokenJaccard(left: Set<string>, right: Set<string>): number {
  if (left.size < 4 || right.size < 4) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union ? intersection / union : 0;
}

type NearDuplicateReference = {
  id?: string;
  statement: string;
  isPendingCandidate: boolean;
};

/**
 * Keep possible overlaps reviewable rather than silently merging or suppressing
 * them. Exact duplicate filtering remains authoritative; near-duplicate hints
 * never grant approval or change the lifecycle state.
 */
function markNearDuplicateForReview(
  candidate: SelfDevLessonInput,
  existingLessons: SelfDevLesson[],
  earlierCandidates: SelfDevLessonInput[],
): void {

  const references: NearDuplicateReference[] = [
    ...existingLessons
      .filter(lesson => lesson.workspace === candidate.workspace && lesson.status !== "retired")
      .map(lesson => ({ id: lesson.id, statement: lesson.statement, isPendingCandidate: false })),
    ...earlierCandidates
      .filter(lesson => lesson.workspace === candidate.workspace)
      .map(lesson => ({ statement: lesson.statement, isPendingCandidate: true })),
  ];

  let best: { reference: NearDuplicateReference; similarity: number } | undefined;
  for (const reference of references) {
    const similarity = scoreNearDuplicateSimilarity(candidate.statement, reference.statement);
    if (similarity >= 0.35 && (!best || similarity > best.similarity)) {
      best = { reference, similarity };
    }
  }
  if (!best) return;

  const tag = "near_duplicate_review";
  candidate.tags = Array.from(new Set([...(candidate.tags ?? []).filter(value => value !== tag).slice(0, SELFDEV_LIMITS.MAX_TAGS - 1), tag]));
  const referenceLabel = best.reference.isPendingCandidate
    ? "another candidate proposed in this distillation pass"
    : `existing lesson ${(best.reference.id ?? "unknown").slice(0, 100)}`;
  const hint = `Review hint: possible near-duplicate of ${referenceLabel} (token overlap ${Math.round(best.similarity * 100)}%). Kept as a candidate; no automatic merge or approval.`;
  const existingRationale = candidate.rationale ?? "";
  candidate.rationale = existingRationale
    ? `${existingRationale.slice(0, Math.max(0, SELFDEV_LIMITS.MAX_RATIONALE_LENGTH - hint.length - 1))}\n${hint}`
    : hint.slice(0, SELFDEV_LIMITS.MAX_RATIONALE_LENGTH);
}

export interface DistillOptions {
  workspace: string;
  events: SelfDevEvent[];
  existingLessons?: SelfDevLesson[];
  maxCandidates?: number;
  /** Optional trusted evidence validator used by production persistence paths. */
  validateEvidence?: (eventId: string) => boolean;
}

export interface DistillResult {
  candidates: SelfDevLessonInput[];
  processedEventIds: string[];
  skippedReasons: Array<{ eventId?: string; reason: string }>;
}

/**
 * Distills raw SelfDevEvents into candidate lessons without autonomous activation.
 * Enforces:
 * - Secret redaction on all generated statements and rationales.
 * - Authority escalation rejection.
 * - Exact workspace scoping and evidence verification.
 * - Deterministic deduplication against existing lessons.
 * - Strict length and candidate count bounds.
 */
export function distillEvents(options: DistillOptions): DistillResult {
  const workspace = options.workspace;
  const maxCandidates = Math.min(options.maxCandidates ?? 5, 20);
  const existingNorms = new Set<string>(
    (options.existingLessons ?? [])
      .filter(l => l.workspace === workspace && l.status !== "retired")
      .map(l => normalizeStatement(l.statement))
  );

  const candidates: SelfDevLessonInput[] = [];
  const processedEventIds: string[] = [];
  const skippedReasons: Array<{ eventId?: string; reason: string }> = [];

  // Sort events chronologically
  const sorted = [...options.events].sort((a, b) => a.ts - b.ts);

  // 1. Check for failure-followed-by-success pairs (Fix cycle)
  for (let i = 0; i < sorted.length; i++) {
    if (candidates.length >= maxCandidates) break;
    const current = sorted[i];

    const isFailure =
      current.kind === "task_failed" ||
      (current.kind === "command_executed" && current.payload?.exitCode !== undefined && current.payload.exitCode !== 0) ||
      (current.kind === "test_result" && (current.payload?.failed as number > 0 || current.payload?.passed === false)) ||
      (current.kind === "build_result" && current.payload?.success === false);

    if (isFailure) {
      // Find subsequent success in the same session or related commands
      const currentTaskId = typeof current.payload?.taskId === "string" ? current.payload.taskId : undefined;
      const subsequentSuccess = sorted.slice(i + 1).find(
        ev => {
          const candidateTaskId = typeof ev.payload?.taskId === "string" ? ev.payload.taskId : undefined;
          // New records carry task IDs: never combine evidence from two different
          // tasks in one long-lived session. Legacy records without IDs retain
          // the historic same-session behavior for backward compatibility.
          const sameTask = !currentTaskId || !candidateTaskId || currentTaskId === candidateTaskId;
          return ev.sessionId === current.sessionId && sameTask &&
          (ev.kind === "task_completed" ||
            (ev.kind === "test_result" && (ev.payload?.failed === 0 || ev.payload?.passed === true)) ||
            (ev.kind === "build_result" && ev.payload?.success === true) ||
            (ev.kind === "command_executed" && ev.payload?.exitCode === 0));
        }
      );

      if (subsequentSuccess) {
        processedEventIds.push(current.id, subsequentSuccess.id);
        const rawStatement = `Resolve ${current.kind} failure: ${subsequentSuccess.summary || "apply verified fix pattern"}`;
        const statement = sanitize(rawStatement).slice(0, SELFDEV_LIMITS.MAX_STATEMENT_LENGTH);
        const rationale = sanitize(
          `Observed failure in ${current.kind} (${current.summary}) resolved by subsequent ${subsequentSuccess.kind} (${subsequentSuccess.summary}) in session ${current.sessionId}.`
        ).slice(0, SELFDEV_LIMITS.MAX_RATIONALE_LENGTH);

        const norm = normalizeStatement(statement);
        if (existingNorms.has(norm)) {
          skippedReasons.push({ eventId: current.id, reason: "duplicate" });
          continue;
        }

        if (hasEscalation(statement) || hasEscalation(rationale)) {
          skippedReasons.push({ eventId: current.id, reason: "authority_escalation_detected" });
          continue;
        }

        const tags = Array.from(new Set([...current.tags, ...subsequentSuccess.tags, "fix_cycle"])).slice(
          0,
          SELFDEV_LIMITS.MAX_TAGS
        );

        const candidate: SelfDevLessonInput = {
          workspace,
          statement,
          rationale,
          evidenceIds: [current.id, subsequentSuccess.id],
          tags,
        };

        markNearDuplicateForReview(candidate, options.existingLessons ?? [], candidates);
        candidates.push(candidate);
        existingNorms.add(norm);
      }
    }
  }

  // 2. Check for user feedback / corrections
  for (const ev of sorted) {
    if (candidates.length >= maxCandidates) break;
    if (ev.kind === "user_feedback" && ev.summary) {
      processedEventIds.push(ev.id);
      const statement = sanitize(`User guideline: ${ev.summary}`).slice(0, SELFDEV_LIMITS.MAX_STATEMENT_LENGTH);
      const rationale = sanitize(`Extracted from user correction in session ${ev.sessionId}: ${ev.summary}`).slice(
        0,
        SELFDEV_LIMITS.MAX_RATIONALE_LENGTH
      );

      const norm = normalizeStatement(statement);
      if (existingNorms.has(norm)) {
        skippedReasons.push({ eventId: ev.id, reason: "duplicate" });
        continue;
      }

      if (hasEscalation(statement) || hasEscalation(rationale)) {
        skippedReasons.push({ eventId: ev.id, reason: "authority_escalation_detected" });
        continue;
      }

      const tags = Array.from(new Set([...ev.tags, "user_feedback"])).slice(0, SELFDEV_LIMITS.MAX_TAGS);

      const candidate: SelfDevLessonInput = {
        workspace,
        statement,
        rationale,
        evidenceIds: [ev.id],
        tags,
      };

      markNearDuplicateForReview(candidate, options.existingLessons ?? [], candidates);
      candidates.push(candidate);
      existingNorms.add(norm);
    }
  }

  // 3. Check for explicitly proposed lessons
  for (const ev of sorted) {
    if (candidates.length >= maxCandidates) break;
    if (ev.kind === "lesson_proposed" && ev.summary) {
      processedEventIds.push(ev.id);
      const statement = sanitize(ev.summary).slice(0, SELFDEV_LIMITS.MAX_STATEMENT_LENGTH);
      const rationale = sanitize(
        typeof ev.payload?.rationale === "string"
          ? ev.payload.rationale
          : `Proposed lesson from session ${ev.sessionId}`
      ).slice(0, SELFDEV_LIMITS.MAX_RATIONALE_LENGTH);

      const norm = normalizeStatement(statement);
      if (existingNorms.has(norm)) {
        skippedReasons.push({ eventId: ev.id, reason: "duplicate" });
        continue;
      }

      if (hasEscalation(statement) || hasEscalation(rationale)) {
        skippedReasons.push({ eventId: ev.id, reason: "authority_escalation_detected" });
        continue;
      }

      const evidenceIds = ev.evidence && ev.evidence.length > 0 ? ev.evidence.slice(0, SELFDEV_LIMITS.MAX_EVIDENCE_ITEMS) : [ev.id];
      const tags = Array.from(new Set([...ev.tags, "lesson_proposed"])).slice(0, SELFDEV_LIMITS.MAX_TAGS);

      const candidate: SelfDevLessonInput = {
        workspace,
        statement,
        rationale,
        evidenceIds,
        tags,
      };

      markNearDuplicateForReview(candidate, options.existingLessons ?? [], candidates);
      candidates.push(candidate);
      existingNorms.add(norm);
    }
  }

  return {
    candidates,
    processedEventIds: Array.from(new Set(processedEventIds)),
    skippedReasons,
  };
}

/**
 * Distills events and persists the generated candidates into CandidateStore.
 */
export async function distillAndStore(
  options: DistillOptions & { candidateStore: CandidateStore }
): Promise<SelfDevLesson[]> {
  const result = distillEvents(options);
  const saved: SelfDevLesson[] = [];

  for (const input of result.candidates) {
    try {
      if (
        options.validateEvidence &&
        (!input.evidenceIds.length || !input.evidenceIds.every(id => options.validateEvidence!(id)))
      ) {
        continue;
      }
      const created = await options.candidateStore.create(input);
      if (created) {
        saved.push(created);
      }
    } catch {
      // Ignore creation errors (e.g. limit reached or duplicate)
    }
  }

  return saved;
}
