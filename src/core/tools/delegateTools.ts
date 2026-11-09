import type { Tool } from "./types.js";
import { delegateBridge, type DelegateMethod } from "../delegate/bridge.js";
import {
  ensureDelegateHistoryIndexWarm,
  getDelegateHistoryIndexStats,
  searchDelegateHistoryIndex,
  syncDelegateHistoryIndex,
} from "../delegate/historySync.js";
import { runDelegateUntilDone } from "../delegate/runUntilDone.js";
import { delegateMultiTabOrchestrator } from "../delegate/multiTabOrchestrator.js";
import { hasDelegateClaim, withDelegateTargetLock } from "../browserTransport/sessionCoordinator.js";
import {
  bindDelegateSemanticAffinity,
  inspectDelegateSemanticAffinity,
  resolveDelegateSemanticAffinity,
} from "../delegate/semanticTabAffinity.js";
import {
  configureDelegateChatOnLockedTarget,
  inspectDelegateChatConfigurationOnLockedTarget,
  validateDelegateChatConfig,
  type DelegateChatConfigRequest,
} from "../delegate/chatConfiguration.js";

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

const optionalTarget = {
  clientId: {
    type: "string", minLength: 8, maxLength: 80,
    description: "Target Chrome Delegate clientId from delegate.read_chat({connections:true}). Required when multiple Chrome profiles are connected.",
  },
  tabId: {
    type: "integer", minimum: 1,
    description: "Optional exact ChatGPT tab ID within the selected Chrome profile. No automatic tab fallback if specified.",
  },
};

const requestIdParameter = {
  type: "string", minLength: 8, maxLength: 80,
  description: "Stable idempotency key: never resends after confirmed or uncertain result.",
};

const modelParameter = {
  type: "string", minLength: 2, maxLength: 80,
  description: "Visible ChatGPT model label to select before the mutation, for example GPT-5.6. Matching is fail-closed if the UI option is absent or ambiguous.",
};
const effortParameter = {
  type: "string", enum: ["low", "medium", "high", "xhigh"],
  description: "ChatGPT reasoning effort to select before the mutation. Fails closed if the account/model UI does not expose that effort.",
};

function resolvedConnectedClientId(explicit?: string): string | undefined {
  const clients = delegateBridge.listConnections();
  if (explicit) return clients.some(client => client.clientId === explicit) ? explicit : undefined;
  return clients.length === 1 ? clients[0].clientId : undefined;
}

async function resolveReadAffinityTab(
  clientId: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const existing = resolveDelegateSemanticAffinity(clientId);
  if (existing) return existing.tabId;

  // Prefer Delegate-CDP inventory because it is a single browser query and
  // does not probe every ChatGPT tab DOM. This is observation-only: the chosen
  // tab is bound as "observed" and can never authorize a semantic mutation.
  try {
    const { delegateCdpTransport } = await import("../delegate/cdpTransport.js");
    const rows = await delegateCdpTransport.rpc<any[]>(
      "delegate.cdp.list_targets", {}, signal, clientId);
    const tabs = Array.isArray(rows) ? rows.filter((tab: any) =>
      Number.isSafeInteger(tab?.tabId) && Number(tab.tabId) > 0 &&
      typeof tab?.url === "string" && /^https:\/\/chatgpt\.com\//.test(tab.url) &&
      !String(tab.url).includes("delegate-history-worker")) : [];
    const active = tabs.filter((tab: any) => tab.active === true);
    const selected = active.length === 1 ? active[0] : tabs.length === 1 ? tabs[0] : undefined;
    if (selected) {
      bindDelegateSemanticAffinity(clientId, Number(selected.tabId), "observed");
      return Number(selected.tabId);
    }
    if (tabs.length > 1) {
      throw new Error(
        "CHATGPT_MULTIPLE_TABS: Multiple ChatGPT tabs are available; choose an exact tabId. No action was dispatched.");
    }
  } catch (error) {
    if (String((error as any)?.message || error).includes("CHATGPT_MULTIPLE_TABS")) throw error;
    // Semantic-only profiles may not advertise Delegate-CDP. Fall through to
    // the compatibility listing below.
  }

  const raw = await delegateBridge.request("delegate.list_tabs", {}, signal, 5_000, clientId);
  let value: any;
  try { value = JSON.parse(raw); } catch { return undefined; }
  const tabs = Array.isArray(value?.tabs) ? value.tabs.filter((tab: any) =>
    Number.isSafeInteger(tab?.tabId) && Number(tab.tabId) > 0 && tab?.ready !== false &&
    typeof tab?.url === "string" && /^https:\/\/chatgpt\.com\//.test(tab.url) &&
    !String(tab.url).includes("delegate-history-worker")) : [];
  const active = tabs.filter((tab: any) => tab.active === true);
  const selected = active.length === 1 ? active[0] : tabs.length === 1 ? tabs[0] : undefined;
  if (!selected) {
    if (tabs.length > 1) {
      throw new Error(
        "CHATGPT_MULTIPLE_TABS: Multiple ChatGPT tabs are available; choose an exact tabId. No action was dispatched.");
    }
    return undefined;
  }
  bindDelegateSemanticAffinity(clientId, Number(selected.tabId), "observed");
  return Number(selected.tabId);
}

