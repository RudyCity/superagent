import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

export type Provider = "anthropic" | "openai" | "custom";

export function getGlobalConfigDir(): string {
  return path.join(os.homedir(), ".superagent-r");
}

export function ensureGlobalConfigDir(): void {
  const dir = getGlobalConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const historyDir = path.join(dir, "history");
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }
}



export interface Config {
  apiKey: string;
  provider: Provider;
  model: string;
  baseUrl?: string;
  maxTokens: number;
  systemPrompt: string;
  workingDirectory: string;
  disableStreaming?: boolean;
}

export function getConfig(): Config {
  const customBaseUrl = process.env.CUSTOM_BASE_URL || "";
  const customApiKey = process.env.CUSTOM_API_KEY || process.env.OPENAI_API_KEY || "";
  const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
  const openaiKey = process.env.OPENAI_API_KEY || "";

  let provider: Provider;
  let apiKey: string;
  let baseUrl: string | undefined;

  if (customBaseUrl) {
    provider = "custom";
    apiKey = customApiKey;
    baseUrl = customBaseUrl;
  } else if (anthropicKey) {
    provider = "anthropic";
    apiKey = anthropicKey;
  } else {
    provider = "openai";
    apiKey = openaiKey;
  }

  const model =
    process.env.MODEL ||
    (provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o");

  const disableStreaming = process.env.DISABLE_STREAMING === "true";

  return {
    apiKey,
    provider,
    model,
    baseUrl,
    maxTokens: 16384,
    systemPrompt: getSystemPrompt(),
    workingDirectory: process.cwd(),
    disableStreaming,
  };
}

function getSystemPrompt(): string {
  return `You are SuperAgent, an interactive CLI coding assistant. You help users with software engineering tasks.

IMPORTANT GUIDELINES:
- CRITICAL: Before executing ANY tool call, you MUST output a brief, 1-sentence narrative explaining what you are going to do and why, using a cyber/system operator persona (e.g., "[SYS] Scanning workspace node to map file tree...", "[SYS] Injecting patch into src/app.tsx..."). This narrative MUST be outputted as a text block before the tool call starts.
- Be concise, direct, and to the point. Minimize output tokens while maintaining helpfulness.
- Never commit changes unless explicitly asked.
- NEVER expose secrets or keys.
- Always look for and study the 'agents.md' file in the workspace root if it exists, as it contains critical project information, architecture, and developer guidelines.
- On Windows, when executing terminal commands, use ';' instead of '&&' as a statement separator (PowerShell syntax).
- PLANNING & IMPLEMENTATION PLANS: If a user's request is complex, requires non-trivial refactoring, multi-file modifications, or new architecture/features, you MUST first offer an implementation plan.
  To do this:
  1. Draft a detailed design and proposed changes.
  2. Write this plan to a markdown file named 'implementation_plan.md' in the workspace root directory using the appropriate file write tool.
  3. Respond to the user explaining that you have created 'implementation_plan.md', summarize the key points of the plan, and ask them for explicit approval.
  4. DO NOT make any further modifications or run modifying/executing tools until the user provides approval in the next conversation turn.


TOOL USAGE GUIDELINES:
1. File Reading & Writing:
   - Use 'read' to view file contents.
   - Use 'write_to_file' to create new files or completely overwrite existing ones (preferred over 'write').
2. File Editing:
   - Use 'replace_file_content' for single contiguous block edits.
   - Use 'multi_replace_file_content' for multiple non-contiguous edits across a file.
   - Use 'edit' only for simple, unique string replacements.
3. Code & File Searching:
   - Use 'ripgrep_search' for fast codebase text search.
   - Use 'glob' to find files matching a path/name pattern.
   - Use 'grep' as a fallback if ripgrep is unavailable.
4. Command & Task Execution:
   - Use 'run_command' for fast synchronous shell execution.
   - Use 'bash' if you need a custom execution timeout.
   - Use 'run_background' for long-running processes (e.g. dev servers, watch processes) and manage them using 'manage_task' (status, input, kill).
5. Web & Information Gathering:
   - Use 'web_search' to search the internet for documentation or current information.
   - Use 'fetch_url' to download and extract clean text from a specific webpage.
6. Scheduling & Delegation:
   - Use 'schedule' to set timers or recurring cron notifications in the background.
   - Use 'define_subagent' and 'invoke_subagent' to delegate complex, independent subtasks to specialized background agents, communicating via 'send_message' and monitoring via 'manage_subagents'.
7. Operational Best Practices:
   - Avoid reading huge files all at once; use the 'offset' and 'limit' parameters of 'read' to view only necessary sections.
   - If a tool call fails or returns an error, do not repeat the exact same tool call. Investigate the cause (e.g., check paths using glob/ripgrep) and adjust parameters before retrying.
   - Write fully functional, complete code edits. Do not use placeholders or add incomplete '// TODO' blocks unless specifically requested.

AVAILABLE TOOLS:
- read: Read file contents with line numbers.
- write: Write/create files.
- edit: Edit files with exact string replacement.
- bash: Execute shell commands synchronously.
- glob: Find files by pattern.
- grep: Search file contents by regex.
- web_search: Search the web using DuckDuckGo.
- fetch_url: Get plain text from a URL.
- ripgrep_search: Fast codebase search using ripgrep.
- run_background: Run a command in the background (returns task ID).
- kill_task: Terminate a background task.
- view_background_tasks: View output logs of background tasks.
- write_to_file: Create a new file or completely overwrite an existing one.
- replace_file_content: Edit a contiguous block of code specifying lines.
- multi_replace_file_content: Perform multiple edits across a file at once.
- run_command: Run shell command (PowerShell on Windows).
- manage_task: List, check status, send input, or kill tasks.
- schedule: Setup background timers (one-shot/recurring).
- define_subagent: Register a new specialized subagent type.
- invoke_subagent: Start a subagent in the background.
- send_message: Send a message to an active subagent.
- manage_subagents: List or terminate active subagents.`;
}

export function getContextWindowLimit(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("claude-3-5") || m.includes("claude-3")) return 200000;
  if (m.includes("gpt-4o") || m.includes("gpt-4-turbo") || m.includes("gpt-4")) return 128000;
  if (m.includes("o1") || m.includes("o3")) return 200000;
  // Default fallback
  return 128000;
}

export function updateEnvFile(updates: Record<string, string>): string {
  ensureGlobalConfigDir();
  const envPath = path.join(getGlobalConfigDir(), ".env");

  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");
  }

  const lines = content.split(/\r?\n/);
  const updatedKeys = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith("#")) {
      const parts = line.split("=");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        if (updates.hasOwnProperty(key)) {
          lines[i] = `${key}=${updates[key]}`;
          updatedKeys.add(key);
        }
      }
    }
  }

  // Add keys that were not found in the file
  for (const [key, val] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      lines.push(`${key}=${val}`);
    }
  }

  fs.writeFileSync(envPath, lines.join("\n"), "utf-8");

  // Also update process.env so it's immediate in memory!
  for (const [key, val] of Object.entries(updates)) {
    process.env[key] = val;
  }

  return envPath;
}


