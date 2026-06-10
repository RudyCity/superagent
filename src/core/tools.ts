import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import fg from "fast-glob";
import { getLocalRgPath, isRgInstalledGlobally, ensureRgInstalled, ensureAndroidCliInstalled } from "./androidSetup.js";

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

// Helper to normalize content for matching by converting CRLF to LF and trimming line spaces
export function normalizeForMatching(str: string): string {
  return str
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n");
}

// Helper to check syntax error in file if typescript or project configurations allow it
async function verifySyntax(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath);
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    try {
      const code = await fs.readFile(filePath, "utf-8");
      // Basic check: matching braces / brackets
      const stack: string[] = [];
      const pairs: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
      for (let i = 0; i < code.length; i++) {
        const c = code[i];
        if (c === "{" || c === "(" || c === "[") {
          stack.push(c);
        } else if (c === "}" || c === ")" || c === "]") {
          if (stack.length === 0 || stack[stack.length - 1] !== pairs[c]) {
            return `Syntax check failed: Unmatched bracket/brace "${c}" near character ${i}`;
          }
          stack.pop();
        }
      }
    } catch {
      // Ignored
    }
  }
  return null;
}

const editTool: Tool = {
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

        // Map normalized coordinates back to actual string
        // To replace accurately in original content: find position in normContent slice, and map start/end
        const subContentStartOffset = normLines.slice(0, startIdx).join("\n").length + (startIdx > 0 ? 1 : 0);
        const matchIndexInNorm = normContent.indexOf(normOldStr, subContentStartOffset);
        
        // Let's do a reliable replacement by joining original lines
        const sliceText = lines.slice(startIdx, endIdx).join("\n");
        const normSliceText = normalizeForMatching(sliceText);
        const matchIdx = normSliceText.indexOf(normOldStr);
        
        // We'll perform a replacement preserving surrounding whitespace of the match area if possible
        // Or simply replace the entire slice line segment by matching the target lines.
        // For absolute robustness, let's substitute the matching range lines directly:
        // We locate the exact characters to replace in the original string using normalized index tracking
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
          // Fallback if index mapping failed
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

// Helper to truncate large output if it exceeds a specified limit (to save tokens)
function truncateOutput(output: string, maxLines = 100): string {
  const lines = output.split(/\r?\n/);
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join("\n") + `\n\n... (output truncated, showing ${maxLines} of ${lines.length} lines)`;
  }
  return output;
}

