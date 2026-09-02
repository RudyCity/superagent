/**
 * configTools.ts — Configuration, presets, persistent memory, history queries, token analytics, and Chrome bridge tools for MCP.
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
    `Active Provider: ${activeProvider}`,
    `Configured Providers: ${providers.join(", ")}`,
    `Active Presets: Single = ${singlePreset || "default"} | Multi = ${multiPreset || "default"}`,
    `Effective Models: Single = ${singleModel} | Multi = ${multiModel}`,
    `\nTier Models (Multi-Agent):`,
    ...Object.entries(tierModels).map(([tier, model]) => `  - ${tier}: ${model}`),
    `\nSystem Settings:`,
    `  - Concurrency: ${settings.concurrencyLimit ?? 5}`,
    `  - Max Iterations: ${settings.maxIterations ?? 50}`,
    `  - Streaming: ${settings.disableStreaming ? "Disabled" : "Enabled"}`,
    `  - Rate Limit RPM: ${settings.rateLimitRpm ?? 60}`,
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleSwitchPreset(args: any): Promise<McpToolResult> {
  const presetId = String(args.presetId || args.preset || args.id || "");
  const mode: "multi" | "single" = args.mode === "multi" ? "multi" : "single";
  if (!presetId) {
    return { content: [{ type: "text", text: "Error: 'presetId' is required." }], isError: true };
  }
  applyModelPreset(presetId, mode, true);
  setActivePresetId(mode, presetId);
  return { content: [{ type: "text", text: `Switched ${mode} mode preset to: ${presetId}` }] };
}

export async function handleSwitchProvider(args: any): Promise<McpToolResult> {
  const providerName = String(args.providerName || args.provider || args.name || "");
  if (!providerName) {
    return { content: [{ type: "text", text: "Error: 'providerName' is required." }], isError: true };
  }
  switchActiveProvider(providerName);
  return { content: [{ type: "text", text: `Active AI provider switched to: ${providerName}` }] };
}

export async function handleMemorySearch(args: any): Promise<McpToolResult> {
  const query = String(args.query || args.search || args.keyword || "");
  const limit = typeof args.limit === "number" ? args.limit : 10;
  if (!query) {
    return { content: [{ type: "text", text: "Error: 'query' is required." }], isError: true };
  }
  const allPinned = getAllPinnedKnowledgeFromDb() || [];
  const matched = allPinned
    .filter(
      (p: any) =>
        (p.content || p.preview || "").toLowerCase().includes(query.toLowerCase()) ||
        (p.tag || "").toLowerCase().includes(query.toLowerCase())
    )
    .slice(0, limit);

  if (matched.length === 0) {
    return { content: [{ type: "text", text: `No pinned knowledge found matching: "${query}"` }] };
  }

  const text = matched
    .map(
      (m: any) =>
        `[Tag: ${m.tag || "general"} | ${new Date(Number(m.timestamp) || Date.now()).toISOString()}]: ${m.content || m.preview}`
    )
    .join("\n\n");
  return { content: [{ type: "text", text }] };
}

export async function handleMemorySave(args: any): Promise<McpToolResult> {
  const content = String(args.content || args.text || args.memory || "");
  const tag = String(args.tag || args.category || "general");
  if (!content) {
    return { content: [{ type: "text", text: "Error: 'content' is required." }], isError: true };
  }
  const now = Date.now();
  savePinnedKnowledgeToDb({
    id: `pin_${now}_${Math.random().toString(36).slice(2, 8)}`,
    content,
    preview: content.slice(0, 200),
    tag,
    role: "user",
    pinnedAt: now,
    timestamp: now,
    sourceSessionPath: process.cwd(),
    workingDirectory: process.cwd(),
  });
  return { content: [{ type: "text", text: `Knowledge snippet saved to persistent memory under tag [${tag}].` }] };
}

export async function handleQueryHistory(args: any): Promise<McpToolResult> {
  const action = String(args.action || "list_sessions");
  const limit = typeof args.limit === "number" ? args.limit : 20;

  if (action === "list_sessions") {
    const sessions = listSessionsFromDb(limit);
    const text = sessions
      .map((s: any) => {
        const dateVal = Number(s.lastModified) || 0;
        const dateStr = dateVal > 0 ? new Date(dateVal).toISOString() : "unknown";
        const mode = s.filePath?.includes("multi") ? "multi" : "single";
        const title = s.displayName || s.firstChat || s.preview || "(no title)";
        return `- ID: ${s.id} | Mode: ${mode} | Messages: ${s.messageCount ?? 0} | Updated: ${dateStr} | Title: ${title}`;
      })
      .join("\n");
    return {
      content: [{ type: "text", text: text || "No sessions found in history database." }],
    };
  }

  if (action === "get_messages") {
    const sessionId = String(args.sessionId || args.id || "");
    if (!sessionId) {
      return {
        content: [{ type: "text", text: "Error: 'sessionId' is required for action 'get_messages'." }],
        isError: true,
      };
    }
    const record = loadSessionFromDb(sessionId);
    if (!record) {
      return {
        content: [{ type: "text", text: `Session '${sessionId}' not found in SQLite database.` }],
      };
    }
    const msgs = record.messages || [];
    const text = msgs
      .map(
        (m: any) =>
          `[${(m.role || "unknown").toUpperCase()}]: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`
      )
      .join("\n\n");
    return {
      content: [{ type: "text", text: text || "(Session has no messages)" }],
    };
  }

  if (action === "search") {
    const query = String(args.query || args.keyword || "");
    if (!query) {
      return {
        content: [{ type: "text", text: "Error: 'query' is required for action 'search'." }],
        isError: true,
      };
    }
    const results = searchMessagesInDb(query, limit);
    if (results.length === 0) {
      return { content: [{ type: "text", text: `No history matches found for query: "${query}"` }] };
    }
    const text = results
      .map((r: any) => {
        const dateVal = Number(r.timestamp) || 0;
        const dateStr = dateVal > 0 ? new Date(dateVal).toISOString() : "unknown";
        const snip = (r.content || "").length > 200 ? (r.content || "").slice(0, 200) + "..." : r.content || "";
        return `[Session ${r.sessionId} | ${r.role} | ${dateStr}]: ${snip}`;
      })
      .join("\n\n");
    return {
      content: [{ type: "text", text }],
    };
  }

  return {
    content: [{ type: "text", text: `Unknown history action: ${action}` }],
    isError: true,
  };
}

export async function handleGetTokenUsage(): Promise<McpToolResult> {
  const lines = [
    "=== Superagent Context & Token Analytics ===",
    `Master Tokens:`,
    `  - Total Prompt Tokens: ${masterPromptTokens}`,
    `  - Total Completion Tokens: ${masterCompletionTokens}`,
    `  - Last Prompt Tokens: ${lastMasterPromptTokens}`,
    `\nContext Limits:`,
    `  - Window Limit: ${getSettings().contextWindowLimit || "auto"}`,
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
    const statusText = [
      `Remote Chrome Bridge Status: ${connected ? "🟢 Connected (Port 9223)" : "🔴 Disconnected"}`,
      meta ? `  - Platform: ${meta.platform || "unknown"} | Extension Version: ${meta.extensionVersion || "1.0.0"}` : "",
      meta ? `  - Active Tab: ${meta.activeTab?.title || "(none)"} (${meta.activeTab?.url || ""})` : "",
      meta ? `  - Total Commands Executed: ${meta.commandCount}` : "",
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text: statusText }] };
  }

  try {
    await ensureRemoteChromeBridge();
    const result = await sendRemoteCommand(action, target, value);
    return { content: [{ type: "text", text: result || `Chrome action '${action}' completed.` }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Remote Chrome error: ${err.message}` }], isError: true };
  }
}

export async function handleExportSession(args: any): Promise<McpToolResult> {
  const sessionId = String(args.sessionId || args.id || "");
  const format = String(args.format || "markdown").toLowerCase();

  if (!sessionId) {
    return { content: [{ type: "text", text: "Error: 'sessionId' is required to export." }], isError: true };
  }

  const record = loadSessionFromDb(sessionId);
  if (!record) {
    return { content: [{ type: "text", text: `Session '${sessionId}' not found in SQLite database.` }], isError: true };
  }

  if (format === "json") {
    return { content: [{ type: "text", text: JSON.stringify(record, null, 2) }] };
  }

  const lines = [
    `# Superagent Session Transcript: ${sessionId}`,
    `Working Directory: ${record.session?.workingDirectory || "unknown"}`,
    `Total Messages: ${(record.messages || []).length}`,
    `Exported At: ${new Date().toISOString()}`,
    `\n---\n`,
  ];

  for (const m of record.messages || []) {
    const role = (m.role || "unknown").toUpperCase();
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 2);
    lines.push(`## [${role}]\n\n${content}\n`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
