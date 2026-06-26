/**
 * Lightweight token estimation for compaction budget enforcement.
 * Uses heuristic (text.length/4) — doesn't need tiktoken accuracy,
 * just needs to prevent unbounded growth within compaction strategies.
 */
export function tokensForMessages(messages) {
    let total = 0;
    for (const m of messages) {
        const text = typeof m.content === "string"
            ? m.content
            : m.content?.map((p) => p.text || "").join("") || "";
        total += Math.ceil(text.length / 4);
        if (m.toolCalls) {
            for (const tc of m.toolCalls) {
                total += Math.ceil(JSON.stringify(tc.args).length / 4);
            }
        }
        if (m.toolResults) {
            for (const tr of m.toolResults) {
                total += Math.ceil(tr.result.length / 4);
            }
        }
    }
    return total;
}
//# sourceMappingURL=CompactionStrategy.js.map