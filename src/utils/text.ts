export function resolveCarriageReturns(text: string): string {
  const lines = text.split("\n");
  const processed = lines.map((line) => {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    const idx = clean.lastIndexOf("\r");
    return idx === -1 ? clean : clean.slice(idx + 1);
  });
  return processed.join("\n");
}

export function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "{}";
  const parts = entries.map(([k, v]) => {
    const raw = String(v ?? "");
    // For command/cmd fields: flatten newlines and truncate to 80 chars
    if (k === "command" || k === "cmd") {
      const flat = raw.replace(/\r?\n/g, " ; ").replace(/\s+/g, " ").trim();
      const truncated = flat.length > 80 ? flat.slice(0, 77) + "..." : flat;
      return `${k}: ${JSON.stringify(truncated)}`;
    }
    const val = JSON.stringify(v);
    const truncated = val.length > 60 ? val.slice(0, 60) + "..." : val;
    return `${k}: ${truncated}`;
  });
  return `{ ${parts.join(", ")} }`;
}

export function formatCompactNumber(num: number): string {
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1).replace(/\.?0+$/, "") + "K";
  }
  return num.toString();
}

/**
 * Perform a fuzzy match and score on a text against a pattern.
 * Returns a score if it matches, or null if it doesn't.
 * Lower score is better/closer match:
 * - 0: Exact match (case-insensitive)
 * - 1: Prefix match (starts with)
 * - 2: Substring match (contains)
 * - 3: Fuzzy / subsequence match
 */
export function fuzzyScore(pattern: string, text: string): number | null {
  if (!pattern) return 0;
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();

  if (t === p) return 0;
  if (t.startsWith(p)) return 1;
  if (t.includes(p)) return 2;

  let pIdx = 0;
  for (let tIdx = 0; tIdx < t.length; tIdx++) {
    if (t[tIdx] === p[pIdx]) {
      pIdx++;
      if (pIdx === p.length) return 3;
    }
  }

  return null;
}

/**
 * Filter and sort a list of possibilities using fuzzy matching against an input.
 */
export function filterSuggestions(possibilities: string[], input: string): string[] {
  const scored = possibilities
    .map((p) => ({ text: p, score: fuzzyScore(input, p) }))
    .filter((item) => item.score !== null) as { text: string; score: number }[];

  return scored
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.text.length !== b.text.length) return a.text.length - b.text.length;
      return a.text.localeCompare(b.text);
    })
    .map((item) => item.text);
}

/**
 * Strip SGR-style mouse escape sequences that may leak into text input
 * when the user clicks on the terminal.
 *
 * Handles:
 *   - SGR format: \x1b[<btn;col;rowM  (or with \x1b stripped by Ink)
 *   - Variable parameter count: [<0;48;30M, [<0;3;18M
 *   - Partial/fragmented at end of string: [<0;48;30 (missing terminator)
 */
