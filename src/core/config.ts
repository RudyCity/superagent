import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { getStaticModelLimit } from "./model_limits.js";

export type Provider = "anthropic" | "openai" | "custom";

export function getRootConfigDir(): string {
  return path.join(os.homedir(), ".superagent-r");
}

export function getGlobalConfigDir(): string {
  const root = getRootConfigDir();
  if (process.env.SUPERAGENT_SESSION_ID) {
    return path.join(root, "sessions", process.env.SUPERAGENT_SESSION_ID);
  }
  return root;
}

export function ensureGlobalConfigDir(): void {
  const rootDir = getRootConfigDir();
  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }
  const dir = getGlobalConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const historyDir = path.join(dir, "history");
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }
  const singleDir = path.join(historyDir, "single");
  if (!fs.existsSync(singleDir)) {
    fs.mkdirSync(singleDir, { recursive: true });
  }
  const multiDir = path.join(historyDir, "multi");
  if (!fs.existsSync(multiDir)) {
    fs.mkdirSync(multiDir, { recursive: true });
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

export function listHistorySessions(isMulti = false): HistorySession[] {
  const mode = isMulti ? "multi" : "single";
  const historyDir = path.join(getGlobalConfigDir(), "history", mode);
  if (!fs.existsSync(historyDir)) return [];

  const currentDir = process.cwd();
  const currentSanitized = currentDir.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();

  let dirs: string[];
  try {
    dirs = fs.readdirSync(historyDir).filter((d) => {
      const nameLower = d.toLowerCase();
      return nameLower === currentSanitized || nameLower.startsWith(currentSanitized + "_");
    });
  } catch {
    return [];
  }

  const sessions: HistorySession[] = [];
  for (const d of dirs) {
    const dirPath = path.join(historyDir, d);
    const filePath = path.join(dirPath, `${d}.json`);
    if (!fs.existsSync(filePath)) continue;

    try {
      const stat = fs.statSync(filePath);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      let messages: Array<{ role: string; content: string; timestamp?: number }> = [];
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
        messages = parsed.messages;
      } else if (Array.isArray(parsed)) {
        messages = parsed;
      } else {
        continue;
      }

      const userMessages = messages.filter((m) => m.role === "user");
      const lastUser = userMessages[userMessages.length - 1];
      const preview = lastUser
        ? lastUser.content.slice(0, 60).replace(/\n/g, " ") + (lastUser.content.length > 60 ? "…" : "")
        : "(no user messages)";

      // Reconstruct display name from sanitized filename as fallback
      // Strip trailing timestamp suffix if present (e.g. _1717999999)
      const cleanName = d.replace(/_\d+$/, "");
      const folderPathName = cleanName
        .replace(/^([a-zA-Z])__/, "$1:\\")
        .replace(/^_+/, "/")
        .replace(/_/g, "/");

      const displayName = lastUser && lastUser.content && lastUser.content.trim()
        ? lastUser.content.trim().slice(0, 60).replace(/\n/g, " ") + (lastUser.content.trim().length > 60 ? "…" : "")
        : folderPathName;

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
    shellPrompt = `\n- ACTIVE TERMINAL SHELL: Windows PowerShell-compatible command execution.\n- On Windows, use ';' to separate commands. Do not use '&&' in generated shell commands.\n- Use \`run_command\` for validation commands and pass the 'timeout' parameter when a custom timeout is needed.\n- Use 'run_background_process' for long-running servers, watchers, or interactive processes.\n- Use 'git_worktree' for worktree list/add/remove/prune operations instead of hand-written cleanup chains.`;
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
- On Windows, use ';' to separate commands. Do not use '&&' in generated shell commands.
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
   - Use \`run_command\` for validation commands and pass the 'timeout' parameter when a custom timeout is needed.
   - Use 'run_background_process' for long-running processes (e.g. dev servers, watch processes, or long test suites). You must monitor background processes using 'manage_background_process' (action: 'status') to inspect their logs and verify if they completed successfully. To avoid busy-waiting or loop polling (which wastes tokens and blocks progress), schedule a check-in using the 'schedule' tool (e.g. '10s' or '30s') to pause and check later.
5. Web & Information Gathering:
   - Use 'web_search' to search the internet for documentation or current information.
   - Use 'fetch_url' to download and extract clean text from a specific webpage.
6. Scheduling & Delegation:
    - Use 'schedule' to set timers or recurring cron notifications in the background. Use this to schedule future check-ins on asynchronous tasks (like background processes or subagents) instead of polling them in a loop.
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

export function loadAgentSkills(): string {
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
      const cachePath = path.join(getRootConfigDir(), "models_cache.json");
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

/** Returns the list of model IDs cached from the last successful API fetch. */
export function getCachedModelIds(): string[] {
  try {
    const cachePath = path.join(getRootConfigDir(), "models_cache.json");
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as Record<string, number>;
      return Object.keys(cache);
    }
  } catch {
    // Ignore
  }
  return [];
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
    const cachePath = path.join(getRootConfigDir(), "models_cache.json");
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
  const envPath = path.join(getRootConfigDir(), ".env");

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
    if (val === "") {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
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

  // Reset all tier and subagent specific model overrides to avoid provider mismatch/dead models
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MODEL_DEPTH_") || key.startsWith("MODEL_DEPT") || 
        (key.startsWith("MODEL_") && key !== "MODEL" && key !== "MODEL_LIMITS")) {
      updates[key] = "";
      delete process.env[key];
    }
  }

  const savedModel = process.env[`${prefix}_MODEL`];
  if (savedModel) {
    updates["MODEL"] = savedModel;
  } else {
    const typeLower = (type || "").toLowerCase();
    const nameLower = name.toLowerCase();
    if (typeLower === "openrouter" || nameLower === "openrouter") {
      updates["MODEL"] = "google/gemini-2.5-flash";
    } else if (typeLower === "anthropic" || nameLower === "anthropic") {
      updates["MODEL"] = "claude-3-5-sonnet-20241022";
    } else if (typeLower === "openai" || nameLower === "openai") {
      updates["MODEL"] = "gpt-4o";
    } else {
      updates["MODEL"] = "gpt-4o";
    }
  }

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

export function isAnthropicCompatible(baseUrl: string, modelName: string): boolean {
  const urlLower = baseUrl.toLowerCase();
  const modelLower = modelName.toLowerCase();
  if (urlLower.includes("anthropic")) return true;
  if (
    urlLower.includes("openrouter.ai") ||
    urlLower.includes("openai.com") ||
    urlLower.includes("litellm") ||
    urlLower.includes("ollama") ||
    urlLower.includes("groq") ||
    urlLower.includes("deepinfra") ||
    urlLower.includes("together")
  ) {
    return false;
  }
  return modelLower.includes("claude");
}

export function getModelInstance() {
  const config = getConfig();
  return getModelInstanceForString(config.model);
}

export function getModelInstanceForString(modelStr: string) {
  const config = getConfig();
  
  if (!modelStr) {
    modelStr = config.model;
  }

  let provider = config.provider;
  let modelName = modelStr;
  let apiKey = config.apiKey;
  let baseUrl = config.baseUrl;

  const colonIndex = modelStr.indexOf(":");
  if (colonIndex > 0) {
    const prefix = modelStr.substring(0, colonIndex).toLowerCase();
    const rest = modelStr.substring(colonIndex + 1);
    if (prefix === "anthropic") {
      provider = "anthropic";
      modelName = rest;
      apiKey = process.env.PROVIDER_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || config.apiKey;
      baseUrl = undefined;
    } else if (prefix === "openai") {
      provider = "openai";
      modelName = rest;
      apiKey = process.env.PROVIDER_OPENAI_API_KEY || process.env.OPENAI_API_KEY || config.apiKey;
      baseUrl = undefined;
    } else if (prefix === "custom") {
      provider = "custom";
      modelName = rest;
      apiKey = process.env.PROVIDER_CUSTOM_API_KEY || process.env.CUSTOM_API_KEY || config.apiKey;
      baseUrl = process.env.PROVIDER_CUSTOM_BASE_URL || process.env.CUSTOM_BASE_URL || config.baseUrl;
    } else {
      const providerUpper = prefix.toUpperCase();
      const customKey = process.env[`PROVIDER_${providerUpper}_API_KEY`];
      const customBase = process.env[`PROVIDER_${providerUpper}_BASE_URL`];
      const customType = process.env[`PROVIDER_${providerUpper}_TYPE`];
      if (customKey !== undefined || customBase !== undefined || customType !== undefined) {
        apiKey = customKey || "";
        baseUrl = customBase || undefined;
        modelName = rest;
        const typeLower = (customType || "").toLowerCase();
        if (typeLower === "anthropic") {
          provider = "anthropic";
          baseUrl = undefined;
        } else if (typeLower === "custom" || typeLower === "openrouter" || baseUrl) {
          provider = "custom";
        } else {
          provider = "openai";
        }
      }
    }
  }

  if (provider === "anthropic" || (provider === "custom" && isAnthropicCompatible(baseUrl || "", modelName))) {
    const anthropic = createAnthropic({
      apiKey,
      ...(baseUrl && { baseURL: baseUrl }),
    });
    return anthropic(modelName);
  }

  const openai = createOpenAI({
    apiKey,
    ...(baseUrl && { baseURL: baseUrl }),
    headers: {
      "HTTP-Referer": "https://github.com/RudyCity/superagent",
      "X-Title": "SuperAgent CLI",
    },
  });
  return openai(modelName);
}

export function getModelInstanceForTier(tier: string, depth: number, subagentType?: string) {
  let modelStr = "";

  if (tier === "single") {
    modelStr = process.env.MODEL || "";
  } else if (tier === "master") {
    modelStr = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "";
  } else if (tier === "superagent") {
    modelStr = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "";
  } else if (tier === "subagent") {
    if (subagentType) {
      const typeUpper = subagentType.toUpperCase();
      modelStr = process.env[`MODEL_SUBAGENT_${typeUpper}`] || process.env[`MODEL_${typeUpper}`] || "";
    }
    if (!modelStr) {
      modelStr = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "";
    }
  }

  // Fallback to depth check if tier is not recognized or not specified
  if (!modelStr && tier !== "single") {
    if (depth === 0) {
      modelStr = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "";
    } else if (depth === 1) {
      modelStr = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "";
    } else if (depth >= 2) {
      if (subagentType) {
        const typeUpper = subagentType.toUpperCase();
        modelStr = process.env[`MODEL_SUBAGENT_${typeUpper}`] || process.env[`MODEL_${typeUpper}`] || "";
      }
      if (!modelStr) {
        modelStr = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "";
      }
    }
  }

  if (!modelStr) {
    modelStr = process.env.MODEL || "";
  }

  return getModelInstanceForString(modelStr);
}

export interface ModelPreset {
  name: string;
  description: string;
  models: Record<string, string>;
}

export function getCustomPresetsPath(): string {
  return path.join(getRootConfigDir(), "model-presets.json");
}

export const BUILT_IN_PRESETS: ModelPreset[] = [
  {
    name: "balanced",
    description: "Recommended multi-agent setup: Sonnet for Master/Superagent/Coder/Reviewer, Gemini 2.5 Flash for Researcher and general Subagents.",
    models: {
      MODEL: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPTH_0: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPT0: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPTH_1: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPT1: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPTH_2: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPT2: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_RESEARCHER: "openrouter:google/gemini-2.5-flash",
      MODEL_RESEARCHER: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_CODER: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_CODER: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_SUBAGENT_REVIEWER: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_REVIEWER: "anthropic:claude-3-5-sonnet-20241022"
    }
  },
  {
    name: "openai-full",
    description: "Full OpenAI stack: GPT-4o for Master/Superagent, GPT-4o-mini for Subagents.",
    models: {
      MODEL: "openai:gpt-4o",
      MODEL_DEPTH_0: "openai:gpt-4o",
      MODEL_DEPT0: "openai:gpt-4o",
      MODEL_DEPTH_1: "openai:gpt-4o",
      MODEL_DEPT1: "openai:gpt-4o",
      MODEL_DEPTH_2: "openai:gpt-4o-mini",
      MODEL_DEPT2: "openai:gpt-4o-mini",
      MODEL_SUBAGENT_RESEARCHER: "openai:gpt-4o-mini",
      MODEL_RESEARCHER: "openai:gpt-4o-mini",
      MODEL_SUBAGENT_CODER: "openai:gpt-4o",
      MODEL_CODER: "openai:gpt-4o",
      MODEL_SUBAGENT_REVIEWER: "openai:gpt-4o",
      MODEL_REVIEWER: "openai:gpt-4o"
    }
  },
  {
    name: "anthropic-full",
    description: "Full Anthropic stack: Claude 3.5 Sonnet for Master/Superagent/Coder, Claude 3.5 Haiku for Subagents.",
    models: {
      MODEL: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPTH_0: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPT0: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPTH_1: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPT1: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPTH_2: "anthropic:claude-3-5-haiku-20241022",
      MODEL_DEPT2: "anthropic:claude-3-5-haiku-20241022",
      MODEL_SUBAGENT_RESEARCHER: "anthropic:claude-3-5-haiku-20241022",
      MODEL_RESEARCHER: "anthropic:claude-3-5-haiku-20241022",
      MODEL_SUBAGENT_CODER: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_CODER: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_SUBAGENT_REVIEWER: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_REVIEWER: "anthropic:claude-3-5-sonnet-20241022"
    }
  },
  {
    name: "gemini-full",
    description: "Full Gemini stack (via OpenRouter): Gemini 2.5 Pro for Master/Superagent, Gemini 2.5 Flash for Subagents.",
    models: {
      MODEL: "openrouter:google/gemini-2.5-pro",
      MODEL_DEPTH_0: "openrouter:google/gemini-2.5-pro",
      MODEL_DEPT0: "openrouter:google/gemini-2.5-pro",
      MODEL_DEPTH_1: "openrouter:google/gemini-2.5-pro",
      MODEL_DEPT1: "openrouter:google/gemini-2.5-pro",
      MODEL_DEPTH_2: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPT2: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_RESEARCHER: "openrouter:google/gemini-2.5-flash",
      MODEL_RESEARCHER: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_CODER: "openrouter:google/gemini-2.5-pro",
      MODEL_CODER: "openrouter:google/gemini-2.5-pro",
      MODEL_SUBAGENT_REVIEWER: "openrouter:google/gemini-2.5-pro",
      MODEL_REVIEWER: "openrouter:google/gemini-2.5-pro"
    }
  },
  {
    name: "fast-cheap",
    description: "Cost-efficient setup: Gemini 2.5 Flash for all tiers.",
    models: {
      MODEL: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPTH_0: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPT0: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPTH_1: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPT1: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPTH_2: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPT2: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_RESEARCHER: "openrouter:google/gemini-2.5-flash",
      MODEL_RESEARCHER: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_CODER: "openrouter:google/gemini-2.5-flash",
      MODEL_CODER: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_REVIEWER: "openrouter:google/gemini-2.5-flash",
      MODEL_REVIEWER: "openrouter:google/gemini-2.5-flash"
    }
  }
];

export function getModelPresets(): ModelPreset[] {
  const presets = [...BUILT_IN_PRESETS];
  const customPath = getCustomPresetsPath();
  if (fs.existsSync(customPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(customPath, "utf-8"));
      if (Array.isArray(data)) {
        for (const p of data) {
          if (p && typeof p === "object" && typeof p.name === "string" && p.models && typeof p.models === "object") {
            // Check if name conflicts with built-in
            const idx = presets.findIndex(bp => bp.name.toLowerCase() === p.name.toLowerCase());
            const cleanPreset = {
              name: p.name.toLowerCase(),
              description: p.description || "Custom model preset.",
              models: p.models
            };
            if (idx !== -1) {
              presets[idx] = cleanPreset;
            } else {
              presets.push(cleanPreset);
            }
          }
        }
      }
    } catch {
      // Ignore corruption
    }
  }
  return presets;
}

export function saveModelPreset(name: string, description: string): string {
  const presetName = name.toLowerCase().trim();
  if (!presetName) {
    throw new Error("Preset name cannot be empty");
  }
  if (BUILT_IN_PRESETS.some(bp => bp.name === presetName)) {
    throw new Error(`Cannot overwrite built-in preset "${name}"`);
  }

  // Gather all model variables currently set in process.env
  const models: Record<string, string> = {};
  
  if (process.env.MODEL) models.MODEL = process.env.MODEL;
  if (process.env.MODEL_DEPTH_0) models.MODEL_DEPTH_0 = process.env.MODEL_DEPTH_0;
  if (process.env.MODEL_DEPT0) models.MODEL_DEPT0 = process.env.MODEL_DEPT0;
  if (process.env.MODEL_DEPTH_1) models.MODEL_DEPTH_1 = process.env.MODEL_DEPTH_1;
  if (process.env.MODEL_DEPT1) models.MODEL_DEPT1 = process.env.MODEL_DEPT1;
  if (process.env.MODEL_DEPTH_2) models.MODEL_DEPTH_2 = process.env.MODEL_DEPTH_2;
  if (process.env.MODEL_DEPT2) models.MODEL_DEPT2 = process.env.MODEL_DEPT2;

  for (const [k, v] of Object.entries(process.env)) {
    if (v && k.startsWith("MODEL_SUBAGENT_")) {
      models[k] = v;
    } else if (v && k.startsWith("MODEL_") && k !== "MODEL" && k !== "MODEL_LIMITS") {
      // e.g. MODEL_RESEARCHER, MODEL_CODER, MODEL_REVIEWER
      models[k] = v;
    }
  }

  if (Object.keys(models).length === 0) {
    throw new Error("No model configuration settings found in environment to save.");
  }

  const customPath = getCustomPresetsPath();
  let customPresets: ModelPreset[] = [];
  if (fs.existsSync(customPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(customPath, "utf-8"));
      if (Array.isArray(parsed)) {
        customPresets = parsed;
      }
    } catch {}
  }

  const newPreset: ModelPreset = {
    name: presetName,
    description: description || "Custom model preset.",
    models
  };

  const existingIdx = customPresets.findIndex(p => p.name === presetName);
  if (existingIdx !== -1) {
    customPresets[existingIdx] = newPreset;
  } else {
    customPresets.push(newPreset);
  }

  ensureGlobalConfigDir();
  fs.writeFileSync(customPath, JSON.stringify(customPresets, null, 2), "utf-8");
  return customPath;
}

export function applyModelPreset(name: string): string {
  const presets = getModelPresets();
  const preset = presets.find(p => p.name.toLowerCase() === name.toLowerCase().trim());
  if (!preset) {
    throw new Error(`Model preset "${name}" not found.`);
  }

  const updates: Record<string, string> = {};

  // 1. Reset all current model keys to avoid leaking old configuration
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MODEL_DEPTH_") || key.startsWith("MODEL_DEPT") || 
        (key.startsWith("MODEL_") && key !== "MODEL" && key !== "MODEL_LIMITS")) {
      updates[key] = "";
      delete process.env[key];
    }
  }

  // 2. Set all model keys from the preset
  for (const [key, val] of Object.entries(preset.models)) {
    updates[key] = val;
  }

  // 3. Set standard MODEL if not specified in the preset
  if (!preset.models.MODEL) {
    updates.MODEL = preset.models.MODEL_DEPTH_0 || preset.models.MODEL_DEPT0 || "gpt-4o";
  }

  // 4. Update the active provider if the default model has a provider prefix
  const defaultModel = updates.MODEL;
  if (defaultModel && defaultModel.includes(":")) {
    const providerPart = defaultModel.split(":")[0].toLowerCase();
    updates.ACTIVE_PROVIDER = providerPart;
  }

  return updateEnvFile(updates);
}

export function deleteModelPreset(name: string): string {
  const presetName = name.toLowerCase().trim();
  if (!presetName) {
    throw new Error("Preset name cannot be empty");
  }
  if (BUILT_IN_PRESETS.some(bp => bp.name === presetName)) {
    throw new Error(`Cannot delete built-in preset "${name}"`);
  }

  const customPath = getCustomPresetsPath();
  if (!fs.existsSync(customPath)) {
    throw new Error(`Model preset "${name}" not found.`);
  }

  let customPresets: ModelPreset[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(customPath, "utf-8"));
    if (Array.isArray(parsed)) {
      customPresets = parsed;
    }
  } catch {}

  const existingIdx = customPresets.findIndex(p => p.name === presetName);
  if (existingIdx === -1) {
    throw new Error(`Model preset "${name}" not found.`);
  }

  customPresets.splice(existingIdx, 1);
  ensureGlobalConfigDir();
  fs.writeFileSync(customPath, JSON.stringify(customPresets, null, 2), "utf-8");
  return customPath;
}

export function updateModelPreset(name: string, description: string, models?: Record<string, string>): string {
  const presetName = name.toLowerCase().trim();
  if (!presetName) {
    throw new Error("Preset name cannot be empty");
  }
  if (BUILT_IN_PRESETS.some(bp => bp.name === presetName)) {
    throw new Error(`Cannot edit built-in preset "${name}"`);
  }

  const customPath = getCustomPresetsPath();
  let customPresets: ModelPreset[] = [];
  if (fs.existsSync(customPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(customPath, "utf-8"));
      if (Array.isArray(parsed)) {
        customPresets = parsed;
      }
    } catch {}
  }

  const existingIdx = customPresets.findIndex(p => p.name === presetName);
  if (existingIdx === -1) {
    throw new Error(`Model preset "${name}" not found.`);
  }

  customPresets[existingIdx] = {
    name: presetName,
    description: description || customPresets[existingIdx].description,
    models: models || customPresets[existingIdx].models
  };

  ensureGlobalConfigDir();
  fs.writeFileSync(customPath, JSON.stringify(customPresets, null, 2), "utf-8");
  return customPath;
}


