import path from "node:path";
import fs from "node:fs";
import type { ToolCall } from "../conversation.js";

/**
 * Delegated fileScope hard enforcement (DEEP-02).
 * Code-enforced immutable boundary for subagents.
 */

function cleanSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizeForComparison(p: string): string {
  const cleaned = cleanSlashes(p).replace(/\/+$/, "");
  return process.platform === "win32" ? cleaned.toLowerCase() : cleaned;
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

  // 2. Check shell tools (bash, run_command, run_background_process)
  const isShellTool = tc.name === "bash" || tc.name === "run_command" || tc.name === "run_background_process";
  if (isShellTool) {
    const args = tc.args || {};

    // Check cwd
    if (typeof args.cwd === "string" && args.cwd.trim()) {
      const checkCwd = isPathInScope(args.cwd.trim(), fileScope, workspaceRoot);
      if (!checkCwd.inScope) {
        return { allowed: false, reason: `Shell execution cwd "${args.cwd}" is outside allowed fileScope.` };
      }
    }

    // Inspect command string for escapes
    const cmd = String(args.command ?? args.cmd ?? "").trim();
    if (cmd) {
      // Check for cd / chdir / pushd outside fileScope
      const cdMatches = cmd.matchAll(/\b(?:cd|chdir|pushd)\s+["']?([^"';&|\n\r]+)["']?/gi);
      for (const m of cdMatches) {
        const targetDir = m[1].trim();
        if (targetDir === "~" || targetDir.startsWith("~/")) {
          return { allowed: false, reason: `Shell command attempts to cd to home directory outside fileScope: "${cmd}"` };
        }
        const check = isPathInScope(targetDir, fileScope, workspaceRoot);
        if (!check.inScope) {
          return { allowed: false, reason: `Shell command attempts to cd outside fileScope to "${targetDir}": "${cmd}"` };
        }
      }

      // Check for path traversal attempts like ../../ escaping fileScope in commands
      const traversalMatches = cmd.matchAll(/(?:^|[\s"'>|&;])((?:\.\.[\\/])+[^\s"'>|&;]*)/g);
      for (const tm of traversalMatches) {
        const travPath = tm[1].trim();
        const check = isPathInScope(travPath, fileScope, workspaceRoot);
        if (!check.inScope) {
          return { allowed: false, reason: `Shell command path traversal "${travPath}" escapes allowed fileScope: "${cmd}"` };
        }
      }
    }
  }

  return { allowed: true };
}
