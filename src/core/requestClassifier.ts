/**
 * requestClassifier.ts — Multi-category request classification for token optimization.
 *
 * Classifies user requests BEFORE the main agent loop to determine intent category.
 * Based on the category, the system selects reduced toolsets, skips unnecessary
 * operations, and uses focused prompts — saving 8K-20K tokens per turn.
 *
 * Two-phase classification:
 *   Phase 1: Heuristic pre-filter (zero LLM cost) — keyword/pattern matching
 *   Phase 2: LLM classification (only when heuristic confidence is below threshold)
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

// ─── Confidence Threshold Helper ────────────────────────────────────────────

const CONFIDENCE_RANK: Record<ClassificationConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Check if a given confidence level meets or exceeds the threshold.
 * Example: meetsThreshold("high", "medium") => true
 *          meetsThreshold("low", "high") => false
 */
export function meetsThreshold(
  confidence: ClassificationConfidence,
  threshold: ClassificationConfidence
): boolean {
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[threshold];
}

// ─── Word Boundary Matching Utilities ───────────────────────────────────────

/**
 * Build a Set of single words for O(1) lookup from a keyword list.
 * Multi-word phrases are separated out into a parallel array.
 */
function splitKeywords(keywords: readonly string[]): {
  words: ReadonlySet<string>;
  phrases: readonly string[];
} {
  const words = new Set<string>();
  const phrases: string[] = [];
  for (const kw of keywords) {
    if (kw.includes(" ")) {
      phrases.push(kw);
    } else {
      words.add(kw.toLowerCase());
    }
  }
  return { words, phrases };
}

/**
 * Count matches using word-boundary matching for single words (O(1) per word)
 * and substring matching for multi-word phrases.
 * Prevents false positives like "error" matching inside "terrorist".
 */
function countKeywordMatches(
  inputWords: readonly string[],
  lowerInput: string,
  kwWords: ReadonlySet<string>,
  kwPhrases: readonly string[]
): number {
  let count = 0;
  // O(1) per input word via Set lookup — word boundary by design
  for (const w of inputWords) {
    if (kwWords.has(w)) count++;
  }
  // Phrase matching via substring (phrases inherently have word boundaries)
  for (const phrase of kwPhrases) {
    if (lowerInput.includes(phrase)) count++;
  }
  return count;
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
  "looks good", "lgtm", "thank you very much", "terima kasih banyak", "makasih banyak",
];

