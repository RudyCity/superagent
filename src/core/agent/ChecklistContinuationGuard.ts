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

/**
 * Detects whether the model's text is explicitly asking the user for input,
 * reporting a blocking limitation, or waiting for confirmation/permission.
 * In these cases, the agent should NOT be auto-nudged to continue acting.
 */
export function isNeedsInputOrLimitation(textContent: string): boolean {
  const text = (textContent || "").trim();
  if (!text) return false;

  // 1. Explicit needs-input phrases
  const needsInputRegex = /\b(?:please (?:provide|specify|choose|select|confirm|clarify|enter|tell me|let me know)|needs? user input|waiting for (?:user|human|your) (?:input|approval|confirmation|response)|which option would you prefer|could you (?:please )?(?:provide|clarify|confirm)|do you want me to|would you like me to|should i proceed with|silakan (?:berikan|pilih|konfirmasi))\b/i;
  if (needsInputRegex.test(text)) return true;

  // 2. Permission / confirmation required
  const permissionRegex = /\b(?:requires? (?:your )?(?:explicit )?permission|need (?:your )?approval|waiting for permission|do you approve|apakah anda setuju|mohon persetujuan)\b/i;
  if (permissionRegex.test(text)) return true;

  // 3. Explicit blocker / limitation
  const blockerRegex = /\b(?:cannot proceed (?:without|because|due to)|unable to (?:proceed|continue|complete)|blocked by|i am blocked|i don't have access to|tidak dapat melanjutkan|terhalang oleh)\b/i;
  if (blockerRegex.test(text)) return true;

  // 4. Ends with a direct question to the user (and is not mere planning narration)
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || "";
  if (/\?$/.test(lastLine)) {
    const isQuestionToUser = /\b(would you|could you|do you|should we|shall we|can you|what would you|which|apakah)\b/i.test(lastLine);
    if (isQuestionToUser) return true;
  }

  return false;
}

/**
 * Detects whether the model is looping on the same repetitive narration without progress.
 */
export function isRepetitiveNarration(currentText: string, previousTexts: string[]): boolean {
  if (!previousTexts || previousTexts.length === 0) return false;
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  const currClean = clean(currentText);
  if (!currClean) return false;

  for (const prev of previousTexts) {
    const prevClean = clean(prev);
    if (!prevClean) continue;
    if (currClean === prevClean) return true;
    if (currClean.length > 20 && prevClean.length > 20) {
      if (currClean.includes(prevClean) || prevClean.includes(currClean)) return true;
    }
  }
  return false;
}
