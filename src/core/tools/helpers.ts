import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execSync } from "child_process";

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
  return str
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n");
}

export async function verifySyntax(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath);
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    try {
      const code = await fs.readFile(filePath, "utf-8");
      const stack: string[] = [];
      const pairs: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
      
      let i = 0;
      while (i < code.length) {
        const c = code[i];
        
        // Skip single-line comments
        if (c === "/" && code[i + 1] === "/") {
          i += 2;
          while (i < code.length && code[i] !== "\n") {
            i++;
          }
          continue;
        }
        
        // Skip multi-line comments
        if (c === "/" && code[i + 1] === "*") {
          i += 2;
          while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) {
            i++;
          }
          i += 2; // skip */
          continue;
        }
        
        // Skip string literals (single, double, template quotes)
        if (c === "'" || c === '"' || c === "`") {
          const quote = c;
          i++;
          while (i < code.length) {
            if (code[i] === "\\") {
              i += 2; // skip escape sequence
              continue;
            }
            if (code[i] === quote) {
              i++;
              break;
            }
            i++;
          }
          continue;
        }
        
        // Skip regex literals (simplified heuristic)
        if (c === "/") {
          let isRegex = false;
          let prevIdx = i - 1;
          while (prevIdx >= 0 && /\s/.test(code[prevIdx])) {
            prevIdx--;
          }
          if (prevIdx >= 0) {
            const prevChar = code[prevIdx];
            if ("=,([:?!&|;~+*-%^<>".includes(prevChar)) {
              isRegex = true;
            }
          } else {
            isRegex = true; // start of file
          }
          
          if (isRegex) {
            i++;
            while (i < code.length) {
              if (code[i] === "\\") {
                i += 2;
                continue;
              }
              if (code[i] === "/") {
                i++;
                break;
              }
              i++;
            }
            continue;
          }
        }

        // Bracket matching
        if (c === "{" || c === "(" || c === "[") {
          stack.push(c);
        } else if (c === "}" || c === ")" || c === "]") {
          if (stack.length === 0 || stack[stack.length - 1] !== pairs[c]) {
            return `Syntax check failed: Unmatched bracket/brace "${c}" near character ${i}`;
          }
          stack.pop();
        }
        i++;
      }
      
      if (stack.length > 0) {
        return `Syntax check failed: Unmatched opening bracket/brace "${stack[stack.length - 1]}"`;
      }
    } catch {
      // Ignored
    }
  }
  return null;
}

export function truncateOutput(output: string, maxLines = 100): string {
  const lines = output.split(/\r?\n/);
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join("\n") + `\n\n... (output truncated, showing ${maxLines} of ${lines.length} lines)`;
  }
  return output;
}

export function detectInteractivePrompt(text: string): string | null {
  const patterns = [
    /\[y\/n\]/i,
    /\(y\/n\)/i,
    /confirm\?/i,
    /proceed\?/i,
    /enter\s+password/i,
    /api\s+key/i,
    /select\s+an\s+option/i,
    /password:/i,
    /passphrase:/i,
    /user(name)?:/i,
    /input\s+.*:/i,
    /choice:/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return `Warning: Interactive prompt detected ("${text.trim().slice(-30)}"). The command may hang. Use run_background and manage_task 'send_input' to interact.`;
    }
  }
  return null;
}
