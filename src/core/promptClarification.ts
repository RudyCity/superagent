/**
 * promptClarification.ts — High-performance ambiguity detection, multi-language translation, persistent intent memory & auto-learning.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { EventEmitter } from "events";

export interface IntentAnalysisResult {
  isAmbiguous: boolean;
  confidence: number;
  detectedLanguage: string;
  rewrittenIntent?: string;
  translatedEnglishPrompt?: string;
  reason?: string;
  shortcutApplied?: boolean;
  learnedFromCorrection?: boolean;
}

export interface TranslationBadgePayload {
  originalPrompt: string;
  translatedPrompt: string;
  detectedLanguage: string;
  confidence: number;
  shortcutApplied?: boolean;
}

export const translationBadgeEmitter = new EventEmitter();

const AMBIGUOUS_PATTERNS = [
  /tambah(kan)?\s+lagi/i,
  /perbaiki\s+ini/i,
  /ubah\s+itu/i,
  /bisa\s+di\s*buat/i,
  /ganti\s+lagi/i,
  /fix\s+this/i,
  /do\s+it/i,
  /make\s+it\s+better/i,
  /update\s+code/i,
  /bikin\s+seperti\s+kemarin/i,
  /beberapa\s+kali\s+ai\s+agent\s+keliru/i,
];

const EXPLICIT_TARGET_PATTERNS = [
  /file\s+[^\s]+/i,
  /function\s+[^\s]+/i,
  /class\s+[^\s]+/i,
  /src\/[^\s]+/i,
  /tests\/[^\s]+/i,
  /package\.json/i,
];

/**
 * Multi-language technical dictionary maps (Indonesian, Japanese, Chinese, Spanish, French, German).
 */
const MULTI_LANG_DICTIONARY: Record<string, Array<[RegExp, string]>> = {
  id: [
    [/ptrompt|promt|prompt/gi, "prompt"],
    [/automatis|otomatis/gi, "automatically"],
    [/di\s*yranslate|di\s*translate|diterjemahkan|yranslate|translate/gi, "translated"],
    [/ke\s+englosih|ke\s+english|ke\s+bahasa\s+inggris/gi, "to English"],
    [/apa\s+bisa\??/gi, "is it possible?"],
    [/bisa\??/gi, "is it possible?"],
    [/tambahkan/gi, "add"],
    [/perbaiki/gi, "fix"],
    [/buatkan|bikin/gi, "create"],
    [/ubah|ganti/gi, "modify"],
    [/pada\s+file/gi, "in file"],
    [/fungsi/gi, "function"],
  ],
  ja: [
    [/修正して|直して/g, " fix "],
    [/追加して/g, " add "],
    [/作成して|作って/g, " create "],
    [/ファイルを/g, " file "],
    [/関数を/g, " function "],
    [/できますか\??/g, " is it possible?"],
  ],
  zh: [
    [/修复|修改|改一下/g, " fix "],
    [/添加|增加/g, " add "],
    [/创建|制作/g, " create "],
    [/文件/g, " file "],
    [/函数/g, " function "],
    [/可以吗\??|行吗\??/g, " is it possible?"],
  ],
  es: [
    [/corregir|arreglar|fijar/gi, "fix"],
    [/añadir|agregar/gi, "add"],
    [/crear/gi, "create"],
    [/en el archivo/gi, "in file"],
    [/función/gi, "function"],
    [/¿es posible\??|es posible\??/gi, "is it possible?"],
  ],
  fr: [
    [/corriger|réparer/gi, "fix"],
    [/ajouter/gi, "add"],
    [/créer/gi, "create"],
    [/dans le fichier/gi, "in file"],
    [/fonction/gi, "function"],
    [/est-ce possible\??/gi, "is it possible?"],
  ],
  de: [
    [/reparieren|beheben/gi, "fix"],
    [/hinzufügen/gi, "add"],
    [/erstellen/gi, "create"],
    [/in der datei/gi, "in file"],
    [/funktion/gi, "function"],
    [/ist das möglich\??/gi, "is it possible?"],
  ],
};

/**
 * Detect language of input prompt.
 */