function bindExplicitTabIfPresent(clientId: string | undefined, params: Record<string, unknown>): void {
  if (clientId && Number.isSafeInteger(params.tabId) && Number(params.tabId) > 0) {
    bindDelegateSemanticAffinity(clientId, Number(params.tabId), "explicit");
  }
}

/** Semantic Delegate writes share the Delegate-CDP FIFO target lock. */
export async function withSemanticDelegateTarget<T>(
  name: string, clientId: string | undefined, tabId: unknown, newTab: boolean,
  fn: (clientId: string) => Promise<T>,
): Promise<T> {
  if (!clientId) throw new Error("DELEGATE_EXPLICIT_CLIENT_REQUIRED: Supply clientId for mutations");
  if (!delegateBridge.listConnections().some(client => client.clientId === clientId)) {
    throw new Error("DELEGATE_TARGET_NOT_CONNECTED: Explicit Chrome profile is offline");
  }
  if (newTab && name === "delegate.create_chat") return fn(clientId);
  if (!Number.isSafeInteger(tabId) || Number(tabId) < 1) {
    throw new Error("DELEGATE_EXPLICIT_TAB_REQUIRED: Supply exact tabId; no implicit mutation target");
  }
  return withDelegateTargetLock(clientId, Number(tabId), async () => {
    if (!delegateBridge.listConnections().some(client => client.clientId === clientId)) {
      throw new Error("DELEGATE_TARGET_NOT_CONNECTED: Target profile disconnected");
    }
    if (hasDelegateClaim(clientId, Number(tabId))) {
      throw new Error("DELEGATE_CDP_TARGET_CLAIMED: Release CDP ownership before semantic mutation");
    }
    if (delegateMultiTabOrchestrator.isReserved(clientId, Number(tabId))) {
      throw new Error("MULTITAB_TARGET_RESERVED: Release orchestrator reservation before direct mutation");
    }
    return fn(clientId);
  });
}

