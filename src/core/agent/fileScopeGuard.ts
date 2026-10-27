import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type { ToolCall } from "../conversation.js";

/**
 * Delegated fileScope hard enforcement (DEEP-02).
 * Code-enforced immutable boundary for subagents.
 */

export const SHELL_TOOL_NAMES = new Set([
  "bash",
  "run_command",
  "run_background_process",
  "shell",
  "exec",
  "terminal",
  "cmd",
  "sh",
  "superagent_exec_command",
  "superagent_office_cli",
]);

function cleanSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizeForComparison(p: string): string {
  const cleaned = cleanSlashes(p).replace(/\/+$/, "");
  return process.platform === "win32" ? cleaned.toLowerCase() : cleaned;
}

/**
 * Strips enclosing quotes (double, single, or backticks) from a token.
 */
function stripQuotes(token: string): string {
  const t = token.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith("`") && t.endsWith("`"))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Normalizes MSYS2/Git Bash drive paths (e.g. /c/Users -> C:/Users, /d/backup -> D:/backup) on Windows.
 */
function normalizeGitBashDrivePath(p: string): string {
  if (process.platform === "win32") {
    const match = p.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (match) {
      const drive = match[1].toUpperCase();
      const rest = match[2] || "/";
      return `${drive}:${rest}`;
    }
  }
  return p;
}

function isUrl(str: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(str);
}

function isStandardSink(target: string): boolean {
  const norm = target.toLowerCase().trim();
  return (
    norm === "/dev/null" ||
    norm === "/dev/zero" ||
    norm === "nul" ||
    norm === "&1" ||
    norm === "&2" ||
    norm === "1>&2" ||
    norm === "2>&1"
  );
}

/**
 * Resolves a path against workspaceRoot and determines canonical realpath,
 * safely resolving symlinks and directory traversals.
 */
export function canonicalizeTarget(targetPath: string, workspaceRoot: string): {
  resolved: string;
  real?: string;
  canonicalResolved: string;
  canonicalReal?: string;
} {
  const normTarget = cleanSlashes(targetPath).trim();
  const resolved = path.isAbsolute(normTarget)
    ? path.normalize(normTarget)
    : path.resolve(workspaceRoot, normTarget);

  let real: string | undefined;
  try {
    if (fs.existsSync(resolved)) {
      real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    } else {
      // Find nearest existing ancestor directory to resolve any symlinks in ancestor path
      let curr = path.dirname(resolved);
      while (curr && !fs.existsSync(curr)) {
        const parent = path.dirname(curr);
        if (parent === curr) break;
        curr = parent;
      }
      if (curr && fs.existsSync(curr)) {
        const realAncestor = fs.realpathSync.native ? fs.realpathSync.native(curr) : fs.realpathSync(curr);
        const rel = path.relative(curr, resolved);
        real = path.resolve(realAncestor, rel);
      }
    }
  } catch {
    // If realpath resolution fails, leave real undefined
  }

  return {
    resolved,
    real,
    canonicalResolved: normalizeForComparison(resolved),
    canonicalReal: real ? normalizeForComparison(real) : undefined,
  };
}

/**
 * Converts a fileScope pattern (e.g. "src/auth/**", "src/auth/*", "package.json")
 * into a matching regex rooted in workspaceRoot.
 */
