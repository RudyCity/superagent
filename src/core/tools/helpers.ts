import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execSync } from "child_process";
import ts from "typescript";

interface WindowsShellResult {
  shellPath: string;
  isBash: boolean;
}

let cachedShell: WindowsShellResult | null = null;

export function resolveWindowsShell(): WindowsShellResult {
  if (cachedShell) return cachedShell;

  if (process.platform !== "win32") {
    cachedShell = { shellPath: "bash", isBash: true };
    return cachedShell;
  }

  // Common Git Bash locations
  const commonPaths = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
  ];

  // Try common installation directories
  for (const p of commonPaths) {
    if (fsSync.existsSync(p)) {
      cachedShell = { shellPath: p, isBash: true };
      return cachedShell;
    }
  }

  // Try checking PATH for bash.exe using 'where'
  try {
    const whereBash = execSync("where bash", { stdio: [] }).toString().trim().split(/\r?\n/)[0];
    if (whereBash && fsSync.existsSync(whereBash)) {
      cachedShell = { shellPath: whereBash, isBash: true };
      return cachedShell;
    }
  } catch {
    // Ignore error if 'where bash' fails
  }

  // Fallback to PowerShell
  cachedShell = { shellPath: "powershell.exe", isBash: false };
  return cachedShell;
}

export function suggestClosest(value: string, options: readonly string[]): string | undefined {
  const distance = (a: string, b: string) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
      }
    }
    return dp[a.length][b.length];
  };
  const best = options.map(option => ({ option, score: distance(value, option) })).sort((a, b) => a.score - b.score)[0];
  return best && best.score <= Math.max(2, Math.floor(best.option.length / 3)) ? best.option : undefined;
}

export function formatToolError(problem: string, fix?: string, example?: string): string {
  return [`Error: ${problem}`, fix ? `Fix: ${fix}` : "", example ? `Example: ${example}` : ""].filter(Boolean).join("\n");
}

export function formatUnknownActionError(action: string, validActions: readonly string[], note?: string): string {
  const suggestion = suggestClosest(action, validActions);
  const fix = suggestion
    ? `Use action \"${suggestion}\". Valid actions: ${validActions.join(", ")}.`
    : `Use one of: ${validActions.join(", ")}.`;
  return formatToolError(`Unknown action \"${action}\".`, note ? `${fix} ${note}` : fix);
}

export function normalizeWindowsPackageRunner(command: string): string {
  // If running on win32, ensure package runners like npm/npx use .cmd to avoid Git Bash execution errors.
  if (process.platform === "win32") {
    return command.replace(/^(npm|npx|pnpm|yarn)(?=\s|$)/, "$1.cmd");
  }
  return command;
}

export function formatCommandForPowerShell(command: string): string {
  const parts: string[] = [];
  let currentPart = "";
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let i = 0;
  while (i < command.length) {
    const char = command[i];
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      currentPart += char;
      i++;
    } else if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      currentPart += char;
      i++;
    } else if (!inDoubleQuote && !inSingleQuote && char === '&' && command[i + 1] === '&') {
      parts.push(currentPart.trim());
      currentPart = "";
      i += 2;
    } else {
      currentPart += char;
      i++;
    }
  }
  parts.push(currentPart.trim());

  if (parts.length <= 1) {
    return command;
  }

  let result = parts[0];
  for (let j = 1; j < parts.length; j++) {
    result += `; if ($?) { ${parts[j]}`;
  }
  result += " }".repeat(parts.length - 1);
  return result;
}

export function normalizeForMatching(str: string): string {
  if (typeof str !== "string") {
    return "";
  }
  // trimEnd only: preserve indentation (semantically significant in code),
  // strip only trailing whitespace which is never meaningful.
  return str
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n");
}

export async function verifySyntax(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath);
  if (ext !== ".ts" && ext !== ".tsx" && ext !== ".js" && ext !== ".jsx") {
    return null;
  }

  try {
    const code = await fs.readFile(filePath, "utf-8");
    const sourceKind = ext === ".tsx" || ext === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, sourceKind);
    const compilerHost = ts.createCompilerHost({
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      noEmit: true,
    });
    compilerHost.getSourceFile = (requestedFileName, languageVersion) => {
      if (path.resolve(requestedFileName) === path.resolve(filePath)) {
        return sourceFile;
      }
      return ts.createCompilerHost({}).getSourceFile(requestedFileName, languageVersion);
    };
    compilerHost.writeFile = () => {};
    const program = ts.createProgram([filePath], { noEmit: true, jsx: ts.JsxEmit.React }, compilerHost);
    const diagnostics = program.getSyntacticDiagnostics(sourceFile);

    if (diagnostics.length === 0) {
      return null;
    }

    const diagnostic = diagnostics[0];
    const position = diagnostic.start ?? 0;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    return `Syntax check failed: ${message} at ${path.basename(filePath)}:${line + 1}:${character + 1}`;
  } catch {
    return null;
  }
}

