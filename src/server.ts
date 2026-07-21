import http from "http";
import { URL } from "url";
import fs from "fs";
import path from "path";
import { Agent } from "./core/agent.js";
import type { AgentEvent } from "./core/agent.js";
import { getConfig, getSettings, getConfiguredProviders, addTrustedDirectory, ensureDirectoryTrusted, getPresets, getActivePresetId, setActivePresetId, updateSettings, listHistorySessions, getTrustedDirectories, closeHistoryDb, generateSessionId, purgeEmptySessions, getPackageRootDir } from "./core/config.js";
import { readChecklistTasks, ReadChecklistResult } from "./core/taskChecklist.js";
import { subagentInstances, superagentInstances, registerMasterAgent, subscribeToActiveOutput, subscribeToSubagents, subscribeToSuperagents, registerQuestionHandler } from "./core/tools/state.js";
import { setBrowserControlHandler } from "./core/tools/otherTools.js";
import { getBrowserMacros, saveBrowserMacro, deleteBrowserMacro } from "./core/config/browserMacros.js";

export type ClientMode = "chrome-extension" | "tline";

interface AgentSession {
  agent: Agent;
  workspace: string;
  mode: "single" | "multi";
  clientMode: ClientMode;
  sessionId: string;
  isCliSession: boolean;
  lastActiveTime?: number;
}

let serverDefaultClientMode: ClientMode = "tline";

export function resolveClientMode(
  req: http.IncomingMessage,
  body?: any,
  defaultMode: ClientMode = serverDefaultClientMode
): ClientMode {
  const headerMode = req.headers["x-client-mode"] as string;
  const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  const queryMode = parsedUrl.searchParams.get("clientMode") || parsedUrl.searchParams.get("client_mode");
  const bodyMode = body?.clientMode || body?.client_mode;

  const raw = (bodyMode || headerMode || queryMode || "").toLowerCase();
  if (raw.includes("chrome") || raw.includes("extension") || raw === "ext") {
    return "chrome-extension";
  }
  if (raw.includes("tline") || raw.includes("cli")) {
    return "tline";
  }
  return defaultMode;
}

async function createAgentForMode(
  targetWorkspace: string,
  targetMode: "single" | "multi",
  targetClientMode: ClientMode
): Promise<Agent> {
  let customSystemPrompt: string | undefined = undefined;
  let customTools: any[] | undefined = undefined;

  if (targetClientMode === "chrome-extension") {
    const { CHROME_EXTENSION_SYSTEM_PROMPT } = await import("./core/prompts.js");
    const { chromeExtensionToolset } = await import("./core/tools/toolsets.js");
    customSystemPrompt = CHROME_EXTENSION_SYSTEM_PROMPT;
    customTools = chromeExtensionToolset;
  } else {
    // tline mode (SuperAgent CLI / Desktop equivalent)
    if (targetMode === "multi") {
      const { MASTER_AGENT_SYSTEM_PROMPT } = await import("./core/prompts.js");
      const { masterToolset } = await import("./core/tools/toolsets.js");
      customSystemPrompt = MASTER_AGENT_SYSTEM_PROMPT;
      customTools = masterToolset;
    } else {
      const { superagentToolset } = await import("./core/tools/toolsets.js");
      customSystemPrompt = undefined;
      customTools = superagentToolset;
    }
  }

  const agent = new Agent(
    (event: AgentEvent) => onEvent(event, agent),
    onPermission,
    onQuestion,
    customSystemPrompt,
    customTools,
    targetWorkspace
  );

  if (targetMode === "multi") {
    agent.tier = "master";
    agent.isMultiAgent = true;
    registerMasterAgent(agent);
  } else {
    agent.tier = "single";
  }

  return agent;
}

export const activeSessions = new Map<string, AgentSession>();
let lastActiveWorkspace: string = process.cwd();
let isBrowseDialogOpen = false;
let visionServerProcess: any = null;

export const killVisionServerProcess = () => {
  if (visionServerProcess) {
    try {
      if (process.platform === "win32") {
        // execSync is loaded dynamically using a helper to avoid require/import issues in ES Module context
        import("child_process").then(({ execSync }) => {
          try {
            execSync(`taskkill /F /T /PID ${visionServerProcess.pid}`, { stdio: "ignore" });
          } catch {}
        });
      } else {
        visionServerProcess.kill();
      }
    } catch {}
  }
};

function resolveSession(req: http.IncomingMessage, requestedSessionId?: string): AgentSession | null {
  const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  let wsPath = req.headers["x-workspace-path"] as string || parsedUrl.searchParams.get("workspace");
  const querySessionId = parsedUrl.searchParams.get("sessionId");
  const targetSessionId = requestedSessionId || querySessionId;

  if (targetSessionId) {
    for (const session of activeSessions.values()) {
      if (session.sessionId === targetSessionId) {
        session.lastActiveTime = Date.now();
        return session;
      }
    }
  }

  if (wsPath) {
    wsPath = path.resolve(wsPath);
    const session = activeSessions.get(wsPath);
    if (session) {
      if (targetSessionId) {
        session.sessionId = targetSessionId;
      }
      session.lastActiveTime = Date.now();
      return session;
    }
  }
  
  if (wsPath) {
    for (const [key, session] of activeSessions.entries()) {
      if (key.toLowerCase() === wsPath.toLowerCase()) {
        if (targetSessionId) {
          session.sessionId = targetSessionId;
        }
        session.lastActiveTime = Date.now();
        return session;
      }
    }
  }

  for (const session of activeSessions.values()) {
    if (session.isCliSession) {
      session.lastActiveTime = Date.now();
      return session;
    }
  }
  
  return null;
}

function resolveWorkspacePath(req: http.IncomingMessage): string {
  const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  const headerWs = req.headers["x-workspace-path"] as string;
  const paramWs = parsedUrl.searchParams.get("workspace");
  if (headerWs) return path.resolve(headerWs);
  if (paramWs) return path.resolve(paramWs);
  
  const session = resolveSession(req);
  return session ? session.workspace : lastActiveWorkspace;
}

