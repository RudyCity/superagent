/** Read-only Senopati V2 shadow safety labels. ToolExecutor still owns consent. */
import type { SenopatiV2ShadowPrediction, SenopatiV2ShadowLabels } from "./senopatiV2Shadow.js";

const APPROVE = new Set(["ya","yes","iya","setuju","saya setuju","saya menyetujui plan ini","saya setujui","approved","approve","yes approve","oke","ok","silakan lanjut","silahkan lanjut","silahkan mulai","lanjut","go ahead","confirm","iya saya setuju","saya izinkan"]);
const DENY = new Set(["tidak","tak","belum","jangan","batal","hentikan","menolak","menentang","no","not","never","stop","cancel","without","jgn","gak","nggak","enggak"]);
const CONDITIONAL = new Set(["jika","kalau","asalkan","bila","tetapi","tapi","namun","sebelum","sesudah","sampai","hanya","only","after","before","until","unless","but","if","when"]);
const DANGEROUS = /(rm\s+-(?:rf|fr|r\s+-f)|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f[a-z]*|docker\s+system\s+prune.*(?:--volumes|-a)|drop\s+(?:table|database)|truncate\s+table|format\s+[a-z]:|wipe\s+(?:all|disk|drive|database)|hapus\s+(?:semua|seluruh|backup|data|database|file)|delete\s+(?:all|entire|every)|destroy\s+(?:the|all)|kosongkan\s+tabel|erase\s+(?:the|all)|force\s+delete|permanently\s+erase|remove\s+all)/i;
const SENSITIVE = /(bank|rekening|payroll|passport|paspor|2fa|two.factor|recovery\s+phone|transfer\s+(?:uang|dana|funds)|password|kata\s+sandi|dokumen\s+pribadi)/i;
const READONLY_START = ["jelaskan","apa","what","why","how","explain","review","audit","investigate","telusuri","bandingkan","berikan informasi","berita","cerita","ceritakan","write a fictional","konsekuensi","consequences","summarize"];
const SEND_WORDS = new Set(["send","share","kirim","bagikan","update","change","ubah","transfer","berikan","ganti"]);

export function normalizeSenopatiV2(text: string): string {
  return text.toLowerCase().replace(/[,\.!]/g, " ").trim().replace(/\s+/g, " ");
}
export function inferSenopatiV2Approval(text: string, context: string): SenopatiV2ShadowLabels["approval"] {
  if (context !== "PLANNING_PENDING") return "none";
  const s = normalizeSenopatiV2(text);
  const words = s.split(" ");
  const denial = words.some(t => DENY.has(t));
  const conditional = words.some(t => CONDITIONAL.has(t));
  if (denial) {
    if (/^(?:tidak|jangan|no\s|not\s|batal)/.test(s)) return "deny";
    return conditional ? "conditional" : "deny";
  }
  if (conditional) return "conditional";
  return APPROVE.has(s) ? "affirm" : "none";
}
export function inferSenopatiV2Risk(text: string, fallback: SenopatiV2ShadowLabels["risk"] = "safe"): SenopatiV2ShadowLabels["risk"] {
  const s = normalizeSenopatiV2(text);
  const readonly = READONLY_START.some(prefix => s.startsWith(prefix)) || text.trim().endsWith("?");
  if (DANGEROUS.test(s)) return readonly ? "safe" : "destructive";
  if (SENSITIVE.test(s) && s.split(" ").some(word => SEND_WORDS.has(word))) return "sensitive";
  return fallback;
}
export function guardSenopatiV2Shadow(raw: SenopatiV2ShadowPrediction, text: string, context = ""): SenopatiV2ShadowPrediction {
  const approval = inferSenopatiV2Approval(text, context);
  const labels = { ...raw.labels, risk: inferSenopatiV2Risk(text, raw.labels.risk), approval };
  if (approval !== "none") {
    labels.intent = approval === "affirm" ? "approve" : "reject";
    labels.action = "none";
  }
  return { ...raw, labels, authorizesExecution: false };
}
