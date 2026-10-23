/**
 * Task-domain overlay for the Senopati System-1 intent model.
 * Senopati remains the primary neural classifier. This layer separates
 * cross-domain tasks from the legacy seven engineering-oriented categories.
 * Explicit, narrow patterns only: ambiguous requests stay with Senopati.
 */
export type AssistantTaskDomain =
  | "conversation" | "knowledge" | "research" | "writing"
  | "creative" | "productivity" | "operations" | "engineering";

export interface AssistantDomainRoute {
  domain: AssistantTaskDomain;
  /** Legacy Senopati category compatibility until the next model schema is deployed. */
  category: "conversation" | "question" | "research" | "command" | "complex_task";
  actionable: boolean;
  reason: string;
}

const NO_EDIT = /\b(?:jangan|tidak|tanpa|without|do not|don't|no|hanya|cuma|only)\b.{0,45}\b(?:edit|ubah|modifikasi|fix|perbaiki|implement(?:asi)?|execute|jalankan|kode|code|menulis kode)\b/i;
const NO_EXECUTE = /\b(?:jangan|tidak|tanpa|without|do not|don't|only|hanya|cuma)\b.{0,45}\b(?:run|jalankan|execute|implement|perbaiki|fix|ubah|edit|deploy|commit|push)\b/i;
const ENGINEERING = /\b(?:source\s*code|codebase|commit|branch|bug|error|stack\s*trace|repo|repository|git|npm|bun\s+(?:run|test|install)|docker|typescript|node\.js|api\s*endpoint|database|schema|migration|refactor|unit\s*test|src\/|\.tsx?\b|\.py\b|\.rdy\b|javascript|implementasi\s+fitur)\b/i;
const WRITING = /\b(?:caption|surat|email|pesan|memo|artikel|berita|proposal|copywriting|blog|puisi|cerpen|cerita|narasi|script\s+video|ringkas|rangkuman|summary|summarize|rewrite|parafrase|paraphrase|undangan|presentasi|essay|pidato|draft|menulis|tuliskan|buatkan\s+teks|write\s+(?:a|an|the)|social\s+post)\b/i;
const CREATIVE = /\b(?:poster|gambar|image|illustration|ilustrasi|visual|desain\s+(?:logo|banner|poster)|logo|banner|animasi|motion|video|musik|music|render|foto|photograph)\b/i;
const PRODUCTIVITY = /\b(?:remind|reminder|ingatkan|pengingat|jadwalkan|schedule|agenda|kalender|calendar|meeting|appointment|pengaturan\s+waktu|to-do|todo|tugas\s+besok)\b/i;
const RESEARCH = /\b(?:riset|research|cari|carikan|temukan|find|search|bandingkan|compare|perbandingan|harga\s+terbaru|terbaru|latest|berita\s+terkini|literatur|sumber|referensi|travel|wisata|perjalanan|restoran|hotel|rekomendasi|recommend)\b/i;
const EXPLAIN = /^(?:tolong\s+)?(?:jelaskan|apa\s+itu|apa\s+yang|mengapa|kenapa|bagaimana|gimana|what\s+is|how\s+does|why\s+is|explain|describe)\b/i;
const USER_ACTION = /\b(?:buatkan|buat|bikin|create|generate|make|kirim|send|upload|unggah|posting|publish|daftarkan|booking|pesankan|isi\s+form|set\s+reminder)\b/i;
const ARTIFACT = /\b(?:pdf|docx|xlsx|pptx|file|berkas|dokumen|presentasi|spreadsheet|canvas|canva)\b/i;

export function inferAssistantDomain(input: string): AssistantDomainRoute | null {
  const t = input.normalize("NFKC").trim().toLowerCase();
  if (!t) return { domain: "conversation", category: "conversation", actionable: false, reason: "empty utterance" };

  if (NO_EDIT.test(t) || NO_EXECUTE.test(t)) {
    return { domain: "research", category: "research", actionable: false, reason: "explicit read-only or no-execution constraint" };
  }

  // Engineering actions must not be stolen by generic writing/creative keywords.
  if (ENGINEERING.test(t)) return null;

  if (PRODUCTIVITY.test(t)) return { domain: "productivity", category: "command", actionable: true, reason: "scheduling/task intent" };
  if (CREATIVE.test(t) && (USER_ACTION.test(t) || /^(?:desain|design|render)\b/.test(t))) {
    return { domain: "creative", category: "command", actionable: true, reason: "creative artifact generation" };
  }
  if (WRITING.test(t)) {
    const artifact = ARTIFACT.test(t) && USER_ACTION.test(t);
    return { domain: "writing", category: artifact ? "command" : "question", actionable: artifact, reason: artifact ? "document artifact writing" : "natural-language writing" };
  }
  if (RESEARCH.test(t)) return { domain: "research", category: "research", actionable: false, reason: "information gathering" };
  if (EXPLAIN.test(t)) return { domain: "knowledge", category: "question", actionable: false, reason: "general explanation" };
  return null;
}

/** Do not let the neural model treat creative or writing text as filesystem destruction. */
export function hasExplicitDestructiveIntent(input: string): boolean {
  return /\b(?:rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-f|drop\s+(?:database|table)|truncate\s+table|format\s+[a-z]:|hapus\s+(?:semua|seluruh|database|file)|delete\s+(?:all|database)|wipe\s+(?:disk|drive)|kill\s+(?:all|process)|uninstall|purge)\b/i.test(input);
}

/** Coding capability activation is based on task content, not the current directory. */
export function isEngineeringIntent(input: string): boolean {
  return ENGINEERING.test(input.normalize("NFKC").toLowerCase()) && !NO_EDIT.test(input) && !NO_EXECUTE.test(input);
}
