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

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Tool } from "./tools/types.js";
import { getSettings } from "./config/jsonConfig.js";

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
  /** Optional secondary category when classification is ambiguous */
  secondaryCategory?: RequestCategory;
  /** Optional Senopati System-1 urgency score (1.0 - 5.0) */
  urgencyScore?: number;
  /** Optional Senopati System-1 safety guardrail flag (true = destructive/blocked, false = safe) */
  isDestructive?: boolean;
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

/** Calculates Jaro-Winkler similarity between two strings. */
function getJaroWinklerSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;

  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0.0;

  const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
  const matches1 = new Array(len1).fill(false);
  const matches2 = new Array(len2).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(len2 - 1, i + matchWindow);

    for (let j = start; j <= end; j++) {
      if (matches2[j]) continue;
      if (s1[i] === s2[j]) {
        matches1[i] = true;
        matches2[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0.0;

  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!matches1[i]) continue;
    while (!matches2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3.0;

  // Winkler modification for common prefix (up to 4 chars)
  const prefixScale = 0.1;
  let prefixLen = 0;
  const maxPrefix = Math.min(4, Math.min(len1, len2));
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) {
      prefixLen++;
    } else {
      break;
    }
  }

  return jaro + prefixLen * prefixScale * (1.0 - jaro);
}

