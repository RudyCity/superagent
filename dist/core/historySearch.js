import fs from "fs";
import { generateText } from "ai";
import { listHistorySessions, getModelInstance, getConfig } from "./config.js";
import { rateLimiter, concurrencyLimiter } from "./rateLimiter.js";
/**
 * Custom subsequence fuzzy matching and token-based scoring algorithm.
 * Returns a score between 0.0 (no match) and 1.0 (exact match).
 */
export function fuzzyScore(text, query) {
    const t = text.toLowerCase();
    const q = query.toLowerCase();
    if (t.includes(q))
        return 1.0;
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length === 0)
        return 0;
    let matches = 0;
    for (const word of words) {
        if (t.includes(word)) {
            matches += 1.0;
        }
        else {
            let qIdx = 0;
            for (let i = 0; i < t.length; i++) {
                if (t[i] === word[qIdx]) {
                    qIdx++;
                    if (qIdx === word.length)
                        break;
                }
            }
            if (qIdx === word.length) {
                matches += 0.5;
            }
        }
    }
    return matches / words.length;
}
/**
 * Filter out verbose tool output logs to save 90-95% of token context.
 */
export function cleanTranscriptForLLM(messages) {
    return messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content || ""}`)
        .join("\n\n");
}
/**
 * Perform a hybrid AI-powered semantic search with an offline fuzzy fallback.
 */
export async function searchHistory(query, isMulti = false) {
    const sessions = listHistorySessions(isMulti);
    if (sessions.length === 0) {
        return "No conversation history sessions found in the workspace.";
    }
    const scoredSessions = [];
    for (const session of sessions) {
        try {
            const raw = fs.readFileSync(session.filePath, "utf-8");
            const parsed = JSON.parse(raw);
            let messages;
            if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
                messages = parsed.messages;
            }
            else if (Array.isArray(parsed)) {
                messages = parsed;
            }
            else {
                continue;
            }
            const dialogueText = cleanTranscriptForLLM(messages);
            const score = fuzzyScore(dialogueText, query);
            if (score > 0) {
                scoredSessions.push({
                    session,
                    messages,
                    dialogueText,
                    score,
                });
            }
        }
        catch {
            // Ignore corrupted files
        }
    }
    // Sort: highest score first, then most recently modified first
    scoredSessions.sort((a, b) => b.score - a.score ||
        b.session.lastModified.getTime() - a.session.lastModified.getTime());
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
            const matchedTurns = [];
            for (const msg of item.messages) {
                if ((msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string") {
                    const contentLower = msg.content.toLowerCase();
                    if (queryWords.some((word) => contentLower.includes(word))) {
                        const cleaned = msg.content.replace(/\r?\n/g, " ");
                        const truncated = cleaned.length > 90 ? cleaned.slice(0, 87) + "..." : cleaned;
                        matchedTurns.push(`      [${msg.role.toUpperCase()}] ${truncated}`);
                        if (matchedTurns.length >= 3)
                            break;
                    }
                }
            }
            lines.push(matchedTurns.join("\n"));
            lines.push("");
        }
        return lines.join("\n").trim();
    };
    const config = getConfig();
    const hasApiKey = !!config.apiKey;
    if (!hasApiKey) {
        return generateFuzzyFallbackText();
    }
    try {
        const model = getModelInstance();
        // AI Semantic Filtering
        const candidates = scoredSessions.slice(0, 5).map((item, idx) => ({
            index: idx,
            displayName: item.session.displayName,
            preview: item.session.preview,
            messageCount: item.session.messageCount,
            lastModified: item.session.lastModified.toISOString(),
        }));
        if (candidates.length === 0) {
            return `No matches found in history for query: "${query}"`;
        }
        const filterPrompt = `You are a developer assistant analyzing past coding session logs.
The developer is searching for context about: "${query}".

Here is a list of top candidate past conversation sessions:
${JSON.stringify(candidates, null, 2)}

Identify the indices of the sessions (up to 3) that are semantically relevant to the developer's search query.
Return ONLY a JSON array of numbers representing the relevant session indices. Example: [0, 2]
If no sessions are relevant, return an empty array: []`;
        let concurrencyAcquiredFilter = false;
        let filterResult = "";
        try {
            if (process.env.SUPERAGENT_MAX_CONCURRENCY === "1") {
                await concurrencyLimiter.acquire();
                concurrencyAcquiredFilter = true;
            }
            await rateLimiter.acquire(1);
            const result = await generateText({
                model,
                prompt: filterPrompt,
            });
            filterResult = result.text;
        }
        finally {
            if (concurrencyAcquiredFilter) {
                concurrencyLimiter.release();
            }
        }
        const jsonMatch = filterResult.match(/\[\s*\d*\s*(?:,\s*\d*\s*)*\]/);
        const indices = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        if (indices.length === 0) {
            return `No semantically relevant conversation history found for: "${query}".\n\n${generateFuzzyFallbackText()}`;
        }
        const reports = [];
        for (const idx of indices) {
            if (idx < 0 || idx >= candidates.length)
                continue;
            const match = scoredSessions[idx];
            const truncatedTranscript = match.dialogueText.slice(-15000);
            const summaryPrompt = `You are analyzing a past coding session transcript.
User search query: "${query}"
Session Name: "${match.session.displayName}"

Here is the dialogue transcript of the session:
${truncatedTranscript}

Please summarize what was discussed, decided, or implemented in this session regarding the query. Be specific, concise, and reference code or actions where appropriate.`;
            let concurrencyAcquiredSummary = false;
            let summary = "";
            try {
                if (process.env.SUPERAGENT_MAX_CONCURRENCY === "1") {
                    await concurrencyLimiter.acquire();
                    concurrencyAcquiredSummary = true;
                }
                await rateLimiter.acquire(1);
                const result = await generateText({
                    model,
                    prompt: summaryPrompt,
                });
                summary = result.text;
            }
            finally {
                if (concurrencyAcquiredSummary) {
                    concurrencyLimiter.release();
                }
            }
            reports.push(`📁 **${match.session.displayName}**\n${summary.trim()}`);
        }
        if (reports.length === 0) {
            return `No semantically relevant conversation history found for: "${query}".\n\n${generateFuzzyFallbackText()}`;
        }
        return `[AI SEMANTIC SEARCH] Found relevant history for "${query}":\n\n` + reports.join("\n\n");
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const fallback = generateFuzzyFallbackText();
        return `[AI Search Failed (${errorMsg}) - Falling back to Fuzzy Search]\n\n${fallback}`;
    }
}
//# sourceMappingURL=historySearch.js.map