export function compileScopePattern(pattern: string, workspaceRoot: string): {
  test: (canonicalPath: string) => boolean;
  rawPattern: string;
} {
  const cleanPat = cleanSlashes(pattern).trim();
  let fullPat = cleanPat;
  if (!path.isAbsolute(fullPat)) {
    fullPat = cleanSlashes(path.resolve(workspaceRoot, cleanPat));
  }
  const isWin = process.platform === "win32";
  const normPat = isWin ? fullPat.toLowerCase() : fullPat;

  // Case 1: Pattern is a recursive directory glob (e.g. /path/to/dir/**)
  if (normPat.endsWith("/**")) {
    const baseDir = normPat.slice(0, -3);
    return {
      rawPattern: pattern,
      test: (p: string) => {
        return p === baseDir || p.startsWith(baseDir + "/");
      },
    };
  }

  // Case 2: Pattern is single-level wildcard (e.g. /path/to/dir/*)
  if (normPat.endsWith("/*")) {
    const baseDir = normPat.slice(0, -2);
    return {
      rawPattern: pattern,
      test: (p: string) => {
        if (!p.startsWith(baseDir + "/")) return false;
        const remainder = p.slice(baseDir.length + 1);
        return !remainder.includes("/");
      },
    };
  }

  // Case 3: Pattern has inline wildcards (e.g. *.ts or src/*.json)
  if (normPat.includes("*") || normPat.includes("?")) {
    let regStr = "^";
    for (let i = 0; i < normPat.length; i++) {
      const c = normPat[i];
      if (c === "*" && normPat[i + 1] === "*") {
        if (normPat[i + 2] === "/") {
          regStr += "(?:.*/)?";
          i += 2;
        } else {
          regStr += ".*";
          i++;
        }
      } else if (c === "*") {
        regStr += "[^/]*";
      } else if (c === "?") {
        regStr += "[^/]";
      } else if (["\\", ".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]"].includes(c)) {
        regStr += "\\" + c;
      } else {
        regStr += c;
      }
    }
    regStr += "$";
    const reg = new RegExp(regStr, isWin ? "i" : "");
    return {
      rawPattern: pattern,
      test: (p: string) => reg.test(p),
    };
  }

  // Case 4: Literal directory or file
  // If literal directory without glob, allow exact match or any descendant
  const baseLiteral = normPat.replace(/\/+$/, "");
  return {
    rawPattern: pattern,
    test: (p: string) => {
      return p === baseLiteral || p.startsWith(baseLiteral + "/");
    },
  };
}

/**
 * Checks whether a single file path is strictly within the allowed fileScope.
 */
export function isPathInScope(
  targetPath: string,
  fileScope: readonly string[],
  workspaceRoot: string
): { inScope: boolean; reason?: string } {
  if (!fileScope || fileScope.length === 0) {
    return { inScope: true };
  }

  const { resolved, real, canonicalResolved, canonicalReal } = canonicalizeTarget(targetPath, workspaceRoot);

  const matchers = fileScope.map((pat) => compileScopePattern(pat, workspaceRoot));

  const resolvedMatches = matchers.some((m) => m.test(canonicalResolved));
  if (!resolvedMatches) {
    return {
      inScope: false,
      reason: `Path "${targetPath}" (resolved: "${resolved}") is outside allowed fileScope [${fileScope.join(", ")}].`,
    };
  }

  // If realpath exists and differs (symlink, reparse point), ensure realpath is also in scope
  if (canonicalReal && canonicalReal !== canonicalResolved) {
    const realMatches = matchers.some((m) => m.test(canonicalReal));
    if (!realMatches) {
      return {
        inScope: false,
        reason: `Symlink/reparse target "${real}" for "${targetPath}" escapes allowed fileScope [${fileScope.join(", ")}].`,
      };
    }
  }

  return { inScope: true };
}

/**
 * Extracts all file paths targeted by a tool call.
 */
export function extractToolCallFilePaths(tc: ToolCall): string[] {
  const paths: string[] = [];
  const args = tc.args || {};

  // Batch file arguments
  if (Array.isArray(args.filePaths)) {
    for (const p of args.filePaths) {
      if (typeof p === "string" && p.trim()) paths.push(p.trim());
      else if (p && typeof p === "object" && typeof p.filePath === "string") paths.push(p.filePath.trim());
    }
  }

  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      const p = f?.filePath ?? f?.TargetFile ?? f?.targetFile ?? f?.path ?? f?.file;
      if (typeof p === "string" && p.trim()) paths.push(p.trim());
    }
  }

  if (Array.isArray(args.edits)) {
    for (const e of args.edits) {
      const p = e?.filePath ?? e?.TargetFile ?? e?.targetFile ?? e?.path ?? e?.file;
      if (typeof p === "string" && p.trim()) paths.push(p.trim());
    }
  }

  if (Array.isArray(args.patches)) {
    for (const pt of args.patches) {
      const p = pt?.filePath ?? pt?.TargetFile ?? pt?.targetFile ?? pt?.path ?? pt?.file;
      if (typeof p === "string" && p.trim()) paths.push(p.trim());
    }
  }

  // Single file arguments
  const singleCandidate =
    args.filePath ?? args.file_path ?? args.TargetFile ?? args.targetFile ??
    args.target_file ?? args.path ?? args.DirectoryPath ?? args.directoryPath ??
    args.SearchPath ?? args.searchPath ?? args.AbsolutePath;
  if (typeof singleCandidate === "string" && singleCandidate.trim()) {
    paths.push(singleCandidate.trim());
  }

  return Array.from(new Set(paths));
}