// Helper to detect if process stdout suggests an interactive input prompt
function detectInteractivePrompt(text: string): string | null {
  const patterns = [
    /\[y\/n\]/i,
    /\(y\/n\)/i,
    /confirm\?/i,
    /proceed\?/i,
    /enter\s+password/i,
    /api\s+key/i,
    /select\s+an\s+option/i
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return `Warning: Interactive prompt detected ("${text.trim().slice(-30)}"). The command may hang. Use run_background and manage_task 'send_input' to interact.`;
    }
  }
  return null;
}

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
        description: "Timeout in ms (default 600000)",
      },
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    let command = args.command as string;
    const timeout = (args.timeout as number) || 600000;
    const isWin = process.platform === "win32";
    if (isWin) {
      command = formatCommandForPowerShell(command);
    }

    try {
      clearActiveToolOutput();
      const proc = execa(command, {
        shell: isWin ? "powershell.exe" : true,
        cwd,
        timeout,
        reject: false,
        all: true,
        cancelSignal: signal,
      });

      let interactiveWarning: string | null = null;
      proc.all?.on("data", (data) => {
        const text = data.toString();
        appendActiveToolOutput(text);
        const warning = detectInteractivePrompt(text);
        if (warning) {
          interactiveWarning = warning;
        }
      });

      const result = await proc;
      clearActiveToolOutput();
      let output = (result.all || result.stdout || "").trim();
      output = truncateOutput(output);
      
      if (interactiveWarning) {
        output = `${interactiveWarning}\n\n${output}`;
      }

      if (result.exitCode !== 0) {
        return `Exit code: ${result.exitCode}\n${output}`;
      }
      return output || "(no output)";
    } catch (err: unknown) {
      clearActiveToolOutput();
      // Re-throw if signal was aborted so the agent loop can clean up
      if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "CancelError"))) {
        const abortErr = new Error("AbortError");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      const message = err instanceof Error ? err.message : String(err);
      return `Error executing command: ${message}`;
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

export type TaskChangeListener = () => void;
const taskChangeListeners = new Set<TaskChangeListener>();

export function subscribeToTasks(listener: TaskChangeListener) {
  taskChangeListeners.add(listener);
  return () => {
    taskChangeListeners.delete(listener);
  };
}

export function notifyTasksChanged() {
  for (const listener of taskChangeListeners) {
    listener();
  }
}

export type ActiveOutputListener = (text: string) => void;
const activeOutputListeners = new Set<ActiveOutputListener>();
let activeToolOutput = "";

export function subscribeToActiveOutput(listener: ActiveOutputListener) {
  activeOutputListeners.add(listener);
  return () => {
    activeOutputListeners.delete(listener);
  };
}

export function getActiveToolOutput() {
  return activeToolOutput;
}

export function clearActiveToolOutput() {
  activeToolOutput = "";
  for (const listener of activeOutputListeners) {
    listener("");
  }
}

export function appendActiveToolOutput(text: string) {
  activeToolOutput += text;
  const lines = activeToolOutput.split("\n");
  if (lines.length > 50) {
    activeToolOutput = lines.slice(lines.length - 50).join("\n");
  }
  for (const listener of activeOutputListeners) {
    listener(activeToolOutput);
  }
}

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
      command = formatCommandForPowerShell(command);
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
      notifyTasksChanged();

      proc.all?.on("data", (data) => {
        const text = data.toString();
        task.output.push(text);
        if (task.output.length > 1000) {
          task.output.shift();
        }
      });

      proc.on("close", (code) => {
        task.output.push(`\n[Process exited with code ${code}]`);
        notifyTasksChanged();
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
      notifyTasksChanged();
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

      // Find match and map index to preserve CRLF / LF line endings
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

      // Match the default line endings of the file
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
      command = formatCommandForPowerShell(command);
    }
    const shell = isWin ? "powershell.exe" : true;
    try {
      clearActiveToolOutput();
      const proc = execa(command, {
        shell,
        cwd,
        reject: false,
        all: true,
        cancelSignal: signal,
      });

      let interactiveWarning: string | null = null;
      proc.all?.on("data", (data) => {
        const text = data.toString();
        appendActiveToolOutput(text);
        const warning = detectInteractivePrompt(text);
        if (warning) {
          interactiveWarning = warning;
        }
      });

      const result = await proc;
      clearActiveToolOutput();
      let output = (result.all || result.stdout || "").trim();
      output = truncateOutput(output);

      if (interactiveWarning) {
        output = `${interactiveWarning}\n\n${output}`;
      }
      return output || "(no output)";
    } catch (err: unknown) {
      clearActiveToolOutput();
      // Re-throw if signal was aborted so the agent loop can clean up
      if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "CancelError"))) {
        const abortErr = new Error("AbortError");
        abortErr.name = "AbortError";
        throw abortErr;
      }
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
        notifyTasksChanged();
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
  result?: string;
}

const SUBAGENT_REPORT_INSTRUCTION = `
CRITICAL INSTRUCTION FOR SUBAGENT REPORTING:
When you have completed your assigned task, or if you are blocked and cannot proceed, you MUST provide a standardized final report in your last response. Format your report exactly as follows using Markdown:

### SUBAGENT TASK REPORT
- **Goal / Objective**: [Brief description of what you were asked to do]
- **Actions Taken**:
  - [Action 1: e.g. read src/app.tsx]
  - [Action 2: e.g. executed tests]
- **Key Findings / Outcomes**:
  - [Detail what you discovered or accomplished]
- **Status & Next Steps**: [Completed / Blocked / Unresolved issues - and any recommendations for the main agent]
`;

const subagentTypes = new Map<string, SubagentType>();
export const subagentInstances = new Map<string, SubagentInstance>();

export type QuestionHandler = (question: string, options: string[]) => Promise<string>;
let activeQuestionHandler: QuestionHandler | null = null;

export function registerQuestionHandler(handler: QuestionHandler | null) {
  activeQuestionHandler = handler;
}

export type SubagentChangeListener = () => void;
const subagentChangeListeners = new Set<SubagentChangeListener>();

export function subscribeToSubagents(listener: SubagentChangeListener) {
  subagentChangeListeners.add(listener);
  return () => {
    subagentChangeListeners.delete(listener);
  };
}

export function notifySubagentsChanged() {
  for (const listener of subagentChangeListeners) {
    listener();
  }
}

