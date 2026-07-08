import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import fg from "fast-glob";
import { execa } from "execa";
import { Tool } from "./types.js";
import { normalizeForMatching, verifySyntax, mapNormToOrigIndices, countOccurrences, fileLockManager } from "./helpers.js";
import { getLocalRgPath, isRgInstalledGlobally, ensureRgInstalled } from "../androidSetup.js";
import { getWorkspaceCachePath } from "../workspaceDiscovery.js";


function buildEditSummary(before: string, after: string, filePath: string, existedBefore = true): string {
  if (before === after) {
    return `No changes made: ${filePath}`;
  }

  const beforeLines = existedBefore || before.length > 0 ? before.split(/\r?\n/) : [];
  const afterLines = after.length > 0 ? after.split(/\r?\n/) : [];
  const m = beforeLines.length;
  const n = afterLines.length;
  const dp = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = beforeLines[i] === afterLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  const preview: string[] = [];
  const pushPreview = (line: string) => {
    if (preview.length < 16) preview.push(line);
  };

  while (i < m || j < n) {
    if (i < m && j < n && beforeLines[i] === afterLines[j]) {
      i++;
      j++;
    } else if (j < n && (i === m || dp[i][j + 1] >= dp[i + 1][j])) {
      added++;
      pushPreview(`+ ${afterLines[j]}`);
      j++;
    } else if (i < m) {
      removed++;
      pushPreview(`- ${beforeLines[i]}`);
      i++;
    }
  }

  const action = existedBefore ? "Changed" : "Created";
  const previewText = preview.length > 0 ? `\nDiff preview:\n${preview.join("\n")}` : "";
  return `${action}: +${added} -${removed}\nFile: ${filePath}${previewText}`;
}


/**
 * Normalize a file path to fix common LLM path construction errors.
 * Handles:
 *   - Double drive letter prefix: D:\d\backup... → D:\backup...
 *   - Git Bash style paths: /d/backup... → D:\backup... (on Windows)
 */
function normalizePath(filePath: string): string {
  // Fix double drive letter: e.g. "D:\d\backup..." or "C:\c\Users..."
  const doubleDriveMatch = filePath.match(/^([A-Za-z]):\\([a-z])\\(.*)$/);
  if (doubleDriveMatch) {
    const drive = doubleDriveMatch[1].toUpperCase();
    const innerDrive = doubleDriveMatch[2].toLowerCase();
    if (drive.toLowerCase() === innerDrive) {
      return `${drive}:\\${doubleDriveMatch[3]}`;
    }
  }
  return filePath;
}

/**
 * Resolve the file path from tool args, accepting common LLM aliases:
 *   filePath, file_path, TargetFile, path (for file-targeting tools)
 * Returns the resolved absolute path, or undefined if no valid path was provided.
 */
function resolveFilePathFromArgs(args: Record<string, unknown>, cwd: string): string | undefined {
  const raw = (args.filePath ?? args.file_path ?? args.TargetFile ?? args.targetFile) as string | undefined;
  if (!raw || typeof raw !== "string" || raw.trim() === "") return undefined;
  return normalizePath(path.resolve(cwd, raw));
}

