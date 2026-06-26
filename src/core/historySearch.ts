import fs from "fs";
import path from "path";
import { generateText } from "ai";
import { listHistorySessions, getModelInstance, getConfig, getSettings } from "./config.js";
import { rateLimiter, concurrencyLimiter } from "./rateLimiter.js";

/**
 * Custom subsequence fuzzy matching and token-based scoring algorithm.
 * Returns a score between 0.0 (no match) and 1.0 (exact match).
 */
export function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase();

  if (t.includes(q)) return 1.0;

  const words = q.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  let matches = 0;
  for (const word of words) {
    if (t.includes(word)) {
      matches += 1.0;
    } else {
      let lastIdx = -1;
      let possibleMatch = true;
      for (let j = 0; j < word.length; j++) {
        const idx = t.indexOf(word[j], lastIdx + 1);
        if (idx === -1) {
          possibleMatch = false;
          break;
        }
        lastIdx = idx;
      }
      if (possibleMatch) {
        matches += 0.5;
      }
    }
  }

  return matches / words.length;
}

/**
 * Filter out verbose tool output logs to save 90-95% of token context.
 */
export function cleanTranscriptForLLM(messages: any[]): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content || ""}`)
    .join("\n\n");
}

interface HistorySearchCacheEntry {
  mtimeMs: number;
  messages: Array<{ role: string; content: string }>;
  dialogueText: string;
}

const historySearchCache = new Map<string, HistorySearchCacheEntry>();

interface SemanticSearchCacheEntry {
  sig: string;
  result: string;
}

const semanticSearchCache = new Map<string, SemanticSearchCacheEntry>();

/**
 * Clear the in-memory semantic search cache.
 */
export function clearSemanticSearchCache(): void {
  semanticSearchCache.clear();
}

/**
 * Perform a hybrid AI-powered semantic search with an offline fuzzy fallback.
 * @param query - The search query
 * @param isMulti - Whether to search multi-agent sessions
 * @param crossSession - If true, search ALL sessions regardless of working directory
 */
export async function searchHistory(
  query: string,
  isMulti = false,
  crossSession = false,
  onDebug?: (msg: string) => void
): Promise<string> {
  if (onDebug) {
    onDebug(`[DEBUG] Starting history search for query: "${query}" (isMulti: ${isMulti}, crossSession: ${crossSession})`);
  }
  const sessions = listHistorySessions(isMulti, crossSession);
  if (onDebug) {
    onDebug(`[DEBUG] Found ${sessions.length} total history sessions.`);
  }
  if (sessions.length === 0) {
    return crossSession
      ? "No conversation history sessions found across any sessions."
      : "No conversation history sessions found in the workspace.";
  }

  const config = getConfig();

  // Generate cache signature from sessions paths and modification times
  const sig = sessions
    .map((s) => `${s.filePath}:${s.lastModified.getTime()}`)
    .join("|");
  const cacheKey = `${query}:${isMulti}:${crossSession}:${config.model || ""}:${config.provider || ""}`;
  const cachedEntry = semanticSearchCache.get(cacheKey);
  if (cachedEntry && cachedEntry.sig === sig) {
    if (onDebug) {
      onDebug(`[DEBUG] Cache hit for query: "${query}". Returning cached results.`);
    }
    return cachedEntry.result;
  }

  const scoredSessions: Array<{
    session: any;
    messages: any[];
    dialogueText: string;
    score: number;
  }> = [];

  const promises = sessions.map(async (session) => {
    try {
      const mtimeMs = session.lastModified.getTime();
      const cached = historySearchCache.get(session.filePath);

      let messages: any[];
      let dialogueText: string;

      if (cached && cached.mtimeMs === mtimeMs) {
        messages = cached.messages;
        dialogueText = cached.dialogueText;
      } else {
        const raw = await fs.promises.readFile(session.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
          messages = parsed.messages;
        } else if (Array.isArray(parsed)) {
          messages = parsed;
        } else {
          return;
        }

        dialogueText = cleanTranscriptForLLM(messages);

        // Cache it, saving only role and content of messages to keep memory low
        historySearchCache.set(session.filePath, {
          mtimeMs,
          messages: messages.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : String(m.content || ""),
          })),
          dialogueText,
        });
      }

      const score = fuzzyScore(dialogueText, query);
      if (score > 0) {
        scoredSessions.push({
          session,
          messages,
          dialogueText,
          score,
        });
      }
    } catch {
      // Ignore corrupted or missing files
    }
  });

  await Promise.all(promises);

  // Sort: highest score first, then most recently modified first
  scoredSessions.sort(
    (a, b) =>
      b.score - a.score ||
      b.session.lastModified.getTime() - a.session.lastModified.getTime()
  );

  if (onDebug) {
    onDebug(`[DEBUG] Scored ${scoredSessions.length} session(s) using subsequence fuzzy matching:`);
    for (const item of scoredSessions.slice(0, 5)) {
      const pct = Math.round(item.score * 100);
      onDebug(`  - 📁 ${item.session.displayName} (Fuzzy Match: ${pct}%, last modified: ${item.session.lastModified.toISOString()})`);
    }
  }

  // Generate offline fuzzy search fallback text
  const generateFuzzyFallbackText = () => {
    if (scoredSessions.length === 0) {
      return `No matches found for query: "${query}"`;
    }
    const lines = [
      `[OFFLINE FUZZY SEARCH] Found ${scoredSessions.length} matching session(s) for "${query}":`,
      "",
    ];
    for (const item of scoredSessions.slice(0, 5)) {
      const pct = Math.round(item.score * 100);
      lines.push(`📁 ${item.session.displayName} (Match: ${pct}%)`);
      const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matchedTurns: string[] = [];
      for (const msg of item.messages) {
        if ((msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string") {
          const contentLower = msg.content.toLowerCase();
          if (queryWords.some((word) => contentLower.includes(word))) {
            const cleaned = msg.content.replace(/\r?\n/g, " ");
            const truncated =
              cleaned.length > 90 ? cleaned.slice(0, 87) + "..." : cleaned;
            matchedTurns.push(`      [${msg.role.toUpperCase()}] ${truncated}`);
            if (matchedTurns.length >= 3) break;
          }
        }
      }
      lines.push(matchedTurns.join("\n"));
      lines.push("");
    }
    return lines.join("\n").trim();
  };

  const hasApiKey = !!config.apiKey;

  if (!hasApiKey) {
    if (onDebug) {
      onDebug("[DEBUG] No API key configured. Skipping AI Semantic Search.");
    }
    const fallback = generateFuzzyFallbackText();
    semanticSearchCache.set(cacheKey, { sig, result: fallback });
    return fallback;
  }

  try {
    const model = getModelInstance();
    if (onDebug) {
      onDebug(`[DEBUG] API key configured. Using model: ${model?.modelId || "unknown"}`);
    }

    // AI Semantic Filtering - Slice increased to 10 for broader pool
    const candidates = scoredSessions.slice(0, 10).map((item, idx) => ({
      index: idx,
      displayName: item.session.displayName,
      preview: item.session.preview,
      messageCount: item.session.messageCount,
      lastModified: item.session.lastModified.toISOString(),
    }));

    if (onDebug) {
      onDebug(`[DEBUG] Top ${candidates.length} candidates for AI semantic filtering:\n${JSON.stringify(candidates, null, 2)}`);
    }

    if (candidates.length === 0) {
      const emptyResult = `No matches found in history for query: "${query}"`;
      semanticSearchCache.set(cacheKey, { sig, result: emptyResult });
      return emptyResult;
    }

    const filterPrompt = `You are a developer assistant analyzing past coding session logs.