export function registerSubagentType(name: string, description: string, systemPrompt: string) {
  subagentTypes.set(name, { name, description, systemPrompt });
}

// Register default subagent types
registerSubagentType(
  "researcher",
  "Specialized in codebase research, file analysis, web searching, and gathering context/information without modifications.",
  "You are a research subagent. Your goal is to gather information, read files, search the codebase, use web search, and analyze code or documentation. Do not modify any files or execute write operations unless explicitly instructed. Keep your findings concise and organized."
);

registerSubagentType(
  "explorer",
  "Specialized in exploring codebase structure, finding required references, APIs, or resources requested by the main agent.",
  "You are an explorer subagent. Your goal is to explore the codebase, APIs, documentation, or other resources to find references and details needed by the main agent. Focus on discovery, map out relationships, and report your findings clearly."
);

registerSubagentType(
  "coder",
  "Specialized in writing code, editing files, implementing features, and refactoring codebase files.",
  "You are a coding subagent. Your goal is to write, edit, and modify files in the codebase to implement requested features, fixes, or refactoring. Ensure you follow clean coding standards, preserve existing comments/formatting, and explain your changes clearly."
);

registerSubagentType(
  "reviewer",
  "Specialized in code review, quality checks, debugging, testing, and finding bugs/flaws.",
  "You are a code review subagent. Your goal is to inspect code changes, identify bugs, security vulnerabilities, performance issues, or architectural improvements. You can run tests, read files, and verify the correctness of the implementation."
);