export function stripSgrMouseSequences(value: string): string {
  return value
    // Full SGR mouse sequences with or without leading ESC
    .replace(/(?:\x1b)?\[<\d+(?:;\d+)*[Mm]/g, "")
    // Partial sequences at end of string (data might be fragmented)
    .replace(/(?:\x1b)?\[<\d+(?:;\d+)*$/gm, "");
}

export function getInsertion(oldVal: string, newVal: string): { prefix: string; inserted: string; suffix: string } {
  let start = 0;
  while (start < oldVal.length && start < newVal.length && oldVal[start] === newVal[start]) {
    start++;
  }
  let endOld = oldVal.length - 1;
  let endNew = newVal.length - 1;
  while (endOld >= start && endNew >= start && oldVal[endOld] === newVal[endNew]) {
    endOld--;
    endNew--;
  }
  const prefix = oldVal.slice(0, start);
  const inserted = newVal.slice(start, endNew + 1);
  const suffix = oldVal.slice(endOld + 1);
  return { prefix, inserted, suffix };
}

export function getPasteSplit(currentInput: string, prefixLen: number, suffixLen: number) {
  const prefix = currentInput.slice(0, Math.min(currentInput.length, prefixLen));
  const suffix = suffixLen > 0 ? currentInput.slice(Math.max(prefix.length, currentInput.length - suffixLen)) : "";
  const inserted = currentInput.slice(prefix.length, currentInput.length - suffix.length);
  return { prefix, inserted, suffix };
}

/**
 * Apply a Unicode combining long solidus overlay (U+0336) to each visible
 * character so the text appears struck-through regardless of terminal
 * ANSI strikethrough support.  Spaces and zero-width characters are
 * skipped to keep the output visually clean.
 */
export function unicodeStrikethrough(text: string): string {
  const COMBINING_STRIKE = "\u0336";
  let result = "";
  for (const ch of text) {
    // Skip spaces and zero-width characters
    if (ch === " " || ch === "\u200B" || ch === "\u200C" || ch === "\u200D" || ch === "\uFEFF") {
      result += ch;
    } else {
      result += ch + COMBINING_STRIKE;
    }
  }
  return result;
}

export function minimizePathInDescription(str: string): string {
  // 1. Handle "file: " pattern
  const fileKeyword = "file: ";
  const idx = str.indexOf(fileKeyword);
  if (idx !== -1) {
    const prefix = str.slice(0, idx + fileKeyword.length);
    const path = str.slice(idx + fileKeyword.length).trim();
    const normalizedPath = path.replace(/\\/g, "/");
    const parts = normalizedPath.split("/");
    const filename = parts[parts.length - 1] || path;
    return prefix + filename;
  }

  // 2. Handle cd command pattern: cd "path" or cd path
  const cdRegex = /(cd\s+)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;&|]+)/i;
  const match = cdRegex.exec(str);
  if (match) {
    const prefix = match[1];
    let rawPath = match[2];
    let isQuoted = false;
    let quoteChar = "";
    if ((rawPath.startsWith('"') && rawPath.endsWith('"')) || (rawPath.startsWith("'") && rawPath.endsWith("'"))) {
      quoteChar = rawPath[0];
      rawPath = rawPath.slice(1, -1);
      isQuoted = true;
    }
    const normalizedPath = rawPath.replace(/\\/g, "/");
    const parts = normalizedPath.split("/");
    const basename = parts[parts.length - 1] || rawPath;
    const replacementPath = isQuoted ? `${quoteChar}.../${basename}${quoteChar}` : `.../${basename}`;
    return str.replace(match[0], prefix + replacementPath);
  }

  return str;
}