function prepareTarget(
  args: Record<string, unknown>,
  allowMessage: boolean,
  allowNewTab = false,
  allowConfig = false,
): { clientId?: string; params: Record<string, unknown>; config?: DelegateChatConfigRequest } {
  const keys = Object.keys(args || {});
  if (keys.some(k => !["clientId", "tabId", "requestId",
      ...(allowMessage ? ["message"] : []),
      ...(allowNewTab ? ["newTab"] : []),
      ...(allowConfig ? ["model", "effort"] : [])].includes(k))) {
    throw new Error("DELEGATE_INVALID_ARGUMENT: Unexpected delegate tool argument");
  }
  const clientId = args?.clientId;
  if (clientId !== undefined &&
      (typeof clientId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(clientId))) {
    throw new Error("DELEGATE_INVALID_CLIENT_ID: Use a clientId from delegate.read_chat({connections:true})");
  }
  const params: Record<string, unknown> = {};
  if (args?.requestId !== undefined && (typeof args.requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{8,80}$/.test(args.requestId))) {
    throw new Error("DELEGATE_INVALID_REQUEST_ID: Use 8-80 letters, digits, underscores or hyphens");
  }
  if (args?.tabId !== undefined) {
    if (!Number.isSafeInteger(args.tabId) || (args.tabId as number) < 1) {
      throw new Error("DELEGATE_INVALID_TAB_ID: tabId must be a positive integer");
    }
    params.tabId = args.tabId;
  }
  if (allowNewTab && args?.newTab !== undefined) {
    if (typeof args.newTab !== "boolean") {
      throw new Error("DELEGATE_INVALID_NEW_TAB: newTab must be boolean");
    }
    if (args.newTab && params.tabId !== undefined) {
      throw new Error("DELEGATE_INVALID_ARGUMENT: newTab cannot be combined with tabId");
    }
    if (args.newTab) params.newTab = true;
  }
  if (allowMessage) {
    if (typeof args.message !== "string" || !args.message.trim() || args.message.length > 100_000) {
      throw new Error("DELEGATE_INVALID_MESSAGE: message must be nonempty text of at most 100000 characters");
    }
    params.message = args.message;
  }
  let config: DelegateChatConfigRequest | undefined;
  if (allowConfig && (args.model !== undefined || args.effort !== undefined)) {
    config = {
      ...(args.model !== undefined ? { model: args.model as string } : {}),
      ...(args.effort !== undefined ? { effort: args.effort as any } : {}),
    };
    validateDelegateChatConfig(config);
  }
  return { clientId: clientId as string | undefined, params, config };
}

function prepareHistoryTarget(
  args: Record<string, unknown>,
  allowedKeys: string[],
): { clientId?: string; params: Record<string, unknown> } {
  const keys = Object.keys(args || {});
  if (keys.some(key => !["clientId", ...allowedKeys].includes(key))) {
    throw new Error("DELEGATE_INVALID_ARGUMENT: Unexpected delegate history argument");
  }
  const clientId = args?.clientId;
  if (clientId !== undefined &&
      (typeof clientId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(clientId))) {
    throw new Error("DELEGATE_INVALID_CLIENT_ID: Use a clientId from delegate.read_chat({connections:true})");
  }
  const params = { ...args };
  delete params.clientId;
  return { clientId: clientId as string | undefined, params };
}