export function detectLanguage(text: string): string {
  if (/[\u4e00-\u9fa5]/.test(text) && !/[\u3040-\u30ff]/.test(text)) return "zh";
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(text)) return "ja";
  if (/\b(el|la|los|las|en|del|archivo|función|por|favor|crear|añadir|corregir)\b/i.test(text)) return "es";
  if (/\b(le|la|les|dans|fichier|fonction|créer|ajouter|corriger)\b/i.test(text)) return "fr";
  if (/\b(der|die|das|in|datei|funktion|erstellen|hinzufügen|beheben)\b/i.test(text)) return "de";
  if (/\b(bisa|tambah|perbaiki|ubah|bikin|diterjemahkan|ke|pada)\b/i.test(text)) return "id";
  return "en";
}

/**
 * Persistent Memory File path in ~/.superagent-r/intent-memory.json
 */
const MEMORY_FILE_PATH = path.join(os.homedir(), ".superagent-r", "intent-memory.json");

function loadPersistentMemory(): Record<string, string> {
  try {
    if (fs.existsSync(MEMORY_FILE_PATH)) {
      const data = fs.readFileSync(MEMORY_FILE_PATH, "utf-8");
      return JSON.parse(data);
    }
  } catch {}
  return {
    "perbaiki ui": "chrome-extension/sidepanel.html",
    "fix ui": "chrome-extension/sidepanel.html",
    "perbaiki prompt": "src/core/prompts.ts",
  };
}

async function savePersistentMemoryAsync(memory: Record<string, string>): Promise<void> {
  try {
    const dir = path.dirname(MEMORY_FILE_PATH);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(MEMORY_FILE_PATH, JSON.stringify(memory, null, 2), "utf-8");
  } catch {}
}

const INTENT_MEMORY_STORE = new Map<string, string>(Object.entries(loadPersistentMemory()));

export function registerIntentShortcut(phrase: string, targetFile: string): void {
  const key = phrase.toLowerCase().trim();
  INTENT_MEMORY_STORE.set(key, targetFile);
  const currentObj = Object.fromEntries(INTENT_MEMORY_STORE);
  savePersistentMemoryAsync(currentObj).catch(() => {});
}

/**
 * Auto-learns shortcut when user provides corrections like "bukan X, maksud saya Y".
 */
export function autoLearnFromCorrection(userFeedback: string): { learned: boolean; phrase?: string; target?: string } {
  const correctionMatch = userFeedback.match(/(?:bukan|not)\s+(.+?),\s*(?:maksud|mean|target)\s+(?:saya\s+)?(?:file\s+)?([^\s]+)/i);
  if (correctionMatch) {
    const phrase = correctionMatch[1].trim();
    const target = correctionMatch[2].trim();
    registerIntentShortcut(phrase, target);
    return { learned: true, phrase, target };
  }
  return { learned: false };
}

/**
 * Multi-Turn Conversation Memory for resolving follow-up options ("yang kedua", "pilih 2", "option 3").
 */
let lastPromptOptions: string[] = [];

export function setLastPromptOptions(options: string[]): void {
  lastPromptOptions = options;
}

export function resolveMultiTurnSelection(text: string): string | null {
  const lower = text.toLowerCase().trim();

  const numMatch = lower.match(/(?:opsi|option|pilih|nomor|no\.?|^)\s*(\d+)/i);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < lastPromptOptions.length) {
      return lastPromptOptions[idx];
    }
  }

  if (/(yang\s+pertama|first\s+one)/i.test(lower) && lastPromptOptions.length >= 1) {
    return lastPromptOptions[0];
  }
  if (/(yang\s+kedua|second\s+one)/i.test(lower) && lastPromptOptions.length >= 2) {
    return lastPromptOptions[1];
  }
  if (/(yang\s+ketiga|third\s+one)/i.test(lower) && lastPromptOptions.length >= 3) {
    return lastPromptOptions[2];
  }
  return null;
}

/**
 * Word-boundary token matching for shortcut lookup.
 */
