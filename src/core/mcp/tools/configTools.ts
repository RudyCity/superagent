/**
 * configTools.ts — Configuration, presets, persistent memory, history queries,
 * token analytics, context compaction, and Chrome bridge tools for MCP.
 */

import { McpToolResult } from "../types.js";
import {
  listSessionsFromDb,
  loadSessionFromDb,
  searchMessagesInDb,
  savePinnedKnowledgeToDb,
  getAllPinnedKnowledgeFromDb,
} from "../../storage/historyDb.js";
import {
  getSettings,
  getActivePresetId,
  setActivePresetId,
  applyModelPreset,
  switchActiveProvider,
  getActiveProviderName,
  getConfiguredProviders,
  getEffectiveMasterModel,
  getAllTierModels,
} from "../../config.js";
import {
  masterPromptTokens,
  masterCompletionTokens,
  lastMasterPromptTokens,
} from "../../tools/state.js";
import {
  isRemoteChromeConnected,
  ensureRemoteChromeBridge,
  sendRemoteCommand,
  getRemoteChromeClientMetadata,
} from "../../tools/remoteChromeBridge.js";

/** Safe date formatter — never throws Invalid time value */
function safeDate(val: unknown): string {
  try {
    const n = typeof val === "string" ? Date.parse(val) : Number(val);
    if (!isNaN(n) && n > 0) return new Date(n).toISOString();
  } catch {}
  return "unknown";
}

/**
 * Formats a message record into rich readable text including reasoning,
 * tool calls (with arguments), and tool results (with outputs/errors).
 */
export function formatMessageDetails(m: any, isDetailed: boolean = false): string {
  const role = (m.role || "unknown").toUpperCase();
  const parts: string[] = [];

  if (m.reasoning && String(m.reasoning).trim()) {
    const r = String(m.reasoning).trim();
    parts.push(`[Reasoning]\n${isDetailed ? r : (r.length > 300 ? r.slice(0, 300) + "..." : r)}`);
  }

  if (m.content && typeof m.content === "string" && m.content.trim()) {
    const c = m.content.trim();
    parts.push(isDetailed ? c : (c.length > 500 ? c.slice(0, 500) + "..." : c));
  } else if (m.content && typeof m.content !== "string") {
    parts.push(JSON.stringify(m.content, null, 2));
  }

  // Tool calls (usually attached to assistant message)
  let toolCalls = m.toolCalls;
  if (typeof toolCalls === "string" && toolCalls.trim()) {
    try { toolCalls = JSON.parse(toolCalls); } catch {}
  }
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      const name = tc.name || tc.toolName || "tool";
      const argsStr = tc.args ? (typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args, null, isDetailed ? 2 : undefined)) : "";
      const argsPreview = isDetailed ? argsStr : (argsStr.length > 300 ? argsStr.slice(0, 300) + "..." : argsStr);
      parts.push(`[Tool Call: ${name}]\nArgs: ${argsPreview}`);
    }
  }

  // Tool results (in tool messages or attached to tool_end)
  let toolResults = m.toolResults;
  if (typeof toolResults === "string" && toolResults.trim()) {
    try { toolResults = JSON.parse(toolResults); } catch {}
  }
  if (Array.isArray(toolResults) && toolResults.length > 0) {
    for (const tr of toolResults) {
      const name = tr.name || tr.toolName || "tool";
      const resVal = tr.result !== undefined ? tr.result : tr.output;
      const resStr = typeof resVal === "string" ? resVal : (resVal !== undefined ? JSON.stringify(resVal, null, isDetailed ? 2 : undefined) : "");
      const resPreview = isDetailed ? resStr : (resStr.length > 400 ? resStr.slice(0, 400) + "..." : resStr);
      const status = tr.isError ? "Error" : "Success";
      parts.push(`[Tool Result: ${name} (${status})]\n${resPreview}`);
    }
  }

  const body = parts.join("\n\n") || "(empty message)";
  return `## [${role}]\n\n${body}\n`;
}

