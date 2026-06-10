import fs from "fs/promises";
import path from "path";
import fg from "fast-glob";
import { execa } from "execa";
import { Tool } from "./types.js";
import { normalizeForMatching, verifySyntax } from "./helpers.js";
import { getLocalRgPath, isRgInstalledGlobally, ensureRgInstalled } from "../androidSetup.js";

export const readTool: Tool = {
  name: "read",
  description: "Read file contents. Returns lines with line numbers.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute or relative path to the file",
      },
      offset: {
        type: "number",
        description: "Line number to start from (1-indexed)",
      },
      limit: {
        type: "number",
        description: "Max lines to read (default 2000)",
      },
    },
    required: ["filePath"],
  },
  async execute(args, cwd, signal) {
    const filePath = path.resolve(cwd, args.filePath as string);
    const offset = Math.max(1, (args.offset as number) || 1);
    const limit = (args.limit as number) || 2000;

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const sliced = lines.slice(offset - 1, offset - 1 + limit);
      return sliced.map((line, i) => `${offset + i}: ${line}`).join("\n");
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
    const filePath = path.resolve(cwd, args.filePath as string);
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, args.content as string, "utf-8");
      return `File written: ${filePath}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error writing file: ${message}`;
    }
  },
};

export const editTool: Tool = {
  name: "edit",
  description:
    "Edit a file by replacing an exact string match (CRLF/LF and trailing whitespace tolerant). Use read first to see content.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file",
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
  async execute(args, cwd, signal) {
    const filePath = path.resolve(cwd, args.filePath as string);
    try {
      const content = await fs.readFile(filePath, "utf-8");
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
        
        const sliceText = lines.slice(startIdx, endIdx).join("\n");
        const normSliceText = normalizeForMatching(sliceText);
        const matchIdx = normSliceText.indexOf(normOldStr);
        
        let normCharIdx = 0;
        let origCharIdx = 0;
        let matchOrigStart = -1;
        let matchOrigEnd = -1;

        while (origCharIdx < content.length && normCharIdx < normContent.length) {
          if (normCharIdx === matchIndexInNorm) {
            matchOrigStart = origCharIdx;
          }
          if (normCharIdx === matchIndexInNorm + normOldStr.length) {
            matchOrigEnd = origCharIdx;
            break;
          }
          const cOrig = content[origCharIdx];
          const cNorm = normContent[normCharIdx];
          
          if (cOrig === "\r") {
            origCharIdx++;
            continue;
          }
          origCharIdx++;
          normCharIdx++;
        }

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
        let normCharIdx = 0;
        let origCharIdx = 0;
        let matchOrigStart = -1;
        let matchOrigEnd = -1;

        while (origCharIdx < content.length && normCharIdx < normContent.length) {
          if (normCharIdx === matchIndexInNorm) {
            matchOrigStart = origCharIdx;
          }
          if (normCharIdx === matchIndexInNorm + normOldStr.length) {
            matchOrigEnd = origCharIdx;
            break;
          }
          const cOrig = content[origCharIdx];
          
          if (cOrig === "\r") {
            origCharIdx++;
            continue;
          }
          origCharIdx++;
          normCharIdx++;
        }

        if (matchOrigStart === -1 || matchOrigEnd === -1) {
          updated = content.replace(oldStr, newStr);
        } else {
          updated = content.slice(0, matchOrigStart) + newStr + content.slice(matchOrigEnd);
        }
      }

      await fs.writeFile(filePath, updated, "utf-8");
      
      const syntaxError = await verifySyntax(filePath);
      if (syntaxError) {
        return `Warning: ${syntaxError}. Changes applied to file: ${filePath}`;
      }

      return `File edited: ${filePath}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error editing file: ${message}`;
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
    },
    required: ["pattern"],
  },
  async execute(args, cwd, signal) {
    const pattern = args.pattern as string;
    const searchPath = args.path
      ? path.resolve(cwd, args.path as string)
      : cwd;

    try {
      const files = await fg(pattern, {
        cwd: searchPath,
        absolute: false,
        onlyFiles: true,
      });
      if (files.length === 0) return "No files found.";
      return files.join("\n");
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
      const files = await fg(`**/${include}`, {
        cwd: searchPath,
        absolute: true,
        onlyFiles: true,
        ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      });

      const results: string[] = [];
      const regex = new RegExp(pattern, "gi");

      for (const file of files.slice(0, 500)) {
        try {
          const content = await fs.readFile(file, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              const relPath = path.relative(searchPath, file);
              results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
            }
            regex.lastIndex = 0;
          }
        } catch {
          // skip unreadable files
        }
      }

      return results.length > 0
        ? results.slice(0, 100).join("\n")
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
  description: "Create a new file or overwrite an existing file's content entirely.",
  parameters: {
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
  async execute(args, cwd, signal) {
    const filePath = path.resolve(cwd, args.filePath as string);
    const overwrite = !!args.overwrite;
    try {
      if (!overwrite) {
        try {
          await fs.access(filePath);
          return `Error: File already exists and overwrite was set to false.`;
        } catch {
          // File does not exist, safe to write
        }
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, args.content as string, "utf-8");
      return `File written successfully: ${filePath}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error writing file: ${message}`;
    }
  },
};

export const replaceFileContentTool: Tool = {
  name: "replace_file_content",
  description: "Edit a single contiguous block of code in a file by specifying line ranges and target content.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to edit",
      },
      targetContent: {
        type: "string",
        description: "The exact target content to replace (including whitespace)",
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
    },
    required: ["filePath", "targetContent", "replacementContent", "startLine", "endLine"],
  },
  async execute(args, cwd, signal) {
    const filePath = path.resolve(cwd, args.filePath as string);
    const targetContent = args.targetContent as string;
    const replacementContent = args.replacementContent as string;
    const startLine = args.startLine as number;
    const endLine = args.endLine as number;

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

      const matchIndexInNorm = normSliceText.indexOf(normTargetContent);
      let normCharIdx = 0;
      let origCharIdx = 0;
      let matchOrigStart = -1;
      let matchOrigEnd = -1;

      while (origCharIdx < sliceText.length && normCharIdx < normSliceText.length) {
        if (normCharIdx === matchIndexInNorm) {
          matchOrigStart = origCharIdx;
        }
        if (normCharIdx === matchIndexInNorm + normTargetContent.length) {
          matchOrigEnd = origCharIdx;
          break;
        }
        const cOrig = sliceText[origCharIdx];
        if (cOrig === "\r") {
          origCharIdx++;
          continue;
        }
        origCharIdx++;
        normCharIdx++;
      }

      let replacedSlice: string;
      if (matchOrigStart === -1 || matchOrigEnd === -1) {
        replacedSlice = sliceText.replace(targetContent, replacementContent);
      } else {
        replacedSlice = sliceText.slice(0, matchOrigStart) + replacementContent + sliceText.slice(matchOrigEnd);
      }

      const newLines = [
        ...lines.slice(0, startLine - 1),
        replacedSlice,
        ...lines.slice(endLine),
      ];

      const originalEnding = content.includes("\r\n") ? "\r\n" : "\n";
      await fs.writeFile(filePath, newLines.join(originalEnding), "utf-8");

      const syntaxError = await verifySyntax(filePath);
      if (syntaxError) {
        return `Warning: ${syntaxError}. File updated: ${filePath}`;
      }

      return `File updated successfully: ${filePath}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error replacing file content: ${message}`;
    }
  },
};