export function cleanAssistantResponse(text: string): string {
  if (!text) return "";
  let cleaned = text;

  // List of regex patterns of commonly echoed system instruction phrases/blocks
  const patternsToStrip = [
    /^\s*Proceed to step-by-step coding and execution! Keep implementation plans and tasks in sync\. Make sure to update task statuses as you complete items\. Write a walkthrough when done\.\s*/i,
    /^\s*- Do NOT perform planning steps \(no get_skills\/use_skill calls or plan\/task modifications for planning\)\.\s*/i,
    /^\s*- Do NOT ask for permission\/confirmation to make changes or run tests\.\s*/i,
    /^\s*- Proceed directly to execution\.\s*/i,
    /^\s*TESTING & COMPILING:\s*/i,
    /^\s*- Ensure the project builds successfully and all tests pass before completing your work\.\s*/i,
    /^\s*- When done, document all modifications, compile logs, and test run reports inside the Walkthrough File before reporting completion\.\s*/i,
    /^\s*We are ready to start\. Proceed!\s*/i,
    /^\s*Do NOT ask for additional design or plan approvals from the user unless you hit a critical architectural blocker\.\s*/i,
    /^\s*Ensure you record your test results and write a final walkthrough summary to the Walkthrough File before completion\.\s*/i,
    /^\s*Please proceed directly with modifying files, compiling\/building, running tests, and completing the user's tasks\.\s*/i,
    /^\s*Do not wait or ask for confirmation unless there is a critical architectural error or a blocker\.\s*/i,
    /^\s*Move quickly to complete the implementation\.\s*/i,
    /^\s*Make sure to update task statuses using `?manage_tasks`?\(action: 'update'\) as you finish tasks\.\s*/i,
    /^\s*Do NOT ask for further plan or design approvals\.\s*/i,
    /^\s*Focus on writing clean code, building, running tests, and completing the tasks\.\s*/i,
    /^\s*Keep implementation plans and tasks in sync\.\s*/i,
    /^\s*No further design approvals or plan confirmations are needed\.\s*/i,
    /^\s*Proceed directly to implementation and verification\.\s*/i,
    /^\s*Do not wait for any further approvals\.\s*/i,
    /^\s*Proceed directly with the implementation\.\s*/i,
    /^\s*Run validation commands \(build\/test\) and record results in the Walkthrough File\.\s*/i,
    /^\s*Do not ask for further confirmation or wait for user input\.\s*/i,
    /^\s*Proceed to implement the plan immediately\.\s*/i,
    /^\s*Do not wait or ask for further confirmation\.\s*/i,
    /^\s*Proceed directly to editing code\.\s*/i,
    /^\s*Run validation commands \(build\/test\) and record results in the Walkthrough File\.\s*/i,
    /^\s*Focus on editing code, building, running tests, and completing the tasks\.\s*/i,
    /^\s*Do not wait for further user approval on edits\.\s*/i,
    /^\s*You do not need to ask for permission again unless there is an unexpected architecture-altering error or critical blocker\.\s*/i,
    /^\s*Do not perform unnecessary Q&A, and proceed directly to editing code\.\s*/i,
    /^\s*Do NOT wait or ask for confirmation\.\s*/i,
    /^\s*Implement all parts of the plan, verify it works \(build, run tests\), and write the walkthrough\.\s*/i,
    /^\s*Do NOT ask the user for permission or confirmation before editing files\.\s*/i,
    /^\s*Proceed directly with executing the plan, running tests\/verification, and writing the walkthrough\.\s*/i,
    /^\s*Proceed directly with implementing code changes, building\/compiling, and running tests\.\s*/i,
    /^\s*Run validation commands \(build\/test\) and record results in the Walkthrough File before completion\.\s*/i,
    /^\s*Make sure to update task statuses as you complete items, and write a walkthrough when done\.\s*/i,
    /^\s*Proceed to next step\.\s*/i,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    const beforeLen = cleaned.length;

    // Strip leading/trailing whitespaces/newlines/carriages
    cleaned = cleaned.replace(/^\s+/, "");

    // Strip divider lines (e.g. --- or === or longer) at the start
    cleaned = cleaned.replace(/^[-=]{3,}\s*[\r\n]*/, "");

    for (const pattern of patternsToStrip) {
      const next = cleaned.replace(pattern, "");
      if (next !== cleaned) {
        cleaned = next;
        changed = true;
      }
    }

    if (cleaned.length !== beforeLen) {
      changed = true;
    }
  }

  return cleaned.trim();
}

export interface PasteState {
  isPasted: boolean;
  pastePrefixLength: number;
  pasteSuffixLength: number;
}

let lastChangeTime = 0;
let fastInputCount = 0;
let fastInputStartIndex = 0;
let originalInputLength = 0;

export function resetPasteDetection() {
  lastChangeTime = 0;
  fastInputCount = 0;
  fastInputStartIndex = 0;
  originalInputLength = 0;
}