The developer is searching for context about: "${query}".

Here is a list of top candidate past conversation sessions:
${JSON.stringify(candidates, null, 2)}

Identify the indices of the sessions (up to 3) that are semantically relevant to the developer's search query.
Return ONLY a JSON array of numbers representing the relevant session indices. Example: [0, 2]
If no sessions are relevant, return an empty array: []`;

    if (onDebug) {
      onDebug(`[DEBUG] Sending filter prompt to AI:\n${filterPrompt}`);
    }

    let concurrencyAcquiredFilter = false;
    let filterResult = "";
    try {
      if (getSettings().concurrencyLimit === 1) {
        await concurrencyLimiter.acquire();
        concurrencyAcquiredFilter = true;
      }
      await rateLimiter.acquire(1);

      const result = await generateText({
        model,
        prompt: filterPrompt,
      });
      filterResult = result.text;
    } finally {
      if (concurrencyAcquiredFilter) {
        concurrencyLimiter.release();
      }
    }

    if (onDebug) {
      onDebug(`[DEBUG] AI filter raw output:\n${filterResult}`);
    }

    const jsonMatch = filterResult.match(/\[\s*\d*\s*(?:,\s*\d*\s*)*\]/);
    const indices: number[] = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    if (onDebug) {
      onDebug(`[DEBUG] Parsed indices: ${JSON.stringify(indices)}`);
    }

    if (indices.length === 0) {
      const noSemanticResult = `No semantically relevant conversation history found for: "${query}".\n\n${generateFuzzyFallbackText()}`;
      semanticSearchCache.set(cacheKey, { sig, result: noSemanticResult });
      return noSemanticResult;
    }

    const reports: string[] = [];
    const summaryPromises = indices.map(async (idx) => {
      if (idx < 0 || idx >= candidates.length) return null;
      const match = scoredSessions[idx];

      const truncatedTranscript = match.dialogueText.slice(-15000);
      const summaryPrompt = `You are analyzing a past coding session transcript.
