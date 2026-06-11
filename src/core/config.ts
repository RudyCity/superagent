import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { getStaticModelLimit } from "./model_limits.js";
import { resolveWindowsShell } from "./tools/helpers.js";

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
  const checkpointsDir = path.join(dir, "checkpoints");
  if (!fs.existsSync(checkpointsDir)) {
    fs.mkdirSync(checkpointsDir, { recursive: true });
  }
}

export interface HistorySession {
  filePath: string;
  displayName: string;
  messageCount: number;
  lastModified: Date;
  preview: string;
}

export function listHistorySessions(): HistorySession[] {
  const historyDir = path.join(getGlobalConfigDir(), "history");
  if (!fs.existsSync(historyDir)) return [];

  const currentDir = process.cwd();
  const currentSanitized = currentDir.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();

  let files: string[];
  try {
    files = fs.readdirSync(historyDir).filter((f) => {
      if (!f.endsWith(".json")) return false;
      const nameWithoutExt = f.replace(/\.json$/, "").toLowerCase();
      return nameWithoutExt === currentSanitized || nameWithoutExt.startsWith(currentSanitized + "_");
    });
  } catch {
    return [];
  }

  const sessions: HistorySession[] = [];
  for (const file of files) {
    const filePath = path.join(historyDir, file);
    try {
      const stat = fs.statSync(filePath);
      const raw = fs.readFileSync(filePath, "utf-8");
      const messages: Array<{ role: string; content: string; timestamp?: number }> = JSON.parse(raw);
      if (!Array.isArray(messages)) continue;

      // Reconstruct display name from sanitized filename
      const nameWithoutExt = file.replace(/\.json$/, "");
      // Strip trailing timestamp suffix if present (e.g. _1717999999)
      const cleanName = nameWithoutExt.replace(/_\d+$/, "");
      const displayName = cleanName
        .replace(/^([a-zA-Z])__/, "$1:\\")
        .replace(/^_+/, "/")
        .replace(/_/g, "/");

      const userMessages = messages.filter((m) => m.role === "user");
      const lastUser = userMessages[userMessages.length - 1];
      const preview = lastUser
        ? lastUser.content.slice(0, 60).replace(/\n/g, " ") + (lastUser.content.length > 60 ? "…" : "")
        : "(no user messages)";

      sessions.push({
        filePath,
        displayName,
        messageCount: messages.length,
        lastModified: stat.mtime,
        preview,
      });
    } catch {
      // Skip corrupt/unreadable files
      continue;
    }
  }

  // Sort by most recently modified first
  sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return sessions;
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
  const activeProvider = process.env.ACTIVE_PROVIDER || "";
  let provider: Provider = "openai";
  let apiKey = "";
  let baseUrl: string | undefined;

  if (activeProvider) {
    const prefix = `PROVIDER_${activeProvider.toUpperCase()}`;
    const type = process.env[`${prefix}_TYPE`] || "";
    apiKey = process.env[`${prefix}_API_KEY`] || "";
    baseUrl = process.env[`${prefix}_BASE_URL`] || "";

    if (!apiKey && !baseUrl) {
      const customBaseUrl = process.env.CUSTOM_BASE_URL || "";
      const customApiKey = process.env.CUSTOM_API_KEY || process.env.OPENAI_API_KEY || "";
      const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
      const openaiKey = process.env.OPENAI_API_KEY || "";

      if (activeProvider.toLowerCase() === "custom" && customBaseUrl) {
        provider = "custom";
        apiKey = customApiKey;
        baseUrl = customBaseUrl;
      } else if (activeProvider.toLowerCase() === "anthropic" && anthropicKey) {
        provider = "anthropic";
        apiKey = anthropicKey;
      } else if (activeProvider.toLowerCase() === "openai" && openaiKey) {
        provider = "openai";
        apiKey = openaiKey;
      }
    } else {
      if (type === "anthropic" || activeProvider.toLowerCase() === "anthropic") {
        provider = "anthropic";
      } else if (type === "custom" || baseUrl) {
        provider = "custom";
      } else {
        provider = "openai";
      }
    }
  } else {
    // Backwards compatibility fallback
    const customBaseUrl = process.env.CUSTOM_BASE_URL || "";
    const customApiKey = process.env.CUSTOM_API_KEY || process.env.OPENAI_API_KEY || "";
    const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
    const openaiKey = process.env.OPENAI_API_KEY || "";

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
  let shellPrompt = "";
  if (process.platform === "win32") {
    const resolved = resolveWindowsShell();
    if (resolved.isBash) {
      shellPrompt = `\n- ACTIVE TERMINAL SHELL: Git Bash (bash.exe). Since Git Bash is available, you CAN run standard Linux/Bash commands (like grep, lsof, piping '|', etc.). Avoid using PowerShell commands unless requested.`;
    } else {
      shellPrompt = `\n- ACTIVE TERMINAL SHELL: Windows PowerShell (powershell.exe). Since Git Bash is NOT available, you MUST use Windows/PowerShell syntax. Do NOT use Unix-only commands (like grep, lsof). When chaining multiple commands, use ';' instead of '&&'.`;
    }
  }

  const basePrompt = `You are SuperAgent, an interactive CLI coding assistant. You help users with software engineering tasks.
${shellPrompt}

SUBAGENTS AVAILABLE OUT-OF-THE-BOX:
You have pre-defined specialized subagents available for delegation (via 'invoke_subagent'):
- 'researcher': Specialized in codebase research, file analysis, web searching, and gathering context/information without modifications.
- 'coder': Specialized in writing code, editing files, implementing features, and refactoring codebase files.
- 'reviewer': Specialized in code review, quality checks, debugging, testing, and finding bugs/flaws.
You can invoke these directly or define new ones if needed.

IMPORTANT GUIDELINES:
- CRITICAL: Before executing ANY tool call, you MUST output a brief, 1-sentence narrative explaining what you are going to do and why, using a cyber/system operator persona (e.g., "[SYS] Scanning workspace node to map file tree...", "[SYS] Injecting patch into src/app.tsx..."). This narrative MUST be outputted as a text block before the tool call starts.
- Be concise, direct, and to the point. Minimize output tokens while maintaining helpfulness.
- Never commit changes unless explicitly asked.
- NEVER expose secrets or keys.
- Always look for and study the 'agents.md' file in the workspace root if it exists, as it contains critical project information, architecture, and developer guidelines.
- On Windows, when executing terminal commands, use ';' instead of '&&' as a statement separator (PowerShell syntax).
- PLANNING, TASKS & VERIFICATION LIFECYCLE: If a user's request is complex, requires non-trivial refactoring, multi-file modifications, or new architecture/features, you MUST follow this structured lifecycle using session-specific markdown files (the exact absolute paths to use are provided dynamically in the context/system prompt):
  1. Planning Phase: Write a detailed design, proposed file changes, and verification plan to the specified 'Implementation Plan File' absolute path. Summarize it for the user and ask for explicit approval. DO NOT modify any codebase files or run modifying terminal commands until approved.
  2. Task Tracking Phase: Once the plan is approved, create a checklist file at the specified 'Task Tracking File' absolute path containing task checkboxes (e.g. \`[ ]\`, \`[/]\`, \`[x]\`). As you work, update progress in that file, marking items as in-progress or completed.
  3. Verification Phase: When implementation is complete, verify all changes. Write a summary of changes, test logs, and verification results to the specified 'Verification/Walkthrough File' absolute path before declaring the task finished.
- BEHAVIORAL GUIDELINES (KARPATHY-INSPIRED): You MUST always read and adhere to the guidelines specified in the 'karpathy-guidelines' skill instruction file located at '.agents/skills/karpathy-guidelines/SKILL.md' for all your coding, architectural, and refactoring decisions.



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
   - Use 'run_background_process' for long-running processes (e.g. dev servers, watch processes, or long test suites). You must monitor background processes using 'manage_background_process' (action: 'status') to inspect their logs and verify if they completed successfully.
5. Web & Information Gathering:
   - Use 'web_search' to search the internet for documentation or current information.
   - Use 'fetch_url' to download and extract clean text from a specific webpage.
6. Scheduling & Delegation:
   - Use 'schedule' to set timers or recurring cron notifications in the background.
   - Use 'invoke_subagent' to spawn pre-defined subagents ('researcher', 'coder', 'reviewer') or custom subagents defined via 'define_subagent' to work on parallel/subtasks. Because they run asynchronously, you must monitor them using 'manage_subagents' (action: 'list' or 'logs') to retrieve their output, and send follow-up instructions via 'send_message'.
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
- run_background_process: Run a command in the background (returns process ID).
- kill_background_process: Terminate a background process.
- view_background_processes: View output logs of background processes.
- write_to_file: Create a new file or completely overwrite an existing one.
- replace_file_content: Edit a contiguous block of code specifying lines.
- multi_replace_file_content: Perform multiple edits across a file at once.
- run_command: Run shell command (PowerShell on Windows).
- manage_background_process: List, check status, send input, or kill processes.
- schedule: Setup background timers (one-shot/recurring).
- define_subagent: Register a new specialized subagent type.
- invoke_subagent: Start a subagent in the background.
- send_message: Send a message to an active subagent.
- manage_subagents: List or terminate active subagents.`;
  
  const skillsPrompt = loadAgentSkills();
  return basePrompt + skillsPrompt;
}

export interface LoadedSkill {
  name: string;
  description: string;
  path: string;
}

export function getInstalledSkills(): LoadedSkill[] {
  const skills: LoadedSkill[] = [];
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const packageRootDir = path.resolve(__dirname, "..", "..");

  const searchDirs = [
    path.join(os.homedir(), ".superagent-r", "skills"),
    path.join(process.cwd(), "skills"),
    path.join(process.cwd(), ".superagent", "skills"),
    path.join(process.cwd(), ".agents", "skills"),
    path.join(packageRootDir, "skills"),
    path.join(packageRootDir, ".agents", "skills")
  ];

  for (const dir of searchDirs) {
    if (fs.existsSync(dir)) {
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (item.isDirectory()) {
            const skillDir = path.join(dir, item.name);
            const skillMdPath = path.join(skillDir, "SKILL.md");
            if (fs.existsSync(skillMdPath)) {
              try {
                const content = fs.readFileSync(skillMdPath, "utf-8");
                let name = item.name;
                let description = "No description provided.";
                
                // Simple frontmatter parser
                const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
                if (fmMatch) {
                  const fm = fmMatch[1];
                  const nameMatch = fm.match(/^name:\s*(.*)$/m);
                  const descMatch = fm.match(/^description:\s*(.*)$/m);
                  if (nameMatch) name = nameMatch[1].trim();
                  if (descMatch) description = descMatch[1].trim();
                } else {
                  // Fallback to searching first heading or lines
                  const headingMatch = content.match(/^#\s*(.*)$/m);
                  if (headingMatch) name = headingMatch[1].trim();
                }
                
                if (!skills.some(s => s.path === skillMdPath)) {
                  skills.push({
                    name,
                    description,
                    path: skillMdPath
                  });
                }
              } catch (e) {
                // Ignore parsing errors for individual skills
              }
            }
          }
        }
      } catch (e) {
        // Ignore directory read errors
      }
    }
  }
  return skills;
}