export function updatePasteState(
  input: string,
  sanitizedVal: string,
  currentState: PasteState
): PasteState {
  const { isPasted, pastePrefixLength, pasteSuffixLength } = currentState;
  const now = Date.now();
  const dt = lastChangeTime ? now - lastChangeTime : Infinity;
  lastChangeTime = now;

  const lengthDiff = sanitizedVal.length - input.length;
  const containsNewline = sanitizedVal.includes("\n");

  if (sanitizedVal.length === 0) {
    fastInputCount = 0;
    fastInputStartIndex = 0;
    originalInputLength = 0;
  }

  // A time delta of less than 80ms is extremely likely to be terminal paste.
  const isFast = dt < 80;

  if (isPasted) {
    const { inserted: oldInserted } = getPasteSplit(input, pastePrefixLength, pasteSuffixLength);
    const newIdx = sanitizedVal.indexOf(oldInserted);
    if (newIdx !== -1 && oldInserted.length > 0) {
      const newlyInsertedStart = newIdx + oldInserted.length;
      const newlyInsertedEnd = sanitizedVal.length - pasteSuffixLength;
      const newlyInsertedLength = newlyInsertedEnd - newlyInsertedStart;
      const newlyInsertedText = sanitizedVal.slice(newlyInsertedStart, newlyInsertedEnd);
      const isContinuation = newlyInsertedLength > 0 && (newlyInsertedLength > 1 || newlyInsertedText.includes("\n") || isFast);

      if (isContinuation) {
        if (isFast) {
          fastInputCount++;
        } else {
          fastInputCount = 0;
        }
        return {
          isPasted: true,
          pastePrefixLength: newIdx,
          pasteSuffixLength
        };
      } else {
        fastInputCount = 0;
        return {
          isPasted: true,
          pastePrefixLength: newIdx,
          pasteSuffixLength: sanitizedVal.length - (newIdx + oldInserted.length)
        };
      }
    } else {
      fastInputCount = 0;
      return {
        isPasted: false,
        pastePrefixLength: 0,
        pasteSuffixLength: 0
      };
    }
  } else {
    if (lengthDiff < 0) {
      fastInputCount = 0;
      return { isPasted: false, pastePrefixLength: 0, pasteSuffixLength: 0 };
    }

    if (lengthDiff > 15 || containsNewline) {
      fastInputCount = 0;
      const { prefix, suffix } = getInsertion(input, sanitizedVal);
      return {
        isPasted: true,
        pastePrefixLength: prefix.length,
        pasteSuffixLength: suffix.length
      };
    }

    if (isFast) {
      if (fastInputCount === 0) {
        const { prefix } = getInsertion(input, sanitizedVal);
        fastInputStartIndex = prefix.length;
        originalInputLength = input.length;
      }
      fastInputCount++;
    } else {
      fastInputCount = 0;
    }

    // If we have seen a sequence of rapid inputs (e.g. 10 or more)
    // and the total length is getting large, we can treat it as a paste!
    if (fastInputCount >= 10 && sanitizedVal.length > 15) {
      const suffixLen = Math.max(0, originalInputLength - fastInputStartIndex);
      return {
        isPasted: true,
        pastePrefixLength: fastInputStartIndex,
        pasteSuffixLength: suffixLen
      };
    }

    if (sanitizedVal.length === 0 || (sanitizedVal.length <= 200 && !containsNewline)) {
      return { isPasted: false, pastePrefixLength: 0, pasteSuffixLength: 0 };
    } else if (lengthDiff > 0 && lengthDiff <= 15 && !containsNewline) {
      return { isPasted: false, pastePrefixLength: 0, pasteSuffixLength: 0 };
    }
  }

  return currentState;
}

export function getActiveCommandContext(text: string, cursorPosition: number) {
  const textBeforeCursor = text.slice(0, cursorPosition);
  
  // Find the last occurrence of '/' or '!' that acts as a command trigger.
  // A command trigger must be either at the start of the string or preceded by a whitespace character.
  let lastTriggerIndex = -1;
  for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
    const char = textBeforeCursor[i];
    if (char === "/" || char === "!") {
      if (i === 0 || /\s/.test(textBeforeCursor[i - 1])) {
        lastTriggerIndex = i;
        break;
      }
    }
  }
  
  if (lastTriggerIndex === -1) {
    return null;
  }
  
  const commandSegment = textBeforeCursor.slice(lastTriggerIndex);
  
  return {
    triggerIndex: lastTriggerIndex,
    commandSegment, // e.g. "/model" or "/model pr" or "/model preset list"
    isBang: textBeforeCursor[lastTriggerIndex] === "!"
  };
}


