/**
 * Beautifies and formats a task summary from Muse so it renders cleanly
 * with proper paragraphs, newlines, and list indentation in the terminal.
 */
export function formatReadableSummary(raw: string): string {
  let text = (raw || "").trim();
  if (!text) return "";

  // 1. Unescape literal \n and \r
  text = text.replace(/\\r/g, "").replace(/\\n/g, "\n");

  // 2. Break major section headings onto their own paragraphs
  const sectionKeywords =
    "TEMUAN|POSITIF|NEGATIF|CATATAN|KESIMPULAN|REKOMENDASI|FINDINGS|RECOMMENDATIONS|NOTES|CONCLUSION|SUMMARY|HASIL|LANGKAH SELANJUTNYA|NEXT STEPS";
  text = text.replace(
    new RegExp("([.!?\\w\\)])\\s+(" + sectionKeywords + "):", "gi"),
    "$1\n\n$2:"
  );
  text = text.replace(
    new RegExp("^(" + sectionKeywords + "):\\s*", "gim"),
    "$1:\n"
  );

  // 3. Break inline numbered list items onto separate lines (e.g. " 1) " or " 1. ")
  text = text.replace(/([:;.!?\w\)])\s+([0-9]+[\)\.])\s+/g, "$1\n  $2 ");

  // 4. Break inline bullets onto separate lines (only after punctuation : ; . ! ?)
  text = text.replace(/([:;.!?])\s+([•\-])\s+/g, "$1\n  $2 ");

  // 5. Clean up any excessive newlines (keep at most 2 consecutive newlines)
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
