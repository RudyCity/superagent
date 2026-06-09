import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import fg from "fast-glob";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, cwd: string, signal?: AbortSignal) => Promise<string>;
}

const readTool: Tool = {
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

const writeTool: Tool = {
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

const editTool: Tool = {
  name: "edit",
  description:
    "Edit a file by replacing an exact string match. Use read first to see content.",
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

      let updated: string;
      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split("\n");
        const startIdx = startLine !== undefined ? startLine - 1 : 0;
        const endIdx = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;

        const targetSubContent = lines.slice(startIdx, endIdx).join("\n");
        if (!targetSubContent.includes(oldStr)) {
          return `Error: oldString not found within lines ${startLine || 1} to ${endLine || lines.length} of ${filePath}`;
        }
        const count = targetSubContent.split(oldStr).length - 1;
        if (count > 1) {
          return `Error: Found ${count} matches for oldString in the specified line range. Provide more context or a narrower range.`;
        }

        const replacedSubContent = targetSubContent.replace(oldStr, newStr);
        const beforeLines = lines.slice(0, startIdx);
        const afterLines = lines.slice(endIdx);
        
        const joinedParts = [];
        if (beforeLines.length > 0) {
          joinedParts.push(beforeLines.join("\n"));
        }
        joinedParts.push(replacedSubContent);
        if (afterLines.length > 0) {
          joinedParts.push(afterLines.join("\n"));
        }
        updated = joinedParts.join("\n");
      } else {
        if (!content.includes(oldStr)) {
          return `Error: oldString not found in ${filePath}`;
        }

        const count = content.split(oldStr).length - 1;
        if (count > 1) {
          return `Error: Found ${count} matches for oldString. Provide more context to make it unique, or specify startLine/endLine.`;
        }

        updated = content.replace(oldStr, newStr);
      }

      await fs.writeFile(filePath, updated, "utf-8");
      return `File edited: ${filePath}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error editing file: ${message}`;
    }
  },
};

const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a shell command. Use for git, npm, build tools, etc. Returns stdout+stderr.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in ms (default 120000)",
      },
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    let command = args.command as string;
    const timeout = (args.timeout as number) || 120000;
    const isWin = process.platform === "win32";
    if (isWin) {
      command = command.replace(/&&/g, ";");
    }

    try {
      const result = await execa(command, {
        shell: isWin ? "powershell.exe" : true,
        cwd,
        timeout,
        reject: false,
        all: true,
        cancelSignal: signal,
      });
      const output = (result.all || result.stdout || "").trim();
      if (result.exitCode !== 0) {
        return `Exit code: ${result.exitCode}\n${output}`;
      }
      return output || "(no output)";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: ${message}`;
    }
  },
};

const globTool: Tool = {
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

const grepTool: Tool = {
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

const webSearchTool: Tool = {
  name: "web_search",
  description: "Search the web using DuckDuckGo HTML search.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
    },
    required: ["query"],
  },
  async execute(args, cwd, signal) {
    const query = args.query as string;
    try {
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal,
      });
      if (!response.ok) {
        return `Search failed with status ${response.status}`;
      }
      const html = await response.text();
      const results: string[] = [];
      const resultBlockRegex = /<div class="result[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g;
      let match;
      let count = 0;
      while ((match = resultBlockRegex.exec(html)) !== null && count < 5) {
        const block = match[1];
        const titleMatch = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block) || /<a class="result__url"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        const snippetMatch = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block) || /<div class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
        const urlMatch = /<a class="result__url"[^>]*href="([^"]*)"/i.exec(block) || /<a class="result__snippet"[^>]*href="([^"]*)"/i.exec(block);

        let title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, "").trim() : "";
        let snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim() : "";
        let url = urlMatch ? urlMatch[1] : "";

        if (url.startsWith("//")) {
          url = "https:" + url;
        }
        if (url.includes("uddg=")) {
          const matchUddg = /uddg=([^&]+)/.exec(url);
          if (matchUddg) {
            url = decodeURIComponent(matchUddg[1]);
          }
        }

        if (title || snippet) {
          results.push(`Title: ${title}\nURL: ${url}\nSnippet: ${snippet}`);
          count++;
        }
      }

      if (results.length === 0) {
        const linkRegex = /<a href="([^"]+)"[^>]*class="result__url"[^>]*>([^<]+)<\/a>/g;
        while ((match = linkRegex.exec(html)) !== null && count < 5) {
          let url = match[1];
          if (url.includes("uddg=")) {
            const matchUddg = /uddg=([^&]+)/.exec(url);
            if (matchUddg) url = decodeURIComponent(matchUddg[1]);
          }
          results.push(`URL: ${url}`);
          count++;
        }
      }

      return results.length > 0 ? results.join("\n\n") : "No results found.";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Search error: ${message}`;
    }
  },
};