export async function handleGetConfig(): Promise<McpToolResult> {
  const settings = getSettings();
  const activeProvider = getActiveProviderName();
  const providers = getConfiguredProviders();
  const singlePreset = getActivePresetId("single");
  const multiPreset = getActivePresetId("multi");
  const singleModel = getEffectiveMasterModel("single");
  const multiModel = getEffectiveMasterModel("multi");
  const tierModels = getAllTierModels("multi");

  const lines = [
    "=== Superagent Configuration ===",
    `Active Provider: ${activeProvider || "none"}`,
    `Configured Providers: ${providers.length > 0 ? providers.map((p: any) => p.name || p).join(", ") : "none"}`,
    `Active Presets: Single = ${singlePreset || "default"} | Multi = ${multiPreset || "default"}`,
    `Effective Models:`,
    `  - Single: ${singleModel}`,
    `  - Multi Master: ${multiModel}`,
    `Tier Models (Multi):`,
    ...Object.entries(tierModels).map(([tier, model]) => `  - ${tier}: ${model}`),
    `\nSystem Settings:`,
    `  - Context Window Limit: ${settings.contextWindowLimit || "auto"}`,
    `  - Max Iterations: ${settings.maxIterations || "auto"}`,
    `  - Streaming: ${settings.disableStreaming ? "disabled" : "enabled"}`,
    `  - Max Concurrency: ${settings.concurrencyLimit ?? 4}`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleSwitchPreset(args: any): Promise<McpToolResult> {
  const presetId = String(args.presetId || args.preset || args.id || "");
  const mode = (args.mode === "multi" ? "multi" : "single") as "multi" | "single";

  if (!presetId) {
    return { content: [{ type: "text", text: "Error: 'presetId' is required." }], isError: true };
  }

  try {
    setActivePresetId(mode, presetId);
    applyModelPreset(presetId, mode, true);
    return {
      content: [{ type: "text", text: `Preset '${presetId}' applied for ${mode} mode.` }],
    };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Failed to switch preset: ${err.message}` }], isError: true };
  }
}

export async function handleSwitchProvider(args: any): Promise<McpToolResult> {
  const providerName = String(args.providerName || args.provider || args.name || "");
  if (!providerName) {
    return { content: [{ type: "text", text: "Error: 'providerName' is required." }], isError: true };
  }
  try {
    const ok = switchActiveProvider(providerName);
    return {
      content: [{ type: "text", text: ok ? `Switched active provider to: ${providerName}` : `Provider '${providerName}' not found in configured providers.` }],
      isError: !ok,
    };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Failed to switch provider: ${err.message}` }], isError: true };
  }
}

export async function handleMemorySearch(args: any): Promise<McpToolResult> {
  const query = String(args.query || args.search || args.keyword || "");
  const limit = typeof args.limit === "number" ? args.limit : 20;

  if (!query) {
    return { content: [{ type: "text", text: "Error: 'query' is required for memory search." }], isError: true };
  }

  const allPinned = getAllPinnedKnowledgeFromDb();
  const lower = query.toLowerCase();
  const matched = allPinned
    .filter((p: any) => {
      const content = String(p.content || "").toLowerCase();
      const tag = String(p.tag || "").toLowerCase();
      const preview = String(p.preview || "").toLowerCase();
      return content.includes(lower) || tag.includes(lower) || preview.includes(lower);
    })
    .slice(0, limit);

  if (matched.length === 0) {
    return { content: [{ type: "text", text: `No persistent memories matched query: "${query}"` }] };
  }

  const text = matched
    .map((p: any) => {
      const dateStr = safeDate(p.pinnedAt || p.timestamp);
      return `[Tag: ${p.tag || "general"} | Saved: ${dateStr}]\n${p.content || ""}`;
    })
    .join("\n\n---\n\n");

  return { content: [{ type: "text", text: `Found ${matched.length} memory snippet(s):\n\n${text}` }] };
}

export async function handleMemorySave(args: any): Promise<McpToolResult> {
  const content = String(args.content || args.knowledge || args.text || "");
  const tag = String(args.tag || args.category || "general");

  if (!content) {
    return { content: [{ type: "text", text: "Error: 'content' is required to save memory." }], isError: true };
  }

  const now = Date.now();
  const preview = content.length > 100 ? content.slice(0, 100) + "..." : content;
  const id = `mcp_mem_${now}_${Math.random().toString(36).slice(2, 8)}`;

  savePinnedKnowledgeToDb({
    id,
    content,
    preview,
    tag,
    role: "assistant",
    pinnedAt: now,
    timestamp: now,
    sourceSessionPath: process.cwd(),
    workingDirectory: process.cwd(),
  });

  return { content: [{ type: "text", text: `Knowledge snippet saved to persistent memory under tag [${tag}]. ID: ${id}` }] };
}

