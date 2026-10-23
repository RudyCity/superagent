import { describe, expect, it } from "vitest";
import { inferAssistantDomain } from "../src/core/assistantRouting.js";
const cases: Array<[string, string, string]> = [
  ["Tolong buat caption Instagram tentang kopi", "writing", "question"],
  ["Buatkan surat undangan rapat", "writing", "question"],
  ["Buatkan dokumen PDF surat undangan", "writing", "command"],
  ["Bikin puisi tentang hujan", "writing", "question"],
  ["Jelaskan apa itu inflasi", "knowledge", "question"],
  ["Cari restoran favorit di Batam", "research", "research"],
  ["Buat rencana perjalanan 3 hari ke Bali", "research", "research"],
  ["Set reminder besok jam 8", "productivity", "command"],
  ["Tolong buat gambar poster promosi", "creative", "command"],
  ["Buat presentasi untuk klien", "writing", "command"],
  ["Review prompt sebagai AI assistant, jangan edit kode", "research", "research"],
  ["Audit lebih dalam dulu beri saran tanpa implementasi", "research", "research"],
];
describe("assistant task-domain overlay", () => {
  it.each(cases)("routes %s to %s / %s", (message, domain, category) => {
    expect(inferAssistantDomain(message)).toMatchObject({ domain, category });
  });
  it.each(["Fix TypeError in src/core/agent.ts", "git reset --hard", "bun test", "refactor database migration"])("preserves Senopati engineering classification for %s", (message) => {
    expect(inferAssistantDomain(message)).toBeNull();
  });
});
