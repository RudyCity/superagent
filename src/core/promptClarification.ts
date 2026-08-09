/**
 * promptClarification.ts — High-performance ambiguity detection, multi-language translation, persistent intent memory & auto-learning.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { EventEmitter } from "events";

// Lazy-loaded @xenova/transformers pipeline for ONNX translation (< 100MB RAM)
let translationPipelinePromise: Promise<any> | null = null;

/**
 * Initializes and warms up the ONNX translation model (Xenova/opus-mt-id-en INT8).
 * Runs lazily in the background on startup with low memory footprint (<100MB RAM).
 */
export async function initONNXTranslationPipeline(): Promise<any> {
  if (!translationPipelinePromise) {
    translationPipelinePromise = (async () => {
      try {
        const { pipeline, env } = await import("@xenova/transformers");
        // Disable local model download checks if offline, set low concurrency
        env.allowRemoteModels = true;
        env.useBrowserCache = false;
        if (env) {
          (env as any).logLevel = 'error';
        }
        if (env?.backends?.onnx) {
          (env.backends.onnx as any).logLevel = 'error';
        }
        
        const translator = await pipeline("translation", "Xenova/opus-mt-id-en", {
          quantized: true,
          session_options: {
            logSeverityLevel: 3,
          },
        } as any);
        return translator;
      } catch (error) {
        // Fallback gracefully if ONNX model fail to load or offline
        translationPipelinePromise = null;
        return null;
      }
    })();
  }
  return translationPipelinePromise;
}

/**
 * Translates prompt using ONNX local transformer if available, falling back to dictionary/pass-through.
 */
export async function translatePromptWithONNX(promptText: string): Promise<string | null> {
  try {
    const translator = await initONNXTranslationPipeline();
    if (!translator) return null;
    const output = await translator(promptText);
    if (Array.isArray(output) && output[0]?.translation_text) {
      return output[0].translation_text;
    }
  } catch (err) {
    // Graceful fallback
  }
  return null;
}

export interface IntentAnalysisResult {
  isAmbiguous: boolean;
  confidence: number;
  detectedLanguage: string;
  rewrittenIntent?: string;
  translatedEnglishPrompt?: string;
  reason?: string;
  shortcutApplied?: boolean;
  learnedFromCorrection?: boolean;
  secretsMasked?: boolean;
}

/**
 * Secret & Sensitive Data Masking (Security Pre-Filter)
 * High-performance single-pass pre-compiled Master Regex scanner with Early Exit Guard.
 */
const SECRET_HINT_PATTERN = /(?:sk-|ghp_|AKIA|eyJ|BEGIN|password|passwd|pwd|secret_key|api_key|access_token|db_pass|[:=])/i;

const MASTER_SECRET_PATTERN = new RegExp(
  [
    "(?:sk-(?:proj-)?[a-zA-Z0-9]{20,})",
    "(?:ghp_[a-zA-Z0-9]{36})",
    "(?:AKIA[0-9A-Z]{16})",
    "(?:eyJ[a-zA-Z0-9_-]{10,}\\.eyJ[a-zA-Z0-9_-]{10,}\\.[a-zA-Z0-9_-]+)",
    "-----BEGIN (?:RSA|OPENSSH|EC|PGP)? PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA|OPENSSH|EC|PGP)? PRIVATE KEY-----",
    "(?:password|passwd|pwd|secret_key|api_key|access_token|db_pass)\\s*[:=]\\s*[\"']?([^\\s\"']{4,})[\"']?",
  ].join("|"),
  "gi"
);

// Ephemeral Secret Vault map: $SECRET_1 -> original secret value (bounded size max 100)
const SECRET_VAULT = new Map<string, string>();
let secretCounter = 0;

export function clearSecretVault(): void {
  SECRET_VAULT.clear();
  secretCounter = 0;
}

