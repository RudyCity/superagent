/**
 * Experimental Senopati V2 approval label postprocessor.
 * Observational only. NEVER authorizes tool execution or plan approval.
 * Parity reference: Cika superagent/evaluation/approval_selective_v1.rdy.
 */
export type SelectiveApprovalLabel = "none" | "affirm" | "deny" | "conditional";

const AFFIRM_EXACT = new Set([
 "ya","iya","yes","ok","oke","setuju","saya setuju","approved","approve",
 "silakan lanjut","silahkan lanjut","silakan dilanjutkan","silahkan dilanjutkan",
 "silakan mulai","silahkan mulai","lanjut","lanjutkan","go ahead",
 "yes go ahead","yes go ahead with that exact plan",
 "ya jalankan rencana yang tadi","ya lanjut","iya lanjut",
 "saya setujui rencana ini","saya setujui plan ini",
 "saya menyetujui rencana ini","saya menyetujui plan ini",
 "saya setuju dengan rencana itu","i approve this plan",
 "i approve the plan","i approve that plan","i agree with the plan",
 "i agree","proceed with the agreed plan",
 "saya izinkan","silakan kerjakan sesuai rencana",
 "laksanakan rencana yang disetujui","confirm","yes approve"
]);
const DENY_FIRST = [
 "tidak","tidak setuju","saya menolak","aku menolak","menolak",
 "jangan","jangan lanjut","jangan hapus","batal","batalkan",
 "stop","stop immediately","no","no thanks","no cancel","not approved",
 "i refuse","i do not approve","i dont approve",
 "belum","belum setuju","belum saya izinkan","gak","nggak","enggak","tak",
 "saya tidak setuju","saya tidak mengizinkan","tidak mengizinkan",
 "i disagree","i do not agree","please stop","tolak"
];
const CONDITIONAL_WORDS = [
 "tapi","tetapi","namun","but","jika","kalau","bila","if","asalkan",
 "asal","setelah","sesudah","sebelum","after","before","until",
 "unless","only","hanya","cuma","nantinya","nanti",
 "ketika","when","selama","syarat","provided","as long as",
 "not now","not yet","jangan","bukan","tanpa","without",
 "in principle","in theory","dengan catatan","as soon as"
];
const CONDITIONAL_PREFIX = [
 "ya","yes","iya","oke","ok","setuju","saya setuju","approve","approved",
 "saya setujui","silakan","silahkan","lanjut","lanjutkan","boleh",
 "go ahead","continue","proceed","sure","i agree","i approve","saya izinkan",
 "laksanakan"
];
const CONDITIONAL_EXACT = new Set([
 "silakan setelah backup selesai","lanjut jika sudah dibackup",
 "iya hanya kalau tidak ada perubahan data",
 "lanjutkan analisisnya saja","please continue the explanation only",
 "boleh jelaskan lebih lanjut saja","saya ingin review dulu",
 "wait for confirmation","pending review","mungkin setelah diuji"
]);
function normalizeApproval(text: string): string {
  const t = text.toLowerCase().replace(/[’‘]/g, "'").replace(/[—–]/g, " ");
  return t.replace(/[,\.\!?;:\n\r\t"'()]/g, " ").trim().replace(/\s+/g, " ");
}
function startsAny(t: string, phrases: string[]): boolean {
  return phrases.some(p => t === p || t.startsWith(p + " "));
}
function hasPhrase(t: string, phrases: string[]): boolean {
  const padded = " " + t + " ";
  return phrases.some(p => padded.includes(" " + p + " "));
}
export function inferSelectiveApproval(text: string, context = ""): SelectiveApprovalLabel {
  if (context !== "PLANNING_PENDING") return "none";
  // Questions, even "yes?" or "approved?", cannot approve a pending plan.
  if (text.trim().endsWith("?")) return "none";
  const t = normalizeApproval(text);
  if (!t) return "none";
  if (startsAny(t, DENY_FIRST)) return "deny";
  if (CONDITIONAL_EXACT.has(t)) return "conditional";
  if (hasPhrase(t, CONDITIONAL_WORDS) && startsAny(t, CONDITIONAL_PREFIX)) return "conditional";
  if (AFFIRM_EXACT.has(t)) return "affirm";
  return "none";
}

export function observeSelectiveApproval(text: string, context = "") {
  const label = inferSelectiveApproval(text, context);
  return {
    label,
    authorizesExecution: false as const,
    requiresIndependentToolAuthorization: true as const,
    abstained: label === "none",
    confidenceCalibrated: false as const,
    source: "cika-superagent-approval-selective-v1" as const,
  };
}
