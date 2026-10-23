import { describe, expect, it } from "vitest";
import { classifyRequest, clearLocalClassifierCache } from "../src/core/requestClassifier.js";
import { getSystemPrompt } from "../src/core/config/base.js";
import { scopeSystemPromptForDomain } from "../src/core/agent/PromptDomainScope.js";

describe("Senopati-backed general assistant routing", () => {
  const cases = [
    ["Tolong buat caption Instagram tentang kopi", "writing", "question"],
    ["Buatkan surat undangan rapat", "writing", "question"],
    ["Jelaskan apa itu inflasi", "knowledge", "question"],
    ["Tolong buat gambar poster promosi", "creative", "command"],
    ["Set reminder besok jam 8", "productivity", "command"],
    ["Buat presentasi untuk klien", "writing", "command"],
    ["Cari restoran favorit di Batam", "research", "research"],
    ["Review prompt sebagai AI assistant, jangan edit kode", "research", "research"],
  ] as const;
  it.each(cases)("routes %s to %s / %s while using Senopati", async (text, domain, category) => {
    const result = await classifyRequest(text);
    expect(result.domain).toBe(domain);
    expect(result.category).toBe(category);
    expect(result.isDestructive).toBe(false);
    expect(result.reason).toContain("assistant-domain=");
  });
  it("keeps explicit destructive commands protected", async () => {
    const result = await classifyRequest("git reset --hard");
    expect(result.isDestructive).toBe(true);
  });
  it("removes engineering-specific prompt rules without removing safety constraints", () => {
    const full = getSystemPrompt();
    const scoped = scopeSystemPromptForDomain(full, "writing");
    expect(scoped.length).toBeLessThan(full.length);
    expect(scoped).not.toContain("- KARPATHY_GUIDELINES:");
    expect(scoped).toContain("- SECURITY:");
    expect(scoped).toContain("INTENT_ROUTING");
    expect(scopeSystemPromptForDomain(full)).toBe(full);
  });
});