export function maskSensitiveData(text: string): { maskedText: string; secretsFound: boolean; vault: Map<string, string> } {
  // Optimization 1: Early Exit Guard Check (0 ms execution for normal prompts)
  SECRET_HINT_PATTERN.lastIndex = 0;
  if (!SECRET_HINT_PATTERN.test(text)) {
    return { maskedText: text, secretsFound: false, vault: SECRET_VAULT };
  }

  let maskedText = text;
  let secretsFound = false;

  // Optimization 2: Single-pass scanning with Master Regex
  MASTER_SECRET_PATTERN.lastIndex = 0;
  if (MASTER_SECRET_PATTERN.test(maskedText)) {
    secretsFound = true;
    MASTER_SECRET_PATTERN.lastIndex = 0;
    maskedText = maskedText.replace(MASTER_SECRET_PATTERN, (match) => {
      let rawSecret = match;
      let prefix = "";

      if (match.includes("=") || match.includes(":")) {
        const delim = match.includes("=") ? "=" : ":";
        const parts = match.split(delim);
        prefix = `${parts[0]}${delim} `;
        rawSecret = parts.slice(1).join(delim).trim();
      }

      // Check if rawSecret already has an alias in SECRET_VAULT
      let alias = "";
      for (const [existingAlias, existingValue] of SECRET_VAULT.entries()) {
        if (existingValue === rawSecret) {
          alias = existingAlias;
          break;
        }
      }

      if (!alias) {
        if (SECRET_VAULT.size >= 100) {
          const oldestKey = SECRET_VAULT.keys().next().value;
          if (oldestKey) SECRET_VAULT.delete(oldestKey);
        }

        secretCounter++;
        alias = `$SECRET_${secretCounter}`;
        SECRET_VAULT.set(alias, rawSecret);
      }

      return `${prefix}${alias}`;
    });
  }

  if (secretsFound) {
    translationBadgeEmitter.emit("badge", {
      originalPrompt: text,
      translatedPrompt: maskedText,
      detectedLanguage: "en",
      confidence: 1.0,
      shortcutApplied: false,
      securityRedacted: true,
    });
  }

  return { maskedText, secretsFound, vault: SECRET_VAULT };
}

/**
 * Replaces secret aliases ($SECRET_1, $SECRET_2, etc.) in text back with their original sensitive values.
 * Useful when tools need to execute or write authentic values safely.
 */
export function unmaskSensitiveData(text: string): string {
  let unmaskedText = text;
  for (const [alias, originalValue] of SECRET_VAULT.entries()) {
    const escapedAlias = alias.replace(/\$/g, "\\$");
    unmaskedText = unmaskedText.replace(new RegExp(escapedAlias, "g"), originalValue);
  }
  return unmaskedText;
}

export function getSecretVault(): Map<string, string> {
  return SECRET_VAULT;
}

/**
 * Noise & Filler Trimming (Token Saver)
 * Strips conversational filler in Indonesian & English to focus LLM on core instructions.
 */
const FILLER_PREFIX_PATTERNS = [
  /^(?:halo|hai|hi|hey|permisi|pantesan|tolong|mohon|bisa|bisakah|bro|gan|min|mas|mbak|pak|bu|ai)\b\s*/gi,
  /^(?:can you|could you|please|kindly|would you mind|i want to|i need to|help me to)\b\s*/gi,
  /^(?:tolong bantu saya untuk|tolong bantuin|bisa tolong|bisakah anda|minta tolong)\b\s*/gi,
];

const FILLER_SUFFIX_PATTERNS = [
  /\b(?:dong|ya|yah|nih|tuh|kan|deh|dulu|saja|aja|makasih|terima kasih|thanks|thank you)\s*[.!?]*$/gi,
];

export function trimConversationalNoise(text: string): string {
  let cleaned = text.trim();

  let previous = "";
  while (cleaned !== previous) {
    previous = cleaned;
    for (const pattern of FILLER_PREFIX_PATTERNS) {
      cleaned = cleaned.replace(pattern, "");
    }
  }

  for (const pattern of FILLER_SUFFIX_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }

  return cleaned.trim() || text;
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
    "extensi chrome": "chrome-extension/",
    "chrome extension": "chrome-extension/",
    "extensi remote": "chrome-extension-remote/",
    "remote extension": "chrome-extension-remote/",
    "chrome extension remote": "chrome-extension-remote/",
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
  const { maskedText } = maskSensitiveData(promptText);
  const trimmed = trimConversationalNoise(maskedText);
  let text = trimmed.trim();
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
  // Pre-processing step 1: Mask sensitive credentials & API keys
  const { maskedText, secretsFound } = maskSensitiveData(promptText);

  // Pre-processing step 2: Trim conversational noise & filler words
  const trimmedText = trimConversationalNoise(maskedText);

  const text = trimmedText.trim();
  if (!text) {
    return { isAmbiguous: false, confidence: 1.0, detectedLanguage: "en", secretsMasked: secretsFound };
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
 * Async version of prompt intent analysis that utilizes ONNX local transformer (<100MB RAM)
 * for high-accuracy translation fallback when detected language is non-English.
 */
export async function analyzePromptIntentAsync(promptText: string): Promise<IntentAnalysisResult> {
  const result = analyzePromptIntent(promptText);

  // If already shortcut-resolved or language is English, return immediate result
  if (result.shortcutApplied || result.learnedFromCorrection || result.detectedLanguage === "en") {
    return result;
  }

  // Fallback to ONNX Transformer for Indonesian or multi-language translation
  const onnxTranslated = await translatePromptWithONNX(promptText);
  if (onnxTranslated && onnxTranslated !== promptText) {
    result.translatedEnglishPrompt = onnxTranslated;
    translationBadgeEmitter.emit("badge", {
      originalPrompt: promptText,
      translatedPrompt: onnxTranslated,
      detectedLanguage: result.detectedLanguage,
      confidence: 0.98,
      shortcutApplied: false,
    });
  }

  return result;
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
