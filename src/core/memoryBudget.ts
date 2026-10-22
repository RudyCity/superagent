/** Compact, deterministic recall sizing: keep overhead bounded on small models. */
export function calculateRecallBudget(
  tokenBudget: number | undefined,
  query: string,
  capChars = 6000,
): number {
  const effectiveTokens = Number.isFinite(tokenBudget) && Number(tokenBudget) > 0
    ? Number(tokenBudget) : 8000;
  const base = Math.max(450, Math.min(capChars, Math.floor(effectiveTokens * 0.35)));
  const terms = query.trim().split(/\s+/).filter(Boolean).length;
  const complexity = Math.min(1.2, 0.65 + terms / 35);
  return Math.max(350, Math.min(capChars, Math.floor(base * complexity)));
}