export const readTool: Tool = {
  name: "read",
  description: "Read file contents with line numbers. PREFER 'filePaths' array to batch multiple reads into ONE call — never read files one-by-one. Each entry can be a string (uses global offset/limit) or {path, offset?, limit?} for per-file ranges.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute or relative path to the file (optional if filePaths is provided)",
      },
      filePaths: {
        type: "array",
        description: "List of paths to read in bulk. Each entry: a string (uses global offset/limit) OR an object {path: string, offset?: number, limit?: number} for per-file line ranges.",
        items: {},
      },
      offset: {
        type: "number",
        description: "Global line number to start from (1-indexed). Overridden by per-file offset.",
      },
      limit: {
        type: "number",
        description: "Global max lines to read (default 800). Overridden by per-file limit.",
      },
    },
  },
  async execute(args, cwd, signal) {
    const filePaths = args.filePaths as string[] | undefined;
    const offset = Math.max(1, (args.offset as number) || 1);
    const limit = (args.limit as number) || 800;

    if (filePaths && Array.isArray(filePaths)) {
      if (filePaths.length === 0) {
        return "Error: 'filePaths' parameter is empty.";
      }
      const results: string[] = [];
      for (const entry of filePaths) {
        // Support mixed: string or {path, offset?, limit?}
        let rawPath: string;
        let fileOffset: number;
        let fileLimit: number;
        if (typeof entry === "string") {
          rawPath = entry;
          fileOffset = offset;
          fileLimit = limit;
        } else if (entry && typeof entry === "object" && typeof (entry as any).path === "string") {
          const obj = entry as { path: string; offset?: number; limit?: number };
          rawPath = obj.path;
          fileOffset = Math.max(1, obj.offset || offset);
          fileLimit = obj.limit || limit;
        } else {
          results.push(`--- Entry: ${JSON.stringify(entry)} ---\nError: Invalid entry. Use a string path or {path, offset?, limit?}.`);
          continue;
        }
        const filePath = normalizePath(path.resolve(cwd, rawPath));
        try {
          const stat = await fs.stat(filePath);
          if (stat.isDirectory()) {
            results.push(`--- File: ${rawPath} (Directory) ---\nError: Cannot read directory in bulk mode.`);
            continue;
          }
          const buffer = await fs.readFile(filePath);
          const checkLimit = Math.min(buffer.length, 1024);
          let isBinary = false;
          for (let i = 0; i < checkLimit; i++) {
            if (buffer[i] === 0) {
              isBinary = true;
              break;
            }
          }
          if (isBinary) {
            results.push(`--- File: ${rawPath} ---\nError: Cannot read binary file`);
            continue;
          }
          const content = buffer.toString("utf-8");
          const lines = content.replace(/\r\n/g, "\n").split("\n");
          const sliced = lines.slice(fileOffset - 1, fileOffset - 1 + fileLimit);
          const output = sliced.map((line, i) => `${fileOffset + i}: ${line}`).join("\n");
          let fileOutput = `--- File: ${rawPath} ---\n${output}`;
          if (lines.length > fileOffset - 1 + fileLimit) {
            const remaining = lines.length - (fileOffset - 1 + fileLimit);
            fileOutput += `\n... (output truncated, showing ${fileLimit} of ${lines.length} lines. There are ${remaining} more lines)`;
          }
          results.push(fileOutput);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          results.push(`--- File: ${rawPath} ---\nError: ${message}`);
        }
      }
      return results.join("\n\n");
    }

    const filePath = resolveFilePathFromArgs(args, cwd);
    if (!filePath) {
      return "Error: Missing required parameter 'filePath' or 'filePaths'. Provide the path to the file to read.";
    }

    try {
      // Check if path is a directory — list contents instead of failing
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(filePath, { withFileTypes: true });
        const lines = entries.slice(0, limit).map((entry: any) => {
          const suffix = entry.isDirectory() ? "/" : "";
          return `${entry.name}${suffix}`;
        });
        const header = `Directory: ${filePath} (${entries.length} entries)`;
        return [header, ...lines].join("\n");
      }

      const buffer = await fs.readFile(filePath);
      
      // Check for binary content (first 1024 bytes check for null bytes)
      const checkLimit = Math.min(buffer.length, 1024);
      for (let i = 0; i < checkLimit; i++) {
        if (buffer[i] === 0) {
          return `Error: Cannot read binary file ${args.filePath}`;
        }
      }

      const content = buffer.toString("utf-8");
      const lines = content.replace(/\r\n/g, "\n").split("\n");
      const sliced = lines.slice(offset - 1, offset - 1 + limit);
      const output = sliced.map((line, i) => `${offset + i}: ${line}`).join("\n");

      if (lines.length > offset - 1 + limit) {
        const remaining = lines.length - (offset - 1 + limit);
        return `${output}\n\n... (output truncated, showing ${limit} of ${lines.length} lines. There are ${remaining} more lines. Use the 'offset' and 'limit' parameters to read the rest of the file)`;
      }
      return output;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error reading file: ${message}`;
    }
  },
};

export const writeTool: Tool = {
  name: "write",
  description: "Write content to a file. Creates parent directories if needed.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute or relative path to the file",
      },
      content: {
        type: "string",
        description: "Content to write",
      },
    },
    required: ["filePath", "content"],
  },
  async execute(args, cwd, signal) {
    const filePath = resolveFilePathFromArgs(args, cwd);
    if (!filePath) {
      return "Error: Missing required parameter 'filePath'. Provide the path to the file to write.";
    }
    const content = args.content as string | undefined;
    if (content === undefined || content === null) {
      return "Error: Missing required parameter 'content'. Provide the content to write to the file.";
    }
    const release = await fileLockManager.acquire(filePath);
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
      return `File written: ${filePath}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error writing file: ${message}`;
    } finally {
      release();
    }
  },
};

export const editTool: Tool = {
  name: "edit",
  description:
    "Edit a file by replacing an exact string match (CRLF/LF tolerant). PREFER 'edits' array to batch multiple edits across files in ONE call — never edit files one-by-one.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file (optional if edits is provided)",
      },
      oldString: {
        type: "string",
        description: "Exact string to find and replace (optional if edits is provided)",
      },
      newString: {
        type: "string",
        description: "Replacement string (optional if edits is provided)",
      },
      startLine: {
        type: "number",
        description: "Optional line number to start searching from (1-indexed)",
      },
      endLine: {
        type: "number",
        description: "Optional line number to end searching at (1-indexed)",
      },
      edits: {
        type: "array",
        description: "Optional list of edits to apply across files.",
        items: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Path to the file to edit",
            },
            oldString: {
              type: "string",
              description: "Exact string to find and replace",
            },
            newString: {
              type: "string",
              description: "Replacement string",
            },
            startLine: {
              type: "number",
              description: "Optional line number to start searching from (1-indexed)",
            },
            endLine: {
              type: "number",
              description: "Optional line number to end searching at (1-indexed)",
            },
          },
          required: ["filePath", "oldString", "newString"],
        },
      },
    },
  },
  async execute(args, cwd, signal) {
    const edits = args.edits as Array<{ filePath: string; oldString: string; newString: string; startLine?: number; endLine?: number }> | undefined;
    if (edits && Array.isArray(edits)) {
      if (edits.length === 0) {
        return "Error: 'edits' parameter is empty.";
      }
      const sortedEdits = edits.map(edit => {
        const raw = edit.filePath;
        const resolved = normalizePath(path.resolve(cwd, raw));
        return { ...edit, resolvedPath: resolved };
      }).sort((a, b) => a.resolvedPath.localeCompare(b.resolvedPath));

      const releases: (() => void)[] = [];
      const results: string[] = [];
      try {
        const uniquePaths = Array.from(new Set(sortedEdits.map(e => e.resolvedPath))).sort();
        for (const p of uniquePaths) {
          releases.push(await fileLockManager.acquire(p));
        }

        const editsByFile = new Map<string, typeof sortedEdits>();
        for (const edit of sortedEdits) {
          const list = editsByFile.get(edit.resolvedPath) || [];
          list.push(edit);
          editsByFile.set(edit.resolvedPath, list);
        }

        for (const [filePath, fileEdits] of editsByFile.entries()) {
          try {
            let content = await fs.readFile(filePath, "utf-8");
            const originalContent = content;
            for (const edit of fileEdits) {
              const oldStr = edit.oldString;
              const newStr = edit.newString;
              const startLine = edit.startLine ? Math.max(1, edit.startLine) : undefined;
              const endLine = edit.endLine ? edit.endLine : undefined;

              const normContent = normalizeForMatching(content);
              const normOldStr = normalizeForMatching(oldStr);

              let updated: string;
              if (startLine !== undefined || endLine !== undefined) {
                const lines = content.split(/\r?\n/);
                const normLines = normContent.split("\n");
                const startIdx = startLine !== undefined ? startLine - 1 : 0;
                const endIdx = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;

                const targetSubNormContent = normLines.slice(startIdx, endIdx).join("\n");
                if (!targetSubNormContent.includes(normOldStr)) {
                  throw new Error(`oldString not found within lines ${startLine || 1} to ${endLine || lines.length} of ${edit.filePath} (matching normalized content)`);
                }
                const count = targetSubNormContent.split(normOldStr).length - 1;
                if (count > 1) {
                  throw new Error(`Found ${count} matches for oldString in the specified line range of ${edit.filePath}. Provide more context or a narrower range.`);
                }

                const subContentStartOffset = normLines.slice(0, startIdx).join("\n").length + (startIdx > 0 ? 1 : 0);
                const matchIndexInNorm = normContent.indexOf(normOldStr, subContentStartOffset);
                
                const normToOrigMap = mapNormToOrigIndices(content, normContent);
                const matchOrigStart = normToOrigMap[matchIndexInNorm] ?? -1;
                const matchOrigEnd = normToOrigMap[matchIndexInNorm + normOldStr.length] ?? -1;

                if (matchOrigStart === -1 || matchOrigEnd === -1) {
                  updated = content.replace(oldStr, newStr);
                } else {
                  updated = content.slice(0, matchOrigStart) + newStr + content.slice(matchOrigEnd);
                }
              } else {
                if (!normContent.includes(normOldStr)) {
                  throw new Error(`oldString not found in ${edit.filePath} (matching normalized content)`);
                }

                const count = normContent.split(normOldStr).length - 1;
                if (count > 1) {
                  throw new Error(`Found ${count} matches for oldString in ${edit.filePath}. Provide more context to make it unique, or specify startLine/endLine.`);
                }

                const matchIndexInNorm = normContent.indexOf(normOldStr);
                
                const normToOrigMap = mapNormToOrigIndices(content, normContent);
                const matchOrigStart = normToOrigMap[matchIndexInNorm] ?? -1;
                const matchOrigEnd = normToOrigMap[matchIndexInNorm + normOldStr.length] ?? -1;

                if (matchOrigStart === -1 || matchOrigEnd === -1) {
                  updated = content.replace(oldStr, newStr);
                } else {
                  updated = content.slice(0, matchOrigStart) + newStr + content.slice(matchOrigEnd);
                }
              }
              content = updated;
            }

            await fs.writeFile(filePath, content, "utf-8");
            const summary = buildEditSummary(originalContent, content, filePath);
            const syntaxError = await verifySyntax(filePath);
            if (syntaxError) {
              results.push(`Warning: ${syntaxError}. Files edited: ${fileEdits[0].filePath}\n${summary}`);
            } else {
              results.push(`File edited: ${fileEdits[0].filePath}\n${summary}`);
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            results.push(`Error editing file ${filePath}: ${message}`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error in bulk editing: ${message}`;
      } finally {
        for (const release of releases.reverse()) {
          release();
        }
      }
      return results.join("\n");
    }

    const filePath = resolveFilePathFromArgs(args, cwd);
    if (!filePath) {
      return "Error: Missing required parameter 'filePath' or 'edits'. Provide the path to the file to edit.";
    }
    const release = await fileLockManager.acquire(filePath);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const originalContent = content;
      const oldStr = args.oldString as string;
      const newStr = args.newString as string;
      const startLine = args.startLine ? Math.max(1, args.startLine as number) : undefined;
      const endLine = args.endLine ? args.endLine as number : undefined;

      const normContent = normalizeForMatching(content);
      const normOldStr = normalizeForMatching(oldStr);

      let updated: string;
      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split(/\r?\n/);
        const normLines = normContent.split("\n");
        const startIdx = startLine !== undefined ? startLine - 1 : 0;
        const endIdx = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;

        const targetSubNormContent = normLines.slice(startIdx, endIdx).join("\n");
        if (!targetSubNormContent.includes(normOldStr)) {
          return `Error: oldString not found within lines ${startLine || 1} to ${endLine || lines.length} of ${filePath} (matching normalized content)`;
        }
        const count = targetSubNormContent.split(normOldStr).length - 1;
        if (count > 1) {
          return `Error: Found ${count} matches for oldString in the specified line range. Provide more context or a narrower range.`;
        }

        const subContentStartOffset = normLines.slice(0, startIdx).join("\n").length + (startIdx > 0 ? 1 : 0);
        const matchIndexInNorm = normContent.indexOf(normOldStr, subContentStartOffset);
        
        const normToOrigMap = mapNormToOrigIndices(content, normContent);
        const matchOrigStart = normToOrigMap[matchIndexInNorm] ?? -1;
        const matchOrigEnd = normToOrigMap[matchIndexInNorm + normOldStr.length] ?? -1;

        if (matchOrigStart === -1 || matchOrigEnd === -1) {
          updated = content.replace(oldStr, newStr);
        } else {
          updated = content.slice(0, matchOrigStart) + newStr + content.slice(matchOrigEnd);
        }
      } else {
        if (!normContent.includes(normOldStr)) {
          return `Error: oldString not found in ${filePath} (matching normalized content)`;
        }

        const count = normContent.split(normOldStr).length - 1;
        if (count > 1) {
          return `Error: Found ${count} matches for oldString. Provide more context to make it unique, or specify startLine/endLine.`;
        }

        const matchIndexInNorm = normContent.indexOf(normOldStr);
        
        const normToOrigMap = mapNormToOrigIndices(content, normContent);
        const matchOrigStart = normToOrigMap[matchIndexInNorm] ?? -1;
        const matchOrigEnd = normToOrigMap[matchIndexInNorm + normOldStr.length] ?? -1;

        if (matchOrigStart === -1 || matchOrigEnd === -1) {
          updated = content.replace(oldStr, newStr);
        } else {
          updated = content.slice(0, matchOrigStart) + newStr + content.slice(matchOrigEnd);
        }
      }

      await fs.writeFile(filePath, updated, "utf-8");
      const summary = buildEditSummary(originalContent, updated, filePath);
      
      const syntaxError = await verifySyntax(filePath);
      if (syntaxError) {
        return `Warning: ${syntaxError}. Changes applied to file: ${filePath}\n${summary}`;
      }

      return `File edited: ${filePath}\n${summary}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error editing file: ${message}`;
    } finally {
      release();
    }
  },
};

