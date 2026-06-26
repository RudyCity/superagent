export function resolveCarriageReturns(text) {
    const lines = text.split("\n");
    const processed = lines.map((line) => {
        const idx = line.lastIndexOf("\r");
        return idx === -1 ? line : line.slice(idx + 1);
    });
    return processed.join("\n");
}
export function formatArgs(args) {
    const entries = Object.entries(args);
    if (entries.length === 0)
        return "{}";
    const parts = entries.map(([k, v]) => {
        const raw = String(v ?? "");
        // For command/cmd fields: flatten newlines and truncate to 80 chars
        if (k === "command" || k === "cmd") {
            const flat = raw.replace(/\r?\n/g, " ; ").replace(/\s+/g, " ").trim();
            const truncated = flat.length > 80 ? flat.slice(0, 77) + "..." : flat;
            return `${k}: ${JSON.stringify(truncated)}`;
        }
        const val = JSON.stringify(v);
        const truncated = val.length > 60 ? val.slice(0, 60) + "..." : val;
        return `${k}: ${truncated}`;
    });
    return `{ ${parts.join(", ")} }`;
}
export function formatCompactNumber(num) {
    if (num >= 1_000_000) {
        return (num / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
    }
    if (num >= 1_000) {
        return (num / 1_000).toFixed(1).replace(/\.?0+$/, "") + "K";
    }
    return num.toString();
}
/**
 * Perform a fuzzy match and score on a text against a pattern.
 * Returns a score if it matches, or null if it doesn't.
 * Lower score is better/closer match:
 * - 0: Exact match (case-insensitive)
 * - 1: Prefix match (starts with)
 * - 2: Substring match (contains)
 * - 3: Fuzzy / subsequence match
 */
export function fuzzyScore(pattern, text) {
    if (!pattern)
        return 0;
    const p = pattern.toLowerCase();
    const t = text.toLowerCase();
    if (t === p)
        return 0;
    if (t.startsWith(p))
        return 1;
    if (t.includes(p))
        return 2;
    let pIdx = 0;
    for (let tIdx = 0; tIdx < t.length; tIdx++) {
        if (t[tIdx] === p[pIdx]) {
            pIdx++;
            if (pIdx === p.length)
                return 3;
        }
    }
    return null;
}
/**
 * Filter and sort a list of possibilities using fuzzy matching against an input.
 */
export function filterSuggestions(possibilities, input) {
    const scored = possibilities
        .map((p) => ({ text: p, score: fuzzyScore(input, p) }))
        .filter((item) => item.score !== null);
    return scored
        .sort((a, b) => {
        if (a.score !== b.score)
            return a.score - b.score;
        if (a.text.length !== b.text.length)
            return a.text.length - b.text.length;
        return a.text.localeCompare(b.text);
    })
        .map((item) => item.text);
}
/**
 * Strip SGR-style mouse escape sequences that may leak into text input
 * when the user clicks on the terminal.
 *
 * Handles:
 *   - SGR format: \x1b[<btn;col;rowM  (or with \x1b stripped by Ink)
 *   - Variable parameter count: [<0;48;30M, [<0;3;18M
 *   - Partial/fragmented at end of string: [<0;48;30 (missing terminator)
 */
export function stripSgrMouseSequences(value) {
    return value
        // Full SGR mouse sequences with or without leading ESC
        .replace(/(?:\x1b)?\[<\d+(?:;\d+)*[Mm]/g, "")
        // Partial sequences at end of string (data might be fragmented)
        .replace(/(?:\x1b)?\[<\d+(?:;\d+)*$/gm, "");
}
export function getInsertion(oldVal, newVal) {
    let start = 0;
    while (start < oldVal.length && start < newVal.length && oldVal[start] === newVal[start]) {
        start++;
    }
    let endOld = oldVal.length - 1;
    let endNew = newVal.length - 1;
    while (endOld >= start && endNew >= start && oldVal[endOld] === newVal[endNew]) {
        endOld--;
        endNew--;
    }
    const prefix = oldVal.slice(0, start);
    const inserted = newVal.slice(start, endNew + 1);
    const suffix = oldVal.slice(endOld + 1);
    return { prefix, inserted, suffix };
}
export function getPasteSplit(currentInput, prefixLen, suffixLen) {
    const prefix = currentInput.slice(0, Math.min(currentInput.length, prefixLen));
    const suffix = suffixLen > 0 ? currentInput.slice(Math.max(prefix.length, currentInput.length - suffixLen)) : "";
    const inserted = currentInput.slice(prefix.length, currentInput.length - suffix.length);
    return { prefix, inserted, suffix };
}
/**
 * Apply a Unicode combining long solidus overlay (U+0336) to each visible
 * character so the text appears struck-through regardless of terminal
 * ANSI strikethrough support.  Spaces and zero-width characters are
 * skipped to keep the output visually clean.
 */
export function unicodeStrikethrough(text) {
    const COMBINING_STRIKE = "\u0336";
    let result = "";
    for (const ch of text) {
        // Skip spaces and zero-width characters
        if (ch === " " || ch === "\u200B" || ch === "\u200C" || ch === "\u200D" || ch === "\uFEFF") {
            result += ch;
        }
        else {
            result += ch + COMBINING_STRIKE;
        }
    }
    return result;
}
export function minimizePathInDescription(str) {
    const fileKeyword = "file: ";
    const idx = str.indexOf(fileKeyword);
    if (idx === -1)
        return str;
    const prefix = str.slice(0, idx + fileKeyword.length);
    const path = str.slice(idx + fileKeyword.length).trim();
    // Extract basename
    const normalizedPath = path.replace(/\\/g, "/");
    const parts = normalizedPath.split("/");
    const filename = parts[parts.length - 1] || path;
    return prefix + filename;
}
//# sourceMappingURL=text.js.map