function loadAgentSkills(): string {
  const skills = getInstalledSkills();
  if (skills.length === 0) {
    return "";
  }

  let text = "\n\nINSTALLED AGENT SKILLS:\n";
  text += "The following specialized agent skills are installed. If a user's task matches one of these skills, you should read the specified 'SKILL.md' file using a file read tool to obtain the detailed instructions, and execute any scripts or workflows it specifies:\n";
  for (const s of skills) {
    text += `- **${s.name}**: ${s.description}\n  Instruction File: ${s.path}\n`;
  }
  return text;
}

export async function fetchAndCacheModels(): Promise<void> {
  const config = getConfig();
  let url = "";
  const headers: Record<string, string> = {};

  if (config.provider === "anthropic") {
    // Anthropic doesn't have a public models list endpoint with context sizes
    return;
  }

  const activeProvider = process.env.ACTIVE_PROVIDER || "";
  if (activeProvider.toLowerCase() === "openrouter") {
    url = "https://openrouter.ai/api/v1/models";
  } else if (config.provider === "openai") {
    if (config.baseUrl) {
      url = `${config.baseUrl.replace(/\/+$/, "")}/models`;
    } else {
      url = "https://api.openai.com/v1/models";
    }
  } else if (config.provider === "custom") {
    if (config.baseUrl) {
      url = `${config.baseUrl.replace(/\/+$/, "")}/models`;
    }
  }

  if (!url) return;

  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return;
    const json = await res.json() as any;
    if (json && Array.isArray(json.data)) {
      const cache: Record<string, number> = {};
      for (const m of json.data) {
        if (!m || !m.id) continue;
        const limit =
          m.context_length ||
          m.max_model_len ||
          m.max_position_embeddings ||
          (m.metadata &&
            (m.metadata.context_length ||
              m.metadata.max_model_len ||
              m.metadata.max_position_embeddings));
        if (limit && typeof limit === "number") {
          cache[m.id] = limit;
        }
      }

      ensureGlobalConfigDir();
      const cachePath = path.join(getGlobalConfigDir(), "models_cache.json");
      let existingCache: Record<string, number> = {};
      if (fs.existsSync(cachePath)) {
        try {
          existingCache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        } catch {}
      }
      const updatedCache = { ...existingCache, ...cache };
      fs.writeFileSync(cachePath, JSON.stringify(updatedCache, null, 2), "utf-8");
    }
  } catch (err) {
    // Ignore fetching errors
  }
}