function historyTool(
  name: DelegateMethod,
  description: string,
  parameters: Record<string, unknown>,
  validate: (params: Record<string, unknown>) => void,
  timeoutMs: number,
): Tool {
  return {
    name, description, parameters,
    async execute(args: Record<string, unknown>, _cwd: string, signal?: AbortSignal): Promise<string> {
      try {
        const allowedKeys = Object.keys((parameters as { properties?: Record<string, unknown> }).properties || {})
          .filter(key => key !== "clientId");
        const { clientId, params } = prepareHistoryTarget(args, allowedKeys);
        validate(params);
        return await delegateBridge.request(name, params, signal, timeoutMs, clientId);
      } catch (error) {
        return "Error: " + (error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function tool(
  name: DelegateMethod,
  description: string,
  parameters: Record<string, unknown>,
  timeoutMs = 20_000,
  allowMessage = false,
  allowConnectionList = false,
  allowNewTab = false,
  allowConfig = false,
): Tool {
  return {
    name, description, parameters,
    async execute(args: Record<string, unknown>, _cwd: string, signal?: AbortSignal): Promise<string> {
      try {
        if (allowConnectionList && args?.connections === true) {
          if (Object.keys(args).some(k => !["connections"].includes(k))) {
            throw new Error("DELEGATE_INVALID_ARGUMENT: connections:true cannot be combined with other options");
          }
          const clients = delegateBridge.listConnections();
          return JSON.stringify({
            connections: clients,
            count: clients.length,
            hint: "For multiple connected profiles, pass clientId to create_chat, read_chat, send_message or stop_generation.",
          });
        }
        const copy = { ...args };
        if (allowConnectionList) {
          if (copy.connections !== undefined && copy.connections !== false) {
            throw new Error("DELEGATE_INVALID_ARGUMENT: connections must be boolean");
          }
          delete copy.connections;
        }
        const { clientId, params, config } = prepareTarget(copy, allowMessage, allowNewTab, allowConfig);
        const selectedClient = resolvedConnectedClientId(clientId);
        bindExplicitTabIfPresent(selectedClient, params);
        if (["delegate.create_chat", "delegate.send_message", "delegate.stop_generation"].includes(name)) {
          // Mutations always require caller-selected profile identity. A single
          // connected profile is still not implicit authorization to mutate it.
          const mutationClient = clientId;
          if (params.tabId === undefined && params.newTab !== true && mutationClient) {
            const affinity = resolveDelegateSemanticAffinity(mutationClient, { write: true });
            if (affinity) params.tabId = affinity.tabId;
          }
          const onceParams = config ? { ...params, ...config } : params;
          const output = await withSemanticDelegateTarget(name, mutationClient, params.tabId, params.newTab === true,
            selected => delegateBridge.executeOnce(args.requestId as string | undefined,
              name, selected, onceParams, async () => {
                if (name === "delegate.send_message" && config) {
                  await configureDelegateChatOnLockedTarget(
                    selected, Number(params.tabId), config, signal);
                }
                const bridgeOutput = await delegateBridge.request(
                  name, params, signal, timeoutMs, selected);
                if (name !== "delegate.create_chat" || !config) return bridgeOutput;

                let targetTab = Number(params.tabId);
                let parsed: any = null;
                try { parsed = JSON.parse(String(bridgeOutput)); } catch {}
                if (params.newTab === true) targetTab = Number(parsed?.tabId);
                if (!Number.isSafeInteger(targetTab) || targetTab < 1)
                  throw new Error("DELEGATE_CONFIG_TARGET_NOT_CONFIRMED");

                const apply = async () => configureDelegateChatOnLockedTarget(
                  selected, targetTab, config, signal);
                let applied;
                try {
                  applied = params.newTab === true
                    ? await withSemanticDelegateTarget(
                        "delegate.configure_chat", selected, targetTab, false, () => apply())
                    : await apply();
                } catch (error) {
                  const code = error instanceof Error ? error.message : String(error);
                  if (!(params.newTab === true && config.effort &&
                        code === "CHATGPT_EFFORT_POSTCONDITION_FAILED")) throw error;

                  // A freshly opened ChatGPT tab can commit the power change only
                  // after CDP detaches. Verify the settled state without replaying
                  // any model click, arrow key, create_chat, or send mutation.
                  let settledMatch: {
                    modelControl?: { text: string; aria: string | null };
                    effortStatus?: string;
                  } | null = null;
                  const settleDeadline = Date.now() + 7_000;
                  while (Date.now() < settleDeadline && !settledMatch) {
                    await new Promise(resolve => setTimeout(resolve, 650));
                    const settled = await withSemanticDelegateTarget(
                      "delegate.inspect_chat_config", selected, targetTab, false,
                      () => inspectDelegateChatConfigurationOnLockedTarget(
                        selected, targetTab, signal),
                    );
                    const modelControl = settled.controls.find(row =>
                      String(row.aria || "").toLowerCase().includes("select chatgpt model"));
                    const effortStatus =
                      settled.effort_status_path?.find(row => row.role === "status")?.text ||
                      modelControl?.text || "";
                    const statusText = [
                      modelControl?.text || "",
                      ...(settled.effort_status_path || []).map(row => row.text || ""),
                    ].join(" ").toLowerCase();
                    const effortMatches = config.effort === "xhigh"
                      ? /(extra high|xhigh)/.test(statusText)
                      : config.effort === "high"
                        ? /high/.test(statusText) && !/extra high/.test(statusText)
                        : config.effort === "medium"
                          ? /medium/.test(statusText)
                          : /low/.test(statusText);
                    const requestedModel = String(config.model || "")
                      .toLowerCase().replace(/^gpt[-\s]*/i, "").trim();
                    const modelText = [
                      modelControl?.text || "",
                      ...(settled.model_candidates || []),
                    ].join(" ").toLowerCase();
                    const modelMatches = !requestedModel || modelText.includes(requestedModel);
                    if (effortMatches && modelMatches) {
                      settledMatch = { modelControl, effortStatus };
                    }
                  }
                  if (!settledMatch) throw error;

                  applied = {
                    requested_model: config.model || null,
                    requested_effort: config.effort || null,
                    applied_model: config.model
                      ? (settledMatch.modelControl?.text || config.model) : null,
                    applied_effort: settledMatch.effortStatus || config.effort,
                    model_control: config.model ? "settled-post-detach" : null,
                    effort_control: "power-keyboard-settled",
                  };
                }
                return JSON.stringify({
                  ...(parsed && typeof parsed === "object" ? parsed : { result: bridgeOutput }),
                  chat_config: applied,
                });
              }));
          if (name === "delegate.create_chat" && params.newTab === true && mutationClient) {
            try {
              const created = JSON.parse(String(output));
              if (Number.isSafeInteger(created?.tabId) && Number(created.tabId) > 0) {
                bindDelegateSemanticAffinity(mutationClient, Number(created.tabId), "created");
              }
            } catch {}
          }
          return output;
        }
        if (name === "delegate.read_chat" && params.tabId === undefined && selectedClient) {
          const affinityTab = await resolveReadAffinityTab(selectedClient, signal);
          if (affinityTab !== undefined) params.tabId = affinityTab;
        }
        return await delegateBridge.request(name, params, signal, timeoutMs, selectedClient ?? clientId);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

export const delegateCreateChatTool: Tool = tool(
  "delegate.create_chat",
  "Start a new ChatGPT chat once. Optional model/effort configure the resulting chat before follow-up work. Set newTab:true to open a separate ChatGPT tab, leaving existing conversations untouched, and return its tabId.",
  schema({
    ...optionalTarget,
    requestId: requestIdParameter,
    newTab: { type: "boolean", description: "Open a new independent ChatGPT tab instead of modifying an existing tab. Cannot combine with tabId." },
    model: modelParameter,
    effort: effortParameter,
  }),
  30_000, false, false, true, true,
);

export const delegateReadChatTool: Tool = tool(
  "delegate.read_chat",
  "Read the selected ChatGPT chat. Detects ChatGPT's visible 'Message delivery timed out. Please try again.' state as delivery_timeout. The extension recovers that UI timeout with one guarded follow-up message, 'continue until done', without clicking Retry or replaying the original request. If no ChatGPT tab exists and tabId is omitted, Delegate opens https://chatgpt.com/ automatically before reading. Use {connections:true} to list connected Chrome profiles without opening a tab. With multiple connections choose clientId explicitly.",
  schema({ ...optionalTarget, connections: {
    type: "boolean", description: "Return list of connected Chrome profiles without accessing any ChatGPT tabs.",
  } }),
  20_000, false, true,
);

export const delegateListChatsTool: Tool = historyTool(
  "delegate.list_chats",
  "List ChatGPT conversation history from the selected Chrome profile without changing the user's active chat. Uses an inactive read-only worker tab and scrolls the Chat history sidebar to load older entries. Paginate with cursor/limit until next_cursor is null.",
  schema({
    clientId: optionalTarget.clientId,
    cursor: { type: "integer", minimum: 0, maximum: 5000, description: "Zero-based history offset." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Chats per page; default 50." },
  }),
  (params) => {
    if (params.cursor !== undefined && (!Number.isSafeInteger(params.cursor) || Number(params.cursor) < 0 || Number(params.cursor) > 5000)) {
      throw new Error("DELEGATE_INVALID_CURSOR: cursor must be an integer from 0 to 5000");
    }
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 200)) {
      throw new Error("DELEGATE_INVALID_LIMIT: limit must be an integer from 1 to 200");
    }
  },
  60_000,
);

export const delegateReadChatFullTool: Tool = historyTool(
  "delegate.read_chat_full",
  "Read a historical ChatGPT conversation by chatId in an inactive read-only worker tab. It scrolls through virtualized/older turns, returns paginated messages, and never sends, retries, or modifies the user's active chat.",
  schema({
    clientId: optionalTarget.clientId,
    chatId: { type: "string", minLength: 8, maxLength: 180, description: "Conversation ID returned by delegate.list_chats." },
    cursor: { type: "integer", minimum: 0, description: "Zero-based message offset." },
    limit: { type: "integer", minimum: 1, maximum: 80, description: "Messages per page; default 40." },
  }, ["chatId"]),
  (params) => {
    if (typeof params.chatId !== "string" || !/^[a-zA-Z0-9:_-]{8,180}$/.test(params.chatId)) {
      throw new Error("DELEGATE_INVALID_CHAT_ID: use a chatId returned by delegate.list_chats");
    }
    if (params.cursor !== undefined && (!Number.isSafeInteger(params.cursor) || Number(params.cursor) < 0)) {
      throw new Error("DELEGATE_INVALID_CURSOR: cursor must be a non-negative integer");
    }
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 80)) {
      throw new Error("DELEGATE_INVALID_LIMIT: limit must be an integer from 1 to 80");
    }
  },
  90_000,
);

export const delegateSearchHistoryTool: Tool = historyTool(
  "delegate.search_history",
  "Search ChatGPT history titles and message content through an inactive read-only worker tab. Scans up to maxChats conversations and returns matching chat IDs/titles with snippets; no active chat, draft, or conversation is modified.",
  schema({
    clientId: optionalTarget.clientId,
    query: { type: "string", minLength: 1, maxLength: 500 },
    limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum matching conversations; default 20." },
    maxChats: { type: "integer", minimum: 1, maximum: 500, description: "Maximum conversations to scan; default 100." },
  }, ["query"]),
  (params) => {
    if (typeof params.query !== "string" || !params.query.trim() || params.query.length > 500) {
      throw new Error("DELEGATE_INVALID_QUERY: query must be 1 to 500 characters");
    }
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 50)) {
      throw new Error("DELEGATE_INVALID_LIMIT: limit must be an integer from 1 to 50");
    }
    if (params.maxChats !== undefined && (!Number.isSafeInteger(params.maxChats) || Number(params.maxChats) < 1 || Number(params.maxChats) > 500)) {
      throw new Error("DELEGATE_INVALID_MAX_CHATS: maxChats must be an integer from 1 to 500");
    }
  },
  300_000,
);

export const delegateSyncHistoryTool: Tool = {
  name: "delegate.sync_history",
  description: "Incrementally mirror ChatGPT history into the local SuperAgent SQLite index. Reads through Delegate worker tabs, refreshes recent chats, and leaves the active ChatGPT tab untouched.",
  parameters: schema({
    clientId: optionalTarget.clientId,
    maxChats: { type: "integer", minimum: 1, maximum: 500 },
    refreshRecent: { type: "integer", minimum: 0, maximum: 100 },
    force: { type: "boolean" },
  }),
  async execute(args, _cwd, signal) {
    try {
      return JSON.stringify(await syncDelegateHistoryIndex({
        clientId: typeof args.clientId === "string" ? args.clientId : undefined,
        maxChats: args.maxChats as number | undefined,
        refreshRecent: args.refreshRecent as number | undefined,
        force: args.force === true,
      }, signal));
    } catch (error) {
      return "Error: " + (error instanceof Error ? error.message : String(error));
    }
  },
};

export const delegateSearchIndexTool: Tool = {
  name: "delegate.search_index",
  description: "Search the local SQLite mirror of ChatGPT history. No browser navigation occurs and no message is sent. Run delegate.sync_history first to refresh the cache.",
  parameters: schema({
    clientId: optionalTarget.clientId,
    query: { type: "string", minLength: 1, maxLength: 500 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  }, ["query"]),
  async execute(args, _cwd, signal) {
    try {
      if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500) {
        throw new Error("DELEGATE_INVALID_QUERY: query must be 1 to 500 characters");
      }
      const selectedClient = typeof args.clientId === "string" ? args.clientId : undefined;
      const warm = await ensureDelegateHistoryIndexWarm(selectedClient, signal);
      return JSON.stringify({
        ...searchDelegateHistoryIndex(
          selectedClient,
          args.query,
          Number(args.limit ?? 20),
        ),
        auto_sync_refreshed: warm.refreshed,
      });
    } catch (error) {
      return "Error: " + (error instanceof Error ? error.message : String(error));
    }
  },
};

export const delegateDoctorTool: Tool = {
  name: "delegate.doctor",
  description: "Read-only Delegate diagnostics for bridge/profile connection, browser DOM state, and local history-index statistics. Never sends, stops, retries, or navigates a chat.",
  parameters: schema({ clientId: optionalTarget.clientId, tabId: optionalTarget.tabId }),
  async execute(args, _cwd, signal) {
    try {
      const clients = delegateBridge.listConnections();
      const selected = typeof args.clientId === "string"
        ? clients.find(client => client.clientId === args.clientId)
        : clients.length === 1 ? clients[0] : undefined;
      let browser: unknown = null;
      let browserError: string | null = null;
      if (selected) {
        try {
          let selectedTab = Number.isSafeInteger(args.tabId) && Number(args.tabId) > 0
            ? Number(args.tabId) : undefined;
          if (selectedTab !== undefined) {
            bindDelegateSemanticAffinity(selected.clientId, selectedTab, "explicit");
          } else {
            selectedTab = await resolveReadAffinityTab(selected.clientId, signal);
          }
          browser = JSON.parse(await delegateBridge.request(
            "delegate.doctor",
            selectedTab === undefined ? {} : { tabId: selectedTab },
            signal,
            20_000,
            selected.clientId,
          ));
        } catch (error) {
          browserError = error instanceof Error ? error.message : String(error);
        }
      }
      return JSON.stringify({
        bridge: {
          connected_profiles: clients.length,
          selected_client_id: selected?.clientId || null,
          selection_required: clients.length > 1 && !selected,
        },
        browser,
        browser_error: browserError,
        history_index: getDelegateHistoryIndexStats(selected?.clientId),
        tab_affinity: selected ? inspectDelegateSemanticAffinity(selected.clientId) : null,
      });
    } catch (error) {
      return "Error: " + (error instanceof Error ? error.message : String(error));
    }
  },
};

export const delegateRunUntilDoneTool: Tool = {
  name: "delegate.run_until_done",
  description: "Send one task and monitor ChatGPT until an explicit completion marker appears. Continuation count and total runtime are bounded. Optional stall recovery may stop a stalled generation before sending a distinct 'continue until done'.",
  parameters: schema({
    ...optionalTarget,
    requestId: requestIdParameter,
    message: { type: "string", minLength: 1, maxLength: 100_000 },
    maxContinuations: { type: "integer", minimum: 0, maximum: 8 },
    pollMs: { type: "integer", minimum: 500, maximum: 5000 },
    stallMs: { type: "integer", minimum: 15000, maximum: 300000 },
    maxRuntimeMs: { type: "integer", minimum: 30000, maximum: 900000 },
    recoverStall: { type: "boolean" },
    completionMarker: { type: "string", minLength: 1, maxLength: 120 },
    model: modelParameter,
    effort: effortParameter,
  }, ["message"]),
  async execute(args, _cwd, signal) {
    try {
      const runClient = typeof args.clientId === "string" ? args.clientId : undefined;
      const config: DelegateChatConfigRequest | undefined =
        args.model !== undefined || args.effort !== undefined
          ? {
              ...(args.model !== undefined ? { model: args.model as string } : {}),
              ...(args.effort !== undefined ? { effort: args.effort as any } : {}),
            }
          : undefined;
      if (config) validateDelegateChatConfig(config);
      return await withSemanticDelegateTarget("delegate.run_until_done", runClient, args.tabId, false,
        selected => delegateBridge.executeOnce(args.requestId as string | undefined,
          "delegate.run_until_done", selected, args, async () => {
            if (config) await configureDelegateChatOnLockedTarget(
              selected, Number(args.tabId), config, signal);
            return JSON.stringify(await runDelegateUntilDone({
        clientId: selected,
        tabId: args.tabId as number | undefined,
        message: String(args.message || ""),
        maxContinuations: args.maxContinuations as number | undefined,
        pollMs: args.pollMs as number | undefined,
        stallMs: args.stallMs as number | undefined,
        maxRuntimeMs: args.maxRuntimeMs as number | undefined,
        recoverStall: args.recoverStall === true,
        completionMarker: typeof args.completionMarker === "string" ? args.completionMarker : undefined,
      }, signal));
          }));
    } catch (error) {
      return "Error: " + (error instanceof Error ? error.message : String(error));
    }
  },
};

export const delegateInspectChatConfigTool: Tool = {
  name: "delegate.inspect_chat_config",
  description: "Read visible ChatGPT model/reasoning controls for one explicit Delegate tab. Read-only: never selects an option, navigates, or reads conversation text.",
  parameters: schema({ ...optionalTarget }, ["clientId", "tabId"]),
  async execute(args, _cwd, signal) {
    try {
      if (typeof args.clientId !== "string" ||
          !/^[A-Za-z0-9_-]{8,80}$/.test(args.clientId) ||
          !Number.isSafeInteger(args.tabId) || Number(args.tabId) < 1) {
        throw new Error("DELEGATE_CONFIG_EXPLICIT_TARGET_REQUIRED");
      }
      if (!delegateBridge.listConnections().some(client => client.clientId === args.clientId)) {
        throw new Error("DELEGATE_TARGET_NOT_CONNECTED");
      }
      return await withDelegateTargetLock(args.clientId, Number(args.tabId), async () =>
        JSON.stringify(await inspectDelegateChatConfigurationOnLockedTarget(
          args.clientId as string, Number(args.tabId), signal,
        )),
      );
    } catch (error) {
      return "Error: " + (error instanceof Error ? error.message : String(error));
    }
  },
};

export const delegateConfigureChatTool: Tool = {
  name: "delegate.configure_chat",
  description: "Set the visible ChatGPT model and/or reasoning effort on one explicit Delegate tab. Uses the fenced target lock and fails closed when the requested UI option is unavailable or ambiguous.",
  parameters: schema({
    ...optionalTarget,
    requestId: requestIdParameter,
    model: modelParameter,
    effort: effortParameter,
  }, ["clientId", "tabId"]),
  async execute(args, _cwd, signal) {
    try {
      if (typeof args.clientId !== "string" ||
          !/^[A-Za-z0-9_-]{8,80}$/.test(args.clientId) ||
          !Number.isSafeInteger(args.tabId) || Number(args.tabId) < 1) {
        throw new Error("DELEGATE_CONFIG_EXPLICIT_TARGET_REQUIRED");
      }
      const config: DelegateChatConfigRequest = {
        ...(args.model !== undefined ? { model: args.model as string } : {}),
        ...(args.effort !== undefined ? { effort: args.effort as any } : {}),
      };
      validateDelegateChatConfig(config);
      return await withSemanticDelegateTarget(
        "delegate.configure_chat", args.clientId, args.tabId, false,
        selected => delegateBridge.executeOnce(
          args.requestId as string | undefined,
          "delegate.configure_chat",
          selected,
          { tabId: args.tabId, ...config },
          async () => JSON.stringify(await configureDelegateChatOnLockedTarget(
            selected, Number(args.tabId), config, signal)),
        ),
      );
    } catch (error) {
      return "Error: " + (error instanceof Error ? error.message : String(error));
    }
  },
};

export const delegateSendMessageTool: Tool = tool(
  "delegate.send_message",
  "Send once to an explicitly selected clientId and tabId. Optional model/effort are applied before Send under the same target lock; requestId prevents replay after uncertain outcomes.",
  schema({
    ...optionalTarget,
    requestId: requestIdParameter,
    message: { type: "string", minLength: 1, maxLength: 100_000 },
    model: modelParameter,
    effort: effortParameter,
  }, ["message"]),
  45_000, true, false, false, true,
);

export const delegateStopGenerationTool: Tool = tool(
  "delegate.stop_generation",
  "Stop ChatGPT generation only with explicit clientId and tabId. Optional requestId prevents reissuing an uncertain stop. Never performs implicit tab fallback.",
  schema({ ...optionalTarget, requestId: requestIdParameter }),
);