const fetchUrlTool: Tool = {
  name: "fetch_url",
  description: "Fetch content from a URL and return a clean text representation.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch",
      },
    },
    required: ["url"],
  },
  async execute(args, cwd, signal) {
    const url = args.url as string;
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal,
      });
      if (!response.ok) {
        return `Failed to fetch URL. Status: ${response.status}`;
      }
      const rawHtml = await response.text();
      let clean = rawHtml
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (clean.length > 8000) {
        clean = clean.slice(0, 8000) + "\n\n... (content truncated)";
      }

      return clean || "(empty content)";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Fetch error: ${message}`;
    }
  },
};

const ripgrepSearchTool: Tool = {
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

    try {
      const result = await execa(
        "rg",
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

interface BackgroundTask {
  id: string;
  command: string;
  process: any;
  output: string[];
}

export const backgroundTasks = new Map<string, BackgroundTask>();

const runBackgroundTool: Tool = {
  name: "run_background",
  description: "Run a shell command in the background. Returns a task ID.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run in the background",
      },
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    let command = args.command as string;
    const isWin = process.platform === "win32";
    if (isWin) {
      command = command.replace(/&&/g, ";");
    }
    const taskId = Math.random().toString(36).substring(2, 9);

    try {
      const proc = execa(command, {
        shell: isWin ? "powershell.exe" : true,
        cwd,
        reject: false,
        all: true,
      });

      const task: BackgroundTask = {
        id: taskId,
        command,
        process: proc,
        output: [],
      };

      backgroundTasks.set(taskId, task);

      proc.all?.on("data", (data) => {
        const text = data.toString();
        task.output.push(text);
        if (task.output.length > 1000) {
          task.output.shift();
        }
      });

      proc.on("close", (code) => {
        task.output.push(`\n[Process exited with code ${code}]`);
      });

      return `Started task in background. Task ID: ${taskId}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Failed to start background task: ${message}`;
    }
  },
};

const killTaskTool: Tool = {
  name: "kill_task",
  description: "Terminate a background task by ID.",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The Task ID returned by run_background",
      },
    },
    required: ["taskId"],
  },
  async execute(args, cwd, signal) {
    const taskId = args.taskId as string;
    const task = backgroundTasks.get(taskId);
    if (!task) {
      return `Error: No task found with ID "${taskId}"`;
    }

    try {
      task.process.kill();
      backgroundTasks.delete(taskId);
      return `Task "${taskId}" has been killed successfully.`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error killing task: ${message}`;
    }
  },
};

const viewBackgroundTasksTool: Tool = {
  name: "view_background_tasks",
  description: "List running background tasks and show their recent output logs.",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Optional Task ID to view detailed output for. If omitted, lists all tasks.",
      },
    },
  },
  async execute(args, cwd, signal) {
    const taskId = args.taskId as string;
    if (taskId) {
      const task = backgroundTasks.get(taskId);
      if (!task) return `No task found with ID "${taskId}"`;
      return `Task: ${task.command}\nStatus: ${task.process.killed ? "Killed" : "Running/Completed"}\nOutput:\n${task.output.join("")}`;
    }

    if (backgroundTasks.size === 0) return "No active background tasks.";
    const lines: string[] = [];
    for (const [id, task] of backgroundTasks.entries()) {
      lines.push(`Task ID: ${id} | Command: ${task.command}`);
    }
    return lines.join("\n");
  },
};

