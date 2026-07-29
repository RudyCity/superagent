import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import fg from "fast-glob";
import { execa } from "execa";
import { Tool } from "./types.js";
import { normalizePath, resolveFilePathFromArgs, getImageMimeType } from "./pathHelpers.js";
import { getLocalRgPath, isRgInstalledGlobally, ensureRgInstalled } from "../androidSetup.js";
import { getWorkspaceCachePath } from "../workspaceDiscovery.js";
import { workspaceMode } from "../ssh/workspaceMode.js";
import { sshReadToolExecute, sshGlobToolExecute, sshGrepToolExecute } from "../ssh/sshCommands.js";

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
    const offset = Math.max(1, (args.offset as number) || 1);
    const limit = (args.limit as number) || 800;
    if (workspaceMode.isSsh()) {
      const targets = args.filePaths || args.filePath;
      if (!targets) return "Error: Missing filePath or filePaths";
      return await sshReadToolExecute(targets as any, offset, limit);
    }
    const filePaths = args.filePaths as any[] | undefined;

    if (filePaths && Array.isArray(filePaths)) {
      if (filePaths.length === 0) {
        return "Error: 'filePaths' parameter is empty.";
      }
      for (const entry of filePaths) {
        const raw = typeof entry === "string" ? entry : entry?.path;
        try {
          resolveFilePathFromArgs({ filePath: raw }, cwd);
        } catch (boundaryErr: any) {
          return `Error: ${boundaryErr.message}`;
        }
      }
      const results: string[] = [];
      for (const entry of filePaths) {
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

          const ext = path.extname(filePath).toLowerCase();
          const mimeType = getImageMimeType(ext);
          if (mimeType) {
            const base64Data = buffer.toString("base64");
            results.push(`--- File: ${rawPath} ---\ndata:${mimeType};base64,${base64Data}`);
            continue;
          }

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

    let filePath: string;
    try {
      const resolved = resolveFilePathFromArgs(args, cwd);
      if (!resolved) {
        return "Error: Missing required parameter 'filePath' or 'filePaths'. Provide the path to the file to read.";
      }
      filePath = resolved;
    } catch (boundaryErr: any) {
      return `Error: ${boundaryErr.message}`;
    }

    try {
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

      const ext = path.extname(filePath).toLowerCase();
      const mimeType = getImageMimeType(ext);
      if (mimeType) {
        const base64Data = buffer.toString("base64");
        return `data:${mimeType};base64,${base64Data}`;
      }

      const checkLimit = Math.min(buffer.length, 1024);
      let isBinary = false;
      for (let i = 0; i < checkLimit; i++) {
        if (buffer[i] === 0) {
          isBinary = true;
          break;
        }
      }
      if (isBinary) {
        return "Error: Cannot read binary file";
      }

      const content = buffer.toString("utf-8");
      const lines = content.replace(/\r\n/g, "\n").split("\n");
      const sliced = lines.slice(offset - 1, offset - 1 + limit);
      const output = sliced.map((line, i) => `${offset + i}: ${line}`).join("\n");
      if (lines.length > offset - 1 + limit) {
        const remaining = lines.length - (offset - 1 + limit);
        return `${output}\n... (output truncated, showing ${limit} of ${lines.length} lines. There are ${remaining} more lines)`;
      }
      return output;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error reading file: ${message}`;
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
    if (workspaceMode.isSsh()) {
      return await sshGlobToolExecute(args.pattern as string, signal);
    }
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
            files = cache.fileList.filter((file: string) => isMatch(file));
          }
        }
      } catch (cacheErr) {
        // Fallback to disk
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
    if (workspaceMode.isSsh()) {
      return await sshGrepToolExecute(args.pattern as string, args.include as string | undefined, signal);
    }
    const pattern = args.pattern as string;
    const include = (args.include as string) || "*";
    const searchPath = args.path
      ? path.resolve(cwd, args.path as string)
      : cwd;

    try {
      new RegExp(pattern, "gi");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: ${message}`;
    }

    try {
      let files: string[] | null = null;

      const isSearchPathFile = fsSync.existsSync(searchPath) && fsSync.statSync(searchPath).isFile();
      if (isSearchPathFile) {
        files = [searchPath];
      } else {
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
      }

      const results: string[] = [];
      const slicedFiles = files.slice(0, 500);

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
                  const relPath = isSearchPathFile
                    ? path.basename(file)
                    : path.relative(searchPath, file).replace(/\\/g, "/");
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
    if (workspaceMode.isSsh()) {
      return await sshGrepToolExecute(args.pattern as string, undefined, signal);
    }
    const pattern = args.pattern as string;
    const rawPath = args.path as string | undefined;
    const searchPath = rawPath ? path.resolve(cwd, rawPath) : cwd;

    if (rawPath && /\s/.test(rawPath) && !fsSync.existsSync(searchPath)) {
      return `Error: Search path "${rawPath}" does not exist. Pass one path per ripgrep_search call; do not combine paths like "src tests".`;
    }

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
