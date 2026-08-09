export interface PromptContextSection {
  id: string;
  content: string;
  maxTokens: number;
}

export interface BudgetedPromptContext {
  text: string;
  usedTokens: number;
  truncatedSectionIds: string[];
}

/** Conservative cross-model estimate used only to bound optional prompt context. */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf-8") / 4);
}

function truncateToTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || !text) return "";
  if (estimatePromptTokens(text) <= tokenBudget) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimatePromptTokens(text.slice(0, middle)) <= tokenBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return text.slice(0, low).trimEnd();
}

/**
 * Keeps optional context within a deterministic estimated-token budget.
 * Sections are evaluated in supplied priority order; each also has its own cap.
 */
export function buildBudgetedPromptContext(
  sections: PromptContextSection[],
  totalTokens: number
): BudgetedPromptContext {
  const included: string[] = [];
  const truncated = new Set<string>();
  let usedTokens = 0;

  for (const section of sections) {
    const content = section.content.trim();
    if (!content) continue;

    const separator = included.length > 0 ? "\n\n" : "";
    const separatorTokens = estimatePromptTokens(separator);
    const sectionLimit = Math.max(0, Math.floor(section.maxTokens));
    const remaining = Math.max(0, Math.floor(totalTokens) - usedTokens - separatorTokens);
    const allowedTokens = Math.min(sectionLimit, remaining);
    const bounded = truncateToTokenBudget(content, allowedTokens);

    if (bounded !== content) truncated.add(section.id);
    if (!bounded) continue;

    included.push(bounded);
    usedTokens += separatorTokens + estimatePromptTokens(bounded);
  }

  return {
    text: included.join("\n\n"),
    usedTokens,
    truncatedSectionIds: Array.from(truncated),
  };
}