registerSubagentType(
  "manual-tester",
  "Specialized in browser testing (Playwright), analyzing console logs/errors, and visual UI/UX design taste checks.",
  "You are a manual testing and browser automation subagent. Your goal is to run end-to-end browser tests using Playwright, navigate web applications, and thoroughly verify functionality.\n\n" +
  "CRITICAL RULES:\n" +
  "1. INITIALIZATION: At the start of your execution, before performing any testing tasks, you MUST check if 'playwright' is installed and ready (e.g., run 'npx playwright --version'). If not, or if browsers are missing, install them (e.g., run 'npm install -D @playwright/test' and 'npx playwright install'). Also check if 'agent-browser' is installed globally (e.g., run 'agent-browser --version' or 'npx agent-browser --version'). If not, install it using 'npm install -g agent-browser' followed by 'agent-browser install' to ensure browser automation capability is fully functional.\n" +
  "2. Access and interact with the browser (using tools like 'agent-browser' or running playwright CLI commands) to perform tests.\n" +
  "3. Inspect browser console logs, network errors, and test execution artifacts (like screenshots, trace files, or test reports) to diagnose issues and trace bugs.\n" +
  "4. Perform visual UI/UX checks (design taste): analyze screenshots to check visual alignment, spacing, typography, responsiveness, styling inconsistencies, and overall design aesthetics to ensure a high-quality, premium visual feel.\n" +
  "5. Provide a clear, structured test report detailing passing tests, failures, visual feedback, and browser error logs."
);

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
    let textBuffer = "";
    let isFirstNode = true;

    function flushTextBuffer() {
      if (!textBuffer) return;
      const cleanText = textBuffer.trim();
      if (cleanText) {
        const lines = cleanText.split("\n");
        logs.push(`${isFirstNode ? "┌" : "├"}───[ ✦ COGNITIVE THINKING ]\n`);
        isFirstNode = false;
        for (const line of lines) {
          logs.push(`│   ${line}\n`);
        }
        logs.push(`│\n`);
      }
      textBuffer = "";
    }

    function formatSubagentArgs(subArgs: Record<string, unknown>): string {
      const entries = Object.entries(subArgs);
      if (entries.length === 0) return "{}";
      const parts = entries.map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        const truncated = val.length > 50 ? val.slice(0, 50) + "..." : val;
        return `${k}: ${truncated}`;
      });
      return `{ ${parts.join(", ")} }`;
    }

    const systemPromptWithReport = `${subType.systemPrompt}\n\n${SUBAGENT_REPORT_INSTRUCTION}`;

    const agentInstance = new Agent(
      (event) => {
        if (event.type === "text") {
          textBuffer += event.content;
        } else if (event.type === "error") {
          flushTextBuffer();
          logs.push(`${isFirstNode ? "┌" : "├"}───[ 🚨 ERROR ]\n`);
          isFirstNode = false;
          const lines = event.message.split("\n");
          for (const line of lines) {
            logs.push(`│   ${line}\n`);
          }
          logs.push(`│\n`);
        } else if (event.type === "tool_start") {
          flushTextBuffer();
          logs.push(`${isFirstNode ? "┌" : "├"}───[ ⚙️ TOOL CALL: ${event.toolCall.name} ]\n`);
          isFirstNode = false;
          logs.push(`│   Description: ${event.description}\n`);
          const argLines = formatSubagentArgs(event.toolCall.args);
          logs.push(`│   Args: ${argLines}\n`);
          logs.push(`│\n`);
        } else if (event.type === "tool_end") {
          flushTextBuffer();
          const r = event.toolResult;
          const status = r.isError ? "🔴 FAILED" : "🟢 SUCCESS";
          logs.push(`│   └───[ ${status} ]\n`);
          const resultStr = typeof r.result === "string" ? r.result : JSON.stringify(r.result);
          const truncated = resultStr.slice(0, 200) + (resultStr.length > 200 ? "..." : "");
          const resultLines = truncated.split("\n");
          for (const line of resultLines) {
            logs.push(`│       ${line}\n`);
          }
          logs.push(`│\n`);
        }
      },
      async (toolCall, desc) => {
        return true;
      },
      async (question, options) => {
        if (activeQuestionHandler) {
          return activeQuestionHandler(`[Subagent ${subagentId} (${role})]: ${question}`, options);
        }
        return options[0] || "";
      },
      systemPromptWithReport
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
    notifySubagentsChanged();

    agentInstance.sendMessage(prompt).then(() => {
      flushTextBuffer();
      logs.push(`└──────────────────────────────────────────────\n`);
      instance.status = "completed";
      const msgs = agentInstance.getHistory().getMessages();
      const lastAssistantMsg = [...msgs].reverse().find(m => m.role === "assistant");
      if (lastAssistantMsg) {
        instance.result = lastAssistantMsg.content;
      }
      notifySubagentsChanged();
    }).catch(() => {
      flushTextBuffer();
      logs.push(`└──────────────────────────────────────────────\n`);
      instance.status = "completed";
      notifySubagentsChanged();
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
    notifySubagentsChanged();
    instance.agent.sendMessage(message).then(() => {
      instance.status = "completed";
      const msgs = instance.agent.getHistory().getMessages();
      const lastAssistantMsg = [...msgs].reverse().find(m => m.role === "assistant");
      if (lastAssistantMsg) {
        instance.result = lastAssistantMsg.content;
      }
      notifySubagentsChanged();
    }).catch(() => {
      instance.status = "completed";
      notifySubagentsChanged();
    });

    return `Message sent to subagent "${recipientId}". Subagent is processing.`;
  },
};

const manageSubagentsTool: Tool = {
  name: "manage_subagents",
  description: "List subagent types/instances, check logs, retrieve reports, or terminate them.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "logs", "report", "kill", "kill_all"],
        description: "Action to perform",
      },
      conversationIds: {
        type: "array",
        items: { type: "string" },
        description: "List of conversation IDs to kill or read logs/reports from",
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
        let line = `  - ID: ${id} | Type: ${inst.typeName} | Role: ${inst.role} | Status: ${inst.status}`;
        if (inst.status === "completed" && inst.result) {
          const snippet = inst.result.length > 120 ? inst.result.slice(0, 120) + "..." : inst.result;
          line += `\n    Report: ${snippet.replace(/\n/g, "\n    ")}`;
        }
        lines.push(line);
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

    if (action === "report") {
      if (!conversationIds || conversationIds.length === 0) {
        return "Error: conversationIds is required to retrieve the report.";
      }
      const id = conversationIds[0];
      const inst = subagentInstances.get(id);
      if (!inst) {
        return `Error: Subagent instance "${id}" not found.`;
      }
      return `Report for Subagent ${id} (${inst.role}):\n\n${inst.result || "No report available yet."}`;
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
      notifySubagentsChanged();
      return `Terminated subagents: ${conversationIds.join(", ")}`;
    }

    if (action === "kill_all") {
      for (const [id, inst] of subagentInstances.entries()) {
        inst.agent.abort();
      }
      subagentInstances.clear();
      notifySubagentsChanged();
      return "All subagent instances terminated.";
    }

    return `Error: Unknown action "${action}"`;
  },
};