export async function handleQueryHistory(args: any): Promise<McpToolResult> {
  const action = String(args.action || "list_sessions");
  const limit = typeof args.limit === "number" ? Math.min(args.limit, 100) : 20;

  if (action === "list_sessions") {
    let sessions: any[] = [];
    try {
      sessions = listSessionsFromDb(limit);
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error reading sessions: ${err.message}` }], isError: true };
    }

    if (sessions.length === 0) {
      return { content: [{ type: "text", text: "No sessions found in history database." }] };
    }

    const text = sessions
      .map((s: any) => {
        const dateStr = safeDate(s.lastModified);
        const mode = s.filePath?.includes("multi") ? "multi" : "single";
        const title = (s.displayName || s.firstChat || s.preview || "(no title)").slice(0, 80);
        const msgCount = s.messageCount ?? 0;
        return `- ID: ${s.id} | ${mode} | ${msgCount} msg | ${dateStr} | ${title}`;
      })
      .join("\n");

    return { content: [{ type: "text", text: `Recent Sessions (${sessions.length}):\n${text}` }] };
  }

  if (action === "get_messages") {
    const sessionId = String(args.sessionId || args.id || "");
    if (!sessionId) {
      return { content: [{ type: "text", text: "Error: 'sessionId' is required for action 'get_messages'." }], isError: true };
    }

    let record: any = null;
    try {
      record = loadSessionFromDb(sessionId);
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error loading session: ${err.message}` }], isError: true };
    }

    if (!record) {
      return { content: [{ type: "text", text: `Session '${sessionId}' not found.` }] };
    }

    const msgs = record.messages || [];
    if (msgs.length === 0) {
      return { content: [{ type: "text", text: `Session '${sessionId}' has no messages.` }] };
    }

    const msgLimit = typeof args.messageLimit === "number" ? args.messageLimit : 50;
    const sliced = msgs.slice(-msgLimit);
    const text = sliced
      .map((m: any) => formatMessageDetails(m, false))
      .join("\n");

    return { content: [{ type: "text", text: `Messages for session ${sessionId} (last ${sliced.length}):\n\n${text}` }] };
  }

  if (action === "search") {
    const query = String(args.query || args.keyword || "");
    if (!query) {
      return { content: [{ type: "text", text: "Error: 'query' is required for action 'search'." }], isError: true };
    }

    let results: any[] = [];
    try {
      results = searchMessagesInDb(query, limit);
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error searching messages: ${err.message}` }], isError: true };
    }

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No history matches for: "${query}"` }] };
    }

    const text = results
      .map((r: any) => {
        const dateStr = safeDate(r.timestamp);
        const snip = (r.content || "").slice(0, 200);
        return `[Session ${r.sessionId} | ${r.role} | ${dateStr}]: ${snip}${(r.content || "").length > 200 ? "..." : ""}`;
      })
      .join("\n\n");

    return { content: [{ type: "text", text: `Found ${results.length} match(es) for "${query}":\n\n${text}` }] };
  }

  return { content: [{ type: "text", text: `Unknown history action '${action}'. Valid: list_sessions, get_messages, search.` }], isError: true };
}