export function truncateOutput(output: string, maxLines = 100): string {
  const lines = output.split(/\r?\n/);
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join("\n") + `\n\n... (output truncated, showing ${maxLines} of ${lines.length} lines)`;
  }
  return output;
}

/**
 * Normalize backslash paths inside git commands to forward slashes.
 * Prevents Windows-style `feat\timer-service` being interpreted as
 * `feat<TAB>imer-service` by Git/Bash.
 *
 * Only transforms arguments that follow git subcommands (checkout, diff,
 * log, branch, worktree, merge, stash, etc.) — leaves the rest untouched.
 */
export function normalizeGitPaths(command: string): string {
  // Match git subcommands that take branch/path arguments
  const gitSubcommands = /\b(git)\s+(checkout|diff|log|branch|worktree|merge|stash|show|reset|restore|add|cherry-pick|rebase)\b/;
  if (!gitSubcommands.test(command)) {
    return command;
  }

  // Replace backslash path separators in tokens that look like branch names
  // or file paths following git subcommands. Avoids modifying string literals.
  return command.replace(
    /(?<=git\s+(?:checkout|diff|log|branch|worktree|merge|stash|show|reset|restore|add|cherry-pick|rebase)\s+)([^\s;&|]+)/g,
    (match) => match.replace(/\\/g, "/")
  );
}

export function detectInteractivePrompt(text: string): string | null {
  // Patterns must be specific enough to avoid matching TypeScript/source code.
  // Each pattern targets typical CLI prompts, not code declarations.
  const patterns = [
    /\[y\/n\]\s*$/im,                    // [y/n] at end of line
    /\(y\/n\)\s*$/im,                    // (y/n) at end of line
    /(?:^|\n)\s*(?:please\s+)?confirm\s*\?/im,  // "confirm?" as standalone prompt
    /(?:^|\n)\s*proceed\s*\?/im,         // "proceed?" as standalone prompt
    /(?:^|\n)\s*enter\s+password\s*:/im,  // "Enter password:" prompt
    /(?:^|\n)\s*select\s+an?\s+option/i, // "Select an option"
    /(?:^|\n)\s*(?:please\s+)?(?:choose|pick)\s+(?:one|an?\s+option)/i,
    /(?:^|\n)\s*password\s*:\s*$/im,     // "password:" at end of line (not in code)
    /(?:^|\n)\s*passphrase\s+for\s+/im,  // SSH passphrase prompt
    /(?:^|\n)\s*username\s*:\s*$/im,     // "username:" at end of line
    /(?:^|\n)\s*(?:continue|accept)\s*\[y\/n/i, // "Continue [y/n"
    /(?:^|\n)\s*do\s+you\s+(?:want|wish)\s+to\s+/i, // "Do you want to..."
    /(?:^|\n)\s*overwrite\s+\(y\/n\)/i,  // "Overwrite (y/n)"
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return `Warning: Interactive prompt detected ("${text.trim().slice(-30)}"). The command may hang. Use run_background_process and manage_background_process 'send_input' to interact.`;
    }
  }
  return null;
}

export function mapNormToOrigIndices(sliceText: string, normSliceText: string): number[] {
  const origLines = sliceText.split(/\r?\n/);
  const normLines = normSliceText.split("\n");
  const normToOrigMap: number[] = [];
  let origCharOffset = 0;

  for (let i = 0; i < origLines.length; i++) {
    const origLine = origLines[i];
    const normLine = normLines[i] ?? "";

    // Since normalizeForMatching uses trimEnd(), leading whitespace is preserved
    // in normLine but trailing whitespace is stripped.
    // The origLine and normLine share the same leading characters, so
    // normalized col 0 maps directly to orig col 0 (no leading-space offset needed).
    // We only need to ensure the end sentinel accounts for any stripped trailing chars.
    for (let col = 0; col < normLine.length; col++) {
      normToOrigMap.push(origCharOffset + col);
    }

    // End sentinel: points to right after the last normalized char in orig.
    // normLine.length == trimEnd length, so this is correct even if origLine
    // has extra trailing spaces (they are beyond the sentinel).
    const sentinelOrigPos = origCharOffset + normLine.length;
    normToOrigMap.push(sentinelOrigPos);

    if (i < origLines.length - 1) {
      // Advance past the original line (full length including trailing spaces)
      // plus the newline character(s).
      const newlineLen = sliceText[origCharOffset + origLine.length] === "\r" ? 2 : 1;
      origCharOffset += origLine.length + newlineLen;
    }
  }
  return normToOrigMap;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    count++;
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return count;
}

export class FileLockManager {
  private locks = new Map<string, Promise<void>>();

  async acquire(filePath: string): Promise<() => void> {
    const absPath = path.resolve(filePath);
    const currentLock = this.locks.get(absPath) || Promise.resolve();

    let resolveLock: () => void = () => {};
    const newLock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    this.locks.set(absPath, currentLock.catch(() => {}).then(() => newLock));

    await currentLock;
    return () => {
      resolveLock();
      if (this.locks.get(absPath) === newLock) {
        this.locks.delete(absPath);
      }
    };
  }
}

export const fileLockManager = new FileLockManager();