const writeToFileTool: Tool = {
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

const replaceFileContentTool: Tool = {
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
      const lines = content.split("\n");
      
      if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
        return `Error: Invalid line range [${startLine}, ${endLine}]. File has ${lines.length} lines.`;
      }

      const sliceOfLines = lines.slice(startLine - 1, endLine);
      const sliceText = sliceOfLines.join("\n");

      if (!sliceText.includes(targetContent)) {
        return `Error: targetContent not found in specified line range [${startLine}, ${endLine}].`;
      }

      const replacedSlice = sliceText.replace(targetContent, replacementContent);
      const newLines = [
        ...lines.slice(0, startLine - 1),
        replacedSlice,
        ...lines.slice(endLine),
      ];

      await fs.writeFile(filePath, newLines.join("\n"), "utf-8");
      return `File updated successfully: ${filePath}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error replacing file content: ${message}`;
    }
  },
};

const multiReplaceFileContentTool: Tool = {
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

const runCommandTool: Tool = {
  name: "run_command",
  description: "Run a terminal command (PowerShell on Windows, default shell on other OS).",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run",
      },
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    let command = args.command as string;
    const isWin = process.platform === "win32";
    if (isWin) {
      command = command.replace(/&&/g, ";");
    }
    const shell = isWin ? "powershell.exe" : true;
    try {
      const result = await execa(command, {
        shell,
        cwd,
        reject: false,
        all: true,
        cancelSignal: signal,
      });
      return (result.all || result.stdout || "").trim() || "(no output)";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error executing command: ${message}`;
    }
  },
};

const manageTaskTool: Tool = {
  name: "manage_task",
  description: "Manage background tasks: list them, check status/output, send input, or kill them.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "status", "send_input", "kill"],
        description: "Action to perform",
      },
      taskId: {
        type: "string",
        description: "The background task ID",
      },
      input: {
        type: "string",
        description: "The input string to send (required for send_input)",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    const taskId = args.taskId as string;
    const input = args.input as string;

    if (action === "list") {
      if (backgroundTasks.size === 0) return "No active background tasks.";
      const lines: string[] = [];
      for (const [id, task] of backgroundTasks.entries()) {
        lines.push(`Task ID: ${id} | Command: ${task.command}`);
      }
      return lines.join("\n");
    }

    if (!taskId) {
      return "Error: taskId is required for status, send_input, and kill actions.";
    }

    const task = backgroundTasks.get(taskId);
    if (!task) {
      return `Error: No task found with ID "${taskId}"`;
    }

    if (action === "status") {
      return `Task: ${task.command}\nStatus: ${task.process.killed ? "Killed" : "Running/Completed"}\nOutput:\n${task.output.join("")}`;
    }

    if (action === "send_input") {
      if (input === undefined) {
        return "Error: input is required for send_input action.";
      }
      try {
        task.process.stdin?.write(input + "\n");
        return `Sent input to task "${taskId}".`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error sending input: ${message}`;
      }
    }

    if (action === "kill") {
      try {
        task.process.kill();
        backgroundTasks.delete(taskId);
        return `Task "${taskId}" has been killed successfully.`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error killing task: ${message}`;
      }
    }

    return `Error: Unknown action "${action}"`;
  },
};

interface ScheduleJob {
  id: string;
  prompt: string;
  timer?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
}
const scheduledJobs = new Map<string, ScheduleJob>();

const scheduleTool: Tool = {
  name: "schedule",
  description: "Schedule a one-shot timer or recurring notification in the background.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The message prompt to display when triggered",
      },
      durationSeconds: {
        type: "number",
        description: "Wait duration in seconds before triggering (for one-shot)",
      },
      cronExpression: {
        type: "string",
        description: "Simple interval (e.g. '5m' for 5 minutes, '1h' for 1 hour) for recurring checks",
      },
    },
    required: ["prompt"],
  },
  async execute(args, cwd, signal) {
    const prompt = args.prompt as string;
    const durationSeconds = args.durationSeconds as number;
    const cronExpression = args.cronExpression as string;
    const jobId = Math.random().toString(36).substring(2, 9);

    if (!durationSeconds && !cronExpression) {
      return "Error: Either durationSeconds or cronExpression must be provided.";
    }

    const job: ScheduleJob = { id: jobId, prompt };

    if (durationSeconds) {
      const ms = durationSeconds * 1000;
      job.timer = setTimeout(() => {
        console.log(`\n[Schedule Triggered (ID: ${jobId})]: ${prompt}`);
        scheduledJobs.delete(jobId);
      }, ms);
      scheduledJobs.set(jobId, job);
      return `One-shot timer scheduled with ID: ${jobId} (triggers in ${durationSeconds} seconds)`;
    }

    if (cronExpression) {
      const match = cronExpression.match(/^(\d+)([smh])$/);
      if (!match) {
        return "Error: cronExpression must be a simple interval like '10s', '5m', or '2h'.";
      }
      const val = parseInt(match[1], 10);
      const unit = match[2];
      let ms = val * 1000;
      if (unit === "m") ms *= 60;
      if (unit === "h") ms *= 3600;

      job.interval = setInterval(() => {
        console.log(`\n[Recurring Schedule Triggered (ID: ${jobId})]: ${prompt}`);
      }, ms);
      scheduledJobs.set(jobId, job);
      return `Recurring schedule configured with ID: ${jobId} (triggers every ${cronExpression})`;
    }

    return "Error scheduling job.";
  },
};

interface SubagentType {
  name: string;
  description: string;
  systemPrompt: string;
}

interface SubagentInstance {
  id: string;
  typeName: string;
  role: string;
  agent: any;
  status: "idle" | "running" | "completed";
  logs: string[];
}

const subagentTypes = new Map<string, SubagentType>();
const subagentInstances = new Map<string, SubagentInstance>();

export function registerSubagentType(name: string, description: string, systemPrompt: string) {
  subagentTypes.set(name, { name, description, systemPrompt });
}

const defineSubagentTool: Tool = {
  name: "define_subagent",
  description: "Define a new subagent type with a specialized role and system prompt.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Unique type name of the subagent",
      },
      description: {
        type: "string",
        description: "A description of what this subagent specializes in",
      },
      systemPrompt: {
        type: "string",
        description: "The system prompt defining the subagent's rules and role",
      },
    },
    required: ["name", "description", "systemPrompt"],
  },
  async execute(args, cwd, signal) {
    const name = args.name as string;
    const description = args.description as string;
    const systemPrompt = args.systemPrompt as string;

    subagentTypes.set(name, { name, description, systemPrompt });
    return `Subagent type "${name}" defined successfully.`;
  },
};

const invokeSubagentTool: Tool = {
  name: "invoke_subagent",
  description: "Invoke an instance of a defined subagent to run a background task.",
  parameters: {
    type: "object",
    properties: {
      typeName: {
        type: "string",
        description: "The name of the defined subagent type to invoke",
      },
      role: {
        type: "string",
        description: "Role / job title of this subagent instance",
      },
      prompt: {
        type: "string",
        description: "The initial instruction or prompt for the subagent",
      },
    },
    required: ["typeName", "role", "prompt"],
  },
  async execute(args, cwd, signal) {
    const typeName = args.typeName as string;
    const role = args.role as string;
    const prompt = args.prompt as string;

    const subType = subagentTypes.get(typeName);
    if (!subType) {
      return `Error: Subagent type "${typeName}" is not defined. Use define_subagent first.`;
    }

    const { Agent } = await import("./agent.js");
    const subagentId = Math.random().toString(36).substring(2, 9);

    const logs: string[] = [];

    const agentInstance = new Agent(
      (event) => {
        if (event.type === "text") {
          logs.push(event.content);
        } else if (event.type === "error") {
          logs.push(`\nError: ${event.message}\n`);
        } else if (event.type === "tool_start") {
          logs.push(`\n⚡ Tool started: ${event.description}\n`);
        } else if (event.type === "tool_end") {
          logs.push(`\n✓ Tool ended: ${event.description}\n`);
        }
      },
      async (toolCall, desc) => {
        return true;
      }
    );

    const instance: SubagentInstance = {
      id: subagentId,
      typeName,
      role,
      agent: agentInstance,
      status: "running",
      logs,
    };

    subagentInstances.set(subagentId, instance);

    agentInstance.sendMessage(prompt).then(() => {
      instance.status = "completed";
    }).catch(() => {
      instance.status = "completed";
    });

    return `Invoked subagent "${typeName}" (Role: ${role}) in background. Conversation ID: ${subagentId}`;
  },
};

const sendMessageTool: Tool = {
  name: "send_message",
  description: "Send a follow-up message to an active subagent.",
  parameters: {
    type: "object",
    properties: {
      recipientId: {
        type: "string",
        description: "The conversation ID of the subagent",
      },
      message: {
        type: "string",
        description: "The follow-up message to send",
      },
    },
    required: ["recipientId", "message"],
  },
  async execute(args, cwd, signal) {
    const recipientId = args.recipientId as string;
    const message = args.message as string;

    const instance = subagentInstances.get(recipientId);
    if (!instance) {
      return `Error: Subagent instance "${recipientId}" not found.`;
    }

    instance.status = "running";
    instance.agent.sendMessage(message).then(() => {
      instance.status = "completed";
    }).catch(() => {
      instance.status = "completed";
    });

    return `Message sent to subagent "${recipientId}". Subagent is processing.`;
  },
};

const manageSubagentsTool: Tool = {
  name: "manage_subagents",
  description: "List subagent types/instances, check logs, or terminate them.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "logs", "kill", "kill_all"],
        description: "Action to perform",
      },
      conversationIds: {
        type: "array",
        items: { type: "string" },
        description: "List of conversation IDs to kill or read logs from",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    const conversationIds = args.conversationIds as string[];

    if (action === "list") {
      const lines: string[] = ["Defined Subagent Types:"];
      if (subagentTypes.size === 0) lines.push("  None");
      for (const [name, t] of subagentTypes.entries()) {
        lines.push(`  - ${name}: ${t.description}`);
      }
      lines.push("\nActive Subagent Instances:");
      if (subagentInstances.size === 0) lines.push("  None");
      for (const [id, inst] of subagentInstances.entries()) {
        lines.push(`  - ID: ${id} | Type: ${inst.typeName} | Role: ${inst.role} | Status: ${inst.status}`);
      }
      return lines.join("\n");
    }

    if (action === "logs") {
      if (!conversationIds || conversationIds.length === 0) {
        return "Error: conversationIds is required to retrieve logs.";
      }
      const id = conversationIds[0];
      const inst = subagentInstances.get(id);
      if (!inst) {
        return `Error: Subagent instance "${id}" not found.`;
      }
      return `Logs for Subagent ${id} (${inst.role}):\n${inst.logs.join("") || "(no logs yet)"}`;
    }

    if (action === "kill") {
      if (!conversationIds || conversationIds.length === 0) {
        return "Error: conversationIds is required for kill action.";
      }
      for (const id of conversationIds) {
        const inst = subagentInstances.get(id);
        if (inst) {
          inst.agent.abort();
          subagentInstances.delete(id);
        }
      }
      return `Terminated subagents: ${conversationIds.join(", ")}`;
    }

    if (action === "kill_all") {
      for (const [id, inst] of subagentInstances.entries()) {
        inst.agent.abort();
      }
      subagentInstances.clear();
      return "All subagent instances terminated.";
    }

    return `Error: Unknown action "${action}"`;
  },
};

export const allTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  webSearchTool,
  fetchUrlTool,
  ripgrepSearchTool,
  runBackgroundTool,
  killTaskTool,
  viewBackgroundTasksTool,
  writeToFileTool,
  replaceFileContentTool,
  multiReplaceFileContentTool,
  runCommandTool,
  manageTaskTool,
  scheduleTool,
  defineSubagentTool,
  invokeSubagentTool,
  sendMessageTool,
  manageSubagentsTool,
];

export function getToolByName(name: string): Tool | undefined {
  return allTools.find((t) => t.name === name);
}

export function getToolDefinitions(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return allTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