export const globTool: Tool = {
  name: "glob",
  description: "Find files matching a glob pattern.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern (e.g. **/*.ts, src/**/*.tsx)",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: cwd)",
      },
      limit: {
        type: "number",
        description: "Maximum number of files to return (default 500)",
      },
    },
    required: ["pattern"],
  },
  async execute(args, cwd, signal) {
    const pattern = args.pattern as string;
    const searchPath = args.path
      ? path.resolve(cwd, args.path as string)
      : cwd;
    const limit = (args.limit as number) || 500;

    try {
      let files: string[] | null = null;
      try {
        const cachePath = getWorkspaceCachePath(searchPath);
        if (fsSync.existsSync(cachePath)) {
          const cacheContent = fsSync.readFileSync(cachePath, "utf-8");
          const cache = JSON.parse(cacheContent);
          if (cache && Array.isArray(cache.fileList)) {
            const picomatchModule = await import("picomatch") as any;
            const picomatch = picomatchModule.default;
            const isMatch = picomatch(pattern);
            // Perform in-memory glob filtering using picomatch utility
            files = cache.fileList.filter((file: string) => isMatch(file));
          }
        }
      } catch (cacheErr) {
        // Fallback to disk if cache read fails
      }

      if (files === null) {
        files = await fg(pattern, {
          cwd: searchPath,
          absolute: false,
          onlyFiles: true,
          ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
        });
      }

      if (files.length === 0) return "No files found.";
      const sliced = files.slice(0, limit);
      const output = sliced.join("\n");
      if (files.length > limit) {
        return `${output}\n\n... (output truncated, showing ${limit} of ${files.length} files)`;
      }
      return output;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: ${message}`;
    }
  },
};

export const grepTool: Tool = {
  name: "grep",
  description: "Search file contents using regex. Returns matching lines.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
      include: {
        type: "string",
        description: "File pattern to include (e.g. *.ts)",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: cwd)",
      },
    },
    required: ["pattern"],
  },
  async execute(args, cwd, signal) {
    const pattern = args.pattern as string;
    const include = (args.include as string) || "*";
    const searchPath = args.path
      ? path.resolve(cwd, args.path as string)
      : cwd;

    try {
      let files: string[] | null = null;
      try {
        const cachePath = getWorkspaceCachePath(searchPath);
        if (fsSync.existsSync(cachePath)) {
          const cacheContent = fsSync.readFileSync(cachePath, "utf-8");
          const cache = JSON.parse(cacheContent);
          if (cache && Array.isArray(cache.fileList)) {
            const picomatchModule = await import("picomatch") as any;
            const picomatch = picomatchModule.default;
            const isMatch = picomatch(`**/${include}`);
            const matchedFiles = cache.fileList.filter((file: string) => isMatch(file));
            files = matchedFiles.map((file: string) => path.resolve(searchPath, file));
          }
        }
      } catch (cacheErr) {
        // Fallback to disk
      }

      if (files === null) {
        files = await fg(`**/${include}`, {
          cwd: searchPath,
          absolute: true,
          onlyFiles: true,
          ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
        });
      }

      const results: string[] = [];
      const regex = new RegExp(pattern, "gi");
      const slicedFiles = files.slice(0, 500);

      // Process in batches of 25 files concurrently
      const BATCH_SIZE = 25;
      for (let offset = 0; offset < slicedFiles.length; offset += BATCH_SIZE) {
        const batch = slicedFiles.slice(offset, offset + BATCH_SIZE);
        await Promise.all(
          batch.map(async (file) => {
            try {
              const content = await fs.readFile(file, "utf-8");
              if (content.includes("\0")) return; // skip binary
              const lines = content.split(/\r?\n/);
              const localRegex = new RegExp(pattern, "gi");
              for (let i = 0; i < lines.length; i++) {
                if (localRegex.test(lines[i])) {
                  const relPath = path.relative(searchPath, file).replace(/\\/g, "/");
                  results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
                }
                localRegex.lastIndex = 0;
              }
            } catch {
              // skip unreadable files
            }
          })
        );
      }

      if (results.length > 100) {
        return results.slice(0, 100).join("\n") + `\n\n... (output truncated, showing 100 of ${results.length} matches. Refine your query/pattern or search path to narrow down results)`;
      }
      return results.length > 0
        ? results.join("\n")
        : "No matches found.";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: ${message}`;
    }
  },
};

export const ripgrepSearchTool: Tool = {
  name: "ripgrep_search",
  description: "Search file contents using ripgrep (rg) if installed. Extremely fast.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The pattern to search for",
      },
      path: {
        type: "string",
        description: "Optional subpath to search within",
      },
    },
    required: ["pattern"],
  },
  async execute(args, cwd, signal) {
    const pattern = args.pattern as string;
    const searchPath = args.path ? path.resolve(cwd, args.path as string) : cwd;

    await ensureRgInstalled();

    let rgExe = "rg";
    if (!(await isRgInstalledGlobally())) {
      const localRg = getLocalRgPath();
      try {
        await fs.access(localRg);
        rgExe = localRg;
      } catch {}
    }

    try {
      const result = await execa(
        rgExe,
        [
          "--vimgrep",
          "--smart-case",
          "--glob", "!node_modules",
          "--glob", "!dist",
          "--glob", "!.git",
          pattern,
          searchPath
        ],
        {
          reject: false,
          cancelSignal: signal,
        }
      );

      if (result.exitCode === 1) {
        return "No matches found.";
      }
      if (result.exitCode !== 0) {
        return `ripgrep failed with code ${result.exitCode}: ${result.stderr}`;
      }

      const lines = result.stdout.split("\n");
      const truncateOutput = (await import("./helpers.js")).truncateOutput;
      if (lines.length > 100) {
        return lines.slice(0, 100).join("\n") + `\n\n... (showing 100 of ${lines.length} results)`;
      }
      return result.stdout;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `ripgrep error: ${message}. Make sure ripgrep is installed.`;
    }
  },
};