export const multiReplaceFileContentTool: Tool = {
  name: "multi_replace_file_content",
  description: "Perform multiple non-contiguous edits across a single file simultaneously.",
  parameters: {
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
          },
          required: ["targetContent", "replacementContent", "startLine", "endLine"],
        },
      },
    },
    required: ["filePath", "chunks"],
  },
  async execute(args, cwd, signal) {
    const filePath = path.resolve(cwd, args.filePath as string);
    interface Chunk {
      targetContent: string;
      replacementContent: string;
      startLine: number;
      endLine: number;
    }
    const chunks = args.chunks as Chunk[];

    if (!Array.isArray(chunks) || chunks.length === 0) {
      return "Error: No chunks provided or invalid format.";
    }

    try {
      let content = await fs.readFile(filePath, "utf-8");
      let lines = content.split("\n");

      const sortedChunks = [...chunks].sort((a, b) => b.startLine - a.startLine);

      for (const chunk of sortedChunks) {
        const { targetContent, replacementContent, startLine, endLine } = chunk;
        if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
          return `Error: Invalid line range [${startLine}, ${endLine}] in chunk. File has ${lines.length} lines.`;
        }

        const sliceOfLines = lines.slice(startLine - 1, endLine);
        const sliceText = sliceOfLines.join("\n");

        if (!sliceText.includes(targetContent)) {
          return `Error: targetContent not found in specified line range [${startLine}, ${endLine}] for a chunk.`;
        }

        const replacedSlice = sliceText.replace(targetContent, replacementContent);
        lines = [
          ...lines.slice(0, startLine - 1),
          replacedSlice,
          ...lines.slice(endLine),
        ];
      }

      await fs.writeFile(filePath, lines.join("\n"), "utf-8");
      return `File updated successfully with ${chunks.length} changes: ${filePath}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error in multi-replace: ${message}`;
    }
  },
};

export const applyPatchTool: Tool = {
  name: "apply_patch",
  description: "Apply a unified diff or patch pattern to modify a file.",
  parameters: {
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
  async execute(args, cwd, signal) {
    const filePath = path.resolve(cwd, args.filePath as string);
    const patchContent = args.patchContent as string;
    try {
      let content = await fs.readFile(filePath, "utf-8");
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
          const oldStr = targetLines.join("\n");
          const newStr = replacementLines.join("\n");
          const normContent = normalizeForMatching(content);
          const normOldStr = normalizeForMatching(oldStr);
          if (normContent.includes(normOldStr)) {
            const matchIndexInNorm = normContent.indexOf(normOldStr);
            let normCharIdx = 0;
            let origCharIdx = 0;
            let matchOrigStart = -1;
            let matchOrigEnd = -1;
            while (origCharIdx < content.length && normCharIdx < normContent.length) {
              if (normCharIdx === matchIndexInNorm) {
                matchOrigStart = origCharIdx;
              }
              if (normCharIdx === matchIndexInNorm + normOldStr.length) {
                matchOrigEnd = origCharIdx;
                break;
              }
              const cOrig = content[origCharIdx];
              if (cOrig === "\r") {
                origCharIdx++;
                continue;
              }
              origCharIdx++;
              normCharIdx++;
            }
            if (matchOrigStart !== -1 && matchOrigEnd !== -1) {
              content = content.slice(0, matchOrigStart) + newStr + content.slice(matchOrigEnd);
            } else {
              content = content.replace(oldStr, newStr);
            }
          } else {
            return `Error: Patch search block not found in target file: ${filePath}`;
          }
        } else {
          if (mode === "search") {
            targetLines.push(line);
          } else if (mode === "replace") {
            replacementLines.push(line);
          }
        }
      }

      await fs.writeFile(filePath, content, "utf-8");
      const syntaxError = await verifySyntax(filePath);
      if (syntaxError) {
        return `Warning: ${syntaxError}. Applied patch to file: ${filePath}`;
      }
      return `Patch applied successfully to ${filePath}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error applying patch: ${message}`;
    }
  },
};