export function getContextWindowLimit(model: string): number {
  // 1. Env overrides
  if (process.env.CONTEXT_WINDOW_LIMIT) {
    const parsed = parseInt(process.env.CONTEXT_WINDOW_LIMIT, 10);
    if (!isNaN(parsed)) return parsed;
  }
  if (process.env.MAX_CONTEXT_TOKENS) {
    const parsed = parseInt(process.env.MAX_CONTEXT_TOKENS, 10);
    if (!isNaN(parsed)) return parsed;
  }

  // 2. Read from models_cache.json
  try {
    const cachePath = path.join(getGlobalConfigDir(), "models_cache.json");
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      if (cache && typeof cache[model] === "number") {
        return cache[model];
      }
    }
  } catch (err) {
    // Ignore cache read errors
  }

  // 3. Fallback to rich static lookup
  const staticLimit = getStaticModelLimit(model);
  if (staticLimit !== null) {
    return staticLimit;
  }

  // Default fallback
  return 256000;
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

export interface ConfiguredProvider {
  name: string;
  type: string;
  baseUrl?: string;
  isActive: boolean;
}

export function getConfiguredProviders(): ConfiguredProvider[] {
  const providers: ConfiguredProvider[] = [];
  const active = process.env.ACTIVE_PROVIDER || "";

  // Add defaults if they are set in env directly (legacy)
  if (process.env.ANTHROPIC_API_KEY && !process.env.PROVIDER_ANTHROPIC_API_KEY) {
    providers.push({ name: "anthropic", type: "anthropic", isActive: !active || active.toLowerCase() === "anthropic" });
  }
  if (process.env.OPENAI_API_KEY && !process.env.PROVIDER_OPENAI_API_KEY) {
    providers.push({ name: "openai", type: "openai", isActive: !active || active.toLowerCase() === "openai" });
  }
  if (process.env.CUSTOM_BASE_URL && !process.env.PROVIDER_CUSTOM_API_KEY) {
    providers.push({ name: "custom", type: "custom", baseUrl: process.env.CUSTOM_BASE_URL, isActive: active.toLowerCase() === "custom" });
  }

  // Scan for PROVIDER_<NAME>_*
  const seen = new Set<string>(providers.map(p => p.name.toLowerCase()));
  for (const key of Object.keys(process.env)) {
    const match = key.match(/^PROVIDER_([A-Z0-9_]+)_API_KEY$/);
    if (match) {
      const name = match[1].toLowerCase();
      if (!seen.has(name)) {
        seen.add(name);
        const type = process.env[`PROVIDER_${match[1]}_TYPE`] || (name === "anthropic" ? "anthropic" : name === "openai" ? "openai" : name === "openrouter" ? "custom" : "custom");
        const baseUrl = process.env[`PROVIDER_${match[1]}_BASE_URL`];
        providers.push({
          name,
          type,
          baseUrl,
          isActive: active.toLowerCase() === name
        });
      }
    }
  }

  return providers;
}

