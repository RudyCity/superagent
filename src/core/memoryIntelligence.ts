import { redactMemorySecrets } from "./memoryLifecycle.js";
import { createHash } from "node:crypto";

export interface MemorySuggestion {
  id: string;
  type: "decision" | "preference" | "fact" | "task-summary";
  content: string;
  confidence: number;
  validationStatus: "candidate";
  requiresReview: true;
}
/** Conservative suggestions: never write automatically or promote to verified. */
export function suggestMemoryCandidates(text: string, maxCandidates = 8): MemorySuggestion[] {
  const lines = String(text || "").split(/[\r\n]+/).map(x => x.trim()).filter(Boolean);
  const patterns: Array<{ kind: MemorySuggestion["type"]; re: RegExp }> = [
    { kind: "decision", re: /^(?:decided?|decision|diputuskan|keputusan|gunakan|we chose|pilih|tetapkan)\s*[:：-]?\s*\S/i },
    { kind: "preference", re: /^(?:prefer|preference|i prefer|saya (?:lebih suka|ingin)|aku (?:lebih suka|ingin)|selalu gunakan)\s*[:：-]?\s*\S/i },
    { kind: "fact", re: /^(?:fact|fakta|requirement|persyaratan|constraint|batasan)\s*[:：-]?\s*\S/i },
    { kind: "task-summary", re: /^(?:completed|selesai|implemented|diimplementasikan)\s*[:：-]?\s*\S/i },
  ];
  const suggestions: MemorySuggestion[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.length < 12 || line.length > 800 || /^(?:password|token|secret|api.?key)\s*[:=]/i.test(line)) continue;
    const entry = patterns.find(item => item.re.test(line));
    if (!entry) continue;
    const content = redactMemorySecrets(line);
    if (content.includes("[REDACTED") || content.length < 12) continue;
    const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    suggestions.push({
      id: "suggest-" + createHash("sha256").update(entry.kind + ":" + normalized).digest("hex").slice(0, 20),
      type: entry.kind, content, confidence: 0.6,
      validationStatus: "candidate", requiresReview: true,
    });
    if (suggestions.length >= Math.max(1, Math.min(30, maxCandidates))) break;
  }
  return suggestions;
}