export const writeToFileTool: Tool = {
  name: "write_to_file",
  description: "Create or overwrite file content entirely. PREFER 'files' array to batch create/overwrite multiple files in ONE call — never write files one-by-one.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to write to (optional if files is provided)",
      },
      content: {
        type: "string",
        description: "The complete content to write to the file (optional if files is provided)",
      },
      overwrite: {
        type: "boolean",
        description: "If true, will overwrite an existing file. If false, will error if the file exists.",
      },
      files: {
        type: "array",
        description: "Optional list of files to write in bulk.",
        items: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Path to the file to write to",
            },
            content: {
              type: "string",
              description: "The complete content to write to the file",
            },
            overwrite: {
              type: "boolean",
              description: "If true, will overwrite an existing file. If false, will error if the file exists.",
            },
          },
          required: ["filePath", "content"],
        },
      },
    },
  },
  async execute(args, cwd, signal) {
    const files = args.files as Array<{ filePath: string; content: string; overwrite?: boolean }> | undefined;
    if (files && Array.isArray(files)) {
      if (files.length === 0) {
        return "Error: 'files' parameter is empty.";
      }
      const sortedFiles = files.map(file => {
        const raw = file.filePath;
        const resolved = normalizePath(path.resolve(cwd, raw));
        return { ...file, resolvedPath: resolved };
      }).sort((a, b) => a.resolvedPath.localeCompare(b.resolvedPath));

      const releases: (() => void)[] = [];
      const results: string[] = [];
      try {
        for (const file of sortedFiles) {
          releases.push(await fileLockManager.acquire(file.resolvedPath));
        }
        for (const file of sortedFiles) {
          const overwrite = !!file.overwrite;
          const nextContent = file.content;
          if (nextContent === undefined || nextContent === null) {
            results.push(`Error: Missing 'content' for file ${file.filePath}`);
            continue;
          }
          if (!overwrite) {
            try {
              await fs.access(file.resolvedPath);
              results.push(`Error: File already exists and overwrite was set to false for ${file.filePath}`);
              continue;
            } catch {
              // File does not exist, safe to write
            }
          }
          let previousContent = "";
          let existedBefore = true;
          try {
            previousContent = await fs.readFile(file.resolvedPath, "utf-8");
          } catch {
            existedBefore = false;
          }
          const summary = buildEditSummary(previousContent, nextContent, file.resolvedPath, existedBefore);
          if (previousContent === nextContent && existedBefore) {
            results.push(summary);
            continue;
          }
          await fs.mkdir(path.dirname(file.resolvedPath), { recursive: true });
          await fs.writeFile(file.resolvedPath, nextContent, "utf-8");
          const syntaxError = await verifySyntax(file.resolvedPath);
          const action = existedBefore ? "File written successfully" : "Created file";
          if (syntaxError) {
            results.push(`Warning: ${syntaxError}. ${action}: ${file.filePath}\n${summary}`);
          } else {
            results.push(`${action}: ${file.filePath}\n${summary}`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error in bulk writing files: ${message}`;
      } finally {
        for (const release of releases.reverse()) {
          release();
        }
      }
      return results.join("\n\n");
    }

    const filePath = resolveFilePathFromArgs(args, cwd);
    if (!filePath) {
      return "Error: Missing required parameter 'filePath' or 'files'. Provide the path to the file to write to.";
    }
    const overwrite = !!args.overwrite;
    const nextContent = args.content as string | undefined;
    if (nextContent === undefined || nextContent === null) {
      return "Error: Missing required parameter 'content'. Provide the content to write to the file.";
    }
    const release = await fileLockManager.acquire(filePath);
    try {
      if (!overwrite) {
        try {
          await fs.access(filePath);
          return `Error: File already exists and overwrite was set to false.`;
        } catch {
          // File does not exist, safe to write
        }
      }
      let previousContent = "";
      let existedBefore = true;
      try {
        previousContent = await fs.readFile(filePath, "utf-8");
      } catch {
        existedBefore = false;
      }
      const summary = buildEditSummary(previousContent, nextContent, filePath, existedBefore);
      if (previousContent === nextContent && existedBefore) {
        return summary;
      }

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, nextContent, "utf-8");
      const syntaxError = await verifySyntax(filePath);
      const action = existedBefore ? "File written successfully" : "Created file";
      if (syntaxError) {
        return `Warning: ${syntaxError}. ${action}: ${filePath}\n${summary}`;
      }
      return `${action}: ${filePath}\n${summary}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error writing file: ${message}`;
    } finally {
      release();
    }
  },
};

export const replaceFileContentTool: Tool = {
  name: "replace_file_content",
  description: "Edit a single contiguous block in a file by line range + target content. PREFER 'edits' array to batch replacements across files in ONE call.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to edit (optional if edits is provided)",
      },
      targetContent: {
        type: "string",
        description: "The exact target content to replace (including whitespace) (optional if edits is provided)",
      },
      replacementContent: {
        type: "string",
        description: "The replacement content (optional if edits is provided)",
      },
      startLine: {
        type: "number",
        description: "Start line number of the block to replace (1-indexed) (optional if edits is provided)",
      },
      endLine: {
        type: "number",
        description: "End line number of the block to replace (1-indexed) (optional if edits is provided)",
      },
      allowMultiple: {
        type: "boolean",
        description: "If true, allow multiple occurrences of targetContent within the line range to be replaced. Default is false.",
      },
      AllowMultiple: {
        type: "boolean",
        description: "Alias for allowMultiple.",
      },
      edits: {
        type: "array",
        description: "Optional list of replacements to perform across multiple files.",
        items: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Path to the file to edit",
            },
            targetContent: {
              type: "string",
              description: "Exact target content to replace",
            },
            replacementContent: {
              type: "string",
              description: "Replacement content",
            },
            startLine: {
              type: "number",
              description: "Start line number (1-indexed)",
            },
            endLine: {
              type: "number",
              description: "End line number (1-indexed)",
            },
            allowMultiple: {
              type: "boolean",
              description: "Allow multiple replacements within range",
            },
            AllowMultiple: {
              type: "boolean",
              description: "Alias for allowMultiple",
            },
          },
          required: ["filePath", "targetContent", "replacementContent", "startLine", "endLine"],
        },
      },
    },
  },
  async execute(args, cwd, signal) {
    const edits = args.edits as Array<{ filePath: string; targetContent: string; replacementContent: string; startLine: number; endLine: number; allowMultiple?: boolean; AllowMultiple?: boolean }> | undefined;
    if (edits && Array.isArray(edits)) {
      if (edits.length === 0) {
        return "Error: 'edits' parameter is empty.";
      }
      const sortedEdits = edits.map(edit => {
        const raw = edit.filePath;
        const resolved = normalizePath(path.resolve(cwd, raw));
        return { ...edit, resolvedPath: resolved };
      }).sort((a, b) => a.resolvedPath.localeCompare(b.resolvedPath));

      const releases: (() => void)[] = [];
      const results: string[] = [];
      try {
        const uniquePaths = Array.from(new Set(sortedEdits.map(e => e.resolvedPath))).sort();
        for (const p of uniquePaths) {
          releases.push(await fileLockManager.acquire(p));
        }

        const editsByFile = new Map<string, typeof sortedEdits>();
        for (const edit of sortedEdits) {
          const list = editsByFile.get(edit.resolvedPath) || [];
          list.push(edit);
          editsByFile.set(edit.resolvedPath, list);
        }

        for (const [filePath, fileEdits] of editsByFile.entries()) {
          try {
            let content = await fs.readFile(filePath, "utf-8");
            const sortedFileEdits = [...fileEdits].sort((a, b) => b.startLine - a.startLine);
            let lines = content.split(/\r?\n/);
            const originalEnding = content.includes("\r\n") ? "\r\n" : "\n";

            for (const edit of sortedFileEdits) {
               const targetContent = edit.targetContent;
               const replacementContent = edit.replacementContent;
               const startLine = Math.max(1, Number(edit.startLine));
               const endLine = Math.max(startLine, Number(edit.endLine));
               const allowMultiple = !!(edit.allowMultiple ?? edit.AllowMultiple);

               if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
                 throw new Error(`Invalid line range [${startLine}, ${endLine}]. File has ${lines.length} lines.`);
               }

               const sliceOfLines = lines.slice(startLine - 1, endLine);
               const sliceText = sliceOfLines.join("\n");
               const normSliceText = normalizeForMatching(sliceText);
               const normTargetContent = normalizeForMatching(targetContent);

               if (!normSliceText.includes(normTargetContent)) {
                 throw new Error(`targetContent not found in specified line range [${startLine}, ${endLine}] (matching normalized content)`);
               }

               const occurrences = countOccurrences(normSliceText, normTargetContent);
               if (occurrences > 1 && !allowMultiple) {
                 throw new Error(`Multiple occurrences of targetContent found in line range [${startLine}, ${endLine}] (matching normalized content). Set allowMultiple to true.`);
               }

               let replacedSlice: string;
               if (occurrences > 1 && allowMultiple) {
                 const matchIndices: number[] = [];
                 let pos = normSliceText.indexOf(normTargetContent);
                 while (pos !== -1) {
                   matchIndices.push(pos);
                   pos = normSliceText.indexOf(normTargetContent, pos + normTargetContent.length);
                 }

                 const normToOrigMap = mapNormToOrigIndices(sliceText, normSliceText);
                 let tempSlice = sliceText;
                 for (let i = matchIndices.length - 1; i >= 0; i--) {
                   const mIdx = matchIndices[i];
                   const origStart = normToOrigMap[mIdx] ?? -1;
                   const origEnd = normToOrigMap[mIdx + normTargetContent.length] ?? -1;
                   if (origStart !== -1 && origEnd !== -1) {
                     tempSlice = tempSlice.slice(0, origStart) + replacementContent + tempSlice.slice(origEnd);
                   }
                 }
                 replacedSlice = tempSlice;
               } else {
                 const matchIndexInNorm = normSliceText.indexOf(normTargetContent);
                 const normToOrigMap = mapNormToOrigIndices(sliceText, normSliceText);
                 const matchOrigStart = normToOrigMap[matchIndexInNorm] ?? -1;
                 const matchOrigEnd = normToOrigMap[matchIndexInNorm + normTargetContent.length] ?? -1;

                 if (matchOrigStart === -1 || matchOrigEnd === -1) {
                   replacedSlice = sliceText.replace(targetContent, replacementContent);
                 } else {
                   replacedSlice = sliceText.slice(0, matchOrigStart) + replacementContent + sliceText.slice(matchOrigEnd);
                 }
               }

               lines = [
                 ...lines.slice(0, startLine - 1),
                 ...replacedSlice.split(/\r?\n/),
                 ...lines.slice(endLine),
               ];
            }

            const nextContent = lines.join(originalEnding);
            const summary = buildEditSummary(content, nextContent, filePath);
            if (content === nextContent) {
              results.push(summary);
              continue;
            }
            await fs.writeFile(filePath, nextContent, "utf-8");
            const syntaxError = await verifySyntax(filePath);
            if (syntaxError) {
              results.push(`Warning: ${syntaxError}. File updated: ${fileEdits[0].filePath}\n${summary}`);
            } else {
              results.push(`File updated successfully: ${fileEdits[0].filePath}\n${summary}`);
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            results.push(`Error in replacing content for ${filePath}: ${message}`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error in bulk replacing: ${message}`;
      } finally {
        for (const release of releases.reverse()) {
          release();
        }
      }
      return results.join("\n\n");
    }

    const filePath = resolveFilePathFromArgs(args, cwd);
    if (!filePath) {
      return "Error: Missing required parameter 'filePath' or 'edits'. Provide the path to the file to edit.";
    }
    const targetContent = (args.targetContent ?? args.TargetContent ?? "") as string;
    const replacementContent = (args.replacementContent ?? args.ReplacementContent ?? "") as string;
    const startLine = Math.max(1, Number(args.startLine ?? args.StartLine ?? 0));
    const endLine = Math.max(startLine, Number(args.endLine ?? args.EndLine ?? 0));
    const allowMultiple = !!(args.allowMultiple ?? args.AllowMultiple);

    if (!targetContent) {
      return "Error: targetContent cannot be empty.";
    }

    const release = await fileLockManager.acquire(filePath);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split(/\r?\n/);
      
      if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
        return `Error: Invalid line range [${startLine}, ${endLine}]. File has ${lines.length} lines.`;
      }

      const sliceOfLines = lines.slice(startLine - 1, endLine);
      const sliceText = sliceOfLines.join("\n");
      const normSliceText = normalizeForMatching(sliceText);
      const normTargetContent = normalizeForMatching(targetContent);

      if (!normSliceText.includes(normTargetContent)) {
        return `Error: targetContent not found in specified line range [${startLine}, ${endLine}] (matching normalized content).`;
      }

      const occurrences = countOccurrences(normSliceText, normTargetContent);
      if (occurrences > 1 && !allowMultiple) {
        return `Error: Multiple occurrences of targetContent found in specified line range [${startLine}, ${endLine}] (matching normalized content). Set 'allowMultiple' to true if you want to replace all occurrences, or use a more specific targetContent/narrower line range.`;
      }

      let replacedSlice: string;
      if (occurrences > 1 && allowMultiple) {
        const matchIndices: number[] = [];
        let pos = normSliceText.indexOf(normTargetContent);
        while (pos !== -1) {
          matchIndices.push(pos);
          pos = normSliceText.indexOf(normTargetContent, pos + normTargetContent.length);
        }

        const normToOrigMap = mapNormToOrigIndices(sliceText, normSliceText);
        let tempSlice = sliceText;
        for (let i = matchIndices.length - 1; i >= 0; i--) {
          const mIdx = matchIndices[i];
          const origStart = normToOrigMap[mIdx] ?? -1;
          const origEnd = normToOrigMap[mIdx + normTargetContent.length] ?? -1;
          if (origStart !== -1 && origEnd !== -1) {
            tempSlice = tempSlice.slice(0, origStart) + replacementContent + tempSlice.slice(origEnd);
          }
        }
        replacedSlice = tempSlice;
      } else {
        const matchIndexInNorm = normSliceText.indexOf(normTargetContent);
        const normToOrigMap = mapNormToOrigIndices(sliceText, normSliceText);
        const matchOrigStart = normToOrigMap[matchIndexInNorm] ?? -1;
        const matchOrigEnd = normToOrigMap[matchIndexInNorm + normTargetContent.length] ?? -1;

        if (matchOrigStart === -1 || matchOrigEnd === -1) {
          replacedSlice = sliceText.replace(targetContent, replacementContent);
        } else {
          replacedSlice = sliceText.slice(0, matchOrigStart) + replacementContent + sliceText.slice(matchOrigEnd);
        }
      }

      const newLines = [
        ...lines.slice(0, startLine - 1),
        ...replacedSlice.split(/\r?\n/),
        ...lines.slice(endLine),
      ];

      const originalEnding = content.includes("\r\n") ? "\r\n" : "\n";
      const nextContent = newLines.join(originalEnding);
      const summary = buildEditSummary(content, nextContent, filePath);
      if (content === nextContent) {
        return summary;
      }
      await fs.writeFile(filePath, nextContent, "utf-8");

      const syntaxError = await verifySyntax(filePath);
      if (syntaxError) {
        return `Warning: ${syntaxError}. File updated: ${filePath}\n${summary}`;
      }

      return `File updated successfully: ${filePath}\n${summary}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error replacing file content: ${message}`;
    } finally {
      release();
    }
  },
};

