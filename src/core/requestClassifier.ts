/**
 * requestClassifier.ts — Multi-category request classification for token optimization.
 *
 * Classifies user requests BEFORE the main agent loop to determine intent category.
 * Based on the category, the system selects reduced toolsets, skips unnecessary
 * operations, and uses focused prompts — saving 8K-20K tokens per turn.
 *
 * Two-phase classification:
 *   Phase 1: Heuristic pre-filter (zero LLM cost) — keyword/pattern matching
 *   Phase 2: LLM classification (only when heuristic confidence is low/medium)
 */

import { Tool } from "./tools/types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RequestCategory =
  | "conversation"   // General chat, acknowledgment, greetings
  | "question"       // Asking about code, concepts, explanations
  | "simple_edit"    // Small code change, fix, rename (<= N files)
  | "research"       // Codebase exploration, investigation
  | "complex_task"   // Major feature, refactor, architecture
  | "debug"          // Bug fixing, error investigation
  | "command";       // Direct action request

export type ClassificationConfidence = "high" | "medium" | "low";

export interface ClassificationResult {
  category: RequestCategory;
  confidence: ClassificationConfidence;
  reason: string;
  /** Whether the heuristic alone was sufficient (no LLM call needed) */
  heuristicOnly: boolean;
  /** Token cost of the classification LLM call (0 if heuristic only) */
  classificationTokens: number;
}

// ─── Heuristic Keyword Sets ─────────────────────────────────────────────────

/** Short acknowledgment / conversation tokens (exact word match) */
const CONVERSATION_EXACT: ReadonlySet<string> = new Set([
  "ok", "okay", "oke", "yes", "no", "y", "n",
  "lanjut", "lanjutkan", "coba", "proceed", "continue",
  "go", "go ahead", "sure", "yep", "yup", "nah", "nope",
  "thanks", "thank you", "thx", "terima kasih", "makasih",
  "good", "great", "nice", "cool", "awesome", "perfect",
  "done", "got it", "understood", "noted",
  "hi", "hello", "hey", "halo",
]);

/** Phrase patterns that strongly indicate conversation (matched as substring) */
const CONVERSATION_PHRASES: readonly string[] = [
  "go ahead", "let's go", "do it", "sounds good", "that's fine",
  "no problem", "alright", "fine by me", "i agree", "approved",
  "looks good", "lgtm",
];

/** Question starter words */
const QUESTION_STARTERS: readonly string[] = [
  "what", "where", "how", "why", "when", "which", "who",
  "explain", "describe", "tell me", "show me", "can you explain",
  "apa", "dimana", "bagaimana", "kenapa", "kapan",
  "is it", "is there", "are there", "does it", "do we",
  "could you", "would you",
];

/** Question indicator phrases */
const QUESTION_PHRASES: readonly string[] = [
  "what does", "what is", "how does", "how do", "how to",
  "why does", "why is", "where is", "where does",
  "can you tell", "can you show", "please explain",
  "what's the difference", "what are the",
];

/** Debug/error indicator keywords */
const DEBUG_KEYWORDS: readonly string[] = [
  "bug", "error", "fix", "broken", "fail", "failed", "failing",
  "crash", "exception", "issue", "wrong", "incorrect",
  "not working", "doesn't work", "does not work",
  "throw", "thrown", "stacktrace", "stack trace",
  "debug", "diagnose", "troubleshoot",
  "TypeError", "ReferenceError", "SyntaxError",
];

/** Research/exploration indicator keywords */
const RESEARCH_KEYWORDS: readonly string[] = [
  "find", "search", "look for", "look up", "lookup",
  "where is", "where are", "locate", "explore",
  "show me all", "list all", "find all",
  "grep", "cari", "cek", "check if",
  "investigate", "scan", "audit",
];

/** Complex task indicator keywords */
const COMPLEX_KEYWORDS: readonly string[] = [
  "implement", "create", "build", "develop", "design",
  "refactor", "restructure", "rewrite", "redesign",
  "add feature", "new feature", "migrate", "upgrade",
  "architecture", "system", "module", "integration",
  "buat", "bikin", "tambahkan", "tambah fitur",
];

// ─── Heuristic Classifier ────────────────────────────────────────────────────

/**
 * Phase 1: Heuristic pre-filter. Zero LLM cost.
 * Returns a classification with confidence level.
 */
