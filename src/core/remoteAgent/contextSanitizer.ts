import type { TaskContextMessage } from "./protocol.js";

/**
 * Common regex patterns for identifying and scrubbing sensitive credentials
 * before envelopes or tool outputs are transmitted over external tunnels.
 */
const SENSITIVE_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  // Anthropic API keys (sk-ant-...)
  {
    regex: /sk-ant-[a-zA-Z0-9_\-]{20,}/g,
    replacement: "[REDACTED_ANTHROPIC_KEY]",
  },
  // OpenAI API keys (sk-... or sk-proj-...)
  {
    regex: /sk-(?:proj-|live-)?[a-zA-Z0-9_\-]{24,}/g,
    replacement: "[REDACTED_OPENAI_KEY]",
  },
  // Google AI / Gemini / Firebase API keys (AIzaSy...)
  {
    regex: /AIzaSy[a-zA-Z0-9_\-]{25,35}/g,
    replacement: "[REDACTED_GOOGLE_KEY]",
  },

  // GitHub Personal Access Tokens (classic & fine-grained)
  {
    regex: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    regex: /github_pat_[a-zA-Z0-9_]{40,}/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  // AWS Access Key IDs
  {
    regex: /AKIA[0-9A-Z]{16}/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  // Slack Tokens (Bot, User, App)
  {
    regex: /xox[baprs]-[0-9a-zA-Z\-]{10,72}/g,
    replacement: "[REDACTED_SLACK_TOKEN]",
  },

  // Private Key Blocks (RSA, EC, OpenSSH, DSA, PGP)
  {
    regex: /-----BEGIN (?:[A-Z0-9 ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+)?PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY_BLOCK]",
  },
  // Bearer authentication tokens
  {
    regex: /Bearer\s+[a-zA-Z0-9_\-\.]{25,}/gi,
    replacement: "Bearer [REDACTED_BEARER_TOKEN]",
  },
  // Database / Redis connection strings with credentials
  {
    regex: /((?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|rediss):\/\/[^:\s\r\n]+:)([^@\s\r\n]+)(@)/gi,
    replacement: "$1[REDACTED_PASSWORD]$3",
  },
  // Environment variable lines with credentials (e.g. API_KEY=xyz, SECRET_KEY="xyz")
  {
    regex: /((?:^|[\r\n])\s*(?:export\s+)?(?:[A-Z0-9_]*(?:API_KEY|SECRET|PASSWORD|TOKEN|AUTH|CREDENTIAL|PRIVATE)[A-Z0-9_]*)\s*=\s*)(['"]?)(?!\[REDACTED)([^\r\n'"]{4,})\2/gi,
    replacement: "$1$2[REDACTED_SECRET]$2",
  },

];

/**
 * Scrubs known secret formats and explicit custom secrets from any text string.
 */
export function scrubSecrets(
  text: string,
  customSecrets?: Array<string | undefined | null>
): string {
  if (!text || typeof text !== "string") {
    return "";
  }

  let scrubbed = text;

  // 1. Scrub standard credential signatures
  for (const { regex, replacement } of SENSITIVE_PATTERNS) {
    scrubbed = scrubbed.replace(regex, replacement);
  }

  // 2. Scrub specific known secrets (e.g. wsToken, botToken, cfAccessClientSecret)
  if (customSecrets && customSecrets.length > 0) {
    for (const secret of customSecrets) {
      if (!secret || typeof secret !== "string" || secret.trim().length < 4) {
        continue;
      }
      const trimmed = secret.trim();
      const escaped = trimmed.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      scrubbed = scrubbed.replace(new RegExp(escaped, "g"), "[REDACTED_SECRET]");
    }
  }

  return scrubbed;
}

export const DEFAULT_MAX_MESSAGE_CHARS = 2500;
export const DEFAULT_MAX_TOTAL_CONTEXT_CHARS = 12000;
export const DEFAULT_MAX_CONTEXT_MESSAGES = 10;

/**
 * Truncates an individual context message if it exceeds maxChars,
 * keeping both the initial context (head) and recent conclusion (tail).
 */
export function truncateContextMessage(
  text: string,
  maxChars = DEFAULT_MAX_MESSAGE_CHARS
): string {
  if (!text || text.length <= maxChars) {
    return text || "";
  }

  // Split budget: 60% head, 40% tail
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.floor(maxChars * 0.4) - 60; // reserve space for notice
  const head = text.slice(0, headLen);
  const tail = text.slice(-Math.max(10, tailLen));
  const omitted = text.length - head.length - tail.length;

  return `${head}\n\n[... truncated ${omitted} characters for context budget ...]\n\n${tail}`;
}

export interface SanitizeContextOptions {
  maxCharsPerMessage?: number;
  maxTotalChars?: number;
  maxMessages?: number;
  customSecrets?: Array<string | undefined | null>;
}

/**
 * Sanitizes and dynamically budgets the conversation context array before sending
 * to a remote brain over WebSocket or Telegram:
 * 1. Scrubs sensitive credentials & API keys.
 * 2. Truncates individual bloated messages.
 * 3. Enforces total character budget, prioritizing newest messages.
 */
export function sanitizeTaskContext(
  messages: TaskContextMessage[],
  options: SanitizeContextOptions = {}
): TaskContextMessage[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  const maxCharsPerMessage = options.maxCharsPerMessage ?? DEFAULT_MAX_MESSAGE_CHARS;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CONTEXT_CHARS;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_CONTEXT_MESSAGES;

  // 1. Take up to maxMessages, scrub secrets, and apply per-message truncation
  const candidateSlice = messages.slice(-maxMessages);
  const processed: TaskContextMessage[] = [];

  for (const msg of candidateSlice) {
    if (!msg || !msg.content || typeof msg.content !== "string") {
      continue;
    }
    const rawText = msg.content.trim();
    if (!rawText) continue;

    const scrubbed = scrubSecrets(rawText, options.customSecrets);
    const truncated = truncateContextMessage(scrubbed, maxCharsPerMessage);

    processed.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: truncated,
    });
  }

  // 2. Budget enforcement from newest to oldest
  const budgeted: TaskContextMessage[] = [];
  let currentTotalChars = 0;

  for (let i = processed.length - 1; i >= 0; i--) {
    const item = processed[i];
    const itemLen = item.content.length;

    if (currentTotalChars + itemLen <= maxTotalChars || budgeted.length === 0) {
      budgeted.unshift(item);
      currentTotalChars += itemLen;
    } else {
      // If adding this message exceeds budget, we can include a truncated snippet if space remains
      const remainingSpace = maxTotalChars - currentTotalChars;
      if (remainingSpace > 300) {
        const snippet = truncateContextMessage(item.content, remainingSpace);
        budgeted.unshift({
          role: item.role,
          content: snippet,
        });
        currentTotalChars += snippet.length;
      }
      break;
    }
  }

  return budgeted;
}

/**
 * Scrubs tool output before returning task_result to the remote brain.
 */
export function scrubToolOutput(
  output: string,
  customSecrets?: Array<string | undefined | null>
): string {
  return scrubSecrets(output, customSecrets);
}
