import fs from "fs";
import path from "path";
import { listHistorySessions, getModelInstance, getConfig, getSettings } from "./config.js";

const stopWords = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "of", "at", "by", "for", "with",
  "about", "against", "between", "into", "through", "during", "before", "after", "above", "below",
  "to", "from", "up", "down", "in", "out", "on", "off", "over", "under", "again", "further",
  "then", "once", "here", "there", "when", "where", "why", "how", "all", "any", "both", "each",
  "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "can", "will", "just", "should", "now"
]);

/**
 * Calculates a local Hybrid TF-IDF + Fuzzy score for a term matching a text.
 * Gives exact matches higher weight than subsequence fuzzy matches.
 */
export function computeTfidfFuzzyScore(
  text: string,
  queryTerms: string[],
  docFreqs: Record<string, number>,
  numDocs: number
): number {
  const t = text.toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    const df = docFreqs[term] || 0;
    // Standard IDF formula with smoothing
    const idf = Math.log((numDocs - df + 0.5) / (df + 0.5) + 1.0) + 1.0;

    let tf = 0;
    let matchPenalty = 1.0;

    // 1. Exact match check
    if (t.includes(term)) {
      let pos = t.indexOf(term);
      while (pos !== -1) {
        tf++;
        pos = t.indexOf(term, pos + term.length);
      }
    } else {
      // 2. Fuzzy subsequence match check
      let lastIdx = -1;
      let possibleMatch = true;
      for (let j = 0; j < term.length; j++) {
        const idx = t.indexOf(term[j], lastIdx + 1);
        if (idx === -1) {
          possibleMatch = false;
          break;
        }
        lastIdx = idx;
      }
      if (possibleMatch) {
        tf = 1;
        matchPenalty = 0.4; // 60% penalty for fuzzy/partial matches
      }
    }

    if (tf > 0) {
      // Logarithmic Term Frequency
      const tfWeight = 1 + Math.log(tf);
      score += tfWeight * idf * matchPenalty;
    }
  }

  return score;
}

