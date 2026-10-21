/**
 * Guard against treating a conversational question as an unfinished implementation.
 * The request (rather than the model's answer) determines whether a checklist nudge
 * makes sense. This is a safety net for classifier mistakes and stale task files.
 */
export const MAX_TEXT_ONLY_CONTINUATIONS = 2;

export function isInformationalRequest(input: string, category?: string): boolean {
  const text = input.trim();
  if (!text) return false;

  // A user can ask for an action in question form ("Can you fix this?").
  // Never suppress checklist enforcement when an explicit execution verb exists.
  const hasAction = /\b(?:tolong|please|kerjakan|lakukan|buat|buatkan|perbaiki|betulkan|fix|implement|implementasikan|ubah|update|edit|hapus|delete|remove|install|pasang|jalankan|run|execute|eksekusi|commit|push|deploy|build|audit|debug|cek|check|periksa|test|uji|tulis|write|generate|create|add|tambahkan|migrasi|lanjut|lanjutkan)\b/i.test(text);
  if (hasAction) return false;

  const withoutConversationalPrefix = text.replace(/^(?:(?:ok|oke|okay|nah|btw|jadi|so|well)\b[\s,:-]*)+/i, "");
  const looksLikeQuestion =
    /[?？]\s*$/.test(text) ||
    /^(?:apa|apakah|ada|bagaimana|gimana|kenapa|mengapa|siapa|kapan|dimana|di mana|berapa|what|which|who|where|when|why|how|do|does|did|is|are|can|could|would|should)\b/i.test(withoutConversationalPrefix);

  return looksLikeQuestion || category === "question" || category === "conversation";
}

/** A synthetic progress marker from sendMessage is not an explicit task list. */
export function isAutoSeededSingleTask(taskContent: string, latestUserText: string): boolean {
  const text = latestUserText.trim();
  if (!text || text.includes(String.fromCharCode(10))) return false;
  const newline = String.fromCharCode(10);
  const expected = ["# Tasks", "", "- [/] " + text].join(newline);
  return taskContent.replaceAll(String.fromCharCode(13), "").trim() === expected;
}


/**
 * Auto-continue system nudges are scoped to one execution turn. Keeping them
 * across user messages pollutes later prompts and can restart a resolved loop.
 */
export function isTransientContinuationNudge(role: string, content: string): boolean {
  if (role !== "system") return false;
  return content.startsWith("[SYS] Continue immediately. Use the available tools to perform the search") ||
    (content.startsWith("[SYS] You have ") && content.includes("unfinished task(s) remaining on the checklist:"));
}