export async function handleGetTokenUsage(): Promise<McpToolResult> {
  const settings = getSettings();
  const windowLimit = settings.contextWindowLimit || "auto";
  const totalUsed = masterPromptTokens + masterCompletionTokens;
  const limitNum = typeof windowLimit === "number" ? windowLimit : 0;
  const usagePercent = limitNum > 0 ? ((totalUsed / limitNum) * 100).toFixed(1) : "N/A";

  const lines = [
    "=== Superagent Context & Token Analytics ===",
    `Master Agent Tokens:`,
    `  - Total Prompt Tokens: ${masterPromptTokens.toLocaleString()}`,
    `  - Total Completion Tokens: ${masterCompletionTokens.toLocaleString()}`,
    `  - Total Combined: ${totalUsed.toLocaleString()}`,
    `  - Last Prompt Tokens: ${lastMasterPromptTokens.toLocaleString()}`,
    `\nContext Window:`,
    `  - Limit: ${windowLimit}`,
    `  - Usage: ${usagePercent}%`,
    `  - Max Iterations: ${settings.maxIterations || "auto"}`,
    `  - Streaming: ${settings.disableStreaming ? "disabled" : "enabled"}`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleRemoteChrome(args: any): Promise<McpToolResult> {
  const action = String(args.action || "status");
  const target = String(args.target || args.url || args.selector || "");
  const value = args.value ? String(args.value) : undefined;

  if (action === "status") {
    const connected = isRemoteChromeConnected();
    const meta = getRemoteChromeClientMetadata();
    const lines = [
      `Remote Chrome Bridge: ${connected ? "Connected (port 9223)" : "Disconnected"}`,
      meta ? `  Platform: ${meta.platform || "unknown"} | Extension: v${meta.extensionVersion || "1.0.0"}` : "",
      meta?.activeTab ? `  Active Tab: ${meta.activeTab.title || "(none)"} - ${meta.activeTab.url || ""}` : "",
      meta ? `  Commands sent: ${meta.commandCount}` : "",
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  try {
    await ensureRemoteChromeBridge();
    const result = await sendRemoteCommand(action, target, value);
    return { content: [{ type: "text", text: result || `Chrome action '${action}' executed.` }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Remote Chrome error: ${err.message}` }], isError: true };
  }
}

export async function handleExportSession(args: any): Promise<McpToolResult> {
  const sessionId = String(args.sessionId || args.id || "");
  const format = String(args.format || "markdown").toLowerCase();

  if (!sessionId) {
    return { content: [{ type: "text", text: "Error: 'sessionId' is required." }], isError: true };
  }

  let record: any = null;
  try {
    record = loadSessionFromDb(sessionId);
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error loading session: ${err.message}` }], isError: true };
  }

  if (!record) {
    return { content: [{ type: "text", text: `Session '${sessionId}' not found.` }], isError: true };
  }

  if (format === "json") {
    return { content: [{ type: "text", text: JSON.stringify(record, null, 2) }] };
  }

  const workDir = record.session?.workingDirectory || record.workingDirectory || "unknown";
  const messages = record.messages || [];
  const lines = [
    `# Superagent Session: ${sessionId}`,
    `Working Directory: ${workDir}`,
    `Total Messages: ${messages.length}`,
    `Exported: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ];

  for (const m of messages) {
    lines.push(formatMessageDetails(m, true));
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleCompactContext(args: any): Promise<McpToolResult> {
  const strategy = String(args.strategy || "auto");
  const maxTokens = typeof args.maxTokens === "number" ? args.maxTokens : 4000;
  const settings = getSettings();
  const windowLimit = settings.contextWindowLimit || "auto";
  const totalUsed = masterPromptTokens + masterCompletionTokens;

  const lines = [
    "Context Compaction Status:",
    `  - Strategy: ${strategy}`,
    `  - Target Token Budget: ${maxTokens.toLocaleString()}`,
    `  - Current Usage: ${totalUsed.toLocaleString()} / ${windowLimit}`,
    `  - Available Strategies: SummarizationStrategy, PruningStrategy, PinningStrategy`,
    `  - Status: ContextManager is active and manages compaction automatically.`,
    strategy !== "auto" ? `  - Manual ${strategy} strategy will be prioritized at next overflow.` : "",
  ].filter(Boolean);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleServerHealth(): Promise<McpToolResult> {
  const { callServerApi } = await import("./processTools.js");
  const { loadActiveProcesses } = await import("../processJournal.js");

  const lines = ["=== Superagent Server Health ==="];

  // Check background HTTP server (port 7888)
  const ping = await callServerApi("/api/ping", "GET", undefined, 2000);
  if (ping.success) {
    lines.push(`Background HTTP Server (port 7888): Online`);
    if (ping.data?.version) lines.push(`  Version: ${ping.data.version}`);
  } else {
    lines.push(`Background HTTP Server (port 7888): Offline (${ping.error || "no response"})`);
  }

  // Check live CLI processes
  const procs = loadActiveProcesses().filter((p) => p.mode !== "mcp");
  if (procs.length > 0) {
    lines.push(`\nActive CLI Sessions: ${procs.length}`);
    for (const p of procs) {
      const uptimeSec = Math.round((Date.now() - p.startedAt) / 1000);
      const m = Math.floor(uptimeSec / 60);
      const s = uptimeSec % 60;
      const uptimeStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
      lines.push(`  - PID ${p.pid} | ${p.mode} | ${p.workingDirectory} | Uptime: ${uptimeStr} | Agent: ${p.isAgentRunning ? "Running" : "Idle"}`);
      if ((p.activeSuperagents || []).length > 0) {
        for (const sa of p.activeSuperagents!) {
          lines.push(`    • Superagent [${sa.id}] ${sa.role} -> ${sa.status}`);
        }
      }
    }
  } else {
    lines.push(`\nActive CLI Sessions: None`);
  }

  // Check Remote Chrome bridge
  const chromeConnected = isRemoteChromeConnected();
  lines.push(`\nRemote Chrome Bridge (port 9223): ${chromeConnected ? "Connected" : "Disconnected"}`);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