function findMatchingShortcut(text: string): { shortcut: string; target: string } | null {
  const lowerText = text.toLowerCase();
  for (const [shortcut, target] of INTENT_MEMORY_STORE.entries()) {
    const escaped = shortcut.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s|[.,!?])`, "i");
    if (regex.test(lowerText) || lowerText.includes(shortcut)) {
      return { shortcut, target };
    }
  }
  return null;
}

/**
 * Translates prompt to English for LLM processing using multi-language dictionary & hybrid fallback.
 */
export function translatePromptToEnglish(promptText: string): { translated: string; detectedLang: string; shortcutApplied?: boolean } {
  let text = promptText.trim();
  const lang = detectLanguage(text);

  const multiTurnResolved = resolveMultiTurnSelection(text);
  if (multiTurnResolved) {
    return {
      translated: `User selected option: "${multiTurnResolved}"`,
      detectedLang: lang,
      shortcutApplied: true,
    };
  }

  const match = findMatchingShortcut(text);
  if (match) {
    return {
      translated: `Fix target component ${match.target} per user request "${text}"`,
      detectedLang: lang,
      shortcutApplied: true,
    };
  }

  const dict = MULTI_LANG_DICTIONARY[lang] || MULTI_LANG_DICTIONARY["id"];
  if (dict) {
    for (const [pattern, replacement] of dict) {
      text = text.replace(pattern, replacement);
    }
  }

  text = text.replace(/\s+/g, " ").trim();
  return { translated: text, detectedLang: lang };
}

/**
 * Analyzes prompt text for ambiguity and returns intent clarity + auto-translation.
 */
export function analyzePromptIntent(promptText: string): IntentAnalysisResult {
  const text = promptText.trim();
  if (!text) {
    return { isAmbiguous: false, confidence: 1.0, detectedLanguage: "en" };
  }

  const correction = autoLearnFromCorrection(text);
  if (correction.learned) {
    const res: IntentAnalysisResult = {
      isAmbiguous: false,
      confidence: 1.0,
      detectedLanguage: detectLanguage(text),
      translatedEnglishPrompt: `Auto-learned user shortcut mapping "${correction.phrase}" -> "${correction.target}"`,
      learnedFromCorrection: true,
    };
    translationBadgeEmitter.emit("badge", {
      originalPrompt: text,
      translatedPrompt: res.translatedEnglishPrompt,
      detectedLanguage: res.detectedLanguage,
      confidence: res.confidence,
    });
    return res;
  }

  const { translated: translatedEnglishPrompt, detectedLang, shortcutApplied } = translatePromptToEnglish(text);

  if (shortcutApplied || (translatedEnglishPrompt && translatedEnglishPrompt !== text)) {
    translationBadgeEmitter.emit("badge", {
      originalPrompt: text,
      translatedPrompt: translatedEnglishPrompt,
      detectedLanguage: detectedLang,
      confidence: shortcutApplied ? 1.0 : 0.95,
      shortcutApplied,
    });
  }

  if (shortcutApplied) {
    return {
      isAmbiguous: false,
      confidence: 1.0,
      detectedLanguage: detectedLang,
      translatedEnglishPrompt,
      shortcutApplied: true,
    };
  }

  const hasAmbiguousPhrase = AMBIGUOUS_PATTERNS.some((p) => p.test(text));
  const hasExplicitTarget = EXPLICIT_TARGET_PATTERNS.some((p) => p.test(text));
  const wordCount = text.split(/\s+/).length;

  if (hasAmbiguousPhrase && !hasExplicitTarget) {
    return {
      isAmbiguous: true,
      confidence: 0.85,
      detectedLanguage: detectedLang,
      rewrittenIntent: `Konfirmasi maksud: "${text}" — Apakah Anda ingin mengklarifikasi komponen/file target sebelum eksekusi?`,
      translatedEnglishPrompt,
      reason: "Detected ambiguous phrase without explicit target file/component.",
    };
  }

  if (wordCount <= 3 && !hasExplicitTarget && !/^(ya|tidak|oke|ok|yes|no|lanjut|batal|help|status|list)$/i.test(text)) {
    return {
      isAmbiguous: true,
      confidence: 0.75,
      detectedLanguage: detectedLang,
      rewrittenIntent: `Prompt sangat singkat ("${text}"). Mohon konfirmasi target atau aksi yang diinginkan.`,
      translatedEnglishPrompt,
      reason: "Short prompt lacking technical target.",
    };
  }

  return {
    isAmbiguous: false,
    confidence: 0.95,
    detectedLanguage: detectedLang,
    translatedEnglishPrompt,
  };
}

/**
 * Mutex lock to prevent race conditions during prompt processing.
 */
let isProcessingRequest = false;

export async function withProcessingLock<T>(fn: () => Promise<T>): Promise<T> {
  if (isProcessingRequest) {
    throw new Error("Request locked: Another request is currently processing. Prevented race condition.");
  }
  isProcessingRequest = true;
  try {
    return await fn();
  } finally {
    isProcessingRequest = false;
  }
}