export const multiReplaceFileContentTool: Tool = {
  name: "multi_replace_file_content",
  description: "Perform multiple non-contiguous edits in a file. PREFER 'files' array to batch multi-chunk edits across files in ONE call.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to edit (optional if files is provided)",
      },
      chunks: {
        type: "array",
        description: "List of replacement chunks to apply (optional if files is provided)",
        items: {
          type: "object",
          properties: {
            targetContent: {
              type: "string",
              description: "The exact content to replace",
            },
            replacementContent: {
              type: "string",
              description: "The replacement content",
            },
            startLine: {
              type: "number",
              description: "Start line number of the block to replace (1-indexed)",
            },
            endLine: {
              type: "number",
              description: "End line number of the block to replace (1-indexed)",
            },
            allowMultiple: {
              type: "boolean",
              description: "If true, allow multiple occurrences of targetContent within the line range to be replaced. Default is false.",
            },
            AllowMultiple: {
              type: "boolean",
              description: "Alias for allowMultiple.",
            },
          },
          required: ["targetContent", "replacementContent", "startLine", "endLine"],
        },
      },
      files: {
        type: "array",
        description: "Optional list of files to edit, each with multiple chunks.",
        items: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Path to the file to edit",
            },
            chunks: {
              type: "array",
              description: "List of replacement chunks to apply",
              items: {
                type: "object",
                properties: {
                  targetContent: {
                    type: "string",
                    description: "The exact content to replace",
                  },
                  replacementContent: {
                    type: "string",
                    description: "The replacement content",
                  },
                  startLine: {
                    type: "number",
                    description: "Start line number of the block to replace (1-indexed)",
                  },
                  endLine: {
                    type: "number",
                    description: "End line number of the block to replace (1-indexed)",
                  },
                  allowMultiple: {
                    type: "boolean",
                    description: "If true, allow multiple occurrences of targetContent within the line range to be replaced. Default is false.",
                  },
                  AllowMultiple: {
                    type: "boolean",
                    description: "Alias for allowMultiple.",
                  },
                },
                required: ["targetContent", "replacementContent", "startLine", "endLine"],
              },
            },
          },
          required: ["filePath", "chunks"],
        },
      },
    },
  },
  async execute(args, cwd, signal) {
    interface Chunk {
      targetContent: string;
      replacementContent: string;
      startLine: number;
      endLine: number;
      allowMultiple?: boolean;
      AllowMultiple?: boolean;
    }
    interface ResolvedChunk {
      originalChunk: Chunk;
      actualStartLine: number;
      actualEndLine: number;
      matchOrigStart: number;
      matchOrigEnd: number;
      minSliceText: string;
    }

    const files = args.files as Array<{ filePath: string; chunks: Chunk[] }> | undefined;
    if (files && Array.isArray(files)) {
      if (files.length === 0) {
        return "Error: 'files' parameter is empty.";
      }
      const sortedFiles = files.map(file => {
        const raw = file.filePath;
        const resolved = normalizePath(path.resolve(cwd, raw));
        return { ...file, resolvedPath: resolved };
      }).sort((a, b) => a.resolvedPath.localeCompare(b.resolvedPath));

      const releases: (() => void)[] = [];
      const results: string[] = [];
      try {
        for (const file of sortedFiles) {
          releases.push(await fileLockManager.acquire(file.resolvedPath));
        }

        for (const file of sortedFiles) {
          try {
            const rawChunks = file.chunks;
            const chunks: Chunk[] = [];
            for (const c of rawChunks as any[]) {
              if (!c || typeof c !== "object") {
                throw new Error("Invalid chunk element: expected an object.");
              }
              const targetContent = c.targetContent ?? c.TargetContent;
              const replacementContent = c.replacementContent ?? c.ReplacementContent;
              if (typeof targetContent !== "string") {
                throw new Error(`Missing or invalid 'targetContent' in chunk.`);
              }
              if (typeof replacementContent !== "string") {
                throw new Error(`Missing or invalid 'replacementContent' in chunk.`);
              }
              if (!targetContent) {
                throw new Error("targetContent in chunk cannot be empty.");
              }
              const startLineVal = c.startLine ?? c.StartLine;
              const endLineVal = c.endLine ?? c.EndLine;
              if (startLineVal === undefined || startLineVal === null) {
                throw new Error("Missing required parameter 'startLine' in chunk.");
              }
              if (endLineVal === undefined || endLineVal === null) {
                throw new Error("Missing required parameter 'endLine' in chunk.");
              }
              const sl = Number(startLineVal);
              const el = Number(endLineVal);
              if (isNaN(sl) || isNaN(el)) {
                throw new Error("'startLine' and 'endLine' must be valid numbers in chunk.");
              }
              const allowMultiple = !!(c.allowMultiple ?? c.AllowMultiple);
              chunks.push({
                targetContent,
                replacementContent,
                startLine: sl,
                endLine: el,
                allowMultiple,
              });
            }

            if (chunks.length === 0) {
              throw new Error("No chunks provided or invalid format.");
            }

            let content = await fs.readFile(file.resolvedPath, "utf-8");
            const originalEnding = content.includes("\r\n") ? "\r\n" : "\n";
            let lines = content.split(/\r?\n/);

            const resolvedChunks: ResolvedChunk[] = [];
            for (const chunk of chunks) {
              const { targetContent, replacementContent, startLine, endLine, allowMultiple } = chunk;
              if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
                throw new Error(`Invalid line range [${startLine}, ${endLine}] in chunk. File has ${lines.length} lines.`);
              }

              const sliceOfLines = lines.slice(startLine - 1, endLine);
              const sliceText = sliceOfLines.join("\n");
              const normSliceText = normalizeForMatching(sliceText);
              const normTargetContent = normalizeForMatching(targetContent);

              if (!normSliceText.includes(normTargetContent)) {
                throw new Error(`targetContent not found in specified line range [${startLine}, ${endLine}] for a chunk.`);
              }

              const occurrences = countOccurrences(normSliceText, normTargetContent);
              if (occurrences > 1 && !allowMultiple) {
                throw new Error(`Multiple occurrences of targetContent found in line range [${startLine}, ${endLine}] for a chunk. Set 'allowMultiple' to true.`);
              }

              const matchIndexInNorm = normSliceText.indexOf(normTargetContent);
              let actualStartLine = startLine;
              let actualEndLine = endLine;
              let matchOrigStart = -1;
              let matchOrigEnd = -1;
              let minSliceText = sliceText;

              if (matchIndexInNorm !== -1) {
                const normToOrigMap = mapNormToOrigIndices(sliceText, normSliceText);

                if (occurrences > 1) {
                  const firstMatchIdx = normSliceText.indexOf(normTargetContent);
                  const lastMatchIdx = normSliceText.lastIndexOf(normTargetContent);
                  
                  const firstOrigStart = normToOrigMap[firstMatchIdx] ?? -1;
                  const lastOrigEnd = normToOrigMap[lastMatchIdx + normTargetContent.length] ?? -1;
                  
                  if (firstOrigStart !== -1 && lastOrigEnd !== -1) {
                    const startLineOffset = sliceText.slice(0, firstOrigStart).split("\n").length - 1;
                    actualStartLine = startLine + startLineOffset;

                    const endLineOffset = sliceText.slice(0, lastOrigEnd).split("\n").length - 1;
                    actualEndLine = startLine + endLineOffset;

                    const minSliceOfLines = lines.slice(actualStartLine - 1, actualEndLine);
                    minSliceText = minSliceOfLines.join("\n");
                  }
                } else {
                  matchOrigStart = normToOrigMap[matchIndexInNorm] ?? -1;
                  matchOrigEnd = normToOrigMap[matchIndexInNorm + normTargetContent.length] ?? -1;

                  if (matchOrigStart !== -1 && matchOrigEnd !== -1) {
                    const startLineOffset = sliceText.slice(0, matchOrigStart).split("\n").length - 1;
                    actualStartLine = startLine + startLineOffset;

                    const endLineOffset = sliceText.slice(0, matchOrigEnd).split("\n").length - 1;
                    actualEndLine = startLine + endLineOffset;

                    const minSliceOfLines = lines.slice(actualStartLine - 1, actualEndLine);
                    minSliceText = minSliceOfLines.join("\n");

                    const normMinSliceText = normalizeForMatching(minSliceText);
                    const matchIndexInMinNorm = normMinSliceText.indexOf(normTargetContent);
                    if (matchIndexInMinNorm !== -1) {
                      const minNormToOrigMap = mapNormToOrigIndices(minSliceText, normMinSliceText);
                      matchOrigStart = minNormToOrigMap[matchIndexInMinNorm] ?? -1;
                      matchOrigEnd = minNormToOrigMap[matchIndexInMinNorm + normTargetContent.length] ?? -1;
                    } else {
                      matchOrigStart = -1;
                      matchOrigEnd = -1;
                    }
                  }
                }
              }

              resolvedChunks.push({
                originalChunk: chunk,
                actualStartLine,
                actualEndLine,
                matchOrigStart,
                matchOrigEnd,
                minSliceText,
              });
            }

            const sortedForOverlapCheck = [...resolvedChunks].sort((a, b) => a.actualStartLine - b.actualStartLine);
            for (let i = 0; i < sortedForOverlapCheck.length - 1; i++) {
              const current = sortedForOverlapCheck[i];
              const next = sortedForOverlapCheck[i + 1];
              if (current.actualEndLine >= next.actualStartLine) {
                throw new Error(`Overlapping line ranges detected between chunks: [${current.originalChunk.startLine}, ${current.originalChunk.endLine}] and [${next.originalChunk.startLine}, ${next.originalChunk.endLine}].`);
              }
            }

            const sortedChunks = [...resolvedChunks].sort((a, b) => b.actualStartLine - a.actualStartLine);
            for (const resolved of sortedChunks) {
              const { originalChunk, matchOrigStart, matchOrigEnd, minSliceText, actualStartLine, actualEndLine } = resolved;
              const { targetContent, replacementContent, allowMultiple } = originalChunk;

              let replacedSlice: string;
              const normMinSliceText = normalizeForMatching(minSliceText);
              const normTargetContent = normalizeForMatching(targetContent);
              const chunkOccurrences = countOccurrences(normMinSliceText, normTargetContent);

              if (chunkOccurrences > 1 && allowMultiple) {
                const matchIndices: number[] = [];
                let pos = normMinSliceText.indexOf(normTargetContent);
                while (pos !== -1) {
                  matchIndices.push(pos);
                  pos = normMinSliceText.indexOf(normTargetContent, pos + normTargetContent.length);
                }

                const minNormToOrigMap = mapNormToOrigIndices(minSliceText, normMinSliceText);
                let tempSlice = minSliceText;
                for (let i = matchIndices.length - 1; i >= 0; i--) {
                  const mIdx = matchIndices[i];
                  const origStart = minNormToOrigMap[mIdx] ?? -1;
                  const origEnd = minNormToOrigMap[mIdx + normTargetContent.length] ?? -1;
                  if (origStart !== -1 && origEnd !== -1) {
                    tempSlice = tempSlice.slice(0, origStart) + replacementContent + tempSlice.slice(origEnd);
                  }
                }
                replacedSlice = tempSlice;
              } else {
                if (matchOrigStart === -1 || matchOrigEnd === -1) {
                  replacedSlice = minSliceText.replace(targetContent, replacementContent);
                } else {
                  replacedSlice = minSliceText.slice(0, matchOrigStart) + replacementContent + minSliceText.slice(matchOrigEnd);
                }
              }

              lines = [
                ...lines.slice(0, actualStartLine - 1),
                ...replacedSlice.split(/\r?\n/),
                ...lines.slice(actualEndLine),
              ];
            }

            const nextContent = lines.join(originalEnding);
            const summary = buildEditSummary(content, nextContent, file.resolvedPath);
            if (content === nextContent) {
              results.push(summary);
              continue;
            }
            await fs.writeFile(file.resolvedPath, nextContent, "utf-8");
            const syntaxError = await verifySyntax(file.resolvedPath);
            if (syntaxError) {
              results.push(`Warning: ${syntaxError}. File updated successfully with ${chunks.length} changes: ${file.filePath}\n${summary}`);
            } else {
              results.push(`File updated successfully with ${chunks.length} changes: ${file.filePath}\n${summary}`);
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            results.push(`Error in multi-replace for ${file.filePath}: ${message}`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error in bulk multi-replace: ${message}`;
      } finally {
        for (const release of releases.reverse()) {
          release();
        }
      }
      return results.join("\n\n");
    }

    const filePath = resolveFilePathFromArgs(args, cwd);
    if (!filePath) {
      return "Error: Missing required parameter 'filePath' or 'files'. Provide the path to the file to edit.";
    }
    let rawChunks = args.chunks || args.ReplacementChunks || args.replacementChunks || [];
    if (typeof rawChunks === "string") {
      try {
        rawChunks = JSON.parse(rawChunks);
      } catch (err: any) {
        return `Error: Invalid 'chunks' parameter. Failed to parse JSON: ${err.message}`;
      }
    }

    const rawChunksArray = Array.isArray(rawChunks)
      ? rawChunks
      : (rawChunks !== undefined && rawChunks !== null ? [rawChunks] : []);

    const chunks: Chunk[] = [];
    for (const c of rawChunksArray) {
      if (!c || typeof c !== "object") {
        return `Error: Invalid chunk element: expected an object, got ${typeof c}.`;
      }
      const targetContent = c.targetContent ?? c.TargetContent;
      const replacementContent = c.replacementContent ?? c.ReplacementContent;
      if (typeof targetContent !== "string") {
        return `Error: Missing or invalid 'targetContent' in chunk. Expected string, got ${typeof targetContent}.`;
      }
      if (typeof replacementContent !== "string") {
        return `Error: Missing or invalid 'replacementContent' in chunk. Expected string, got ${typeof replacementContent}.`;
      }
      if (!targetContent) {
        return "Error: targetContent in chunk cannot be empty.";
      }
      const startLineVal = c.startLine ?? c.StartLine;
      const endLineVal = c.endLine ?? c.EndLine;
      if (startLineVal === undefined || startLineVal === null) {
        return "Error: Missing required parameter 'startLine' in chunk.";
      }
      if (endLineVal === undefined || endLineVal === null) {
        return "Error: Missing required parameter 'endLine' in chunk.";
      }
      const sl = Number(startLineVal);
      const el = Number(endLineVal);
      if (isNaN(sl) || isNaN(el)) {
        return "Error: 'startLine' and 'endLine' must be valid numbers in chunk.";
      }
      const allowMultiple = !!(c.allowMultiple ?? c.AllowMultiple);
      chunks.push({
        targetContent,
        replacementContent,
        startLine: sl,
        endLine: el,
        allowMultiple,
      });
    }

    if (chunks.length === 0) {
      return "Error: No chunks provided or invalid format.";
    }

    const release = await fileLockManager.acquire(filePath);
    try {
      let content = await fs.readFile(filePath, "utf-8");
      const originalEnding = content.includes("\r\n") ? "\r\n" : "\n";
      let lines = content.split(/\r?\n/);

      const resolvedChunks: ResolvedChunk[] = [];

      for (const chunk of chunks) {
        const { targetContent, replacementContent, startLine, endLine, allowMultiple } = chunk;
        if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
          return `Error: Invalid line range [${startLine}, ${endLine}] in chunk. File has ${lines.length} lines.`;
        }

        const sliceOfLines = lines.slice(startLine - 1, endLine);
        const sliceText = sliceOfLines.join("\n");
        const normSliceText = normalizeForMatching(sliceText);
        const normTargetContent = normalizeForMatching(targetContent);

        if (!normSliceText.includes(normTargetContent)) {
          return `Error: targetContent not found in specified line range [${startLine}, ${endLine}] for a chunk (matching normalized content).`;
        }

        const occurrences = countOccurrences(normSliceText, normTargetContent);
        if (occurrences > 1 && !allowMultiple) {
          return `Error: Multiple occurrences of targetContent found in specified line range [${startLine}, ${endLine}] for a chunk (matching normalized content). Set 'allowMultiple' to true in the chunk if you want to replace all occurrences, or use a more specific targetContent/narrower line range.`;
        }

        const matchIndexInNorm = normSliceText.indexOf(normTargetContent);
        let actualStartLine = startLine;
        let actualEndLine = endLine;
        let matchOrigStart = -1;
        let matchOrigEnd = -1;
        let minSliceText = sliceText;

        if (matchIndexInNorm !== -1) {
          const normToOrigMap = mapNormToOrigIndices(sliceText, normSliceText);

          if (occurrences > 1) {
            const firstMatchIdx = normSliceText.indexOf(normTargetContent);
            const lastMatchIdx = normSliceText.lastIndexOf(normTargetContent);
            
            const firstOrigStart = normToOrigMap[firstMatchIdx] ?? -1;
            const lastOrigEnd = normToOrigMap[lastMatchIdx + normTargetContent.length] ?? -1;
            
            if (firstOrigStart !== -1 && lastOrigEnd !== -1) {
              const startLineOffset = sliceText.slice(0, firstOrigStart).split("\n").length - 1;
              actualStartLine = startLine + startLineOffset;

              const endLineOffset = sliceText.slice(0, lastOrigEnd).split("\n").length - 1;
              actualEndLine = startLine + endLineOffset;

              const minSliceOfLines = lines.slice(actualStartLine - 1, actualEndLine);
              minSliceText = minSliceOfLines.join("\n");
            }
          } else {
            matchOrigStart = normToOrigMap[matchIndexInNorm] ?? -1;
            matchOrigEnd = normToOrigMap[matchIndexInNorm + normTargetContent.length] ?? -1;

            if (matchOrigStart !== -1 && matchOrigEnd !== -1) {
              const startLineOffset = sliceText.slice(0, matchOrigStart).split("\n").length - 1;
              actualStartLine = startLine + startLineOffset;

              const endLineOffset = sliceText.slice(0, matchOrigEnd).split("\n").length - 1;
              actualEndLine = startLine + endLineOffset;

              const minSliceOfLines = lines.slice(actualStartLine - 1, actualEndLine);
              minSliceText = minSliceOfLines.join("\n");

              // Recalculate match indices for the minSliceText to ensure correct replacement character offsets
              const normMinSliceText = normalizeForMatching(minSliceText);
              const matchIndexInMinNorm = normMinSliceText.indexOf(normTargetContent);
              if (matchIndexInMinNorm !== -1) {
                const minNormToOrigMap = mapNormToOrigIndices(minSliceText, normMinSliceText);
                matchOrigStart = minNormToOrigMap[matchIndexInMinNorm] ?? -1;
                matchOrigEnd = minNormToOrigMap[matchIndexInMinNorm + normTargetContent.length] ?? -1;
              } else {
                matchOrigStart = -1;
                matchOrigEnd = -1;
              }
            }
          }
        }

        resolvedChunks.push({
          originalChunk: chunk,
          actualStartLine,
          actualEndLine,
          matchOrigStart,
          matchOrigEnd,
          minSliceText,
        });
      }

      // Check for overlapping actual line ranges defensively
      const sortedForOverlapCheck = [...resolvedChunks].sort((a, b) => a.actualStartLine - b.actualStartLine);
      for (let i = 0; i < sortedForOverlapCheck.length - 1; i++) {
        const current = sortedForOverlapCheck[i];
        const next = sortedForOverlapCheck[i + 1];
        if (current.actualEndLine >= next.actualStartLine) {
          return `Error: Overlapping line ranges detected between chunks: [${current.originalChunk.startLine}, ${current.originalChunk.endLine}] and [${next.originalChunk.startLine}, ${next.originalChunk.endLine}].`;
        }
      }

      // Sort in descending order of actualStartLine to safely apply splices bottom-to-top
      const sortedChunks = [...resolvedChunks].sort((a, b) => b.actualStartLine - a.actualStartLine);

      for (const resolved of sortedChunks) {
        const { originalChunk, matchOrigStart, matchOrigEnd, minSliceText, actualStartLine, actualEndLine } = resolved;
        const { targetContent, replacementContent, allowMultiple } = originalChunk;

        let replacedSlice: string;
        const normMinSliceText = normalizeForMatching(minSliceText);
        const normTargetContent = normalizeForMatching(targetContent);
        const chunkOccurrences = countOccurrences(normMinSliceText, normTargetContent);

        if (chunkOccurrences > 1 && allowMultiple) {
          const matchIndices: number[] = [];
          let pos = normMinSliceText.indexOf(normTargetContent);
          while (pos !== -1) {
            matchIndices.push(pos);
            pos = normMinSliceText.indexOf(normTargetContent, pos + normTargetContent.length);
          }

          const minNormToOrigMap = mapNormToOrigIndices(minSliceText, normMinSliceText);
          let tempSlice = minSliceText;
          for (let i = matchIndices.length - 1; i >= 0; i--) {
            const mIdx = matchIndices[i];
            const origStart = minNormToOrigMap[mIdx] ?? -1;
            const origEnd = minNormToOrigMap[mIdx + normTargetContent.length] ?? -1;
            if (origStart !== -1 && origEnd !== -1) {
              tempSlice = tempSlice.slice(0, origStart) + replacementContent + tempSlice.slice(origEnd);
            }
          }
          replacedSlice = tempSlice;
        } else {
          if (matchOrigStart === -1 || matchOrigEnd === -1) {
            replacedSlice = minSliceText.replace(targetContent, replacementContent);
          } else {
            replacedSlice = minSliceText.slice(0, matchOrigStart) + replacementContent + minSliceText.slice(matchOrigEnd);
          }
        }

        lines = [
          ...lines.slice(0, actualStartLine - 1),
          ...replacedSlice.split(/\r?\n/),
          ...lines.slice(actualEndLine),
        ];
      }

      const nextContent = lines.join(originalEnding);
      const summary = buildEditSummary(content, nextContent, filePath);
      if (content === nextContent) {
        return summary;
      }
      await fs.writeFile(filePath, nextContent, "utf-8");
      const syntaxError = await verifySyntax(filePath);
      if (syntaxError) {
        return `Warning: ${syntaxError}. File updated successfully with ${chunks.length} changes: ${filePath}\n${summary}`;
      }
      return `File updated successfully with ${chunks.length} changes: ${filePath}\n${summary}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error in multi-replace: ${message}`;
    } finally {
      release();
    }
  },
};

// Helper: Apply patch content to file content string, returns patched content or error string
async function applyPatchToContent(content: string, patchContent: string, filePath: string): Promise<{ result: string; error?: string }> {
  const originalEnding = content.includes("\r\n") ? "\r\n" : "\n";
  
  // If it looks like a unified diff
  if (patchContent.includes("@@ ") || patchContent.startsWith("---") || patchContent.startsWith("diff")) {
    const matchAt = (lines: string[], start: number, target: string[]): boolean => {
      if (start + target.length > lines.length) return false;
      for (let idx = 0; idx < target.length; idx++) {
        if (lines[start + idx].trimEnd() !== target[idx].trimEnd()) {
          return false;
        }
      }
      return true;
    };

    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const patchLines = patchContent.split(/\r?\n/);
    let i = 0;
    while (i < patchLines.length) {
      const line = patchLines[i];
      if (line.startsWith("@@")) {
        const match = /@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/.exec(line);
        if (match) {
          const oldStart = parseInt(match[1], 10) - 1;
          
          i++;
          const hunkOld: string[] = [];
          const hunkNew: string[] = [];
          
          while (
            i < patchLines.length &&
            !patchLines[i].startsWith("@@") &&
            !patchLines[i].startsWith("diff") &&
            !patchLines[i].startsWith("---") &&
            !patchLines[i].startsWith("+++")
          ) {
            const hLine = patchLines[i];
            if (hLine.startsWith("-")) {
              hunkOld.push(hLine.slice(1));
            } else if (hLine.startsWith("+")) {
              hunkNew.push(hLine.slice(1));
            } else if (hLine.startsWith(" ")) {
              hunkOld.push(hLine.slice(1));
              hunkNew.push(hLine.slice(1));
            } else {
              hunkOld.push(hLine);
              hunkNew.push(hLine);
            }
            i++;
          }
          
          let foundIdx = -1;
          const radius = 100;
          const searchStart = Math.max(0, oldStart - radius);
          const searchEnd = Math.min(lines.length - hunkOld.length + 1, oldStart + radius);
          
          for (let j = oldStart; j >= searchStart; j--) {
            if (matchAt(lines, j, hunkOld)) {
              foundIdx = j;
              break;
            }
          }
          if (foundIdx === -1) {
            for (let j = oldStart + 1; j < searchEnd; j++) {
              if (matchAt(lines, j, hunkOld)) {
                foundIdx = j;
                break;
              }
            }
          }
          
          if (foundIdx === -1) {
            return { result: content, error: `Could not find matching lines for patch hunk around line ${oldStart + 1}` };
          }
          
          lines.splice(foundIdx, hunkOld.length, ...hunkNew);
          continue;
        }
      }
      i++;
    }
    content = lines.join(originalEnding);
  } else {
    const lines = patchContent.split(/\r?\n/);
    let targetLines: string[] = [];
    let replacementLines: string[] = [];
    let mode: "search" | "replace" | "idle" = "idle";

    for (const line of lines) {
      if (line.startsWith("<<<<<<<")) {
        mode = "search";
        targetLines = [];
      } else if (line.startsWith("=======")) {
        mode = "replace";
        replacementLines = [];
      } else if (line.startsWith(">>>>>>>")) {
        mode = "idle";
        const oldStr = targetLines.join(originalEnding);
        const newStr = replacementLines.join(originalEnding);
        const normContent = normalizeForMatching(content);
        const normOldStr = normalizeForMatching(oldStr);
        if (normContent.includes(normOldStr)) {
          const matchIndexInNorm = normContent.indexOf(normOldStr);
          
          const normToOrigMap = mapNormToOrigIndices(content, normContent);
          const matchOrigStart = normToOrigMap[matchIndexInNorm] ?? -1;
          const matchOrigEnd = normToOrigMap[matchIndexInNorm + normOldStr.length] ?? -1;
          
          if (matchOrigStart !== -1 && matchOrigEnd !== -1) {
            content = content.slice(0, matchOrigStart) + newStr + content.slice(matchOrigEnd);
          } else {
            content = content.replace(oldStr, newStr);
          }
        } else {
          return { result: content, error: `Patch search block not found in target file: ${filePath}` };
        }
      } else {
        if (mode === "search") {
          targetLines.push(line);
        } else if (mode === "replace") {
          replacementLines.push(line);
        }
      }
    }
  }

  return { result: content };
}

export const applyPatchTool: Tool = {
  name: "apply_patch",
  description: "Apply a unified diff or patch pattern to modify a file. PREFER 'patches' array to batch patches across multiple files in ONE call.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to patch (optional if patches is provided)",
      },
      patchContent: {
        type: "string",
        description: "Unified diff or search-replace format block (optional if patches is provided)",
      },
      patches: {
        type: "array",
        description: "List of patches to apply across multiple files in bulk.",
        items: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Path to the file to patch",
            },
            patchContent: {
              type: "string",
              description: "Unified diff or search-replace format block",
            },
          },
          required: ["filePath", "patchContent"],
        },
      },
    },
  },
  async execute(args, cwd, signal) {
    const patches = args.patches as Array<{ filePath: string; patchContent: string }> | undefined;
    if (patches && Array.isArray(patches)) {
      if (patches.length === 0) {
        return "Error: 'patches' parameter is empty.";
      }
      const sortedPatches = patches.map(p => {
        const resolved = normalizePath(path.resolve(cwd, p.filePath));
        return { ...p, resolvedPath: resolved };
      }).sort((a, b) => a.resolvedPath.localeCompare(b.resolvedPath));

      const releases: (() => void)[] = [];
      const results: string[] = [];
      try {
        const uniquePaths = Array.from(new Set(sortedPatches.map(p => p.resolvedPath))).sort();
        for (const p of uniquePaths) {
          releases.push(await fileLockManager.acquire(p));
        }

        for (const patch of sortedPatches) {
          try {
            const originalContent = await fs.readFile(patch.resolvedPath, "utf-8");
            const { result: content, error } = await applyPatchToContent(originalContent, patch.patchContent, patch.resolvedPath);
            if (error) {
              results.push(`Error patching ${patch.filePath}: ${error}`);
              continue;
            }
            const summary = buildEditSummary(originalContent, content, patch.resolvedPath);
            if (originalContent === content) {
              results.push(summary);
              continue;
            }
            await fs.writeFile(patch.resolvedPath, content, "utf-8");
            const syntaxError = await verifySyntax(patch.resolvedPath);
            if (syntaxError) {
              results.push(`Warning: ${syntaxError}. Applied patch to: ${patch.filePath}\n${summary}`);
            } else {
              results.push(`Patch applied: ${patch.filePath}\n${summary}`);
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            results.push(`Error patching ${patch.filePath}: ${message}`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error in bulk patching: ${message}`;
      } finally {
        for (const release of releases.reverse()) {
          release();
        }
      }
      return results.join("\n\n");
    }

    const filePath = resolveFilePathFromArgs(args, cwd);
    if (!filePath) {
      return "Error: Missing required parameter 'filePath' or 'patches'. Provide the path to the file to patch.";
    }
    const patchContent = args.patchContent as string;
    const release = await fileLockManager.acquire(filePath);
    try {
      const originalContent = await fs.readFile(filePath, "utf-8");
      const { result: content, error } = await applyPatchToContent(originalContent, patchContent, filePath);
      if (error) {
        return `Error: ${error}`;
      }

      const summary = buildEditSummary(originalContent, content, filePath);
      if (originalContent === content) {
        return summary;
      }
      await fs.writeFile(filePath, content, "utf-8");
      const syntaxError = await verifySyntax(filePath);
      if (syntaxError) {
        return `Warning: ${syntaxError}. Applied patch to file: ${filePath}\n${summary}`;
      }
      return `Patch applied successfully to ${filePath}\n${summary}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error applying patch: ${message}`;
    } finally {
      release();
    }
  },
};