export function registerCliAgent(agent: Agent, workspace: string, mode: "single" | "multi", clientMode: ClientMode = "tline") {
  const targetWorkspace = path.resolve(workspace);
  activeSessions.set(targetWorkspace, {
    agent,
    workspace: targetWorkspace,
    mode,
    clientMode,
    sessionId: generateSessionId(),
    isCliSession: true
  });
  lastActiveWorkspace = targetWorkspace;
}


interface BrowserInstance {
  res: http.ServerResponse;
  clientId: string;
  windowId: string;
  tabTitle: string;
  tabUrl: string;
  profileName: string;
  lastActive: number;
}
const sseClients = new Set<http.ServerResponse>();
const browserInstances = new Map<string, BrowserInstance>();

const pendingPermissions = new Map<string, (approval: boolean | "session") => void>();
const pendingQuestions = new Map<string, (answer: any) => void>();
const pendingBrowserControls = new Map<string, { resolve: (val: string) => void, reject: (err: any) => void }>();

function executeBrowserControlOnClient(action: string, target: string, value?: string, instanceId?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const controlId = Math.random().toString(36).substring(2, 9);
    pendingBrowserControls.set(controlId, { resolve, reject });
    
    const event = {
      type: "browser_control_required",
      controlId,
      action,
      target,
      value: value ?? ""
    };

    if (instanceId && browserInstances.has(instanceId)) {
      const inst = browserInstances.get(instanceId)!;
      try {
        inst.res.write(`data: ${JSON.stringify(event)}\n\n`);
        inst.lastActive = Date.now();
      } catch (err) {
        browserInstances.delete(instanceId);
        reject(new Error(`Failed to send event to instance ${instanceId}: ${err}`));
      }
    } else {
      if (browserInstances.size > 0) {
        let bestInst: BrowserInstance | null = null;
        let bestKey = "";
        for (const [key, inst] of browserInstances.entries()) {
          if (!bestInst || inst.lastActive > bestInst.lastActive) {
            bestInst = inst;
            bestKey = key;
          }
        }
        if (bestInst) {
          try {
            bestInst.res.write(`data: ${JSON.stringify(event)}\n\n`);
            bestInst.lastActive = Date.now();
            return;
          } catch (err) {
            browserInstances.delete(bestKey);
          }
        }
      }
      broadcastEvent(event);
    }
  });
}

setBrowserControlHandler((action, target, value, instanceId) => {
  if (action === "list_instances") {
    const list = Array.from(browserInstances.entries()).map(([key, inst]) => ({
      instanceId: key,
      clientId: inst.clientId,
      windowId: inst.windowId,
      profileName: inst.profileName,
      tabTitle: inst.tabTitle,
      tabUrl: inst.tabUrl,
      lastActive: new Date(inst.lastActive).toISOString()
    }));
    return Promise.resolve(JSON.stringify(list, null, 2));
  }
  return executeBrowserControlOnClient(action, target, value, instanceId);
});

function broadcastEvent(event: any) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  if (process.env.LOG_STREAM_RESPONSE === 'true') {
    if (event?.event?.type === 'text_delta') {
      process.stdout.write(event.event.text || event.event.delta || '');
    } else if (event?.event?.type === 'message') {
      const sub = event.event;
      const contentStr = typeof sub.content === 'string' ? sub.content : JSON.stringify(sub.content);
      console.log(`\n[SuperAgent][Stream Message] [${sub.role || 'assistant'}]: ${contentStr}`);
    } else if (event?.event?.type) {
      console.log(`\n[SuperAgent][Stream Event] [${event.event.type}]`, JSON.stringify(event.event));
    } else {
      console.log(`\n[SuperAgent][Stream Event]`, JSON.stringify(event));
    }
  }
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

function sendJSON(res: http.ServerResponse, status: number, data: any) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-workspace-path",
  });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => resolve(body));
    req.on("error", err => reject(err));
  });
}

function getSessionForAgent(agentRef?: Agent): AgentSession | undefined {
  if (!agentRef) return undefined;
  for (const session of activeSessions.values()) {
    if (session.agent === agentRef) return session;
  }
  return undefined;
}

// Global Agent Event Handlers
const onEvent = (event: AgentEvent, agentRef?: Agent) => {
  const session = getSessionForAgent(agentRef);
  const sessionId = agentRef?.sessionId || session?.sessionId;
  const workspace = session?.workspace || agentRef?.workingDirectory;
  const metadata = { ...(sessionId ? { sessionId } : {}), ...(workspace ? { workspace } : {}) };
  if (session) {
    session.lastActiveTime = Date.now();
  }
  broadcastEvent({ type: "agent_event", event, ...metadata });
  // When agent finishes a turn and is waiting for plan approval, notify extension clients
  if (event.type === "done" && agentRef && agentRef.planState === "PLANNING_PENDING") {
    broadcastEvent({ type: "plan_approval_required", planState: "PLANNING_PENDING", ...metadata });
  }
};

// Subscribe to active tool output streaming and broadcast it to SSE clients
subscribeToActiveOutput((output) => {
  broadcastEvent({
    type: "tool_progress",
    content: output
  });
});

// Subscribe to subagents/superagents completion notifications to broadcast and/or resume the agent
subscribeToSubagents(() => {
  const activeList = Array.from(subagentInstances.values());
  activeList.forEach((inst) => {
    if (inst.status === "completed" && inst.result && !(inst as any).notified) {
      (inst as any).notified = true;
      const msg = `🤖 [SUBAGENT NOTIFICATION]: Subagent ${inst.id} (${inst.role || inst.typeName}) has completed!\nReport Summary:\n${inst.result}`;
      
      broadcastEvent({
        type: "agent_event",
        event: {
          type: "system",
          content: msg
        }
      });

      for (const session of activeSessions.values()) {
        if (path.resolve(session.workspace) === path.resolve(inst.agent.workingDirectory) && !session.agent.isAgentRunning()) {
          broadcastEvent({
            type: "agent_event",
            event: {
              type: "text",
              content: `\n[SYSTEM TRIGGER] ${msg}\n`
            }
          });
          session.agent.sendMessage(msg).catch(err => {
            broadcastEvent({ type: "error", message: err.message || String(err) });
          });
        }
      }
    }
  });
});