/** Calculates Levenshtein distance between two strings. */
function getLevenshteinDistance(a: string, b: string): number {
  const tmp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) {
    tmp[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) {
    tmp[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1,
        tmp[i][j - 1] + 1,
        tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return tmp[a.length][b.length];
}

/**
 * Checks if a word matches any target keywords using fuzzy Jaro-Winkler/Levenshtein similarity
 * and duplicate letter collapsing.
 */
function fuzzyMatch(word: string, targets: ReadonlySet<string>): boolean {
  if (targets.has(word)) return true;
  if (word.length < 4) return false;

  const collapsedWord = word.replace(/(.)\1+/g, "$1");

  for (const target of targets) {
    if (target.length < 4) continue;

    const collapsedTarget = target.replace(/(.)\1+/g, "$1");
    if (collapsedWord === collapsedTarget) return true;

    // Guard: exclude bad phonetic/semantic overlaps that similarity algorithms incorrectly match
    if (
      (collapsedTarget === "otomasi" && (collapsedWord === "optimasi" || collapsedWord === "optimize" || collapsedWord === "optimas")) ||
      (collapsedTarget === "makro" && collapsedWord === "mikro")
    ) {
      continue;
    }

    // Use Jaro-Winkler for quick similarity scoring on words of similar length
    if (Math.abs(collapsedWord.length - collapsedTarget.length) <= 3) {
      if (collapsedTarget === "referenceerror" && collapsedWord !== "referenceerror") {
        continue;
      }
      const jwSim = getJaroWinklerSimilarity(collapsedWord, collapsedTarget);
      if (jwSim >= 0.94) {
        return true;
      }
    }

    // Fallback to Levenshtein distance on collapsed versions if both are sufficiently long
    if (collapsedWord.length >= 5 && collapsedTarget.length >= 5) {
      const dist = getLevenshteinDistance(collapsedWord, collapsedTarget);
      const maxDist = collapsedTarget.length >= 7 ? 2 : 1;
      if (dist <= maxDist) {
        return true;
      }
    }
  }
  return false;
}

/** Calculates Soundex phonetic representation of a word. */
function getSoundex(word: string): string {
  if (!word) return "";
  const upper = word.toUpperCase();
  const first = upper[0];
  const mappings = new Map([
    ["B", "1"], ["F", "1"], ["P", "1"], ["V", "1"],
    ["C", "2"], ["G", "2"], ["J", "2"], ["K", "2"], ["Q", "2"], ["S", "2"], ["X", "2"], ["Z", "2"],
    ["D", "3"], ["T", "3"],
    ["L", "4"],
    ["M", "5"], ["N", "5"],
    ["R", "6"]
  ]);

  let code = first;
  let prevCode = mappings.get(first) || "";

  for (let i = 1; i < upper.length; i++) {
    const char = upper[i];
    if (char === "H" || char === "W") continue;
    const currentCode = mappings.get(char) || "";
    if (currentCode && currentCode !== prevCode) {
      code += currentCode;
      prevCode = currentCode;
    } else if (!currentCode) {
      prevCode = "";
    }
  }

  return (code + "000").substring(0, 4);
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
  kwPhrases: readonly string[],
  useFuzzy = false
): number {
  let count = 0;
  // O(1) per input word via Set lookup — word boundary by design
  for (const w of inputWords) {
    if (kwWords.has(w)) {
      count++;
    } else if (useFuzzy && fuzzyMatch(w, kwWords)) {
      count++;
    }
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
  // English affirmations / short replies
  "ok", "okay", "yes", "no", "y", "n",
  "proceed", "continue", "go", "sure", "yep", "yup", "nah", "nope",
  "thanks", "thank you", "thx",
  "good", "great", "nice", "cool", "awesome", "perfect", "excellent",
  "done", "got it", "understood", "noted", "got",
  "hi", "hello", "hey",
  "next", "skip", "pass",
  // English status / flow indicators
  "ongoing", "onging",
  // Indonesian affirmations / acknowledgments
  // Note: "ya" intentionally omitted — too ambiguous (variable name, Python keyword,
  // yes-answer to agent confirmation that should still route through the main loop).
  "oke", "iya", "sip", "siap", "siap bos", "siap boss",
  "lanjut", "lanjutkan",
  "mantap", "mantul", "keren", "bagus", "oke sip",
  "gas", "gass", "gassss", "gaskeun",
  "ngerti", "paham", "mengerti", "ngerti kok",
  "halo", "hai", "halo juga", "hai juga",
  "yaudah", "udah", "sudah", "udah selesai",
  "terima kasih", "makasih", "trims", "makasih ya",
  "benar", "betul", "tepat", "bener",
  "setuju", "tentu", "tentu saja", "boleh", "silakan", "silahkan",
  "ayo", "mari", "monggo",
  "ga", "gak", "enggak", "kaga", "tidak",
  "woke", "wkkwkw", "wkwk", "haha", "hehe",
  // Discussion indicators
  "diskusi", "ngobrol", "obrol",
]);

/** Phrase patterns that strongly indicate conversation (matched as substring) */
const CONVERSATION_PHRASES: readonly string[] = [
  // English
  "go ahead", "let's go", "do it", "sounds good", "that's fine",
  "no problem", "alright", "fine by me", "i agree", "approved",
  "looks good", "lgtm", "thank you very much",
  "makes sense", "got it thanks", "that works", "that's correct",
  "you're welcome", "no worries", "fair enough",
  "on going",
  // Indonesian
  "terima kasih banyak", "makasih banyak", "makasih ya",
  "oke lanjut", "lanjut aja", "silakan lanjut", "bisa lanjut",
  "oke siap", "siap bos", "siap boss",
  "oke paham", "iya paham", "sudah paham", "ngerti kok",
  "iya betul", "iya benar", "iya tepat", "oke betul",
  // Indonesian conversational questions (catch before weak question detection)
  "kamu siapa", "kamu apa", "model apa", "nama kamu", "siapa kamu",
  "apa kabar", "kamu lagi apa", "kamu pakai", "kamu pake",
  "lagu apa", "versi berapa", "umur berapa", "kamu dari mana",
  "kamu bisa apa", "kamu kerja apa", "tujuan kamu",
  "itu apa", "ini apa", "maksudnya apa",
  "oke deh lanjut", "ya udah lanjut", "gass aja",
  "sip lanjut", "gas bro",
  "diskusi aja", "cuma nanya", "cuma diskusi", "hanya diskusi",
  "kita diskusi", "mari diskusi", "mau diskusi", "mau ngobrol",
  "ngobrol aja", "cuma ngobrol",
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
  "compiler", "compile",
  "gagal", "rusak", "salah", "bermasalah", "perbaiki", "perbaikan", "benerin", "betulkan", "eror",
]);

/** Research/exploration indicator keywords — split into words + phrases */
const RESEARCH_KW = splitKeywords([
  "find", "search", "look for", "look up", "lookup",
  "where is", "where are", "locate", "explore",
  "show me all", "list all", "find all",
  "grep", "cari", "cek", "check if",
  "investigate", "scan", "temukan", "telusuri",
  "profile", "bookmarks", "history", "downloads",
]);

/** Complex task indicator keywords — split into words + phrases */
const COMPLEX_KW = splitKeywords([
  "implement", "create", "build", "develop", "design",
  "refactor", "restructure", "rewrite", "redesign",
  "add feature", "new feature", "migrate", "upgrade",
  "architecture", "system", "module", "integration",
  "buat", "bikin", "tambahkan", "tambah fitur",
  "schema", "database", "auth", "oauth", "docker", "kubernetes", "migrasi", "integrasi", "refaktor", "rancang",
  "audit", "review",
  "optimasi", "tingkatkan", "optimize",
]);

/** Command action indicator keywords — split into words + phrases */
const COMMAND_KW = splitKeywords([
  "run", "execute", "start", "stop", "test", "deploy", "commit", "push", "pull",
  "install", "pnpm", "npm", "yarn", "bun", "git", "docker", "cargo", "pip", "npx",
  // Note: "coba" removed from here — it lives in CONVERSATION_EXACT only.
  // "coba jalankan" / "coba run" is caught by other command keywords in the phrase.
  "jalankan", "jalanin", "running", "tes", "uji",
  "upload", "ulad", "post", "publish", "postkan", "posting", "kirim",
  "macro", "makro", "browser macro", "automation", "otomasi",
  "type", "click", "fill", "ketik", "klik", "isi", "input",
  "medium", "tab", "tabs", "chrome", "browser",
  // Mode switching commands
  "ganti mode", "ubah mode", "switch mode", "change mode", "pindah mode",
  "mode implement", "mode debug", "mode plan", "mode code", "mode ask",
]);

// ─── Precompiled RegExp Patterns ────────────────────────────────────────────

/** Edit verb pattern — precompiled at module level for reuse */
const EDIT_VERBS_RE = /\b(change|edit|modify|update|rename|move|add|remove|delete|replace|insert|append|swap|toggle)\b/i;

/** Edit intent pattern for question disambiguation */
const EDIT_INTENT_RE = /\b(change|edit|modify|update|add|remove|delete|fix|replace|write|create|make|run|test|execute)\b/i;

/** Match a complete identity question, not model names or embedded task text. */
const MODEL_IDENTITY_RE = /^(?:kamu|anda)\s+model\s+ap(?:a)?$/i;

/** Explicit operational requests must not lose shell access to research keywords. */
const OPERATIONAL_REQUEST_RE = /^(?:(?:please|tolong|silakan)\s+)?(?:(?:clean\s+up|cleanup|clean|delete|remove|hapus|bersihkan)\b|(?:cek|check|verify|validate)\s+runtime\b)/i;

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

  // ── Session Inspection Detection (Immediate Priority) ───────────────
  const SESSION_ID_RE = /(?:session:\s*[`"']?)?(sess_\d+_[a-zA-Z0-9]+)/i;
  const SESSION_INSPECT_KEYWORDS = /\b(cek\s+sesi|check\s+session|inspect\s+session|lihat\s+sesi|buka\s+sesi|peer\s+session|target\s+session)\b/i;
  if (SESSION_ID_RE.test(cleanLower) || SESSION_INSPECT_KEYWORDS.test(cleanLower)) {
    return {
      category: "research",
      confidence: "high",
      reason: `Session inspection request: matched session ID or session keyword in "${trimmed}"`,
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // ── Ultra-short messages (1-3 words) ──────────────────────────────────
  if (wordCount <= 3) {
    // Check exact match against conversation tokens
    if (
      CONVERSATION_EXACT.has(cleanLower) || 
      words.every(w => CONVERSATION_EXACT.has(w)) ||
      // Apply Soundex phonetic matching for short single-word affirmations
      (words.length === 1 && (
        getSoundex(cleanLower) === getSoundex("oke") ||
        getSoundex(cleanLower) === getSoundex("iya") ||
        getSoundex(cleanLower) === getSoundex("yes") ||
        getSoundex(cleanLower) === getSoundex("gas") ||
        getSoundex(cleanLower) === getSoundex("bisa") ||
        getSoundex(cleanLower) === getSoundex("boleh") ||
        getSoundex(cleanLower) === getSoundex("siap") ||
        getSoundex(cleanLower) === getSoundex("makasih") ||
        getSoundex(cleanLower) === getSoundex("betul") ||
        getSoundex(cleanLower) === getSoundex("paham") ||
        getSoundex(cleanLower) === getSoundex("mas")
      ))
    ) {
      // Guard: skip conversation if short message contains technical keywords alongside conversation tokens
      if (wordCount <= 3 && wordCount > 1) {
        const hasTechnicalWord = words.some(w => 
          COMPLEX_KW.words.has(w) || DEBUG_KW.words.has(w) || COMMAND_KW.words.has(w) || RESEARCH_KW.words.has(w)
        );
        if (hasTechnicalWord) {
          // Don't classify as conversation — fall through to other detectors
        } else {
          return {
            category: "conversation",
            confidence: "high",
            reason: `Short acknowledgment/phonetic match: "${trimmed}"`,
            heuristicOnly: true,
            classificationTokens: 0,
          };
        }
      } else {
        return {
          category: "conversation",
          confidence: "high",
          reason: `Short acknowledgment/phonetic match: "${trimmed}"`,
          heuristicOnly: true,
          classificationTokens: 0,
        };
      }
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

  // Whole-message matching keeps abbreviated identity questions out of fallback.
  if (MODEL_IDENTITY_RE.test(cleanLower)) {
    return {
      category: "conversation",
      confidence: "high",
      reason: "Assistant model identity question",
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // Cleanup and runtime validation require execution tools even when paired with "check".
  if (OPERATIONAL_REQUEST_RE.test(cleanLower)
    && /\b(cek|check|inspect|verify|validate|jalankan|run|test)\b/i.test(cleanLower)) {
    return {
      category: "command",
      confidence: "high",
      reason: "Explicit cleanup or runtime validation request",
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // ── Conversation phrase matching ──────────────────────────────────────
  const hasActionIntent = EDIT_INTENT_RE.test(cleanLower)
    || EDIT_VERBS_RE.test(cleanLower)
    || /\b(perbaiki|benerin|betulkan|jalankan|hapus|bersihkan)\b/i.test(cleanLower);
  if (wordCount <= 6 && !hasActionIntent) {
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

  // ── Pre-calculate category scores to detect ambiguities ────────────────
  const debugScore = countKeywordMatches(words, cleanLower, DEBUG_KW.words, DEBUG_KW.phrases, true);
  const customDebugKw = customKeywords?.debug ? splitKeywords(customKeywords.debug) : null;
  const customDebug = customDebugKw
    ? countKeywordMatches(words, cleanLower, customDebugKw.words, customDebugKw.phrases, true)
    : 0;
  const totalDebug = debugScore + customDebug;

  const researchScore = countKeywordMatches(words, cleanLower, RESEARCH_KW.words, RESEARCH_KW.phrases, true);
  const customResearchKw = customKeywords?.research ? splitKeywords(customKeywords.research) : null;
  const customResearch = customResearchKw
    ? countKeywordMatches(words, cleanLower, customResearchKw.words, customResearchKw.phrases, true)
    : 0;
  const totalResearch = researchScore + customResearch;

  const complexScore = countKeywordMatches(words, cleanLower, COMPLEX_KW.words, COMPLEX_KW.phrases, true);
  const customComplexKw = customKeywords?.complex_task ? splitKeywords(customKeywords.complex_task) : null;
  const customComplex = customComplexKw
    ? countKeywordMatches(words, cleanLower, customComplexKw.words, customComplexKw.phrases, true)
    : 0;
  const totalComplex = complexScore + customComplex;

  const commandScore = countKeywordMatches(words, cleanLower, COMMAND_KW.words, COMMAND_KW.phrases, true);
  const customCommandKw = customKeywords?.command ? splitKeywords(customKeywords.command) : null;
  const customCommand = customCommandKw
    ? countKeywordMatches(words, cleanLower, customCommandKw.words, customCommandKw.phrases, true)
    : 0;
  const totalCommand = commandScore + customCommand;

  // Disambiguate: question-phrased debug queries ("how do I fix this bug?") → question
  if (totalDebug <= 2 && totalDebug >= 1 && startsWithQuestion && endsWithQuestion) {
    return {
      category: "question",
      confidence: "medium",
      reason: `Question-phrased debug query: starts with question word + ends with ? + <=2 debug keywords`,
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // ── Debug detection (word-boundary safe) ───────────────────────────────
  if (totalDebug >= 2) {
    const hasConflict = totalResearch >= totalDebug || totalComplex >= totalDebug || totalCommand >= totalDebug;
    if (!hasConflict) {
      return {
        category: "debug",
        confidence: "high",
        reason: `Multiple debug keywords detected (${totalDebug} matches)`,
        heuristicOnly: true,
        classificationTokens: 0,
      };
    }
  }

  if (totalDebug >= 1) {
    const hasConflict = totalResearch >= totalDebug || totalComplex >= totalDebug || totalCommand >= totalDebug;
    if (!hasConflict) {
      return {
        category: "debug",
        confidence: "medium",
        reason: `Debug keyword detected (${totalDebug} match)`,
        heuristicOnly: true,
        classificationTokens: 0,
      };
    }
  }

  // ── Research detection (word-boundary safe) ────────────────────────────
  if (totalResearch >= 1 && wordCount <= 15) {
    const hasConflict = totalDebug >= totalResearch || totalComplex >= totalResearch || totalCommand >= totalResearch;
    if (!hasConflict) {
      return {
        category: "research",
        confidence: totalResearch >= 2 ? "high" : "medium",
        reason: `Research keywords detected (${totalResearch} matches)`,
        heuristicOnly: true,
        classificationTokens: 0,
      };
    }
  }

  // ── Complex task detection (word-boundary safe) ────────────────────────
  if (totalComplex >= 2 || (totalComplex >= 1 && wordCount > 15)) {
    const hasConflict = totalDebug >= totalComplex || totalResearch >= totalComplex || totalCommand >= totalComplex;
    if (!hasConflict) {
      return {
        category: "complex_task",
        confidence: totalComplex >= 2 ? "high" : "medium",
        reason: `Complex task keywords detected (${totalComplex} matches, ${wordCount} words)`,
        heuristicOnly: true,
        classificationTokens: 0,
      };
    }
  }

  // ── Command detection (word-boundary safe) ─────────────────────────────
  if (totalCommand >= 1) {
    const hasConflict = totalDebug >= totalCommand || totalResearch >= totalCommand || totalComplex >= totalCommand;
    if (!hasConflict) {
      return {
        category: "command",
        confidence: wordCount <= 10 ? "high" : "medium",
        reason: `Command keywords detected (${totalCommand} matches, ${wordCount} words)`,
        heuristicOnly: true,
        classificationTokens: 0,
      };
    }
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

  // ── Conversational heuristic: short Indonesian questions with personal pronouns ──
  const CONVERSATION_PRONOUNS = /\b(kamu|aku|saya|dia|kita|anda|lo|lu|gue|gw|elo)\b/i;
  if ((startsWithQuestion || endsWithQuestion) && wordCount <= 6) {
    if (CONVERSATION_PRONOUNS.test(cleanLower)) {
      return {
        category: "conversation",
        confidence: "medium",
        reason: `Short conversational question: pronoun detected (${wordCount} words)`,
        heuristicOnly: true,
        classificationTokens: 0,
      };
    }
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

  // Phase 1.5: Try statistical classifier before low-confidence fallback
  const statResult = classifyStatistical(words, cleanLower, customKeywords);
  if (statResult) {
    return statResult;
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

/**
 * Phase 1.5: Lightweight statistical classifier.
 * Evaluates category probabilities using normalized TF-IDF keyword scores.
 * Prevents unnecessary local LLM model execution for medium-length texts.
 */
function classifyStatistical(
  words: string[],
  cleanLower: string,
  customKeywords?: Partial<Record<RequestCategory, string[]>>
): ClassificationResult | null {
  const categories: RequestCategory[] = ["debug", "research", "command", "complex_task", "conversation", "question"];
  const scores: Record<RequestCategory, number> = {
    conversation: 0,
    question: 0,
    simple_edit: 0,
    debug: 0,
    research: 0,
    command: 0,
    complex_task: 0
  };

  const kwMapping: Record<RequestCategory, { words: ReadonlySet<string>; phrases: readonly string[] }> = {
    debug: DEBUG_KW,
    research: RESEARCH_KW,
    command: COMMAND_KW,
    complex_task: COMPLEX_KW,
    conversation: { words: CONVERSATION_EXACT, phrases: CONVERSATION_PHRASES },
    question: { words: new Set(QUESTION_STARTERS), phrases: QUESTION_PHRASES },
    simple_edit: { words: new Set(), phrases: [] }
  };

  let totalScore = 0;
  for (const cat of categories) {
    const kw = kwMapping[cat];
    let score = countKeywordMatches(words, cleanLower, kw.words, kw.phrases, true);
    
    // Custom keywords boost
    if (customKeywords?.[cat]) {
      const customKw = splitKeywords(customKeywords[cat]!);
      score += countKeywordMatches(words, cleanLower, customKw.words, customKw.phrases, true);
    }
    
    scores[cat] = score;
    totalScore += score;
  }

  if (totalScore >= 2) {
    let bestCategory: RequestCategory = "complex_task";
    let runnerUpCategory: RequestCategory | undefined;
    let maxScore = 0;
    let runnerUpScore = 0;

    for (const cat of categories) {
      if (scores[cat] > maxScore) {
        runnerUpScore = maxScore;
        runnerUpCategory = bestCategory;
        maxScore = scores[cat];
        bestCategory = cat;
      } else if (scores[cat] > runnerUpScore) {
        runnerUpScore = scores[cat];
        runnerUpCategory = cat;
      }
    }

    const confidenceRatio = maxScore / totalScore;
    const ratioDifference = (maxScore - runnerUpScore) / totalScore;
    let secondaryCategory: RequestCategory | undefined;
    
    if (ratioDifference < 0.3 && runnerUpCategory) {
      secondaryCategory = runnerUpCategory;
    }

    if (totalScore === 2 && confidenceRatio < 0.7 && !secondaryCategory) {
      return null;
    }

    if (confidenceRatio >= 0.7 || totalScore === 2 || secondaryCategory) {
      const confidence = (confidenceRatio >= 0.7 || (totalScore === 2 && confidenceRatio === 1.0)) ? "high" : "medium";
      return {
        category: bestCategory,
        confidence,
        reason: `Statistical TF-IDF routing totalScore=${totalScore} confidenceRatio=${confidenceRatio.toFixed(2)}`,
        heuristicOnly: true,
        classificationTokens: 0,
        ...(secondaryCategory ? { secondaryCategory } : {})
      };
    }
  }

  return null;
}

// ─── Local Senopati System-1 ONNX Classifier ──────────────────────────────────
// Architecture: Non-Autoregressive Transformer Encoder + Multi-Task RLCD
// Author & Lead Architect: Rudy Hermawan (hrudy715@gmail.com)
// Copyright (c) Rudy Hermawan. All rights reserved.

export const SENOPATI_CATEGORIES: readonly RequestCategory[] = [
  "conversation",
  "question",
  "simple_edit",
  "research",
  "complex_task",
  "debug",
  "command",
] as const;

let senopatiSession: any = null;
let senopatiVocab: { vocab_size: number; word2id: Record<string, number> } | null = null;
let senopatiBundle: { session: any; vocab: { vocab_size: number; word2id: Record<string, number> } } | null = null;
let senopatiLoadingPromise: Promise<{ session: any; vocab: { vocab_size: number; word2id: Record<string, number> } } | null> | null = null;

/**
 * Locate Senopati ONNX model and vocabulary across common repository locations.
 */
export function getSenopatiModelPaths(): { modelPath: string; vocabPath: string } | null {
  const candidates = [
    path.resolve(process.cwd(), "models", "senopati"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "models", "senopati"),
    "D:\\backup from pc asus\\Documents Development\\superagent\\models\\senopati",
    "G:\\project\\cika\\build",
  ];
  for (const dir of candidates) {
    const m = path.join(dir, "senopati_superagent.onnx");
    const v = path.join(dir, "senopati_superagent_vocab.json");
    if (fs.existsSync(m) && fs.existsSync(v)) {
      return { modelPath: m, vocabPath: v };
    }
  }
  return null;
}

/**
 * Canonical clean text parser matching SenopatiTokenizer in Rudy/Python.
 */
export function cleanSenopatiText(text: string): string[] {
  let cleaned = "";
  for (const c of text.toLowerCase()) {
    if (/[a-z0-9 _\-./$]/.test(c)) {
      cleaned += c;
    } else {
      cleaned += " ";
    }
  }
  const rawWords = cleaned.split(/\s+/).filter(w => w.length > 0);
  const words: string[] = [];
  for (const w of rawWords) {
    const stripped = w.replace(/^[ .,!?]+|[ .,!?]+$/g, "");
    if (stripped.length > 0) {
      words.push(stripped);
    }
  }
  return words;
}

/**
 * Encode raw text into sequence of token IDs (<cls> = 2, <sep> = 3, <unk> = 1).
 */
export function encodeSenopatiTokens(
  text: string,
  word2id: Record<string, number>,
  maxLen = 64
): number[] {
  const words = cleanSenopatiText(text);
  const tokens = [2]; // <cls>
  const unkId = word2id["<unk>"] ?? 1;
  for (const w of words) {
    tokens.push(word2id[w] !== undefined ? word2id[w] : unkId);
    if (tokens.length >= maxLen - 1) break;
  }
  tokens.push(3); // <sep>
  return tokens;
}

/**
 * Lazily initialize and cache the Senopati ONNX inference session.
 */
export async function getSenopatiSession(onProgress?: (event: any) => void): Promise<{
  session: any;
  vocab: { vocab_size: number; word2id: Record<string, number> };
} | null> {
  if (senopatiBundle) {
    return senopatiBundle;
  }

  if (senopatiLoadingPromise) {
    return senopatiLoadingPromise;
  }

  senopatiLoadingPromise = (async () => {
    const paths = getSenopatiModelPaths();
    if (!paths) {
      return null;
    }

    try {
      if (onProgress) {
        onProgress({
          type: "model_load",
          modelName: "senopati_onnx",
          status: "loading",
        });
      }

      const ortModule = await import("onnxruntime-node");
      const ort = (ortModule as any).default || ortModule;
      const sessionOptions = {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all" as const,
      };

      const session = await ort.InferenceSession.create(paths.modelPath, sessionOptions);
      const vocabContent = fs.readFileSync(paths.vocabPath, "utf8");
      const vocab = JSON.parse(vocabContent);

      senopatiSession = session;
      senopatiVocab = vocab;
      senopatiBundle = { session, vocab };

      if (onProgress) {
        onProgress({
          type: "model_load",
          modelName: "senopati_onnx",
          status: "loaded",
        });
      }

      return senopatiBundle;
    } catch {
      return null;
    } finally {
      senopatiLoadingPromise = null;
    }
  })();

  return senopatiLoadingPromise;
}

// ─── Micro LRU Cache for Senopati ONNX Inference ─────────────────────────
const SENOPATI_CACHE_MAX_SIZE = 256;
const senopatiLRUCache = new Map<string, ClassificationResult>();

/**
 * Clear the in-memory LRU cache for Senopati classifications.
 */
export function clearSenopatiLRUCache(): void {
  senopatiLRUCache.clear();
}

/**
 * Execute pure local System-1 classification using Senopati ONNX with Micro LRU caching.
 */
export async function classifyWithSenopatiONNX(
  text: string,
  heuristicResult?: ClassificationResult,
  onProgress?: (event: any) => void
): Promise<ClassificationResult | null> {
  const cacheKey = text.trim().toLowerCase();
  if (cacheKey.length > 0 && senopatiLRUCache.has(cacheKey)) {
    const cached = senopatiLRUCache.get(cacheKey)!;
    // Refresh LRU order
    senopatiLRUCache.delete(cacheKey);
    senopatiLRUCache.set(cacheKey, cached);
    return { ...cached, reason: `${cached.reason} [cache-hit]` };
  }

  const bundle = await getSenopatiSession(onProgress);
  if (!bundle) return null;

  const { session, vocab } = bundle;
  const tokens = encodeSenopatiTokens(text, vocab.word2id, 64);

  const ortModule = await import("onnxruntime-node");
  const ort = (ortModule as any).default || ortModule;
  const tensor = new ort.Tensor(
    "int64",
    new BigInt64Array(tokens.map(t => BigInt(t))),
    [1, tokens.length]
  );

  const feeds = { input_ids: tensor };
  const outputs = await session.run(feeds);

  const choiceProbs: number[] = Array.from(outputs.choice_probs.data);
  const scoreProbs: number[] = Array.from(outputs.score_probs.data);
  const noulProbs: number[] = Array.from(outputs.noul_probs.data);

  // Argmax category choice
  let maxIdx = 0;
  for (let i = 1; i < choiceProbs.length; i++) {
    if (choiceProbs[i] > choiceProbs[maxIdx]) {
      maxIdx = i;
    }
  }

  const category = SENOPATI_CATEGORIES[maxIdx] || "question";
  const confidenceScore = choiceProbs[maxIdx];
  const confidence: ClassificationConfidence =
    confidenceScore >= 0.60 ? "high" : confidenceScore >= 0.30 ? "medium" : "low";

  // Expected urgency score: sum((i + 1) * p_i) for i in 0..4
  let expScore = 0;
  for (let i = 0; i < scoreProbs.length; i++) {
    expScore += (i + 1) * scoreProbs[i];
  }

  // Destructive guardrail: noulProbs[1] is P(destructive)
  // Guard against false positives: questions/conversations or queries without destructive action keywords are not destructive
  const destructiveActionRegex = /\b(rm|del|delete|remove|drop|truncate|kill|destroy|format|wipe|hapus|hilangkan|bersihkan|uninstall|unlink|purge|reset\s+--hard)\b/i;
  const isQuestionOrChat = category === "conversation" || category === "question" || text.trim().endsWith("?");
  const isDestructive = !isQuestionOrChat && (noulProbs[1] > 0.5 || destructiveActionRegex.test(text));

  // Detect second-best category for secondaryCategory
  let secondIdx = -1;
  let secondProb = 0;
  for (let i = 0; i < choiceProbs.length; i++) {
    if (i !== maxIdx && choiceProbs[i] > secondProb) {
      secondProb = choiceProbs[i];
      secondIdx = i;
    }
  }
  const secondaryCategory = (secondIdx >= 0 && secondProb >= 0.20) ? SENOPATI_CATEGORIES[secondIdx] : undefined;

  const result: ClassificationResult = {
    category,
    confidence,
    reason: `Senopati ONNX System-1: ${category} (conf: ${(confidenceScore * 100).toFixed(1)}%, urgency: ${expScore.toFixed(2)}/5, risk: ${isDestructive ? "destructive" : "safe"})`,
    heuristicOnly: false,
    classificationTokens: 0,
    secondaryCategory,
    urgencyScore: expScore,
    isDestructive,
  };

  // Store in Micro LRU cache
  if (cacheKey.length > 0) {
    if (senopatiLRUCache.size >= SENOPATI_CACHE_MAX_SIZE) {
      const oldestKey = senopatiLRUCache.keys().next().value;
      if (oldestKey !== undefined) {
        senopatiLRUCache.delete(oldestKey);
      }
    }
    senopatiLRUCache.set(cacheKey, result);
  }

  return result;
}

/**
 * Clear the local classifier cache and session. Used for testing purposes.
 */
export function clearLocalClassifierCache(): void {
  senopatiSession = null;
  senopatiVocab = null;
  senopatiBundle = null;
  senopatiLoadingPromise = null;
  clearSenopatiLRUCache();
}

/**
 * Maps the structured output of Supra-Router-51M telemetry into Superagent's RequestCategory.
 */
export function mapSupraTelemetryToCategory(
  telemetry: string,
  heuristicCategory: RequestCategory
): RequestCategory {
  const lower = telemetry.toLowerCase();

  // Gibberish / Degeneration Check:
  const hasFormat = lower.includes("complexity:") || lower.includes("route:") || lower.includes("code:") || lower.includes("domain:");
  if (!hasFormat) {
    return heuristicCategory;
  }

  const isCode = lower.includes("code: true") || lower.includes("domain: programming") || lower.includes("domain: code");
  const isMath = lower.includes("math: true");
  const isBigModel = lower.includes("route: big model") || lower.includes("route: cloud");

  const complexityMatch = lower.match(/complexity:\s*([1-5])/);
  const complexity = complexityMatch ? parseInt(complexityMatch[1], 10) : 1;

  // 1. If it's classified as programming/code-related
  if (isCode) {
    if (isBigModel || complexity >= 4) {
      if (heuristicCategory === "debug") {
        return "debug";
      }
      return "complex_task";
    } else {
      if (heuristicCategory === "command") {
        return "command";
      }
      return "simple_edit";
    }
  }

  // 2. If high complexity or math-intensive task
  if (isBigModel || complexity >= 3) {
    if (heuristicCategory === "research" || lower.includes("domain: research") || lower.includes("domain: search")) {
      return "research";
    }
    if (heuristicCategory === "debug" || heuristicCategory === "complex_task" || heuristicCategory === "simple_edit" || heuristicCategory === "command") {
      return heuristicCategory;
    }
    return "research";
  }

  // 3. Keep conversation classification if heuristic is conversation
  if (heuristicCategory === "conversation") {
    return "conversation";
  }

  // 4. If the heuristic was action-oriented, do not downgrade to question
  if (
    heuristicCategory === "debug" ||
    heuristicCategory === "simple_edit" ||
    heuristicCategory === "command" ||
    heuristicCategory === "complex_task"
  ) {
    if (heuristicCategory === "command") return "command";
    if (heuristicCategory === "debug") return "debug";
    return "simple_edit";
  }

  // 5. Default to question for low complexity read-only queries
  return "question";
}

/**
 * Warm up/pre-load the local classifier model in the background.
 * Call this during app startup to eliminate first-use classification delay.
 */
export function isLocalClassifierLoaded(): boolean {
  return senopatiSession !== null;
}

export async function warmUpClassifier(onProgress?: (event: any) => void): Promise<void> {
  const settings = getSettings();
  if (settings.classifierEnabled === false) return;
  try {
    let progressCb = onProgress;
    if (!progressCb) {
      try {
        const { getProgressCallback } = await import("./tools/state.js");
        const cb = getProgressCallback();
        if (cb) progressCb = cb;
      } catch {}
    }

    // Warm up pure native Senopati ONNX session (<1ms startup, zero download)
    await getSenopatiSession(progressCb);
  } catch {
    // Ignore warm-up failure (will retry on demand)
  }
}

/**
 * Phase 2: Local classification.
 * Prioritizes native Senopati ONNX model (zero external download, <1ms inference).
 */
export async function classifyWithLLM(
  userInput: string,
  model?: any,
  heuristicResult?: ClassificationResult,
  onProgress?: (event: any) => void
): Promise<ClassificationResult> {
  try {
    let progressCb = onProgress;
    if (!progressCb) {
      try {
        const { getProgressCallback } = await import("./tools/state.js");
        const cb = getProgressCallback();
        if (cb) progressCb = cb;
      } catch {}
    }

    const dummyHeuristic: ClassificationResult = heuristicResult || {
      category: "question",
      confidence: "low",
      reason: "Direct Senopati classification",
      heuristicOnly: false,
      classificationTokens: 0,
    };

    // Pure Senopati ONNX execution (production, CLI, runtime)
    const senopatiResult = await classifyWithSenopatiONNX(userInput, dummyHeuristic, progressCb);
    if (senopatiResult) {
      return senopatiResult;
    }

    return dummyHeuristic;
  } catch (err: any) {
    // Fallback to heuristic on local model failure
    return {
      ...(heuristicResult || {
        category: "question",
        confidence: "low",
        reason: "Direct Senopati classification failed",
        heuristicOnly: false,
        classificationTokens: 0,
      }),
      reason: `Senopati Classifier failed: ${err.message}`,
    };
  }
}

// ─── Full Classification Pipeline ────────────────────────────────────────────

/**
 * Main classification entry point.
 * By default, bypasses regex heuristics entirely and runs Senopati System-1 ONNX neural classification directly.
 * Regex heuristics are disabled by default as requested (useHeuristic: false).
 */
export async function classifyRequest(
  userInput: string | any[],
  model?: any,
  options?: {
    confidenceThreshold?: ClassificationConfidence;
    customKeywords?: Partial<Record<RequestCategory, string[]>>;
    skipLLM?: boolean;
    useHeuristic?: boolean; // Regex heuristics toggle (OFF by default)
    onProgress?: (event: any) => void;
  }
): Promise<ClassificationResult> {
  // Extract text from multimodal input
  const text = typeof userInput === "string"
    ? userInput
    : (userInput as any[]).map((p: any) => p.type === "text" ? p.text : "").join(" ");

  const trimmedText = text.trim();

  // If input is empty/whitespace, classify as conversation immediately (no neural pass needed)
  if (!trimmedText) {
    return {
      category: "conversation",
      confidence: "high",
      reason: "Empty or whitespace-only input",
      heuristicOnly: true,
      classificationTokens: 0,
    };
  }

  // If caller explicitly requested regex heuristic mode:
  if (options?.useHeuristic === true) {
    const threshold = options?.confidenceThreshold ?? "high";
    const heuristicResult = classifyHeuristic(text, options?.customKeywords);

    // If heuristic confidence meets threshold, skip local model entirely
    if (meetsThreshold(heuristicResult.confidence, threshold)) {
      return heuristicResult;
    }

    // Secondary local classification for low-confidence heuristic results
    if (!options?.skipLLM) {
      return classifyWithLLM(text, model, heuristicResult, options?.onProgress);
    }

    // Fallback to heuristic when local model is unavailable or skipped
    return heuristicResult;
  }

  // DEFAULT ROUTE: PURE SENOPATI SYSTEM-1 ONNX NEURAL CLASSIFIER (REGEX DISABLED)
  try {
    const senopatiResult = await classifyWithSenopatiONNX(text, undefined, options?.onProgress);
    if (senopatiResult) {
      return senopatiResult;
    }
  } catch (err: any) {
    // Graceful fallback if ONNX engine throws
  }

  // Fallback to heuristic only if Senopati ONNX model cannot be loaded
  const fallbackResult = classifyHeuristic(text, options?.customKeywords);
  return {
    ...fallbackResult,
    reason: `${fallbackResult.reason} (Senopati fallback)`,
  };
}

// ─── Toolset Filtering ──────────────────────────────────────────────────────

/** Tool names allowed per category (null means full toolset) */
const CATEGORY_TOOLS: Record<RequestCategory, string[] | null> = {
  conversation: ["switch_mode"],
  question: [
    "switch_mode",
    "read", "glob", "grep", "ripgrep_search", "web_search", "get_skills", "use_skill",
    "fetch_url", "search_history", "load_pinned_session", "search_pinned_knowledge",
    "rmemory_search", "rmemory_conversation_search", "rmemory_read_cos", "ask_question",
    "read_shared_memory", "inspect_session",
    "list_chrome_profiles", "get_active_browser_tabs", "chrome_extension_status",
    "manage_chrome_bookmarks", "manage_chrome_history", "list_chrome_extensions",
    "get_browser_console_logs", "get_browser_network_logs", "manage_chrome_downloads",
    "extract_page_content_markdown", "capture_tab_fullpage_pdf",
    "control_browser_tab", "control_browser_macro_save", "control_browser_macro_run",
    "run_headless_browser", "simulate_virtual_cursor", "control_isolated_cdp",
    "manage_browser_cookies_storage", "set_browser_emulation", "set_network_conditions"
  ],
  research: [
    "switch_mode",
    "read", "glob", "grep", "ripgrep_search", "web_search", "fetch_url",
    "get_skills", "use_skill", "search_history", "load_pinned_session", "search_pinned_knowledge",
    "rmemory_search", "rmemory_conversation_search", "rmemory_read_cos", "ask_question",
    "read_shared_memory", "inspect_session",
    "list_chrome_profiles", "get_active_browser_tabs", "chrome_extension_status",
    "manage_chrome_bookmarks", "manage_chrome_history", "list_chrome_extensions",
    "get_browser_console_logs", "get_browser_network_logs", "manage_chrome_downloads",
    "extract_page_content_markdown", "capture_tab_fullpage_pdf",
    "control_browser_tab", "control_browser_macro_save", "control_browser_macro_run",
    "run_headless_browser", "simulate_virtual_cursor", "control_isolated_cdp",
    "manage_browser_cookies_storage", "set_browser_emulation", "set_network_conditions"
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
  // Mode-specific instructions handled by activeModeNotice in ContextBuilder.
  switch (category) {
    case "conversation":
      return `\n\nCLASSIFICATION: conversation`;
    case "question":
      return `\n\nCLASSIFICATION: question`;
    case "research":
      return `\n\nCLASSIFICATION: research`;
    default:
      return "";
  }
}

/**
 * Get a focused system prompt addendum for the classification result,
 * incorporating category, urgency score, and destructive safety alerts from Senopati System-1.
 * Author / Model Architecture Credit: Rudy Hermawan <hrudy715@gmail.com>
 */
export function getClassificationPromptAddendum(classification: ClassificationResult): string {
  const parts: string[] = [];
  const category = classification.category;

  switch (category) {
    case "conversation":
      parts.push("CLASSIFICATION: conversation");
      if (classification.urgencyScore !== undefined && classification.urgencyScore <= 1.5) {
        parts.push("Tone: Friendly, concise, casual conversation. No code modifications or tools needed.");
      }
      break;
    case "question":
      parts.push("CLASSIFICATION: question");
      break;
    case "research":
      parts.push("CLASSIFICATION: research");
      break;
    case "command":
      parts.push("CLASSIFICATION: command");
      break;
    case "simple_edit":
      parts.push("CLASSIFICATION: simple_edit");
      break;
    case "debug":
      parts.push("CLASSIFICATION: debug");
      break;
    case "complex_task":
      parts.push("CLASSIFICATION: complex_task");
      break;
  }

  if (classification.urgencyScore !== undefined && classification.urgencyScore >= 4.0) {
    parts.push(`[URGENCY HIGH: ${classification.urgencyScore.toFixed(1)}/5.0] Prioritize direct, high-impact resolution with minimal roundtrips.`);
  }

  if (classification.isDestructive) {
    parts.push(`[SENOPATI AI SYSTEM-1: DESTRUCTIVE SAFETY GUARD TRIGGERED] This request involves irreversible or destructive operations (Urgency: ${(classification.urgencyScore ?? 5.0).toFixed(1)}/5). Do NOT execute without explicit user approval.`);
  }

  return parts.length > 0 ? `\n\n${parts.join("\n")}` : "";
}

/**
 * Checks whether a shell/terminal command is destructive, using Senopati ONNX guardrail
 * combined with critical fast regex safeguards (e.g. rm -rf, git reset --hard, format, dd).
 * Powered by Senopati Neural Engine (Credit: Rudy Hermawan <hrudy715@gmail.com>).
 */
export async function isDestructiveCommand(cmd: string): Promise<boolean> {
  const trimmed = (cmd || "").trim();
  if (!trimmed) return false;

  // 1. Fast regex safety check for undeniable dangerous shell patterns
  const dangerousRegex = /(rm\s+(-rf|-fr|-r\s+-f|-f\s+-r)\s+[/~*]|git\s+reset\s+--hard|git\s+clean\s+-f[xd]*|mkfs|dd\s+if=|drop\s+database|format\s+[c-z]:)/i;
  if (dangerousRegex.test(trimmed)) {
    return true;
  }

  // 2. Senopati Neural Guardrail System-1 evaluation
  try {
    const res = await classifyWithSenopatiONNX(trimmed);
    if (res?.isDestructive === true) {
      return true;
    }
  } catch {}

  return false;
}

/**
 * Commands that indicate the user wants to continue or proceed with ongoing work or tasks.
 * When prior conversation exists, these must never be short-circuited by conversational fast-path.
 */
export const CONTINUATION_COMMANDS: ReadonlySet<string> = new Set([
  "lanjut", "lanjutkan", "continue", "proceed", "next", "go", "gas", "gass", "gaskeun",
  "ayo", "mari", "do it", "silakan", "silahkan", "jalan", "jalankan", "lakukan", "teruskan",
  "gas bro", "lanjut bos", "lanjut boss", "lanjutkan bos", "lanjutkan boss",
  "ganti mode", "ubah mode", "switch mode", "change mode", "pindah mode",
  "mode implement", "mode debug", "mode plan", "mode code", "mode ask",
]);

/**
 * Returns true when the classification is a high-confidence conversational
 * message that qualifies for the fast-path response (no full agent loop).
 *
 * Fast-path is only activated for the top-level single/master tier
 * (never for superagent/subagent which are task-driven, not conversational).
 */
export function isHighConfidenceConversation(
  classification: ClassificationResult,
  tier: string,
  planState?: string,
  hasPriorMessages: boolean = false,
  userInput?: string
): boolean {
  if (planState && planState !== "IDLE") {
    return false;
  }
  if (userInput) {
    const text = typeof userInput === "string" ? userInput : "";
    if (/\b(?:ganti|ubah|switch|change|pindah)\s+mode\b/i.test(text)) {
      return false;
    }
    if (hasPriorMessages) {
      const cleanLower = text.toLowerCase().replace(PUNCTUATION_STRIP_RE, "").trim();
      if (CONTINUATION_COMMANDS.has(cleanLower)) {
        return false;
      }
    }
  }
  return (
    classification.category === "conversation" &&
    classification.confidence === "high" &&
    (tier === "single" || tier === "master")
  );
}