const askQuestionTool: Tool = {
  name: "ask_question",
  description: "Ask the user a multiple-choice question to clarify requirements or get design decisions. Returns the selected option.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user",
      },
      options: {
        type: "array",
        items: {
          type: "string",
        },
        description: "List of options for the user to choose from",
      },
    },
    required: ["question", "options"],
  },
  async execute(args, cwd, signal) {
    return `Error: ask_question must be executed interactively.`;
  },
};

const applyPatchTool: Tool = {
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
      // Basic search-replace parsing for unified-like chunks if we don't have standard patch libs
      // Parse search & replace blocks: e.g. looking for <<<, ===, >>> or standard unified hunk headers
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

const gitActionTool: Tool = {
  name: "git_action",
  description: "Execute a structured Git action (status, log, diff, commit).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "diff", "commit", "log"],
        description: "The git action to perform",
      },
      message: {
        type: "string",
        description: "Commit message (required for commit)",
      },
      limit: {
        type: "number",
        description: "Max commit log entries (default 5)",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    try {
      if (action === "status") {
        const { stdout } = await execa("git", ["status", "--porcelain"], { cwd, cancelSignal: signal });
        return stdout || "Clean working tree.";
      }
      if (action === "diff") {
        const { stdout } = await execa("git", ["diff"], { cwd, cancelSignal: signal });
        return truncateOutput(stdout, 120) || "No unstaged changes.";
      }
      if (action === "commit") {
        const message = args.message as string;
        if (!message) return "Error: Commit message is required.";
        await execa("git", ["add", "-A"], { cwd, cancelSignal: signal });
        const { stdout } = await execa("git", ["commit", "-m", message], { cwd, cancelSignal: signal });
        return stdout;
      }
      if (action === "log") {
        const limit = (args.limit as number) || 5;
        const { stdout } = await execa("git", ["log", `-${limit}`, "--oneline"], { cwd, cancelSignal: signal });
        return stdout;
      }
      return "Unknown git action.";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Git action error: ${message}`;
    }
  },
};

const screenshotTool: Tool = {
  name: "screenshot",
  description: "Capture current desktop screenshot to debug visual compose UI.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(args, cwd, signal) {
    const isWin = process.platform === "win32";
    if (!isWin) {
      return "Screenshot tool is only supported on Windows in this execution context.";
    }
    const outputPath = path.resolve(cwd, `screenshot_${Date.now()}.png`);
    try {
      // Execute Powershell script to grab screen screenshot using System.Drawing
      const psCommand = `
        Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
        $graphics = [System.Drawing.Graphics]::FromImage($bmp);
        $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
        $bmp.Save('${outputPath.replace(/\\/g, "\\\\")}');
        $graphics.Dispose();
        $bmp.Dispose();
      `.replace(/\n/s, " ");
      await execa("powershell.exe", ["-Command", psCommand], { cancelSignal: signal });
      return `Screenshot successfully captured: ${outputPath}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Failed to capture screenshot: ${message}`;
    }
  },
};

const androidCliTool: Tool = {
  name: "android_cli",
  description: "Execute an Android CLI command (e.g., 'sdk list', 'emulator list', 'run'). Returns the output.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The android subcommand and options to run (e.g., 'sdk list', 'emulator list', 'info'). Do not include the 'android' command prefix.",
      },
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    const subCommand = args.command as string;
    await ensureAndroidCliInstalled();
    const isWin = process.platform === "win32";
    let exe = "android";
    if (isWin) {
      const userProfile = process.env.USERPROFILE || process.env.HOMEPATH || "C:\\Users\\USER";
      const winPath = path.join(userProfile, "AppData", "AndroidCLI", "android.exe");
      try {
        await fs.access(winPath);
        exe = `"${winPath}"`;
      } catch {}
    } else {
      const home = process.env.HOME || "";
      const unixPath = path.join(home, ".android-cli", "bin", "android");
      try {
        await fs.access(unixPath);
        exe = unixPath;
      } catch {}
    }
    const fullCommand = isWin ? `& ${exe} ${subCommand}` : `${exe} ${subCommand}`;
    try {
      const { stdout, stderr } = await execa(fullCommand, {
        cwd,
        cancelSignal: signal,
        shell: isWin ? "powershell.exe" : true,
      });
      return (stdout || stderr || "").trim() || "(no output)";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Android CLI error: ${message}`;
    }
  },
};

export const allTools: Tool[] = [
  readTool,
  askQuestionTool,
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
  applyPatchTool,
  gitActionTool,
  screenshotTool,
  androidCliTool,
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
