import http from "http";
import { URL } from "url";
import fs from "fs";
import path from "path";
import { Agent } from "./core/agent.js";
import type { AgentEvent } from "./core/agent.js";
import { getConfig, getSettings, getConfiguredProviders, addTrustedDirectory, ensureDirectoryTrusted, getPresets, getActivePresetId, setActivePresetId, updateSettings, listHistorySessions, getTrustedDirectories, closeHistoryDb, generateSessionId, purgeEmptySessions, getPackageRootDir, getInstalledSkills, getSuperAgentVersion } from "./core/config.js";
import { readChecklistTasks, ReadChecklistResult } from "./core/taskChecklist.js";
import { subagentInstances, superagentInstances, registerMasterAgent, subscribeToActiveOutput, subscribeToSubagents, subscribeToSuperagents, registerQuestionHandler } from "./core/tools/state.js";
import { setBrowserControlHandler } from "./core/tools/otherTools.js";
import { getBrowserMacros, saveBrowserMacro, deleteBrowserMacro } from "./core/config/browserMacros.js";
import { execSync } from "child_process";
import { handleServerRoute } from "./serverRoutes.js";

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
        try {
          execSync(`taskkill /F /T /PID ${visionServerProcess.pid}`, { stdio: "ignore" });
        } catch {}
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
  const reqClientMode = resolveClientMode(req);

  if (targetSessionId) {
    for (const session of activeSessions.values()) {
      if (session.sessionId === targetSessionId && session.clientMode === reqClientMode) {
        session.lastActiveTime = Date.now();
        return session;
      }
    }
  }

  if (wsPath) {
    wsPath = path.resolve(wsPath);
    const session = activeSessions.get(`${reqClientMode}:${wsPath}`);
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
      if (session.clientMode === reqClientMode && session.workspace.toLowerCase() === wsPath.toLowerCase()) {
        if (targetSessionId) {
          session.sessionId = targetSessionId;
        }
        session.lastActiveTime = Date.now();
        return session;
      }
    }
  }

  for (const session of activeSessions.values()) {
    if (session.clientMode === reqClientMode && session.isCliSession) {
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
  activeSessions.set(`${clientMode}:${targetWorkspace}`, {
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

  // Broadcast subagents_update to SSE clients so frontend receives live logs & state updates
  broadcastEvent({
    type: "subagents_update",
    subagents: activeList.map((inst) => ({
      id: inst.id,
      typeName: inst.typeName,
      role: inst.role,
      status: inst.status,
      result: inst.result,
      logs: inst.logs || [],
      prompt: inst.prompt,
      completedAt: inst.completedAt
    }))
  });

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
        const isMatch = inst.parentAgent
          ? session.agent === inst.parentAgent
          : path.resolve(session.workspace) === path.resolve(inst.agent.workingDirectory);
        if (isMatch && !session.agent.isAgentRunning()) {
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
        const isMatch = inst.parentAgent
          ? session.agent === inst.parentAgent
          : path.resolve(session.workspace) === path.resolve(inst.agent.workingDirectory);
        if (isMatch && !session.agent.isAgentRunning()) {
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
      const handled = await handleServerRoute(req, res, pathname, parsedUrl, {
        activeSessions,
        lastActiveWorkspace,
        setLastActiveWorkspace: (ws: string) => { lastActiveWorkspace = ws; },
        isBrowseDialogOpen,
        setIsBrowseDialogOpen: (v: boolean) => { isBrowseDialogOpen = v; },
        serverDefaultClientMode,
        sseClients,
        browserInstances,
        pendingPermissions,
        pendingQuestions,
        pendingBrowserControls,
        resolveSession,
        resolveWorkspacePath,
        resolveClientMode,
        createAgentForMode,
        broadcastEvent,
        sendJSON,
        readBody,
        executeBrowserControlOnClient,
        killVisionServerProcess
      });

      if (!handled) {
        sendJSON(res, 404, { error: "Not Found" });
      }
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
      console.log(`\n🚀 SuperAgent Server v${getSuperAgentVersion()} is running at http://localhost:${port}`);
      console.log(`💡 Mode: REST API & Server-Sent Events (SSE)`);
      console.log(`🎯 Default Client Mode: ${serverDefaultClientMode}`);
      console.log(`📂 Current Workspace: ${lastActiveWorkspace}\n`);
    }
  });
}