subscribeToSuperagents(() => {
  const activeList = Array.from(superagentInstances.values());
  activeList.forEach((inst) => {
    if (inst.status === "completed" && inst.result && !(inst as any).notified) {
      (inst as any).notified = true;
      const msg = `⚡ [SUPERAGENT NOTIFICATION]: Superagent ${inst.id} (${inst.role}) has completed!\nReport Summary:\n${inst.result}`;
      
      broadcastEvent({
        type: "agent_event",
        event: {
          type: "system",
          content: msg
        }
      });

      for (const session of activeSessions.values()) {
        if (path.resolve(session.workspace) === path.resolve(inst.agent.workingDirectory) && !session.agent.isAgentRunning()) {
          broadcastEvent({
            type: "agent_event",
            event: {
              type: "text",
              content: `\n[SYSTEM TRIGGER] ${msg}\n`
            }
          });
          session.agent.sendMessage(msg).catch(err => {
            broadcastEvent({ type: "error", message: err.message || String(err) });
          });
        }
      }
    }
  });
});

const onPermission = (toolCall: any, description: string) => {
  return new Promise<boolean | "session">((resolve) => {
    const permissionId = Math.random().toString(36).substring(2, 9);
    pendingPermissions.set(permissionId, resolve);
    broadcastEvent({
      type: "permission_required",
      permissionId,
      toolCall,
      description
    });
  });
};

const onQuestion = (question: any, options?: string[], isMultiSelect?: boolean) => {
  return new Promise<any>((resolve) => {
    const questionId = Math.random().toString(36).substring(2, 9);
    pendingQuestions.set(questionId, resolve);
    broadcastEvent({
      type: "question_required",
      questionId,
      question,
      options,
      isMultiSelect
    });
  });
};