User search query: "${query}"
Session Name: "${match.session.displayName}"

Here is the dialogue transcript of the session:
${truncatedTranscript}

Please summarize what was discussed, decided, or implemented in this session regarding the query. Be specific, concise, and reference code or actions where appropriate.`;

      if (onDebug) {
        onDebug(`[DEBUG] Generating semantic summary for "${match.session.displayName}"`);
        onDebug(`[DEBUG] Sending summary prompt to AI:\n${summaryPrompt}`);
      }

      let concurrencyAcquiredSummary = false;
      let summary = "";
      try {
        if (getSettings().concurrencyLimit === 1) {
          await concurrencyLimiter.acquire();
          concurrencyAcquiredSummary = true;
        }
        await rateLimiter.acquire(1);

        const result = await generateText({
          model,
          prompt: summaryPrompt,
        });
        summary = result.text;
      } finally {
        if (concurrencyAcquiredSummary) {
          concurrencyLimiter.release();
        }
      }

      if (onDebug) {
        onDebug(`[DEBUG] Raw AI summary output for "${match.session.displayName}":\n${summary}`);
        onDebug(`[PROGRESS] Completed semantic summary for: 📁 ${match.session.displayName}`);
      }

      return {
        displayName: match.session.displayName,
        summary: summary.trim(),
      };
    });

    const summaryResults = await Promise.all(summaryPromises);
    for (const res of summaryResults) {
      if (res) {
        reports.push(`📁 **${res.displayName}**\n${res.summary}`);
      }
    }

    if (reports.length === 0) {
      const noSemanticResult = `No semantically relevant conversation history found for: "${query}".\n\n${generateFuzzyFallbackText()}`;
      semanticSearchCache.set(cacheKey, { sig, result: noSemanticResult });
      return noSemanticResult;
    }

    const finalResult = `[AI SEMANTIC SEARCH] Found relevant history for "${query}":\n\n` + reports.join("\n\n");
    semanticSearchCache.set(cacheKey, { sig, result: finalResult });
    return finalResult;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const fallback = generateFuzzyFallbackText();
    const errorResult = `[AI Search Failed (${errorMsg}) - Falling back to Fuzzy Search]\n\n${fallback}`;
    return errorResult;
  }
}