/**
 * Subsequence fuzzy matching (kept for backward compatibility / tests)
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
 * Perform a hybrid search on local conversation history.
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

  const settings = getSettings();
  if (settings.enableRmemory) {
    if (onDebug) {
      onDebug("[DEBUG] RMemory is active. Performing semantic history search.");
    }
    try {
      const { getRMemoryClient } = await import("./rmemoryUtil.js");
      const client = getRMemoryClient(3000);
      const res = await client.searchConversation({ query, limit: 30 });
      const messages = res.messages || [];
      if (messages.length > 0) {
        const grouped = new Map<string, typeof messages>();
        for (const msg of messages) {
          if (msg.session_id) {
            if (!grouped.has(msg.session_id)) {
              grouped.set(msg.session_id, []);
            }
            grouped.get(msg.session_id)!.push(msg);
          }
        }

        const sessions = listHistorySessions(isMulti, crossSession);
        const sessionMap = new Map(sessions.map(s => [s.id, s]));

        const lines: string[] = [
          "----------------------------------------------------------------------",
          `[RMEMORY SEMANTIC SEARCH] Found relevant history for "${query}"`,
          "----------------------------------------------------------------------",
        ];

        const sessionMessagesMap = new Map<string, Array<{ role: string; content: string }>>();

        for (const [sid, msgs] of grouped.entries()) {
          const sessionMeta = sessionMap.get(sid);
          if (!crossSession && !sessionMeta) {
            continue;
          }

          const displayName = sessionMeta ? sessionMeta.displayName : `Session ${sid}`;
          lines.push(`📁 ${displayName}`);

          // Fetch full conversation messages for context
          let sessionMsgs = sessionMessagesMap.get(sid);
          if (!sessionMsgs) {
            if (sessionMeta) {
              try {
                const raw = fs.readFileSync(sessionMeta.filePath, "utf-8");
                const parsed = JSON.parse(raw);
                let rawMsgs: any[] = [];
                if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
                  rawMsgs = parsed.messages;
                } else if (Array.isArray(parsed)) {
                  rawMsgs = parsed;
                }
                sessionMsgs = rawMsgs
                  .filter(m => m.role === "user" || m.role === "assistant")
                  .map(m => ({
                    role: m.role,
                    content: typeof m.content === "string" ? m.content : String(m.content || ""),
                  }));
              } catch {}
            }
            if (!sessionMsgs) {
              sessionMsgs = await client.getConversationMessages(sid);
            }
            sessionMessagesMap.set(sid, sessionMsgs);
          }

          // Show context around each matched message (up to 3 matches per session)
          const shownMatches = msgs.slice(0, 3);
          for (const matchMsg of shownMatches) {
            const matchIdx = sessionMsgs.findIndex(
              m => m.content.trim() === matchMsg.content.trim() && m.role === matchMsg.role
            );
            if (matchIdx !== -1) {
              const start = Math.max(0, matchIdx - 1);
              const end = Math.min(sessionMsgs.length - 1, matchIdx + 1);
              for (let i = start; i <= end; i++) {
                const m = sessionMsgs[i];
                const marker = i === matchIdx ? "→" : " ";
                const roleStr = m.role.toUpperCase();
                const contentClean = m.content.replace(/\r?\n/g, " ");
                const preview = contentClean.length > 90 ? contentClean.slice(0, 87) + "..." : contentClean;
                lines.push(`     ${marker} [${roleStr}] ${preview}`);
              }
            } else {
              // Fallback to match message only
              const roleStr = matchMsg.role.toUpperCase();
              const contentClean = matchMsg.content.replace(/\r?\n/g, " ");
              const preview = contentClean.length > 90 ? contentClean.slice(0, 87) + "..." : contentClean;
              lines.push(`      → [${roleStr}] ${preview}`);
            }
          }
          lines.push("----------------------------------------------------------------------");
        }

        if (lines.length > 3) {
          const finalResult = lines.join("\n").trim();
          const config = getConfig();
          const cacheKey = `${query}:${isMulti}:${crossSession}:${config.model || ""}:${config.provider || ""}`;
          semanticSearchCache.set(cacheKey, { sig: "rmemory", result: finalResult });
          return finalResult;
        }
      }
    } catch (err: any) {
      if (onDebug) {
        onDebug(`[DEBUG] RMemory semantic search failed: ${err.message}. Falling back to hybrid search.`);
      }
    }
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

  const sessionsData: Array<{
    session: any;
    messages: any[];
    dialogueText: string;
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

      sessionsData.push({
        session,
        messages,
        dialogueText,
      });
    } catch {
      // Ignore corrupted or missing files
    }
  });

  await Promise.all(promises);

  // Tokenize query
  const queryTerms = query.toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .split(/\s+/)
    .filter((k) => k.length > 1 && !stopWords.has(k));

  const finalQueryTerms = queryTerms.length > 0 ? queryTerms : query.toLowerCase().split(/\s+/).filter(Boolean);

  if (onDebug) {
    onDebug(`[DEBUG] Tokenized query terms: ${JSON.stringify(finalQueryTerms)}`);
  }

  // Calculate Document Frequency
  const numDocs = sessionsData.length;
  const docFreqs: Record<string, number> = {};
  for (const term of finalQueryTerms) {
    let freq = 0;
    for (const data of sessionsData) {
      if (data.dialogueText.toLowerCase().includes(term)) {
        freq++;
      } else {
        const t = data.dialogueText.toLowerCase();
        let lastIdx = -1;
        let possibleMatch = true;
        for (let j = 0; j < term.length; j++) {
          const idx = t.indexOf(term[j], lastIdx + 1);
          if (idx === -1) {
            possibleMatch = false;
            break;
          }
          lastIdx = idx;
        }
        if (possibleMatch) {
          freq++;
        }
      }
    }
    docFreqs[term] = freq;
  }

  // Calculate Hybrid TF-IDF scores
  for (const data of sessionsData) {
    const score = computeTfidfFuzzyScore(data.dialogueText, finalQueryTerms, docFreqs, numDocs);
    if (score > 0) {
      scoredSessions.push({
        ...data,
        score,
      });
    }
  }

  // Sort: highest score first, then most recently modified first
  scoredSessions.sort(
    (a, b) =>
      b.score - a.score ||
      b.session.lastModified.getTime() - a.session.lastModified.getTime()
  );

  if (onDebug) {
    onDebug(`[DEBUG] Scored ${scoredSessions.length} session(s) using hybrid TF-IDF + Fuzzy:`);
    for (const item of scoredSessions.slice(0, 5)) {
      const formattedScore = Math.round(item.score * 10) / 10;
      onDebug(`  - 📁 ${item.session.displayName} (Score: ${formattedScore}, last modified: ${item.session.lastModified.toISOString()})`);
    }
  }

  // Generate hybrid result text directly (No LLM summarizes, we show contextual matching turns)
  const generateHybridResultText = () => {
    if (scoredSessions.length === 0) {
      return `No matches found for query: "${query}"`;
    }
    const lines = [
      "----------------------------------------------------------------------",
      `[HYBRID SEMANTIC SEARCH] Found ${scoredSessions.length} matching session(s) for "${query}"`,
      "----------------------------------------------------------------------",
    ];
    for (const item of scoredSessions.slice(0, 5)) {
      const scoreFormatted = Math.round(item.score * 10) / 10;
      lines.push(`📁 ${item.session.displayName} (Score: ${scoreFormatted})`);
      const matchedTurns: string[] = [];
      for (const msg of item.messages) {
        if ((msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string") {
          const contentLower = msg.content.toLowerCase();
          if (finalQueryTerms.some((word) => contentLower.includes(word))) {
            const cleaned = msg.content.replace(/\r?\n/g, " ");
            const truncated =
              cleaned.length > 120 ? cleaned.slice(0, 117) + "..." : cleaned;
            matchedTurns.push(`      [${msg.role.toUpperCase()}] ${truncated}`);
            if (matchedTurns.length >= 3) break;
          }
        }
      }
      if (matchedTurns.length > 0) {
        lines.push(matchedTurns.join("\n"));
      } else {
        const firstUser = item.messages.find(m => m.role === "user");
        if (firstUser) {
          const cleaned = firstUser.content.replace(/\r?\n/g, " ");
          const truncated = cleaned.length > 120 ? cleaned.slice(0, 117) + "..." : cleaned;
          lines.push(`      [USER] ${truncated}`);
        }
      }
      lines.push("----------------------------------------------------------------------");
    }
    return lines.join("\n").trim();
  };

  const finalResult = generateHybridResultText();
  semanticSearchCache.set(cacheKey, { sig, result: finalResult });
  return finalResult;
}

export async function syncAllHistoryToRMemory(): Promise<void> {
  const settings = getSettings();
  if (!settings.enableRmemory) return;

  try {
    const { getRMemoryClient } = await import("./rmemoryUtil.js");
    const { getRootConfigDir } = await import("./config/paths.js");
    const client = getRMemoryClient(5000);

    const rmemoryDir = path.join(getRootConfigDir(), "rmemory");
    if (!fs.existsSync(rmemoryDir)) {
      fs.mkdirSync(rmemoryDir, { recursive: true });
    }
    const registryPath = path.join(rmemoryDir, "synced_sessions.json");
    let syncedIds: string[] = [];
    if (fs.existsSync(registryPath)) {
      try {
        const raw = fs.readFileSync(registryPath, "utf-8");
        syncedIds = JSON.parse(raw);
        if (!Array.isArray(syncedIds)) syncedIds = [];
      } catch {
        syncedIds = [];
      }
    }

    const singleSessions = listHistorySessions(false, true);
    const multiSessions = listHistorySessions(true, true);
    const allSessions = [...singleSessions, ...multiSessions];

    let changed = false;
    for (const session of allSessions) {
      if (syncedIds.includes(session.id)) continue;

      try {
        const raw = fs.readFileSync(session.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        let messages: any[] = [];
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
          messages = parsed.messages;
        } else if (Array.isArray(parsed)) {
          messages = parsed;
        }

        const filteredMsgs = messages
          .filter((m) => (m.role === "user" || m.role === "assistant"))
          .map((m) => {
            const content = typeof m.content === "string" ? m.content.trim() : String(m.content || "");
            return {
              role: m.role as "user" | "assistant",
              content: content.length > 0 ? content : "[empty message]",
              timestamp: new Date(m.timestamp || Date.now()).toISOString(),
            };
          });

        if (filteredMsgs.length > 0) {
          await client.addConversation({
            session_id: session.id,
            messages: filteredMsgs,
          });
        }
        syncedIds.push(session.id);
        changed = true;
      } catch (err) {
        // Skip corrupted files
      }
    }

    if (changed) {
      fs.writeFileSync(registryPath, JSON.stringify(syncedIds, null, 2), "utf-8");
    }
  } catch (err) {
    console.error("Failed to sync history sessions to RMemory:", err);
  }
}