/** Question starter words */
const QUESTION_STARTERS: readonly string[] = [
  "what", "where", "how", "why", "when", "which", "who",
  "explain", "describe", "tell me", "show me", "can you explain",
  "apa", "dimana", "bagaimana", "kenapa", "kapan", "apakah", "siapa", "siapakah", "mengapa",
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

/** Debug/error indicator keywords — split into words + phrases */
const DEBUG_KW = splitKeywords([
  "bug", "error", "fix", "broken", "fail", "failed", "failing",
  "crash", "exception", "issue", "wrong", "incorrect",
  "not working", "doesn't work", "does not work",
  "throw", "thrown", "stacktrace", "stack trace",
  "debug", "diagnose", "troubleshoot",
  "typeerror", "referenceerror", "syntaxerror",
  "gagal", "rusak", "salah", "bermasalah",
]);

/** Research/exploration indicator keywords — split into words + phrases */
const RESEARCH_KW = splitKeywords([
  "find", "search", "look for", "look up", "lookup",
  "where is", "where are", "locate", "explore",
  "show me all", "list all", "find all",
  "grep", "cari", "cek", "check if",
  "investigate", "scan", "audit", "temukan", "telusuri",
]);

/** Complex task indicator keywords — split into words + phrases */
const COMPLEX_KW = splitKeywords([
  "implement", "create", "build", "develop", "design",
  "refactor", "restructure", "rewrite", "redesign",
  "add feature", "new feature", "migrate", "upgrade",
  "architecture", "system", "module", "integration",
  "buat", "bikin", "tambahkan", "tambah fitur",
  "schema", "database", "auth", "oauth", "docker", "kubernetes", "migrasi", "integrasi", "refaktor", "rancang",
]);

/** Command action indicator keywords — split into words + phrases */
const COMMAND_KW = splitKeywords([
  "run", "execute", "start", "stop", "test", "deploy", "commit", "push", "pull",
  "install", "pnpm", "npm", "yarn", "bun", "git", "docker", "cargo", "pip", "npx",
  "jalankan", "jalanin", "coba", "running", "runnign", "tes", "uji",
]);

// ─── Precompiled RegExp Patterns ────────────────────────────────────────────

/** Edit verb pattern — precompiled at module level for reuse */
const EDIT_VERBS_RE = /\b(change|edit|modify|update|rename|move|add|remove|delete|replace|insert|append|swap|toggle)\b/i;

/** Edit intent pattern for question disambiguation */
const EDIT_INTENT_RE = /\b(change|edit|modify|update|add|remove|delete|fix|replace|write|create|make|run|test|execute)\b/i;

/** Punctuation strip pattern for exact matching */
const PUNCTUATION_STRIP_RE = /^[!?.,\s()'""-]+|[!?.,\s()'""-]+$/g;

/** Word split pattern */
const WORD_SPLIT_RE = /[^a-zA-Z0-9']+/;

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

  // Clean punctuation from start/end of string for exact matching
  const cleanLower = lower.replace(PUNCTUATION_STRIP_RE, "").trim();
  const words = cleanLower.split(WORD_SPLIT_RE).filter(Boolean);
  const wordCount = words.length;

  // ── Ultra-short messages (1-3 words) ──────────────────────────────────
  if (wordCount <= 3) {
    // Check exact match against conversation tokens
    if (CONVERSATION_EXACT.has(cleanLower) || words.every(w => CONVERSATION_EXACT.has(w))) {
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
    if (customConv.some(kw => cleanLower === kw.toLowerCase() || words.includes(kw.toLowerCase()))) {
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
    if (CONVERSATION_PHRASES.some(phrase => cleanLower.includes(phrase))) {
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
  const startsWithQuestion = QUESTION_STARTERS.some(q => cleanLower.startsWith(q));
  const hasQuestionPhrase = QUESTION_PHRASES.some(p => cleanLower.includes(p));
  const endsWithQuestion = cleanLower.endsWith("?") || trimmed.endsWith("?");

  if ((startsWithQuestion && endsWithQuestion) || hasQuestionPhrase) {
    // Strong question signal: question word + question mark, or explicit question phrase
    if (!EDIT_INTENT_RE.test(trimmed)) {
      return {
        category: "question",
        confidence: "high",
        reason: `Question pattern: starts with question word=${startsWithQuestion}, ends with ?=${endsWithQuestion}, has phrase=${hasQuestionPhrase}`,
        heuristicOnly: true,
        classificationTokens: 0,
      };
    }
  }

  // ── Debug detection (word-boundary safe) ───────────────────────────────
  const debugScore = countKeywordMatches(words, cleanLower, DEBUG_KW.words, DEBUG_KW.phrases);
  const customDebugKw = customKeywords?.debug ? splitKeywords(customKeywords.debug) : null;
  const customDebug = customDebugKw
    ? countKeywordMatches(words, cleanLower, customDebugKw.words, customDebugKw.phrases)
    : 0;
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

  // ── Research detection (word-boundary safe) ────────────────────────────
  const researchScore = countKeywordMatches(words, cleanLower, RESEARCH_KW.words, RESEARCH_KW.phrases);
  const customResearchKw = customKeywords?.research ? splitKeywords(customKeywords.research) : null;
  const customResearch = customResearchKw
    ? countKeywordMatches(words, cleanLower, customResearchKw.words, customResearchKw.phrases)
    : 0;
  if (researchScore + customResearch >= 1 && wordCount <= 15) {
    return {
      category: "research",
      confidence: researchScore + customResearch >= 2 ? "high" : "medium",
      reason: `Research keywords detected (${researchScore + customResearch} matches)`,
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // ── Complex task detection (word-boundary safe) ────────────────────────
  const complexScore = countKeywordMatches(words, cleanLower, COMPLEX_KW.words, COMPLEX_KW.phrases);
  const customComplexKw = customKeywords?.complex_task ? splitKeywords(customKeywords.complex_task) : null;
  const customComplex = customComplexKw
    ? countKeywordMatches(words, cleanLower, customComplexKw.words, customComplexKw.phrases)
    : 0;
  if (complexScore + customComplex >= 2 || (complexScore + customComplex >= 1 && wordCount > 15)) {
    return {
      category: "complex_task",
      confidence: complexScore + customComplex >= 2 ? "high" : "medium",
      reason: `Complex task keywords detected (${complexScore + customComplex} matches, ${wordCount} words)`,
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // ── Command detection (word-boundary safe) ─────────────────────────────
  const commandScore = countKeywordMatches(words, cleanLower, COMMAND_KW.words, COMMAND_KW.phrases);
  const customCommandKw = customKeywords?.command ? splitKeywords(customKeywords.command) : null;
  const customCommand = customCommandKw
    ? countKeywordMatches(words, cleanLower, customCommandKw.words, customCommandKw.phrases)
    : 0;
  if (commandScore + customCommand >= 1) {
    return {
      category: "command",
      confidence: wordCount <= 10 ? "high" : "medium",
      reason: `Command keywords detected (${commandScore + customCommand} matches, ${wordCount} words)`,
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // ── Simple edit detection (short imperative with edit verbs) ──────────
  if (EDIT_VERBS_RE.test(trimmed) && wordCount <= 20) {
    return {
      category: "simple_edit",
      confidence: "medium",
      reason: `Edit verb detected in short message (${wordCount} words)`,
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // ── Weak/Possible question detection (Moved to bottom to prevent hijacking) ──
  if (startsWithQuestion || endsWithQuestion) {
    return {
      category: "question",
      confidence: "medium",
      reason: `Possible question: starts with question word=${startsWithQuestion}, ends with ?=${endsWithQuestion}`,
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

    // Compact prompt — optimized for minimal token usage
    const classificationPrompt = `Classify intent. Reply ONE word: conversation|question|simple_edit|research|complex_task|debug|command.
Rules: conversation=greetings/ack/yes/no/thanks. question=ask about code/concepts,NO edits. simple_edit=minor changes 1-3 files. research=search/find/explore. complex_task=major features/refactor/migration. debug=bug fix/error resolution. command=run/build/deploy/commit.
Compound requests: pick category requiring tools (debug/complex_task/command) over read-only (question/research).
Heuristic: ${heuristicResult.category}(${heuristicResult.confidence})
Input: "${userInput.substring(0, 400)}"
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
 *
 * Optimization: When the heuristic returns confidence >= threshold, the LLM
 * call is skipped entirely, saving tokens and latency.
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

  const trimmedText = text.trim();

  // If input is empty/whitespace, classify as conversation immediately (no LLM call needed)
  if (!trimmedText) {
    return {
      category: "conversation",
      confidence: "high",
      reason: "Empty or whitespace-only input",
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  const threshold = options?.confidenceThreshold ?? "high";

  // Phase 1: Always run heuristic first (zero cost)
  const heuristicResult = classifyHeuristic(text, options?.customKeywords);

  // If heuristic confidence meets threshold, skip LLM entirely
  if (meetsThreshold(heuristicResult.confidence, threshold)) {
    return heuristicResult;
  }

  // Phase 2: LLM classification for low-confidence heuristic results
  if (!options?.skipLLM && model) {
    return classifyWithLLM(text, model, heuristicResult);
  }

  // Fallback to heuristic when LLM is unavailable or skipped
  return heuristicResult;
}

// ─── Toolset Filtering ──────────────────────────────────────────────────────

/** Tool names allowed per category (null means full toolset) */
const CATEGORY_TOOLS: Record<RequestCategory, string[] | null> = {
  conversation: [],
  question: [
    "read", "glob", "grep", "ripgrep_search", "web_search", "get_skills",
    "fetch_url", "search_history", "load_pinned_session", "search_pinned_knowledge",
    "rmemory_search", "rmemory_conversation_search", "rmemory_read_cos",
  ],
  research: [
    "read", "glob", "grep", "ripgrep_search", "web_search", "fetch_url",
    "get_skills", "search_history", "load_pinned_session", "search_pinned_knowledge",
    "rmemory_search", "rmemory_conversation_search", "rmemory_read_cos",
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