export function switchActiveProvider(name: string): string {
  const prefix = `PROVIDER_${name.toUpperCase()}`;
  const type = process.env[`${prefix}_TYPE`] || "";
  const apiKey = process.env[`${prefix}_API_KEY`] || "";
  const baseUrl = process.env[`${prefix}_BASE_URL`] || "";

  const updates: Record<string, string> = {
    ACTIVE_PROVIDER: name,
  };

  if (type === "openrouter" || name.toLowerCase() === "openrouter") {
    updates["CUSTOM_BASE_URL"] = "https://openrouter.ai/api/v1";
    updates["CUSTOM_API_KEY"] = apiKey;
    updates["ANTHROPIC_API_KEY"] = "";
    updates["OPENAI_API_KEY"] = "";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  } else if (type === "anthropic" || name.toLowerCase() === "anthropic") {
    updates["ANTHROPIC_API_KEY"] = apiKey;
    updates["CUSTOM_BASE_URL"] = "";
    updates["CUSTOM_API_KEY"] = "";
    updates["OPENAI_API_KEY"] = "";
    delete process.env.CUSTOM_BASE_URL;
    delete process.env.CUSTOM_API_KEY;
    delete process.env.OPENAI_API_KEY;
  } else if (type === "openai" || name.toLowerCase() === "openai") {
    updates["OPENAI_API_KEY"] = apiKey;
    updates["CUSTOM_BASE_URL"] = "";
    updates["CUSTOM_API_KEY"] = "";
    updates["ANTHROPIC_API_KEY"] = "";
    delete process.env.CUSTOM_BASE_URL;
    delete process.env.CUSTOM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    updates["CUSTOM_BASE_URL"] = baseUrl;
    updates["CUSTOM_API_KEY"] = apiKey;
    updates["ANTHROPIC_API_KEY"] = "";
    updates["OPENAI_API_KEY"] = "";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  }

  return updateEnvFile(updates);
}

export function getModelInstance() {
  const config = getConfig();
  if (config.provider === "anthropic") {
    const anthropic = createAnthropic({ apiKey: config.apiKey });
    return anthropic(config.model);
  }
  const openai = createOpenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl && { baseURL: config.baseUrl }),
    headers: {
      "HTTP-Referer": "https://github.com/RudyCity/superagent",
      "X-Title": "SuperAgent CLI",
    },
  });
  return openai(config.model);
}


