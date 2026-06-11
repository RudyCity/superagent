export function resolveCarriageReturns(text: string): string {
  const lines = text.split("\n");
  const processed = lines.map((line) => {
    const idx = line.lastIndexOf("\r");
    return idx === -1 ? line : line.slice(idx + 1);
  });
  return processed.join("\n");
}

export function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "{}";
  const parts = entries.map(([k, v]) => {
    const val = typeof v === "string" ? v : JSON.stringify(v);
    const truncated = val.length > 60 ? val.slice(0, 60) + "..." : val;
    return `${k}: ${truncated}`;
  });
  return `{ ${parts.join(", ")} }`;
}

export function formatCompactNumber(num: number): string {
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
export function fuzzyScore(pattern: string, text: string): number | null {
  if (!pattern) return 0;
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();

  if (t === p) return 0;
  if (t.startsWith(p)) return 1;
  if (t.includes(p)) return 2;

  let pIdx = 0;
  for (let tIdx = 0; tIdx < t.length; tIdx++) {
    if (t[tIdx] === p[pIdx]) {
      pIdx++;
      if (pIdx === p.length) return 3;
    }
  }

  return null;
}

/**
 * Filter and sort a list of possibilities using fuzzy matching against an input.
 */
export function filterSuggestions(possibilities: string[], input: string): string[] {
  const scored = possibilities
    .map((p) => ({ text: p, score: fuzzyScore(input, p) }))
    .filter((item) => item.score !== null) as { text: string; score: number }[];

  return scored
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.text.length !== b.text.length) return a.text.length - b.text.length;
      return a.text.localeCompare(b.text);
    })
    .map((item) => item.text);
}