export function classifyHeuristic(
  userInput: string,
  customKeywords?: Partial<Record<RequestCategory, string[]>>
): ClassificationResult {
  const text = typeof userInput === "string" ? userInput : "";
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const words = lower.split(/[^a-zA-Z0-9'']+/).filter(Boolean);
  const wordCount = words.length;

  // ── Ultra-short messages (1-3 words) ──────────────────────────────────
  if (wordCount <= 3) {
    // Check exact match against conversation tokens
    if (CONVERSATION_EXACT.has(lower) || words.every(w => CONVERSATION_EXACT.has(w))) {
      return {
        category: "conversation",
        confidence: "high",
        reason: `Short acknowledgment: "${trimmed}"`,
        heuristicOnly: true,
        classificationTokens: 0,
      };
    }

    // Merge custom conversation keywords
    const customConv = customKeywords?.conversation || [];
    if (customConv.some(kw => lower === kw.toLowerCase() || words.includes(kw.toLowerCase()))) {
      return {
        category: "conversation",
        confidence: "high",
        reason: `Custom conversation keyword: "${trimmed}"`,
        heuristicOnly: true,
        classificationTokens: 0,
      };
    }
  }

  // ── Conversation phrase matching ──────────────────────────────────────
  if (wordCount <= 6) {
    if (CONVERSATION_PHRASES.some(phrase => lower.includes(phrase))) {
      return {
        category: "conversation",
        confidence: "high",
        reason: `Conversation phrase detected: "${trimmed}"`,
        heuristicOnly: true,
        classificationTokens: 0,
      };
    }
  }

  // ── Question detection (high confidence for clear patterns) ───────────
  const startsWithQuestion = QUESTION_STARTERS.some(q => lower.startsWith(q));
  const hasQuestionPhrase = QUESTION_PHRASES.some(p => lower.includes(p));
  const endsWithQuestion = trimmed.endsWith("?");

  if ((startsWithQuestion && endsWithQuestion) || hasQuestionPhrase) {
    // Strong question signal: question word + question mark, or explicit question phrase
    const hasEditIntent = /\b(change|edit|modify|update|add|remove|delete|fix|replace)\b/i.test(trimmed);
    if (!hasEditIntent) {
      return {
        category: "question",
        confidence: "high",
        reason: `Question pattern: starts with question word=${startsWithQuestion}, ends with ?=${endsWithQuestion}, has phrase=${hasQuestionPhrase}`,
        heuristicOnly: true,
        classificationTokens: 0,
      };
    }
  }

  if (startsWithQuestion || endsWithQuestion) {
    return {
      category: "question",
      confidence: "medium",
      reason: `Possible question: starts with question word=${startsWithQuestion}, ends with ?=${endsWithQuestion}`,
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // ── Debug detection ───────────────────────────────────────────────────
  const debugScore = DEBUG_KEYWORDS.filter(kw => lower.includes(kw)).length;
  const customDebug = (customKeywords?.debug || []).filter(kw => lower.includes(kw.toLowerCase())).length;
  if (debugScore + customDebug >= 2) {
    return {
      category: "debug",
      confidence: "high",
      reason: `Multiple debug keywords detected (${debugScore + customDebug} matches)`,
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }
  if (debugScore + customDebug >= 1) {
    return {
      category: "debug",
      confidence: "medium",
      reason: `Debug keyword detected (${debugScore + customDebug} match)`,
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // ── Research detection ────────────────────────────────────────────────
  const researchScore = RESEARCH_KEYWORDS.filter(kw => lower.includes(kw)).length;
  const customResearch = (customKeywords?.research || []).filter(kw => lower.includes(kw.toLowerCase())).length;
  if (researchScore + customResearch >= 1 && wordCount <= 15) {
    return {
      category: "research",
      confidence: researchScore + customResearch >= 2 ? "high" : "medium",
      reason: `Research keywords detected (${researchScore + customResearch} matches)`,
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // ── Complex task detection ────────────────────────────────────────────
  const complexScore = COMPLEX_KEYWORDS.filter(kw => lower.includes(kw)).length;
  const customComplex = (customKeywords?.complex_task || []).filter(kw => lower.includes(kw.toLowerCase())).length;
  if (complexScore + customComplex >= 2 || (complexScore + customComplex >= 1 && wordCount > 15)) {
    return {
      category: "complex_task",
      confidence: complexScore + customComplex >= 2 ? "high" : "medium",
      reason: `Complex task keywords detected (${complexScore + customComplex} matches, ${wordCount} words)`,
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // ── Simple edit detection (short imperative with edit verbs) ──────────
  const editVerbs = /\b(change|edit|modify|update|rename|move|add|remove|delete|replace|insert|append|swap|toggle)\b/i;
  if (editVerbs.test(trimmed) && wordCount <= 20) {
    return {
      category: "simple_edit",
      confidence: "medium",
      reason: `Edit verb detected in short message (${wordCount} words)`,
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // ── Fallback: low confidence, needs LLM ───────────────────────────────
  return {
    category: "complex_task",
    confidence: "low",
    reason: `No strong heuristic signal (${wordCount} words)`,
    heuristicOnly: true,
    classificationTokens: 0,
  };
}

// ─── LLM Classifier ─────────────────────────────────────────────────────────

/**
 * Phase 2: LLM-based classification. Uses a compact prompt for accurate routing.
 * Only called when heuristic confidence is below threshold.
 */
export async function classifyWithLLM(
  userInput: string,
  model: any,
  heuristicResult: ClassificationResult
): Promise<ClassificationResult> {
  try {
    const { generateText } = await import("ai");

    const classificationPrompt = `Classify user request intent. Reply with EXACTLY one word from: conversation, question, simple_edit, research, complex_task, debug, command

Rules:
- conversation: greetings, acknowledgments, yes/no, thanks, approval
- question: asking about code/concepts/explanations (no file changes)
- simple_edit: small code change affecting 1-3 files
- research: codebase exploration, finding/searching, investigation
- complex_task: major feature, refactor, architecture, multi-file work
- debug: bug fixing, error investigation, troubleshooting
- command: direct action (run test, build, deploy, commit)

Heuristic guess: ${heuristicResult.category} (${heuristicResult.confidence})

User request: "${userInput.substring(0, 500)}"

Category:`;

    const response = await generateText({
      model,
      prompt: classificationPrompt,
    });

    const totalTokens = (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0);
    const rawCategory = response.text.trim().toLowerCase().replace(/[^a-z_]/g, "");

    const validCategories: RequestCategory[] = [
      "conversation", "question", "simple_edit", "research",
      "complex_task", "debug", "command",
    ];

    const category = validCategories.includes(rawCategory as RequestCategory)
      ? (rawCategory as RequestCategory)
      : heuristicResult.category;

    return {
      category,
      confidence: "high",
      reason: `LLM classification: ${rawCategory} (heuristic was: ${heuristicResult.category})`,
      heuristicOnly: false,
      classificationTokens: totalTokens,
    };
  } catch (err: any) {
    // Fallback to heuristic on LLM failure
    return {
      ...heuristicResult,
      reason: `${heuristicResult.reason} (LLM fallback: ${err.message})`,
    };
  }
}

// ─── Full Classification Pipeline ────────────────────────────────────────────

/**
 * Main classification entry point.
 * Runs heuristic first, then optionally LLM if confidence is below threshold.
 */
export async function classifyRequest(
  userInput: string | any[],
  model: any,
  options?: {
    confidenceThreshold?: ClassificationConfidence;
    customKeywords?: Partial<Record<RequestCategory, string[]>>;
    skipLLM?: boolean;
  }
): Promise<ClassificationResult> {
  // Extract text from multimodal input
  const text = typeof userInput === "string"
    ? userInput
    : (userInput as any[]).map((p: any) => p.type === "text" ? p.text : "").join(" ");

  const threshold = options?.confidenceThreshold ?? "medium";

  // Phase 1: Heuristic
  const heuristic = classifyHeuristic(text, options?.customKeywords);

  // Determine if LLM phase is needed
  const confidenceRank: Record<ClassificationConfidence, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };

  const needsLLM = !options?.skipLLM &&
    confidenceRank[heuristic.confidence] < confidenceRank[threshold] &&
    model;

  if (!needsLLM) {
    return heuristic;
  }

  // Phase 2: LLM classification
  return classifyWithLLM(text, model, heuristic);
}

// ─── Toolset Filtering ──────────────────────────────────────────────────────

/** Tool names allowed per category (null means full toolset) */
const CATEGORY_TOOLS: Record<RequestCategory, string[] | null> = {
  conversation: [],
  question: [
    "read", "glob", "grep", "ripgrep_search", "web_search", "get_skills",
    "fetch_url", "search_history", "load_pinned_session", "search_pinned_knowledge",
    "tdai_memory_search", "tdai_conversation_search", "tdai_read_cos",
  ],
  research: [
    "read", "glob", "grep", "ripgrep_search", "web_search", "fetch_url",
    "get_skills", "search_history", "load_pinned_session", "search_pinned_knowledge",
    "tdai_memory_search", "tdai_conversation_search", "tdai_read_cos",
  ],
  simple_edit: null,
  complex_task: null,
  debug: null,
  command: null,
};

/**
 * Filter a toolset based on the request category.
 * Returns null if no filtering needed (full toolset).
 */
export function getToolsetForCategory(
  category: RequestCategory,
  fullToolset: Tool[]
): Tool[] {
  const allowedNames = CATEGORY_TOOLS[category];

  // null means use full toolset
  if (allowedNames === null) {
    return fullToolset;
  }

  // Empty array means no tools
  if (allowedNames.length === 0) {
    return [];
  }

  // Filter to allowed tools only
  const nameSet = new Set(allowedNames);
  return fullToolset.filter(t => nameSet.has(t.name));
}

/**
 * Whether to skip workspace discovery for this category.
 */
export function shouldSkipWorkspaceDiscovery(category: RequestCategory): boolean {
  return category === "conversation";
}

/**
 * Whether to skip plan state injection for this category.
 */
export function shouldSkipPlanInjection(category: RequestCategory): boolean {
  return category === "conversation" || category === "question";
}

/**
 * Get a focused system prompt addendum for the category.
 * Returns empty string if no addendum needed.
 */
export function getCategoryPromptAddendum(category: RequestCategory): string {
  switch (category) {
    case "conversation":
      return `\n\nCLASSIFICATION: Conversational message detected. Respond directly without tools. Keep response concise and natural.`;
    case "question":
      return `\n\nCLASSIFICATION: Question detected. Use read-only tools if needed to answer. Do not modify any files.`;
    case "research":
      return `\n\nCLASSIFICATION: Research/exploration request. Focus on searching and reading files to gather information. Report findings.`;
    default:
      return "";
  }
}