/**
 * Recursively validates a shell command string against delegated fileScope.
 * Covers cmd.exe, PowerShell, and POSIX shells with fail-closed semantics.
 */
export function validateShellCommandString(
  cmd: string,
  effectiveCwd: string,
  fileScope: readonly string[],
  workspaceRoot: string
): { allowed: boolean; reason?: string } {
  const trimmed = cmd.trim();
  if (!trimmed) return { allowed: true };

  // 1. Fail-closed on obfuscated/encoded commands
  // PowerShell -EncodedCommand / -enc / -e
  if (/(?:^|\s)-(?:e|enc|encodedcommand)\b/i.test(trimmed)) {
    return {
      allowed: false,
      reason: `Encoded shell commands (-enc/-EncodedCommand) cannot be verified against delegated fileScope.`,
    };
  }

  // 2. Unpack and recursively validate nested shells
  // POSIX: bash -c "...", sh -c '...'
  const posixNested = trimmed.matchAll(/\b(?:bash|sh|zsh)\s+-c\s+(?:(["'])([\s\S]+?)\1|([^\s;&|]+))/gi);
  for (const m of posixNested) {
    const inner = m[2] ?? m[3];
    if (inner) {
      const res = validateShellCommandString(inner, effectiveCwd, fileScope, workspaceRoot);
      if (!res.allowed) return res;
    }
  }

  // CMD: cmd.exe /c "...", cmd /k "..."
  const cmdNested = trimmed.matchAll(/\bcmd(?:\.exe)?\s+[\/](?:c|k)\s+(?:(["'])([\s\S]+?)\1|([^\r\n;&|]+))/gi);
  for (const m of cmdNested) {
    const inner = m[2] ?? m[3];
    if (inner) {
      const res = validateShellCommandString(inner, effectiveCwd, fileScope, workspaceRoot);
      if (!res.allowed) return res;
    }
  }

  // PowerShell: powershell -Command "...", pwsh -c '...'
  const psNested = trimmed.matchAll(/\b(?:powershell|pwsh)(?:\.exe)?\s+(?:-c|-command)\s+(?:(["'])([\s\S]+?)\1|([^\r\n;&|]+))/gi);
  for (const m of psNested) {
    const inner = m[2] ?? m[3];
    if (inner) {
      const res = validateShellCommandString(inner, effectiveCwd, fileScope, workspaceRoot);
      if (!res.allowed) return res;
    }
  }

  // eval "..."
  const evalNested = trimmed.matchAll(/\beval\s+(?:(["'])([\s\S]+?)\1|([^\s;&|]+))/gi);
  for (const m of evalNested) {
    const inner = m[2] ?? m[3];
    if (inner) {
      const res = validateShellCommandString(inner, effectiveCwd, fileScope, workspaceRoot);
      if (!res.allowed) return res;
    }
  }

  // 3. Directory changes: cd, chdir, pushd, Set-Location, sl
  const cdMatches = trimmed.matchAll(/\b(?:cd|chdir|pushd|Set-Location|sl)\s+((?:"[^"]+")|(?:'[^']+')|(?:`[^`]+`)|(?:[^\s;&|\n\r]+))/gi);
  for (const m of cdMatches) {
    let targetDir = stripQuotes(m[1]);
    if (targetDir === "~" || targetDir.startsWith("~/") || targetDir.startsWith("~\\")) {
      targetDir = path.resolve(os.homedir(), targetDir.replace(/^~[\\/]?/, ""));
    } else if (!path.isAbsolute(targetDir)) {
      targetDir = path.resolve(effectiveCwd, targetDir);
    }
    const check = isPathInScope(targetDir, fileScope, workspaceRoot);
    if (!check.inScope) {
      return {
        allowed: false,
        reason: `Shell command attempts to cd outside fileScope to "${targetDir}": "${trimmed}"`,
      };
    }
  }

  // 4. Shell Redirections: >, >>, <, 2>, 2>>, &>
  const redirMatches = trimmed.matchAll(/(?:>>|>|<|2>>|2>|&>)\s*((?:"[^"]+")|(?:'[^']+')|(?:`[^`]+`)|(?:[^\s;&|<>()\n\r]+))/g);
  for (const rm of redirMatches) {
    const rawTarget = stripQuotes(rm[1]);
    if (!rawTarget || isStandardSink(rawTarget)) continue;
    const target = normalizeGitBashDrivePath(rawTarget);
    const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(effectiveCwd, target);
    const check = isPathInScope(resolved, fileScope, workspaceRoot);
    if (!check.inScope) {
      return {
        allowed: false,
        reason: `Shell redirection target "${rawTarget}" (resolved: "${resolved}") is outside allowed fileScope.`,
      };
    }
  }

  // PowerShell pipeline redirections: | Out-File, | Set-Content, | Add-Content
  const psRedirMatches = trimmed.matchAll(/\|\s*(?:Out-File|Set-Content|Add-Content)\s+(?:-(?:FilePath|Path|LiteralPath)\s+)?((?:"[^"]+")|(?:'[^']+')|(?:`[^`]+`)|(?:[^\s;&|\n\r]+))/gi);
  for (const psm of psRedirMatches) {
    const rawTarget = stripQuotes(psm[1]);
    if (!rawTarget || isStandardSink(rawTarget)) continue;
    const target = normalizeGitBashDrivePath(rawTarget);
    const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(effectiveCwd, target);
    const check = isPathInScope(resolved, fileScope, workspaceRoot);
    if (!check.inScope) {
      return {
        allowed: false,
        reason: `PowerShell output target "${rawTarget}" (resolved: "${resolved}") is outside allowed fileScope.`,
      };
    }
  }

  // Tee redirection: | tee [-a] target
  const teeMatches = trimmed.matchAll(/\|\s*tee\s+(?:-a\s+)?((?:"[^"]+")|(?:'[^']+')|(?:`[^`]+`)|(?:[^\s;&|\n\r]+))/gi);
  for (const tm of teeMatches) {
    const rawTarget = stripQuotes(tm[1]);
    if (!rawTarget || isStandardSink(rawTarget)) continue;
    const target = normalizeGitBashDrivePath(rawTarget);
    const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(effectiveCwd, target);
    const check = isPathInScope(resolved, fileScope, workspaceRoot);
    if (!check.inScope) {
      return {
        allowed: false,
        reason: `Tee output target "${rawTarget}" (resolved: "${resolved}") is outside allowed fileScope.`,
      };
    }
  }

  // 5. Windows absolute paths: C:\..., D:/..., quoted or unquoted
  const winAbsMatches = trimmed.matchAll(/(?:"([a-zA-Z]:\\[^"]*|[a-zA-Z]:\/[^"]*)"|'([a-zA-Z]:\\[^']*|[a-zA-Z]:\/[^']*)'|(?:\b|\s|^)([a-zA-Z]:\\[^\s;,|&<>()]+|[a-zA-Z]:\/[^\s;,|&<>()]+))/g);
  for (const wm of winAbsMatches) {
    const rawPath = wm[1] ?? wm[2] ?? wm[3];
    if (rawPath) {
      const resolved = path.normalize(rawPath);
      const check = isPathInScope(resolved, fileScope, workspaceRoot);
      if (!check.inScope) {
        return {
          allowed: false,
          reason: `Shell command references absolute path "${rawPath}" outside allowed fileScope [${fileScope.join(", ")}].`,
        };
      }
    }
  }

  // 6. UNC paths: \\server\share\... or //server/share/...
  const uncMatches = trimmed.matchAll(/(?:"(\\\\[^"]+|\/\/[^"]+)"|'(\\\\[^']+|\/\/[^']+)'|(?:\b|\s|^)(\\\\[^\s;,|&<>()]+|\/\/[^\s;,|&<>()]+))/g);
  for (const unc of uncMatches) {
    const rawPath = unc[1] ?? unc[2] ?? unc[3];
    if (rawPath && !isUrl(rawPath)) {
      const check = isPathInScope(rawPath, fileScope, workspaceRoot);
      if (!check.inScope) {
        return {
          allowed: false,
          reason: `Shell command references UNC path "${rawPath}" outside allowed fileScope.`,
        };
      }
    }
  }

  // 7. Git Bash / MSYS2 drive absolute paths: /c/..., /d/...
  const gitBashMatches = trimmed.matchAll(/(?:"(\/[a-zA-Z]\/[^"]*)"|'(\/[a-zA-Z]\/[^']*)'|(?:\b|\s|^)(\/[a-zA-Z]\/[^\s;,|&<>()]+))/g);
  for (const gm of gitBashMatches) {
    const rawPath = gm[1] ?? gm[2] ?? gm[3];
    if (rawPath && !isUrl(rawPath)) {
      const norm = normalizeGitBashDrivePath(rawPath);
      const check = isPathInScope(norm, fileScope, workspaceRoot);
      if (!check.inScope) {
        return {
          allowed: false,
          reason: `Shell command references Git Bash absolute path "${rawPath}" outside allowed fileScope [${fileScope.join(", ")}].`,
        };
      }
    }
  }

  // 8. Unix absolute paths: /etc/..., /var/..., /tmp/..., etc.
  const unixAbsMatches = trimmed.matchAll(/(?:"(\/[^"]+)"|'(\/[^']+)'|(?:\b|\s|^)(\/[a-zA-Z0-9_\-\.\/]+))/g);
  for (const um of unixAbsMatches) {
    const rawPath = um[1] ?? um[2] ?? um[3];
    if (!rawPath || isStandardSink(rawPath) || isUrl(rawPath)) continue;

    // Filter out Windows command line switches: e.g. /s, /q, /y, /fo
    if (process.platform === "win32") {
      const remainder = rawPath.slice(1);
      if (!remainder.includes("/") && !remainder.includes("\\") && !/\.[a-zA-Z0-9]+$/.test(remainder)) {
        continue;
      }
    }

    const check = isPathInScope(rawPath, fileScope, workspaceRoot);
    if (!check.inScope) {
      return {
        allowed: false,
        reason: `Shell command references absolute path "${rawPath}" outside allowed fileScope [${fileScope.join(", ")}].`,
      };
    }
  }

  // 9. Path traversal: ../, ..\, or ..
  const traversalMatches = trimmed.matchAll(/(?:^|[\s"'>|&;=])((?:\.\.[\/\\][^\s"'`;&|<>]*|\.\.))(?=[\s"'`;&|<>!]|$)/g);
  for (const tm of traversalMatches) {
    const travPath = tm[1].trim();
    const resolved = path.resolve(effectiveCwd, travPath);
    const check = isPathInScope(resolved, fileScope, workspaceRoot);
    if (!check.inScope) {
      return {
        allowed: false,
        reason: `Shell command path traversal "${travPath}" (resolved: "${resolved}") escapes allowed fileScope [${fileScope.join(", ")}]: "${trimmed}"`,
      };
    }
  }

  // 10. File operation command inspection (cat, type, Get-Content, Set-Content, cp, mv, copy, move, rm, del, etc.)
  const fileOpRegex = /(?:^|[|;&]\s*)\b(cat|type|Get-Content|gc|Set-Content|sc|Add-Content|ac|cp|copy|Copy-Item|cpi|mv|move|Move-Item|mi|rm|del|erase|Remove-Item|ri|touch|New-Item|head|tail|more|less)\b([^;&|]*)/gi;
  let opMatch: RegExpExecArray | null;
  while ((opMatch = fileOpRegex.exec(trimmed)) !== null) {
    const opArgs = opMatch[2] || "";
    const tokenRegex = /(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
    let tok: RegExpExecArray | null;
    while ((tok = tokenRegex.exec(opArgs)) !== null) {
      const rawArg = tok[1] ?? tok[2] ?? tok[3];
      if (!rawArg) continue;
      if (rawArg.startsWith("-") || rawArg.startsWith("/")) {
        const eqIdx = rawArg.search(/[=:]/);
        if (eqIdx !== -1) {
          const val = stripQuotes(rawArg.slice(eqIdx + 1));
          if (val && !isStandardSink(val) && !isUrl(val)) {
            const resolved = path.isAbsolute(val) ? path.normalize(val) : path.resolve(effectiveCwd, val);
            const check = isPathInScope(resolved, fileScope, workspaceRoot);
            if (!check.inScope) {
              return {
                allowed: false,
                reason: `File operation argument "${val}" (resolved: "${resolved}") is outside allowed fileScope.`,
              };
            }
          }
        }
        continue;
      }
      if (isStandardSink(rawArg) || isUrl(rawArg)) continue;
      const target = normalizeGitBashDrivePath(rawArg);
      const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(effectiveCwd, target);
      const check = isPathInScope(resolved, fileScope, workspaceRoot);
      if (!check.inScope) {
        return {
          allowed: false,
          reason: `File operation target "${rawArg}" (resolved: "${resolved}") is outside allowed fileScope [${fileScope.join(", ")}].`,
        };
      }
    }
  }

  // 11. Script execution: node, python, bun, deno, powershell -File, bash, sh
  const scriptRegex = /(?:^|[|;&]\s*)\b(?:node|python|python3|bun|deno|perl|ruby|bash|sh|zsh)\s+([^;&|]+)/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptRegex.exec(trimmed)) !== null) {
    const rest = scriptMatch[1].trim();
    const tokenRegex = /(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
    let tok: RegExpExecArray | null;
    while ((tok = tokenRegex.exec(rest)) !== null) {
      const raw = tok[1] ?? tok[2] ?? tok[3];
      if (!raw) continue;
      if (raw.startsWith("-")) {
        if (raw === "-e" || raw === "-c" || raw === "--eval") {
          const nextTok = tokenRegex.exec(rest);
          const inlineCode = nextTok ? (nextTok[1] ?? nextTok[2] ?? nextTok[3]) : undefined;
          if (inlineCode) {
            const res = validateShellCommandString(inlineCode, effectiveCwd, fileScope, workspaceRoot);
            if (!res.allowed) return res;
          }
          break;
        }
        continue;
      }
      const target = normalizeGitBashDrivePath(raw);
      const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(effectiveCwd, target);
      const check = isPathInScope(resolved, fileScope, workspaceRoot);
      if (!check.inScope) {
        return {
          allowed: false,
          reason: `Script execution file "${raw}" (resolved: "${resolved}") is outside allowed fileScope [${fileScope.join(", ")}].`,
        };
      }
      break;
    }
  }

  // PowerShell -File script.ps1
  const psFileRegex = /\b(?:powershell|pwsh)(?:\.exe)?\s+(?:-File|-f)\s+(?:["']([^"']+)["']|([^\s;&|]+))/gi;
  let psFileMatch: RegExpExecArray | null;
  while ((psFileMatch = psFileRegex.exec(trimmed)) !== null) {
    const raw = psFileMatch[1] ?? psFileMatch[2];
    if (raw) {
      const target = normalizeGitBashDrivePath(raw);
      const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(effectiveCwd, target);
      const check = isPathInScope(resolved, fileScope, workspaceRoot);
      if (!check.inScope) {
        return {
          allowed: false,
          reason: `PowerShell script file "${raw}" (resolved: "${resolved}") is outside allowed fileScope.`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Validates any tool call (file tools or shell tools) against delegated fileScope.
 */
export function validateToolCallAgainstFileScope(
  fileScope: readonly string[],
  tc: ToolCall,
  workspaceRoot: string
): { allowed: boolean; reason?: string } {
  if (!fileScope || fileScope.length === 0) {
    return { allowed: true };
  }

  // 1. Check all extracted direct file/directory path arguments
  const filePaths = extractToolCallFilePaths(tc);
  for (const fp of filePaths) {
    const check = isPathInScope(fp, fileScope, workspaceRoot);
    if (!check.inScope) {
      return { allowed: false, reason: check.reason };
    }
  }

  // 2. Check shell tools
  if (SHELL_TOOL_NAMES.has(tc.name)) {
    const args = tc.args || {};

    // Determine effective cwd
    let effectiveCwd = workspaceRoot;
    if (typeof args.cwd === "string" && args.cwd.trim()) {
      effectiveCwd = path.resolve(workspaceRoot, args.cwd.trim());
      const checkCwd = isPathInScope(effectiveCwd, fileScope, workspaceRoot);
      if (!checkCwd.inScope) {
        return {
          allowed: false,
          reason: `Shell execution cwd "${args.cwd}" (resolved: "${effectiveCwd}") is outside allowed fileScope.`,
        };
      }
    }

    // Inspect command string for escapes
    const cmd = String(args.command ?? args.cmd ?? args.script ?? args.input ?? args.CommandLine ?? "").trim();
    if (cmd) {
      const cmdCheck = validateShellCommandString(cmd, effectiveCwd, fileScope, workspaceRoot);
      if (!cmdCheck.allowed) {
        return cmdCheck;
      }
    }
  }

  return { allowed: true };
}