export async function runServer(port: number, silent = false, defaultClientMode: ClientMode = "tline") {
  serverDefaultClientMode = defaultClientMode;
  registerQuestionHandler(onQuestion);

  try {
    purgeEmptySessions(24);
  } catch {}

  // Idle workspace session harvesting (30 min inactivity timeout)
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  const harvestTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of activeSessions.entries()) {
      if (!session.isCliSession && !session.agent.isAgentRunning()) {
        const lastActive = session.lastActiveTime || now;
        if (now - lastActive > IDLE_TIMEOUT_MS) {
          activeSessions.delete(key);
        }
      }
    }
  }, 5 * 60 * 1000);

  // Start the Python Vision Server in the background

  try {
    const { execa } = await import("execa");
    const scriptPath = path.join(getPackageRootDir(), "scripts", "vision_server.py");
    visionServerProcess = execa("python", [scriptPath, "8095"]);
    if (!silent) {
      console.log("🚀 Starting Python UI-DETR-1 Vision Server on port 8095...");
    }
    
    visionServerProcess.catch((err: any) => {
      if (!silent) {
        console.error("[Vision Server Process Terminated/Failed]", err.message);
      }
    });

    const cleanup = () => {
      clearInterval(harvestTimer);
      killVisionServerProcess();
      try {
        closeHistoryDb();
      } catch {}
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  } catch (err: any) {
    if (!silent) {
      console.error("Failed to spawn Python Vision Server:", err.message);
    }
  }
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-workspace-path",
      });
      res.end();
      return;
    }

    try {
      // SSE Endpoint
      if (pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        sseClients.add(res);

        const clientId = parsedUrl.searchParams.get("clientId") || "";
        const windowId = parsedUrl.searchParams.get("windowId") || "";
        const tabTitle = parsedUrl.searchParams.get("tabTitle") || "";
        const tabUrl = parsedUrl.searchParams.get("tabUrl") || "";
        const profileName = parsedUrl.searchParams.get("profileName") || "";

        const instanceKey = clientId && windowId ? `${clientId}:${windowId}` : "";
        if (instanceKey) {
          browserInstances.set(instanceKey, {
            res,
            clientId,
            windowId,
            tabTitle,
            tabUrl,
            profileName,
            lastActive: Date.now()
          });
        }

        // Keep SSE connection alive
        const keepAliveInterval = setInterval(() => {
          try {
            res.write(": keepalive\n\n");
          } catch {
            clearInterval(keepAliveInterval);
          }
        }, 15000);

        req.on("close", () => {
          clearInterval(keepAliveInterval);
          sseClients.delete(res);
          if (instanceKey) {
            browserInstances.delete(instanceKey);
          }
        });
        return;
      }

      // Status
      if (pathname === "/api/status" && req.method === "GET") {
        const session = resolveSession(req);
        sendJSON(res, 200, {
          status: "online",
          workspace: resolveWorkspacePath(req),
          mode: session ? session.mode : "single",
          clientMode: session ? session.clientMode : serverDefaultClientMode,
          sessionId: session ? session.sessionId : null,
          agentActive: !!session,
          agentRunning: session ? session.agent.isAgentRunning() : false,
          isCliSession: session ? session.isCliSession : false,
          planState: session ? session.agent.planState : "IDLE",
        });
        return;
      }

      // Workspaces List
      if (pathname === "/api/workspaces" && req.method === "GET") {
        const workspaces = Array.from(activeSessions.values()).map(s => ({
          sessionId: s.sessionId,
          workspace: s.workspace,
          mode: s.mode,
          clientMode: s.clientMode,
          isCliSession: s.isCliSession,
          agentRunning: s.agent.isAgentRunning(),
          planState: s.agent.planState,
          lastActiveTime: s.lastActiveTime || Date.now()
        }));
        sendJSON(res, 200, { success: true, workspaces });
        return;
      }

      // Get chat history
      if (pathname === "/api/history" && req.method === "GET") {
        const session = resolveSession(req);
        if (!session) {
          sendJSON(res, 200, { success: true, messages: [] });
          return;
        }
        const messages = session.agent.getConversationMessages();
        sendJSON(res, 200, { success: true, messages });
        return;
      }

      // Get list of previous history sessions
      if (pathname === "/api/history/sessions" && req.method === "GET") {
        const workspacePath = resolveWorkspacePath(req);
        const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
        const queryMode = parsedUrl.searchParams.get("mode");
        const session = resolveSession(req);
        const mode = queryMode || (session ? session.mode : "single");
        const isMulti = mode === "multi";
        if (!workspacePath) {
          sendJSON(res, 200, { success: true, sessions: [] });
          return;
        }
        const sessions = listHistorySessions(isMulti, false, workspacePath);
        sendJSON(res, 200, { success: true, sessions });
        return;
      }

      // Delete a history session by ID
      if (pathname.startsWith("/api/history/session/") && req.method === "DELETE") {
        const sessionId = decodeURIComponent(pathname.replace("/api/history/session/", ""));
        if (!sessionId) {
          sendJSON(res, 400, { error: "Missing session ID" });
          return;
        }
        try {
          const { deleteSessionFromDb, clearHistoryCache } = await import("./core/config.js");
          deleteSessionFromDb(sessionId);
          clearHistoryCache();

          // Remove from activeSessions map and abort if running
          for (const [key, session] of activeSessions.entries()) {
            if (session.sessionId === sessionId) {
              if (session.agent.isAgentRunning()) {
                session.agent.abort();
              }
              activeSessions.delete(key);
            }
          }

          // Broadcast real-time sessions updated event to connected clients
          broadcastEvent({ type: "superagent-sessions-changed" });

          sendJSON(res, 200, { success: true });
        } catch (err: any) {
          sendJSON(res, 500, { error: err.message });
        }
        return;
      }

      // Get input history for a workspace
      if (pathname === "/api/input-history" && req.method === "GET") {
        const workspacePath = resolveWorkspacePath(req);
        if (!workspacePath) {
          sendJSON(res, 200, { success: true, history: [] });
          return;
        }
        try {
          const { getWorkspaceId } = await import("./core/config/paths.js");
          const { getInputHistoryFromDb } = await import("./core/storage/historyDb.js");
          const wsId = getWorkspaceId(workspacePath);
          const history = getInputHistoryFromDb(wsId, 200);
          sendJSON(res, 200, { success: true, history });
        } catch (err: any) {
          sendJSON(res, 200, { success: true, history: [] });
        }
        return;
      }

      // Save input history for a workspace
      if (pathname === "/api/input-history" && req.method === "POST") {
        const workspacePath = resolveWorkspacePath(req);
        if (!workspacePath) {
          sendJSON(res, 400, { error: "No workspace path" });
          return;
        }
        try {
          const bodyStr = await readBody(req);
          const body = JSON.parse(bodyStr || "{}");
          const { command } = body;
          if (!command || typeof command !== "string" || !command.trim()) {
            sendJSON(res, 400, { error: "Missing or empty 'command' field" });
            return;
          }
          const { getWorkspaceId } = await import("./core/config/paths.js");
          const { saveInputHistoryToDb } = await import("./core/storage/historyDb.js");
          const wsId = getWorkspaceId(workspacePath);
          saveInputHistoryToDb(wsId, command.trim());
          sendJSON(res, 200, { success: true });
        } catch (err: any) {
          sendJSON(res, 500, { error: err.message });
        }
        return;
      }

      // Initialize session
      if (pathname === "/api/init" && req.method === "POST") {
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr || "{}");
        const { mode, workspace, resume, initialPrompt, sessionId: customSessionId } = body;

        const targetWorkspace = workspace ? path.resolve(workspace) : process.cwd();
        
        // Trust the directory automatically for the extension server usage
        addTrustedDirectory(targetWorkspace);
        await ensureDirectoryTrusted(targetWorkspace);

        const targetMode = mode === "multi" ? "multi" : "single";
        const targetClientMode = resolveClientMode(req, body, serverDefaultClientMode);
        const sessionId = customSessionId || resume || generateSessionId();

        const existingSession = activeSessions.get(targetWorkspace);
        if (
          existingSession &&
          existingSession.sessionId === sessionId &&
          existingSession.mode === targetMode &&
          existingSession.clientMode === targetClientMode
        ) {
          sendJSON(res, 200, {
            success: true,
            sessionId: existingSession.sessionId,
            workspace: targetWorkspace,
            mode: existingSession.mode,
            clientMode: existingSession.clientMode
          });
          return;
        }

        if (existingSession && existingSession.agent.isAgentRunning()) {
          existingSession.agent.abort();
        }

        const agent = await createAgentForMode(targetWorkspace, targetMode, targetClientMode);
        agent.sessionId = sessionId;

        pendingPermissions.clear();
        pendingQuestions.clear();

        if (resume) {
          try {
            await agent.loadHistory(resume);
          } catch {}
        }

        activeSessions.set(targetWorkspace, {
          agent,
          workspace: targetWorkspace,
          mode: targetMode,
          clientMode: targetClientMode,
          sessionId,
          isCliSession: false
        });
        lastActiveWorkspace = targetWorkspace;

        sendJSON(res, 200, {
          success: true,
          sessionId,
          workspace: targetWorkspace,
          mode: targetMode,
          clientMode: targetClientMode
        });

        if (initialPrompt && initialPrompt.trim()) {
          // Process initial prompt in the background
          setTimeout(() => {
            agent.sendMessage(initialPrompt).catch(err => {
              broadcastEvent({ type: "error", message: err.message || String(err) });
            });
          }, 100);
        }
        return;
      }

      // Send chat message
      if (pathname === "/api/chat" && req.method === "POST") {
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr || "{}");
        const { message, sessionId: reqSessionId } = body;

        const session = resolveSession(req, reqSessionId);
        if (!session) {
          sendJSON(res, 400, { error: "Session not initialized" });
          return;
        }

        if (!message) {
          sendJSON(res, 400, { error: "Empty message", sessionId: session.sessionId });
          return;
        }

        // Direct terminal command executor prefix
        if (typeof message === "string" && message.startsWith("!")) {
          const command = message.slice(1).trim();
          if (!command) {
            sendJSON(res, 400, { error: "Empty terminal command", sessionId: session.sessionId });
            return;
          }

          // Run in background and stream output via SSE
          (async () => {
            const wsPath = session.workspace || lastActiveWorkspace;
            broadcastEvent({
              type: "agent_event",
              event: {
                type: "text",
                content: `> Executing command: ${command}\n`
              }
            });

            try {
              const { execa } = await import("execa");
              const cp = execa(command, {
                cwd: wsPath,
                all: true,
                reject: false,
                shell: true
              });

              cp.all?.on("data", (chunk) => {
                broadcastEvent({
                  type: "agent_event",
                  event: {
                    type: "text",
                    content: chunk.toString()
                  }
                });
              });

              const result = await cp;
              broadcastEvent({
                type: "agent_event",
                event: {
                  type: "text",
                  content: `\n> Command finished with exit code ${result.exitCode}\n`
                }
              });
            } catch (err: any) {
              broadcastEvent({
                type: "agent_event",
                event: {
                  type: "text",
                  content: `\n> Command failed: ${err.message}\n`
                }
              });
            } finally {
              // Notify done to stop spinner
              broadcastEvent({
                type: "agent_event",
                event: {
                  type: "done",
                  stats: { totalTimeMs: 0 }
                }
              });
            }
          })();

          sendJSON(res, 200, { success: true, sessionId: session.sessionId });
          return;
        }

        // Run message in the background so HTTP finishes quickly
        // Client receives output via SSE
        session.agent.sendMessage(message).catch(err => {
          broadcastEvent({ type: "error", message: err.message || String(err) });
        });

        sendJSON(res, 200, { success: true, sessionId: session.sessionId });
        return;
      }


      // Handle Permission Approval
      if (pathname === "/api/approve" && req.method === "POST") {
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr || "{}");
        const { permissionId, approval } = body;

        const resolver = pendingPermissions.get(permissionId);
        if (resolver) {
          resolver(approval);
          pendingPermissions.delete(permissionId);
          sendJSON(res, 200, { success: true });
        } else {
          sendJSON(res, 404, { error: "Permission request not found" });
        }
        return;
      }

      // Handle Plan Approval
      if (pathname === "/api/plan/approve" && req.method === "POST") {
        const session = resolveSession(req);
        if (!session) {
          sendJSON(res, 400, { error: "Session not initialized" });
          return;
        }
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr || "{}");
        const { action } = body;

        if (action === "approve") {
          session.agent.approvePlan();
          session.agent.sendMessage("Implementation plan approved via interactive approval wizard. Continue with the approved plan now.").catch(err => {
            broadcastEvent({ type: "error", message: err.message || String(err) });
          });
          sendJSON(res, 200, { success: true });
        } else if (action === "reject") {
          session.agent.planState = "IDLE";
          session.agent.abort();
          broadcastEvent({ type: "plan_approval_required", planState: "IDLE" });
          sendJSON(res, 200, { success: true });
        } else {
          sendJSON(res, 400, { error: "Invalid action. Use approve or reject." });
        }
        return;
      }

      // Handle Question Answer
      if (pathname === "/api/answer" && req.method === "POST") {
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr || "{}");
        const { questionId, answer } = body;

        const resolver = pendingQuestions.get(questionId);
        if (resolver) {
          resolver(answer);
          pendingQuestions.delete(questionId);
          sendJSON(res, 200, { success: true });
        } else {
          sendJSON(res, 404, { error: "Question request not found" });
        }
        return;
      }

      // Update browser instance tab info and profile name
      if (pathname === "/api/browser/update-instance" && req.method === "POST") {
        try {
          const bodyStr = await readBody(req);
          const { clientId, windowId, tabTitle, tabUrl, profileName } = JSON.parse(bodyStr || "{}");
          const instanceKey = clientId && windowId ? `${clientId}:${windowId}` : "";
          if (instanceKey && browserInstances.has(instanceKey)) {
            const inst = browserInstances.get(instanceKey)!;
            if (tabTitle !== undefined) inst.tabTitle = tabTitle;
            if (tabUrl !== undefined) inst.tabUrl = tabUrl;
            if (profileName !== undefined) inst.profileName = profileName;
            inst.lastActive = Date.now();
            sendJSON(res, 200, { success: true });
          } else {
            sendJSON(res, 404, { error: "Instance not registered" });
          }
        } catch (err: any) {
          sendJSON(res, 400, { error: err.message });
        }
        return;
      }

      // Handle Browser Control Result
      if (pathname === "/api/browser/result" && req.method === "POST") {
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr || "{}");
        const { controlId, result, isError } = body;

        const resolver = pendingBrowserControls.get(controlId);
        if (resolver) {
          if (isError) {
            resolver.reject(new Error(result));
          } else {
            if (typeof result === "string" && result.startsWith("data:image/png;base64,")) {
              try {
                const base64Data = result.replace(/^data:image\/png;base64,/, "");
                const wsPath = resolveWorkspacePath(req);
                const outputPath = path.join(wsPath, "chrome_screenshot.png");
                fs.writeFileSync(outputPath, base64Data, "base64");
                resolver.resolve(`Screenshot saved to workspace at: ${outputPath}`);
              } catch (writeErr: any) {
                resolver.reject(new Error(`Failed to save screenshot: ${writeErr.message}`));
              }
            } else {
              resolver.resolve(result);
            }
          }
          pendingBrowserControls.delete(controlId);
          sendJSON(res, 200, { success: true });
        } else {
          sendJSON(res, 404, { error: "Browser control request not found" });
        }
        return;
      }

      // Vision Elements Detection via UI-DETR-1
      if (pathname === "/api/browser/detect-ui" && req.method === "POST") {
        try {
          const bodyStr = await readBody(req);
          const body = JSON.parse(bodyStr || "{}");
          const threshold = parseFloat(body.threshold ?? "0.35");
          
          const screenshotResult = await executeBrowserControlOnClient("screenshot", "", "");
          if (screenshotResult.includes("Error") || screenshotResult.includes("failed")) {
            sendJSON(res, 500, { error: `Failed to capture screenshot: ${screenshotResult}` });
            return;
          }
          
          let screenshotPath: string = "";
          let screenshotBase64: string = "";
          
          const wsPath = resolveWorkspacePath(req);
          
          if (screenshotResult.startsWith("data:image/png;base64,")) {
            screenshotBase64 = screenshotResult.replace(/^data:image\/png;base64,/, "");
            const os = await import("os");
            screenshotPath = path.join(os.tmpdir(), "sa_detect_ui.png");
            fs.writeFileSync(screenshotPath, screenshotBase64, "base64");
          } else {
            const match = screenshotResult.match(/Screenshot saved to workspace at: (.+)/);
            screenshotPath = match ? match[1].trim() : path.join(wsPath, "chrome_screenshot.png");
          }
          
          // Call local Python Inference Server
          const response = await fetch("http://127.0.0.1:8095/detect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image_base64: screenshotBase64 || undefined,
              image_path: screenshotBase64 ? undefined : screenshotPath,
              threshold
            })
          });
          
          const data = await response.json() as any;
          if (data.error) {
            sendJSON(res, 500, { error: `Vision Server Error: ${data.error}` });
            return;
          }
          
          if (!screenshotBase64 && fs.existsSync(screenshotPath)) {
            screenshotBase64 = fs.readFileSync(screenshotPath).toString("base64");
          }
          
          sendJSON(res, 200, { elements: data.elements ?? [], screenshotBase64 });
        } catch (err: any) {
          sendJSON(res, 500, { error: err.message });
        }
        return;
      }

      // Browser Macro Presets CRUD
      if (pathname === "/api/browser/macros" && req.method === "GET") {
        sendJSON(res, 200, getBrowserMacros());
        return;
      }

      if (pathname === "/api/browser/macros" && req.method === "POST") {
        try {
          const bodyStr = await readBody(req);
          const macro = JSON.parse(bodyStr || "{}");
          if (!macro.name || !Array.isArray(macro.steps)) {
            sendJSON(res, 400, { error: "Macro must have 'name' and 'steps' fields." });
            return;
          }
          saveBrowserMacro(macro);
          sendJSON(res, 200, { success: true, name: macro.name });
        } catch (err: any) {
          sendJSON(res, 400, { error: err.message || "Invalid macro payload." });
        }
        return;
      }

      if (pathname === "/api/browser/macros" && req.method === "DELETE") {
        try {
          const bodyStr = await readBody(req);
          const { name } = JSON.parse(bodyStr || "{}");
          if (!name) {
            sendJSON(res, 400, { error: "'name' field is required." });
            return;
          }
          const deleted = deleteBrowserMacro(name);
          if (deleted) {
            sendJSON(res, 200, { success: true });
          } else {
            sendJSON(res, 404, { error: `Macro "${name}" not found.` });
          }
        } catch (err: any) {
          sendJSON(res, 400, { error: err.message || "Invalid delete payload." });
        }
        return;
      }

      // Abort agent execution
      if (pathname === "/api/abort" && req.method === "POST") {
        const session = resolveSession(req);
        if (session) {
          session.agent.abort();
        } else {
          for (const s of activeSessions.values()) {
            s.agent.abort();
          }
        }

        for (const sub of subagentInstances.values()) {
          if (sub.status === "running") {
            sub.status = "error";
          }
        }
        for (const superInst of superagentInstances.values()) {
          if (superInst.status === "running") {
            superInst.status = "terminated";
          }
        }

        pendingPermissions.clear();
        pendingQuestions.clear();

        const metadata = session ? { sessionId: session.sessionId, workspace: session.workspace } : {};

        broadcastEvent({
          type: "status",
          text: "Agent execution aborted by user.",
          ...metadata
        });

        broadcastEvent({
          type: "agent_event",
          event: { type: "done", stats: { totalTimeMs: 0 } },
          ...metadata
        });

        sendJSON(res, 200, { success: true });
        return;
      }

      // Shutdown server process
      if (pathname === "/api/shutdown" && req.method === "POST") {
        sendJSON(res, 200, { success: true, message: "Server shutting down..." });
        killVisionServerProcess();
        setTimeout(() => {
          process.exit(0);
        }, 500);
        return;
      }

      // Fetch Tasks
      if (pathname === "/api/tasks" && req.method === "GET") {
        const session = resolveSession(req);
        let taskPath = "";
        if (session) {
          taskPath = session.agent.getTaskFilePath();
        } else {
          const wsPath = resolveWorkspacePath(req);
          const taskFile = "task.md";
          taskPath = wsPath ? path.join(wsPath, taskFile) : "";
        }

        let taskData: ReadChecklistResult = { tasks: [], missing: true };
        if (taskPath && fs.existsSync(taskPath)) {
          taskData = await readChecklistTasks(taskPath);
        }
        sendJSON(res, 200, taskData);
        return;
      }

      // Fetch active subagents/superagents instances
      if (pathname === "/api/instances" && req.method === "GET") {
        const subagents = Array.from(subagentInstances.entries()).map(([id, inst]) => ({
          id,
          typeName: inst.typeName,
          status: inst.status,
          result: inst.result,
          completedAt: inst.completedAt
        }));
        const superagents = Array.from(superagentInstances.entries()).map(([id, inst]) => ({
          id,
          role: inst.role,
          status: inst.status,
          result: inst.result,
          completedAt: inst.completedAt
        }));
        sendJSON(res, 200, { subagents, superagents });
        return;
      }

      // Fetch workspace files
      if (pathname === "/api/workspace/files" && req.method === "GET") {
        const wsPath = resolveWorkspacePath(req);
        if (!wsPath) {
          sendJSON(res, 200, { success: true, files: [] });
          return;
        }

        try {
          const { execa } = await import("execa");
          const { stdout } = await execa("git", ["ls-files"], { cwd: wsPath, reject: false });
          const files = stdout.split("\n").filter(Boolean);
          sendJSON(res, 200, { success: true, files });
        } catch (err: any) {
          sendJSON(res, 200, { success: true, files: [], error: err.message });
        }
        return;
      }

      // Read workspace file content
      if (pathname === "/api/workspace/file/read" && req.method === "POST") {
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr || "{}");
        const { filepath } = body;
        if (!filepath) {
          sendJSON(res, 400, { error: "Missing filepath" });
          return;
        }

        const wsPath = resolveWorkspacePath(req);
        if (!wsPath) {
          sendJSON(res, 400, { error: "No active workspace select" });
          return;
        }

        const fullPath = path.resolve(wsPath, filepath);
        // Verify path traversal safety
        if (!fullPath.startsWith(path.resolve(wsPath))) {
          sendJSON(res, 403, { error: "Access denied (path traversal)" });
          return;
        }

        try {
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            const content = fs.readFileSync(fullPath, "utf-8");
            sendJSON(res, 200, { success: true, content });
          } else {
            sendJSON(res, 404, { error: "File not found" });
          }
        } catch (err: any) {
          sendJSON(res, 500, { error: err.message });
        }
        return;
      }

      // Open workspace file in system default editor
      if (pathname === "/api/workspace/file/open" && req.method === "POST") {
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr || "{}");
        const { filepath } = body;
        if (!filepath) {
          sendJSON(res, 400, { error: "Missing filepath" });
          return;
        }

        const wsPath = resolveWorkspacePath(req);
        if (!wsPath) {
          sendJSON(res, 400, { error: "No active workspace select" });
          return;
        }

        let fullPath = filepath;
        if (!path.isAbsolute(filepath)) {
          fullPath = path.resolve(wsPath, filepath);
        }

        // Verify path traversal safety
        if (!fullPath.startsWith(path.resolve(wsPath))) {
          sendJSON(res, 403, { error: "Access denied (outside workspace)" });
          return;
        }

        try {
          if (fs.existsSync(fullPath)) {
            const { execa } = await import("execa");
            const isWindows = process.platform === "win32";
            const isMac = process.platform === "darwin";
            const command = isWindows ? "cmd" : (isMac ? "open" : "xdg-open");
            const args = isWindows ? ["/c", "start", '""', fullPath] : [fullPath];

            await execa(command, args, { shell: isWindows });
            sendJSON(res, 200, { success: true });
          } else {
            sendJSON(res, 404, { error: "File not found" });
          }
        } catch (err: any) {
          sendJSON(res, 500, { error: err.message });
        }
        return;
      }

      // Fetch Git changes
      if (pathname === "/api/git/changes" && req.method === "GET") {
        const wsPath = resolveWorkspacePath(req);
        if (!wsPath) {
          sendJSON(res, 200, { success: true, changes: [] });
          return;
        }

        try {
          const { execa } = await import("execa");
          const { stdout } = await execa("git", ["status", "--porcelain"], { cwd: wsPath, reject: false });
          const changes = stdout
            .split("\n")
            .filter(Boolean)
            .map(line => {
              const status = line.slice(0, 2).trim();
              const filepath = line.slice(3).trim();
              return { status, filepath };
            });
          sendJSON(res, 200, { success: true, changes });
        } catch (err: any) {
          sendJSON(res, 200, { success: true, changes: [], error: err.message });
        }
        return;
      }

      // Fetch active background tasks
      if (pathname === "/api/background-tasks" && req.method === "GET") {
        try {
          const { backgroundTasks } = await import("./core/tools/state.js");
          const list = Array.from(backgroundTasks.entries()).map(([id, task]) => ({
            id,
            command: task.command,
            hasExited: !!task.hasExited,
            exitCode: task.exitCode ?? null,
            cwd: task.cwd,
            output: task.output.slice(-20)
          }));
          sendJSON(res, 200, { success: true, tasks: list });
        } catch (err: any) {
          sendJSON(res, 500, { error: err.message });
        }
        return;
      }

      // Kill active background task
      if (pathname === "/api/background-tasks/kill" && req.method === "POST") {
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr || "{}");
        const { id } = body;
        if (!id) {
          sendJSON(res, 400, { error: "Missing process ID" });
          return;
        }

        try {
          const { backgroundTasks } = await import("./core/tools/state.js");
          const task = backgroundTasks.get(id);
          if (task) {
            if (task.process && typeof task.process.kill === "function") {
              task.process.kill("SIGTERM");
            }
            task.hasExited = true;
            task.exitCode = -1;
            backgroundTasks.delete(id);
            sendJSON(res, 200, { success: true });
          } else {
            sendJSON(res, 404, { error: "Process not found" });
          }
        } catch (err: any) {
          sendJSON(res, 500, { error: err.message });
        }
        return;
      }

      // Fetch Config / Models
      if (pathname === "/api/config" && req.method === "GET") {
        const settings = getSettings();
        const providers = getConfiguredProviders();
        const singlePresets = getPresets("single");
        const multiPresets = getPresets("multi");
        const activeSinglePresetId = getActivePresetId("single");
        const activeMultiPresetId = getActivePresetId("multi");
        const trustedDirectories = getTrustedDirectories();
        sendJSON(res, 200, {
          settings,
          providers,
          presets: {
            single: singlePresets,
            multi: multiPresets
          },
          activePresetId: {
            single: activeSinglePresetId,
            multi: activeMultiPresetId
          },
          trustedDirectories
        });
        return;
      }

      // Update Config / Models
      if (pathname === "/api/config" && req.method === "POST") {
        try {
          const bodyStr = await readBody(req);
          const body = JSON.parse(bodyStr || "{}");
          
          if (body.settings) {
            updateSettings(body.settings);
          }
          if (body.activePresetId) {
            if (body.activePresetId.single) {
              setActivePresetId("single", body.activePresetId.single);
            }
            if (body.activePresetId.multi) {
              setActivePresetId("multi", body.activePresetId.multi);
            }
          }
          sendJSON(res, 200, { success: true });
        } catch (err: any) {
          sendJSON(res, 400, { success: false, error: err.message || String(err) });
        }
        return;
      }

      // Browse directory dialog
      if (pathname === "/api/browse" && req.method === "GET") {
        if (isBrowseDialogOpen) {
          sendJSON(res, 400, { success: false, error: "A folder selection dialog is already open." });
          return;
        }

        isBrowseDialogOpen = true;
        try {
          const { exec } = await import("child_process");
          let selectedPath = "";
          const platform = process.platform;

          const runCmd = (cmd: string): Promise<string> => {
            return new Promise((resolve, reject) => {
              exec(cmd, { encoding: "utf8" }, (error, stdout, stderr) => {
                if (error) {
                  reject(error);
                } else {
                  resolve(stdout);
                }
              });
            });
          };

          if (platform === "win32") {
            const commands = [
              'Add-Type -AssemblyName System.Windows.Forms',
              '$form = New-Object System.Windows.Forms.Form',
              '$form.TopMost = $true',
              '$form.TopLevel = $true',
              '$form.Width = 1',
              '$form.Height = 1',
              '$form.ShowInTaskbar = $false',
              '$form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
              '$form.Show()',
              '$form.Activate()',
              '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
              '$f.Description = \'Select Local Workspace Folder\'',
              '$f.ShowNewFolderButton = $true',
              '$res = $f.ShowDialog($form)',
              'if ($res -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }'
            ];
            const commandLine = commands.join('; ');
            try {
              const stdout = await runCmd(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${commandLine}"`);
              selectedPath = stdout.trim();
            } catch (err: any) {
              console.warn("Folder dialog closed or failed:", err.message);
              // Do not early-return here — let the outer finally reset isBrowseDialogOpen.
              // Return empty path so caller knows nothing was selected.
              selectedPath = "";
            }
          } else if (platform === "darwin") {
            try {
              const script = 'tell application "Finder" to set selectedFolder to choose folder with prompt "Select Local Workspace Folder"\nPOSIX path of selectedFolder';
              const stdout = await runCmd(`osascript -e ${JSON.stringify(script)}`);
              selectedPath = stdout.trim();
            } catch (err: any) {
              console.warn("macOS folder picker cancelled or failed:", err.message);
            }
          } else {
            try {
              const stdout = await runCmd('zenity --file-selection --directory --title="Select Local Workspace Folder"');
              selectedPath = stdout.trim();
            } catch {
              try {
                const stdout = await runCmd('kdialog --getexistingdirectory');
                selectedPath = stdout.trim();
              } catch (err: any) {
                console.warn("Linux folder picker cancelled or failed:", err.message);
              }
            }
          }

          sendJSON(res, 200, { success: true, path: selectedPath });
        } catch (err: any) {
          sendJSON(res, 500, { success: false, error: err.message || String(err) });
        } finally {
          isBrowseDialogOpen = false;
        }
        return;
      }

      // Switch active workspace
      if (pathname === "/api/switch-workspace" && req.method === "POST") {
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr || "{}");
        const { workspace, mode } = body;

        if (!workspace) {
          sendJSON(res, 400, { error: "workspace path is required" });
          return;
        }

        const targetWorkspace = path.resolve(workspace);
        addTrustedDirectory(targetWorkspace);
        await ensureDirectoryTrusted(targetWorkspace);

        const targetMode = mode === "multi" ? "multi" : "single";
        const targetClientMode = resolveClientMode(req, body, serverDefaultClientMode);

        let session = activeSessions.get(targetWorkspace);
        if (!session || session.mode !== targetMode || session.clientMode !== targetClientMode) {
          if (session && session.agent.isAgentRunning()) {
            session.agent.abort();
          }

          const sessionId = Date.now().toString();
          const agent = await createAgentForMode(targetWorkspace, targetMode, targetClientMode);

          // Automatically load/resume last active session history for this workspace
          try {
            await agent.loadHistory(true);
          } catch {}

          session = {
            agent,
            workspace: targetWorkspace,
            mode: targetMode,
            clientMode: targetClientMode,
            sessionId,
            isCliSession: false
          };
          activeSessions.set(targetWorkspace, session);
        } else {
          if (session.agent.isAgentRunning()) {
            session.agent.abort();
          }
        }

        lastActiveWorkspace = targetWorkspace;

        sendJSON(res, 200, {
          success: true,
          sessionId: session.sessionId,
          workspace: targetWorkspace,
          mode: session.mode,
          clientMode: session.clientMode
        });
        return;
      }

      // Fetch plan, task, and walkthrough markdown content
      if (pathname === "/api/documents" && req.method === "GET") {
        const session = resolveSession(req);
        let planPath = "";
        let taskPath = "";
        let walkthroughPath = "";

        if (session) {
          planPath = session.agent.getPlanFilePath();
          taskPath = session.agent.getTaskFilePath();
          walkthroughPath = session.agent.getWalkthroughFilePath();
        } else {
          const wsPath = lastActiveWorkspace;
          const planFile = "implementation_plan.md";
          const taskFile = "task.md";
          const walkthroughFile = "walkthrough.md";

          planPath = wsPath ? path.join(wsPath, planFile) : "";
          taskPath = wsPath ? path.join(wsPath, taskFile) : "";
          walkthroughPath = wsPath ? path.join(wsPath, walkthroughFile) : "";
        }

        const readMarkdown = async (filePath: string): Promise<string> => {
          try {
            if (filePath && fs.existsSync(filePath)) {
              return await fs.promises.readFile(filePath, "utf-8");
            }
          } catch {}
          return "";
        };

        const planContent = await readMarkdown(planPath);
        const taskContent = await readMarkdown(taskPath);
        const walkthroughContent = await readMarkdown(walkthroughPath);

        sendJSON(res, 200, {
          plan: planContent,
          tasks: taskContent,
          walkthrough: walkthroughContent
        });
        return;
      }

      // Default 404
      sendJSON(res, 404, { error: "Not Found" });

    } catch (err: any) {
      console.error("[SERVER ERROR]", err);
      sendJSON(res, 500, { error: err.message || String(err) });
    }
  });

  server.on("error", (err: any) => {
    if (!silent) {
      console.error("[Server Error]", err);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    if (!silent) {
      console.log(`\n🚀 Superagent Server is running at http://localhost:${port}`);
      console.log(`💡 Mode: REST API & Server-Sent Events (SSE)`);
      console.log(`🎯 Default Client Mode: ${serverDefaultClientMode}`);
      console.log(`📂 Current Workspace: ${lastActiveWorkspace}\n`);
    }
  });
}
