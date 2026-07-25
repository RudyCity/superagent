import http from "http";
import path from "path";
import fs from "fs";
import { URL } from "url";
import type { Agent } from "./core/agent.js";
import { 
  getSettings,
  getModelPresets, 
  addTrustedDirectory, 
  ensureDirectoryTrusted, 
  getPresets, 
  getActivePresetId, 
  getActivePreset,
  setActivePresetId, 
  applyModelPreset,
  saveModelPreset,
  deleteModelPreset,
  savePreset,
  deletePreset,
  getProviders,
  addProvider,
  removeProvider,
  switchActiveProvider,
  loadModelConfig,
  mutateModelConfig,
  updateSettings, 
  listHistorySessions, 
  getTrustedDirectories, 
  generateSessionId, 
  getInstalledSkills,
  exportSession,
  saveWorkspaceToDb,
  saveSessionToDb,
  loadSessionFromDb,
  clearHistoryCache,
  getWorkspaceId,
  getWorkspaceFromDb,
  getSuperAgentVersion
} from "./core/config.js";
import { readChecklistTasks, ReadChecklistResult } from "./core/taskChecklist.js";
import { subagentInstances, superagentInstances, backgroundTasks } from "./core/tools/state.js";
import { getBrowserMacros, saveBrowserMacro, deleteBrowserMacro } from "./core/config/browserMacros.js";

export async function handleServerRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  parsedUrl: URL,
  ctx: {
    activeSessions: Map<string, any>;
    lastActiveWorkspace: string;
    setLastActiveWorkspace: (ws: string) => void;
    isBrowseDialogOpen: boolean;
    setIsBrowseDialogOpen: (v: boolean) => void;
    serverDefaultClientMode: any;
    sseClients: Set<http.ServerResponse>;
    browserInstances: Map<string, any>;
    pendingPermissions: Map<string, (approval: boolean | "session") => void>;
    pendingQuestions: Map<string, (answer: any) => void>;
    pendingBrowserControls: Map<string, { resolve: (val: string) => void; reject: (err: any) => void }>;
    resolveSession: (req: http.IncomingMessage, sessionId?: string) => any;
    resolveWorkspacePath: (req: http.IncomingMessage) => string;
    resolveClientMode: (req: http.IncomingMessage, body?: any, defaultMode?: any) => any;
    createAgentForMode: (targetWorkspace: string, targetMode: "single" | "multi", targetClientMode: any) => Promise<Agent>;
    broadcastEvent: (event: any) => void;
    sendJSON: (res: http.ServerResponse, status: number, data: any) => void;
    readBody: (req: http.IncomingMessage) => Promise<string>;
    executeBrowserControlOnClient: (action: string, target: string, value?: string, instanceId?: string) => Promise<string>;
    killVisionServerProcess: () => void;
  }
): Promise<boolean> {
  const {
    activeSessions,
    lastActiveWorkspace,
    setLastActiveWorkspace,
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
  } = ctx;

  // SSE Endpoint
  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    try { (res.socket as any)?.setNoDelay(true); } catch {}
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

    const keepAliveInterval = setInterval(() => {
      try { res.write(": keepalive\n\n"); } catch { clearInterval(keepAliveInterval); }
    }, 15000);

    req.on("close", () => {
      clearInterval(keepAliveInterval);
      sseClients.delete(res);
      if (instanceKey) browserInstances.delete(instanceKey);
    });
    return true;
  }

  // Status
  if (pathname === "/api/status" && req.method === "GET") {
    const session = resolveSession(req);
    sendJSON(res, 200, {
      status: "online",
      version: getSuperAgentVersion(),
      workspace: resolveWorkspacePath(req),
      mode: session ? session.mode : "single",
      clientMode: session ? session.clientMode : serverDefaultClientMode,
      sessionId: session ? session.sessionId : null,
      agentActive: !!session,
      agentRunning: session ? session.agent.isAgentRunning() : false,
      isCliSession: session ? session.isCliSession : false,
      planState: session ? session.agent.planState : "IDLE",
    });
    return true;
  }

  // Workspaces List
  if (pathname === "/api/workspaces" && req.method === "GET") {
    const workspaces = Array.from(activeSessions.values()).map(s => {
      const wsId = s.workspace ? getWorkspaceId(s.workspace) : "";
      const wsRecord = wsId ? getWorkspaceFromDb(wsId) : null;
      return {
        sessionId: s.sessionId,
        workspace: s.workspace,
        name: wsRecord?.name || (s.workspace ? path.basename(s.workspace) : undefined),
        mode: s.mode,
        clientMode: s.clientMode,
        isCliSession: s.isCliSession,
        agentRunning: s.agent.isAgentRunning(),
        planState: s.agent.planState,
        lastActiveTime: s.lastActiveTime || Date.now()
      };
    });
    sendJSON(res, 200, { success: true, workspaces });
    return true;
  }

  // Get chat history
  if (pathname === "/api/history" && req.method === "GET") {
    const targetSessionId = parsedUrl.searchParams.get("sessionId") || parsedUrl.searchParams.get("id");
    const session = resolveSession(req, targetSessionId || undefined);
    if (session && targetSessionId && session.sessionId === targetSessionId) {
      const msgs = session.agent.getConversationMessages();
      if (msgs.length > 0) {
        sendJSON(res, 200, { success: true, messages: msgs });
        return true;
      }
    }
    if (targetSessionId) {
      const dbResult = loadSessionFromDb(targetSessionId);
      if (dbResult && dbResult.session && dbResult.messages.length > 0) {
        const formattedMsgs = dbResult.messages.map((m) => {
          let content = m.content;
          if (typeof m.content === "string" && (m.content.startsWith("[") || m.content.startsWith("{"))) {
            try { content = JSON.parse(m.content); } catch {}
          }
          let toolCalls = undefined;
          if (m.toolCalls) {
            try { toolCalls = JSON.parse(m.toolCalls); } catch {}
          }
          let toolResults = undefined;
          if (m.toolResults) {
            try { toolResults = JSON.parse(m.toolResults); } catch {}
          }
          return {
            role: m.role,
            content,
            toolCalls,
            toolResults,
            reasoning: m.reasoning,
            timestamp: m.timestamp,
          };
        });
        sendJSON(res, 200, { success: true, messages: formattedMsgs });
        return true;
      }
    }
    sendJSON(res, 200, { success: true, messages: [] });
    return true;
  }

  // Get list of previous history sessions
  if (pathname === "/api/history/sessions" && req.method === "GET") {
    const workspacePath = resolveWorkspacePath(req);
    const queryMode = parsedUrl.searchParams.get("mode");
    const session = resolveSession(req);
    const mode = queryMode || (session ? session.mode : "single");
    const isMulti = mode === "multi";
    if (!workspacePath) {
      sendJSON(res, 200, { success: true, sessions: [] });
      return true;
    }
    const sessions = listHistorySessions(isMulti, false, workspacePath);
    sendJSON(res, 200, { success: true, sessions });
    return true;
  }

  // Delete a history session by ID
  if (pathname.startsWith("/api/history/session/") && req.method === "DELETE") {
    const sessionId = decodeURIComponent(pathname.replace("/api/history/session/", ""));
    if (!sessionId) {
      sendJSON(res, 400, { error: "Missing session ID" });
      return true;
    }
    try {
      const { deleteSessionFromDb, clearHistoryCache } = await import("./core/config.js");
      deleteSessionFromDb(sessionId);
      clearHistoryCache();

      for (const [key, session] of activeSessions.entries()) {
        if (session.sessionId === sessionId) {
          if (session.agent.isAgentRunning()) session.agent.abort();
          activeSessions.delete(key);
        }
      }

      broadcastEvent({ type: "superagent-sessions-changed" });
      sendJSON(res, 200, { success: true });
    } catch (err: any) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // Save or update session metadata (title, messages) in SQLite DB
  if (pathname === "/api/history/session" && req.method === "POST") {
    try {
      const bodyStr = await readBody(req);
      const body = JSON.parse(bodyStr || "{}");
      const { session, messages } = body;
      if (!session || !session.id) {
        sendJSON(res, 400, { error: "Session metadata with id is required" });
        return true;
      }
      const workspacePath = resolveWorkspacePath(req);
      const sessionId = session.id;
      const title = session.title || session.displayName || "New Chat";
      
      const { saveSessionToDb, loadSessionFromDb, clearHistoryCache, getGlobalConfigDir } = await import("./core/config.js");
      
      const existing = loadSessionFromDb(sessionId);
      const filePath = existing.session?.filePath || session.filePath || path.join(getGlobalConfigDir(), "history", "single", sessionId, `${sessionId}.json`);
      
      const msgsToSave = Array.isArray(messages) && messages.length > 0 ? messages.map((m: any, idx: number) => ({
        sessionId,
        role: m.role || "user",
        content: typeof m.text === "string" ? m.text : (typeof m.content === "string" ? m.content : JSON.stringify(m.content || m.text || "")),
        toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : undefined,
        toolResults: m.toolResults ? JSON.stringify(m.toolResults) : undefined,
        reasoning: m.reasoning || m.thought,
        timestamp: m.timestamp || Date.now(),
        sequenceOrder: idx
      })) : (existing.messages || []);

      const userMsgs = msgsToSave.filter((m: any) => m.role === "user" && m.content);
      const firstUserContent = userMsgs[0]?.content || null;
      const lastUserContent = userMsgs[userMsgs.length - 1]?.content || null;

      saveSessionToDb(
        {
          id: sessionId,
          filePath,
          displayName: title,
          messageCount: msgsToSave.length,
          lastModified: session.updatedAt || Date.now(),
          preview: title,
          workingDirectory: workspacePath,
          firstChat: firstUserContent || title,
          lastChat: lastUserContent || title
        },
        msgsToSave
      );

      clearHistoryCache();
      broadcastEvent({ type: "superagent-sessions-changed" });
      sendJSON(res, 200, { success: true });
    } catch (err: any) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // Get input history for a workspace
  if (pathname === "/api/input-history" && req.method === "GET") {
    const workspacePath = resolveWorkspacePath(req);
    if (!workspacePath) {
      sendJSON(res, 200, { success: true, history: [] });
      return true;
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
    return true;
  }

  // Save input history for a workspace
  if (pathname === "/api/input-history" && req.method === "POST") {
    const workspacePath = resolveWorkspacePath(req);
    if (!workspacePath) {
      sendJSON(res, 400, { error: "No workspace path" });
      return true;
    }
    try {
      const bodyStr = await readBody(req);
      const body = JSON.parse(bodyStr || "{}");
      const { command } = body;
      if (!command || typeof command !== "string" || !command.trim()) {
        sendJSON(res, 400, { error: "Missing or empty 'command' field" });
        return true;
      }
      const { getWorkspaceId } = await import("./core/config/paths.js");
      const { saveInputHistoryToDb } = await import("./core/storage/historyDb.js");
      const wsId = getWorkspaceId(workspacePath);
      saveInputHistoryToDb(wsId, command.trim());
      sendJSON(res, 200, { success: true });
    } catch (err: any) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // Initialize session
  if (pathname === "/api/init" && req.method === "POST") {
    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr || "{}");
    const { mode, workspace, resume, initialPrompt, sessionId: customSessionId } = body;

    const targetWorkspace = workspace ? path.resolve(workspace) : process.cwd();
    addTrustedDirectory(targetWorkspace);
    await ensureDirectoryTrusted(targetWorkspace);

    const targetMode = mode === "multi" ? "multi" : "single";
    const targetClientMode = resolveClientMode(req, body, serverDefaultClientMode);
    const sessionId = customSessionId || resume || generateSessionId();

    const existingSession = activeSessions.get(`${targetClientMode}:${targetWorkspace}:server`);
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
      return true;
    }

    if (existingSession && existingSession.agent.isAgentRunning()) {
      existingSession.agent.abort();
    }

    const agent = await createAgentForMode(targetWorkspace, targetMode, targetClientMode);
    agent.sessionId = sessionId;

    pendingPermissions.clear();
    pendingQuestions.clear();

    if (resume) {
      try { await agent.loadHistory(resume); } catch {}
    }

    activeSessions.set(`${targetClientMode}:${targetWorkspace}:server`, {
      agent,
      workspace: targetWorkspace,
      mode: targetMode,
      clientMode: targetClientMode,
      sessionId,
      isCliSession: false
    });
    setLastActiveWorkspace(targetWorkspace);

    sendJSON(res, 200, {
      success: true,
      sessionId,
      workspace: targetWorkspace,
      mode: targetMode,
      clientMode: targetClientMode
    });

    if (initialPrompt && initialPrompt.trim()) {
      const activePresetId = getActivePresetId(targetMode);
      const presetsForMode = getPresets(targetMode) || [];
      const hasValidActivePreset = Boolean(
        activePresetId &&
        presetsForMode.some(p => p.id?.toLowerCase() === activePresetId.toLowerCase() || p.name?.toLowerCase() === activePresetId.toLowerCase())
      );
      if (hasValidActivePreset) {
        setTimeout(() => {
          agent.sendMessage(initialPrompt).catch((err: any) => {
            broadcastEvent({ type: "error", message: err.message || String(err) });
          });
        }, 100);
      } else {
        broadcastEvent({ type: "error", message: `Cannot run initial prompt: No active model preset configured for ${targetMode} mode.` });
      }
    }
    return true;
  }

  // Send chat message
  if (pathname === "/api/chat" && req.method === "POST") {
    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr || "{}");
    const { message, sessionId: reqSessionId } = body;

    const session = resolveSession(req, reqSessionId);
    if (!session) {
      sendJSON(res, 400, { error: "Session not initialized" });
      return true;
    }

    if (!message) {
      sendJSON(res, 400, { error: "Empty message", sessionId: session.sessionId });
      return true;
    }

    const activePresetId = getActivePresetId(session.mode);
    const presetsForMode = getPresets(session.mode) || [];
    const hasValidActivePreset = Boolean(
      activePresetId &&
      presetsForMode.some(p => p.id?.toLowerCase() === activePresetId.toLowerCase() || p.name?.toLowerCase() === activePresetId.toLowerCase())
    );
    if (!hasValidActivePreset) {
      sendJSON(res, 400, { error: `No active model preset configured for ${session.mode} mode. Please select an active preset first.`, sessionId: session.sessionId });
      return true;
    }

    if (typeof message === "string" && message.startsWith("!")) {
      const command = message.slice(1).trim();
      if (!command) {
        sendJSON(res, 400, { error: "Empty terminal command", sessionId: session.sessionId });
        return true;
      }

      (async () => {
        const wsPath = session.workspace || lastActiveWorkspace;
        broadcastEvent({ type: "agent_event", event: { type: "text", content: `> Executing command: ${command}\n` } });

        try {
          const { execa } = await import("execa");
          const cp = execa(command, { cwd: wsPath, all: true, reject: false, shell: true });
          cp.all?.on("data", (chunk) => {
            broadcastEvent({ type: "agent_event", event: { type: "text", content: chunk.toString() } });
          });
          const result = await cp;
          broadcastEvent({ type: "agent_event", event: { type: "text", content: `\n> Command finished with exit code ${result.exitCode}\n` } });
        } catch (err: any) {
          broadcastEvent({ type: "agent_event", event: { type: "text", content: `\n> Command failed: ${err.message}\n` } });
        } finally {
          broadcastEvent({ type: "agent_event", event: { type: "done", stats: { totalTimeMs: 0 } } });
        }
      })();

      sendJSON(res, 200, { success: true, sessionId: session.sessionId });
      return true;
    }

    session.agent.sendMessage(message).catch((err: any) => {
      broadcastEvent({ type: "error", message: err.message || String(err) });
    });

    sendJSON(res, 200, { success: true, sessionId: session.sessionId });
    return true;
  }

  // Advisor Status & Events routes for Chrome Extension / Web Panel
  if (pathname === "/api/advisor/status" && req.method === "GET") {
    const { getAdvisorMetrics } = await import("./core/advisorLogger.js");
    const metrics = getAdvisorMetrics();
    sendJSON(res, 200, { success: true, metrics });
    return true;
  }

  if (pathname === "/api/advisor/events" && req.method === "GET") {
    const { getAdvisorEvents } = await import("./core/advisorLogger.js");
    const limit = parseInt(parsedUrl.searchParams.get("limit") || "50", 10);
    const events = getAdvisorEvents(limit);
    sendJSON(res, 200, { success: true, events });
    return true;
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
    return true;
  }

  // Handle Plan Approval
  if (pathname === "/api/plan/approve" && req.method === "POST") {
    const session = resolveSession(req);
    if (!session) {
      sendJSON(res, 400, { error: "Session not initialized" });
      return true;
    }
    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr || "{}");
    const { action } = body;

    if (action === "approve") {
      session.agent.approvePlan();
      session.agent.sendMessage("Implementation plan approved via interactive approval wizard. Continue with the approved plan now.").catch((err: any) => {
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
    return true;
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
    return true;
  }

  // Update browser instance
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
    return true;
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
    return true;
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
        return true;
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
        return true;
      }
      
      if (!screenshotBase64 && fs.existsSync(screenshotPath)) {
        screenshotBase64 = fs.readFileSync(screenshotPath).toString("base64");
      }
      
      sendJSON(res, 200, { elements: data.elements ?? [], screenshotBase64 });
    } catch (err: any) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // Browser Macro Presets CRUD
  if (pathname === "/api/browser/macros" && req.method === "GET") {
    sendJSON(res, 200, getBrowserMacros());
    return true;
  }

  if (pathname === "/api/browser/macros" && req.method === "POST") {
    try {
      const bodyStr = await readBody(req);
      const macro = JSON.parse(bodyStr || "{}");
      if (!macro.name || !Array.isArray(macro.steps)) {
        sendJSON(res, 400, { error: "Macro must have 'name' and 'steps' fields." });
        return true;
      }
      saveBrowserMacro(macro);
      sendJSON(res, 200, { success: true, name: macro.name });
    } catch (err: any) {
      sendJSON(res, 400, { error: err.message || "Invalid macro payload." });
    }
    return true;
  }

  if (pathname === "/api/browser/macros" && req.method === "DELETE") {
    try {
      const bodyStr = await readBody(req);
      const { name } = JSON.parse(bodyStr || "{}");
      if (!name) {
        sendJSON(res, 400, { error: "'name' field is required." });
        return true;
      }
      const deleted = deleteBrowserMacro(name);
      if (deleted) sendJSON(res, 200, { success: true });
      else sendJSON(res, 404, { error: `Macro "${name}" not found.` });
    } catch (err: any) {
      sendJSON(res, 400, { error: err.message || "Invalid delete payload." });
    }
    return true;
  }

  // Abort agent execution
  if (pathname === "/api/abort" && req.method === "POST") {
    const session = resolveSession(req);
    if (session) {
      session.agent.abort();
    } else {
      for (const s of activeSessions.values()) s.agent.abort();
    }

    for (const sub of subagentInstances.values()) {
      if (sub.status === "running") sub.status = "error";
    }
    for (const superInst of superagentInstances.values()) {
      if (superInst.status === "running") superInst.status = "terminated";
    }

    pendingPermissions.clear();
    pendingQuestions.clear();

    const metadata = session ? { sessionId: session.sessionId, workspace: session.workspace } : {};
    broadcastEvent({ type: "status", text: "Agent execution aborted by user.", ...metadata });
    broadcastEvent({ type: "agent_event", event: { type: "done", stats: { totalTimeMs: 0 } }, ...metadata });

    sendJSON(res, 200, { success: true });
    return true;
  }

  // Shutdown server process
  if (pathname === "/api/shutdown" && req.method === "POST") {
    sendJSON(res, 200, { success: true, message: "Server shutting down..." });
    killVisionServerProcess();
    setTimeout(() => { process.exit(0); }, 500);
    return true;
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
    return true;
  }

  // Fetch active subagents/superagents instances & background procs
  if (pathname === "/api/instances" && req.method === "GET") {
    const subagents = Array.from(subagentInstances.entries()).map(([id, inst]) => ({
      id,
      typeName: inst.typeName,
      role: inst.role,
      status: inst.status,
      result: inst.result,
      logs: inst.logs || [],
      prompt: inst.prompt,
      completedAt: inst.completedAt
    }));
    const superagents = Array.from(superagentInstances.entries()).map(([id, inst]) => ({
      id,
      typeName: 'superagent',
      role: inst.role || 'Superagent',
      status: inst.status,
      result: inst.result,
      logs: inst.logs || [],
      prompt: inst.task,
      completedAt: inst.completedAt
    }));
    const procs = Array.from(backgroundTasks.values())
      .filter(t => !t.isHidden)
      .map(t => {
        let logs: string[] = t.output || [];
        if (t.logPath && fs.existsSync(t.logPath)) {
          try {
            const raw = fs.readFileSync(t.logPath, "utf-8");
            const lines = raw.split("\n").filter(l => l.trim().length > 0);
            if (lines.length > 0) logs = lines.slice(-1000);
          } catch {}
        }
        return {
          id: t.id,
          pid: t.process?.pid || 0,
          name: t.command,
          status: t.hasExited ? 'stopped' : 'running',
          commandLine: t.command,
          hasExited: !!t.hasExited,
          logs
        };
      });
    sendJSON(res, 200, { subagents, superagents, procs });
    return true;
  }

  // Fetch workspace files
  if (pathname === "/api/workspace/files" && req.method === "GET") {
    const wsPath = resolveWorkspacePath(req);
    if (!wsPath) {
      sendJSON(res, 200, { success: true, files: [] });
      return true;
    }
    try {
      const { execa } = await import("execa");
      const { stdout } = await execa("git", ["ls-files"], { cwd: wsPath, reject: false });
      const files = stdout.split("\n").filter(Boolean);
      sendJSON(res, 200, { success: true, files });
    } catch (err: any) {
      sendJSON(res, 200, { success: true, files: [], error: err.message });
    }
    return true;
  }

  // Read workspace file content
  if (pathname === "/api/workspace/file/read" && req.method === "POST") {
    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr || "{}");
    const { filepath } = body;
    if (!filepath) {
      sendJSON(res, 400, { error: "Missing filepath" });
      return true;
    }
    const wsPath = resolveWorkspacePath(req);
    if (!wsPath) {
      sendJSON(res, 400, { error: "No active workspace select" });
      return true;
    }
    const fullPath = path.resolve(wsPath, filepath);
    if (!fullPath.startsWith(path.resolve(wsPath))) {
      sendJSON(res, 403, { error: "Access denied (path traversal)" });
      return true;
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
    return true;
  }

  // Open workspace file
  if (pathname === "/api/workspace/file/open" && req.method === "POST") {
    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr || "{}");
    const { filepath } = body;
    if (!filepath) {
      sendJSON(res, 400, { error: "Missing filepath" });
      return true;
    }
    const wsPath = resolveWorkspacePath(req);
    if (!wsPath) {
      sendJSON(res, 400, { error: "No active workspace select" });
      return true;
    }
    let fullPath = filepath;
    if (!path.isAbsolute(filepath)) fullPath = path.resolve(wsPath, filepath);

    if (!fullPath.startsWith(path.resolve(wsPath))) {
      sendJSON(res, 403, { error: "Access denied (outside workspace)" });
      return true;
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
    return true;
  }

  // Fetch Git changes
  if (pathname === "/api/git/changes" && req.method === "GET") {
    const wsPath = resolveWorkspacePath(req);
    if (!wsPath) {
      sendJSON(res, 200, { success: true, changes: [] });
      return true;
    }
    try {
      const { execa } = await import("execa");
      const { stdout } = await execa("git", ["status", "--porcelain"], { cwd: wsPath, reject: false });
      const changes = stdout.split("\n").filter(Boolean).map(line => ({
        status: line.slice(0, 2).trim(),
        filepath: line.slice(3).trim()
      }));
      sendJSON(res, 200, { success: true, changes });
    } catch (err: any) {
      sendJSON(res, 200, { success: true, changes: [], error: err.message });
    }
    return true;
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
    return true;
  }

  // Kill active background task
  if (pathname === "/api/background-tasks/kill" && req.method === "POST") {
    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr || "{}");
    const { id } = body;
    if (!id) {
      sendJSON(res, 400, { error: "Missing process ID" });
      return true;
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
    return true;
  }

  // Skills list
  if (pathname === "/api/skills" && req.method === "GET") {
    try {
      const skills = getInstalledSkills();
      sendJSON(res, 200, { skills });
    } catch (err: any) {
      sendJSON(res, 500, { error: err.message || String(err) });
    }
    return true;
  }

  // Helper: derive active provider profile id from active preset's main tier
  const deriveActiveProviderId = (): string => {
    try {
      const isMulti = process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true";
      const preset = getActivePreset<any>(isMulti ? "multi" : "single");
      const tier = isMulti ? preset.models?.master : preset.models?.superagent;
      return tier?.providerProfileId || "";
    } catch { return ""; }
  };

  // Fetch Config (full snapshot: settings, providers, presets, activePresetId)
  if (pathname === "/api/config" && req.method === "GET") {
    const settings = getSettings();
    const config = loadModelConfig();
    const configSingle: any[] = getPresets("single") || [];
    const configMulti: any[] = getPresets("multi") || [];
    let cliSingle: any[] = [];
    let cliMulti: any[] = [];
    try {
      cliSingle = getModelPresets("single") || [];
      cliMulti = getModelPresets("multi") || [];
    } catch (e) {}

    const mergePresets = (configList: any[], cliList: any[]) => {
      const map = new Map<string, any>();
      for (const p of cliList) {
        if (p && p.name) map.set(p.name, { ...p, id: p.id || p.name });
      }
      for (const p of configList) {
        if (p && (p.name || p.id)) {
          const key = p.name || p.id;
          map.set(key, { ...map.get(key), ...p, id: p.id || p.name });
        }
      }
      return Array.from(map.values());
    };

    const singlePresets = mergePresets(configSingle, cliSingle);
    const multiPresets = mergePresets(configMulti, cliMulti);
    const activeSinglePresetId = getActivePresetId("single");
    const activeMultiPresetId = getActivePresetId("multi");
    const trustedDirectories = getTrustedDirectories();
    sendJSON(res, 200, {
      settings,
      superagentVersion: getSuperAgentVersion(),
      providers: config.providers,    // ALL providers, not filtered by apiKey
      presets: { single: singlePresets, multi: multiPresets },
      activePresetId: { single: activeSinglePresetId, multi: activeMultiPresetId },
      activeProviderProfileId: deriveActiveProviderId(),
      trustedDirectories
    });
    return true;
  }

  // Update Config (settings + active preset switching)
  if (pathname === "/api/config" && req.method === "POST") {
    try {
      const bodyStr = await readBody(req);
      const body = JSON.parse(bodyStr || "{}");
      if (body.settings) updateSettings(body.settings);
      if (body.activePresetId) {
        if (body.activePresetId.single) applyModelPreset(body.activePresetId.single, "single");
        if (body.activePresetId.multi) applyModelPreset(body.activePresetId.multi, "multi");
      }
      sendJSON(res, 200, { success: true });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  // Set Active Preset
  if (pathname === "/api/config/active-preset" && req.method === "POST") {
    try {
      const bodyStr = await readBody(req);
      const { mode, presetId } = JSON.parse(bodyStr || "{}");
      if (!mode || !presetId) {
        sendJSON(res, 400, { error: "mode and presetId are required" });
        return true;
      }
      applyModelPreset(presetId, mode as "single" | "multi");
      const config = loadModelConfig();
      sendJSON(res, 200, {
        success: true,
        activePresetId: config.activePresetId,
        activeProviderProfileId: deriveActiveProviderId()
      });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  // Save/Update a Preset
  if (pathname === "/api/config/preset" && req.method === "POST") {
    try {
      const bodyStr = await readBody(req);
      const { mode, preset } = JSON.parse(bodyStr || "{}");
      if (!mode || !preset?.name) {
        sendJSON(res, 400, { error: "mode and preset.name are required" });
        return true;
      }
      const m = mode as "single" | "multi";
      const presetId = (preset.id || preset.name).toLowerCase().replace(/\s+/g, "-");
      const jsonPreset = {
        id: presetId,
        name: preset.name,
        description: preset.description || "Custom model preset.",
        models: preset.models || {}
      };
      savePreset(m, jsonPreset);
      // CLI compat: convert structured models to MODEL_* flat format for model-presets.json
      try {
        const raw = preset.models || {};
        const fmtTier = (tier: any): string => {
          if (!tier?.model) return "";
          return tier.providerProfileId ? `${tier.providerProfileId}@${tier.model}` : tier.model;
        };
        const cliModels: Record<string, string> = {};
        if (m === "multi") {
          const mv = fmtTier(raw.master); if (mv) cliModels.MODEL_MULTI_MASTER = mv;
          const sv = fmtTier(raw.superagent); if (sv) cliModels.MODEL_MULTI_SUPERAGENT = sv;
          const dv = fmtTier(raw.subagentDefault); if (dv) cliModels.MODEL_MULTI_SUBAGENT = dv;
          for (const [k, v] of Object.entries(raw.subagentDetails || {})) {
            const fv = fmtTier(v); if (fv) cliModels[`MODEL_MULTI_SUBAGENT_${k.toUpperCase()}`] = fv;
          }
        } else {
          const sv = fmtTier(raw.superagent); if (sv) cliModels.MODEL_SINGLE_SUPERAGENT = sv;
          const dv = fmtTier(raw.subagentDefault); if (dv) cliModels.MODEL_SINGLE_SUBAGENT = dv;
          for (const [k, v] of Object.entries(raw.subagentDetails || {})) {
            const fv = fmtTier(v); if (fv) cliModels[`MODEL_SINGLE_SUBAGENT_${k.toUpperCase()}`] = fv;
          }
        }
        if (Object.keys(cliModels).length > 0) saveModelPreset(preset.name, preset.description || "", cliModels, m);
      } catch {}
      const singlePresets = getPresets("single");
      const multiPresets = getPresets("multi");
      sendJSON(res, 200, {
        success: true,
        presets: { single: singlePresets, multi: multiPresets },
        activePresetId: { single: getActivePresetId("single"), multi: getActivePresetId("multi") }
      });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  // Delete a Preset
  if (pathname.startsWith("/api/config/preset/") && req.method === "DELETE") {
    try {
      const parts = pathname.replace("/api/config/preset/", "").split("/");
      const mode = parts[0] as "single" | "multi";
      const presetId = decodeURIComponent(parts[1] || "");
      if (!mode || !presetId) {
        sendJSON(res, 400, { error: "mode and preset id are required" });
        return true;
      }
      deletePreset(mode, presetId);
      // Resolve preset name from model-config.json for model-presets.json cleanup
      try {
        const cfg = loadModelConfig();
        const match = (cfg.presets[mode] as any[]).find(
          (p) => p.id?.toLowerCase() === presetId.toLowerCase() || p.name?.toLowerCase() === presetId.toLowerCase()
        );
        const nameToDelete = match?.name || presetId;
        deleteModelPreset(nameToDelete, mode);
      } catch {}
      const singlePresets = getPresets("single");
      const multiPresets = getPresets("multi");
      sendJSON(res, 200, {
        success: true,
        presets: { single: singlePresets, multi: multiPresets },
        activePresetId: { single: getActivePresetId("single"), multi: getActivePresetId("multi") }
      });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  // Save/Update a Provider Profile
  if (pathname === "/api/config/provider" && req.method === "POST") {
    try {
      const bodyStr = await readBody(req);
      const { provider } = JSON.parse(bodyStr || "{}");
      if (!provider?.id || !provider?.name) {
        sendJSON(res, 400, { error: "provider.id and provider.name are required" });
        return true;
      }
      addProvider({
        id: provider.id,
        name: provider.name,
        provider: provider.type || provider.provider || "openai",
        apiKey: provider.apiKey || "",
        baseUrl: provider.baseUrl || ""
      });
      const config = loadModelConfig();
      sendJSON(res, 200, {
        success: true,
        providers: config.providers,
        activeProviderProfileId: deriveActiveProviderId()
      });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  // Delete a Provider Profile
  if (pathname.startsWith("/api/config/provider/") && req.method === "DELETE") {
    try {
      const providerId = decodeURIComponent(pathname.replace("/api/config/provider/", ""));
      if (!providerId) {
        sendJSON(res, 400, { error: "provider id is required" });
        return true;
      }
      removeProvider(providerId);
      const config = loadModelConfig();
      sendJSON(res, 200, {
        success: true,
        providers: config.providers,
        activeProviderProfileId: (config as any).activeProviderProfileId || ""
      });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  // Set Active Provider Profile
  if (pathname === "/api/config/active-provider" && req.method === "POST") {
    try {
      const bodyStr = await readBody(req);
      const { providerId } = JSON.parse(bodyStr || "{}");
      if (!providerId) {
        sendJSON(res, 400, { error: "providerId is required" });
        return true;
      }
      switchActiveProvider(providerId);
      sendJSON(res, 200, {
        success: true,
        activeProviderProfileId: providerId
      });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  // Fetch Provider Models (live from provider API)
  if (pathname === "/api/config/provider-models" && req.method === "GET") {
    const parsedQs = new URL("http://localhost" + req.url!).searchParams;
    const providerId = parsedQs.get("providerId") || "";
    try {
      const config = loadModelConfig();
      const providers = config.providers || [];
      const provider = (providerId ? providers.find((p: any) => p.id === providerId) : null) || providers[0];

      const DEFAULT_PROVIDER_MODELS: Record<string, string[]> = {
        openai: ["gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "o3-mini", "gpt-4-turbo"],
        anthropic: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"],
        gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-1.5-flash", "gemini-1.5-pro"],
        deepseek: ["deepseek-chat", "deepseek-coder", "deepseek-reasoner"],
        openrouter: ["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "google/gemini-2.5-flash", "deepseek/deepseek-r1"],
        groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "deepseek-r1-distill-llama-70b"],
        mistral: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"],
        ollama: ["llama3.2", "qwen2.5-coder", "deepseek-r1", "mistral", "phi4", "codellama"],
        azure: ["gpt-4o", "gpt-4o-mini"]
      };

      if (!provider) {
        sendJSON(res, 200, { models: DEFAULT_PROVIDER_MODELS.openai, providerType: "openai", isRealFetched: false });
        return true;
      }

      const providerType = ((provider as any).provider || (provider as any).type || "openai").toLowerCase();
      const defaultModels = DEFAULT_PROVIDER_MODELS[providerType] || DEFAULT_PROVIDER_MODELS.openai;
      const apiKey = (provider.apiKey || "").trim();
      let baseUrl = (provider.baseUrl || "").trim().replace(/\/+$/, "");
      let fetchedModels: string[] = [];
      let isRealFetched = false;
      let fetchError: string | undefined;

      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      try {
        if (providerType === "ollama") {
          const url = baseUrl ? (baseUrl.endsWith("/api/tags") ? baseUrl : `${baseUrl}/api/tags`) : "http://localhost:11434/api/tags";
          const r = await fetch(url, { signal: controller.signal });
          if (r.ok) { const d: any = await r.json(); if (Array.isArray(d.models)) { fetchedModels = d.models.map((m: any) => m.name || m.model).filter(Boolean); isRealFetched = fetchedModels.length > 0; } }
        } else if (providerType === "anthropic") {
          if (apiKey) {
            const url = baseUrl ? `${baseUrl}/v1/models` : "https://api.anthropic.com/v1/models";
            const r = await fetch(url, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, signal: controller.signal });
            if (r.ok) { const d: any = await r.json(); const raw = Array.isArray(d.data) ? d.data : (Array.isArray(d.models) ? d.models : []); fetchedModels = raw.map((m: any) => m.id || m.name).filter(Boolean); isRealFetched = fetchedModels.length > 0; }
          }
        } else if (providerType === "gemini") {
          if (apiKey) {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, { signal: controller.signal });
            if (r.ok) { const d: any = await r.json(); if (Array.isArray(d.models)) { fetchedModels = d.models.map((m: any) => (m.name || "").replace(/^models\//, "")).filter((n: string) => n && n.includes("gemini")); isRealFetched = fetchedModels.length > 0; } }
          }
        } else {
          if (apiKey || providerType === "custom") {
            if (!baseUrl) {
              if (providerType === "openai") baseUrl = "https://api.openai.com/v1";
              else if (providerType === "deepseek") baseUrl = "https://api.deepseek.com/v1";
              else if (providerType === "openrouter") baseUrl = "https://openrouter.ai/api/v1";
              else if (providerType === "groq") baseUrl = "https://api.groq.com/openai/v1";
              else if (providerType === "mistral") baseUrl = "https://api.mistral.ai/v1";
            }
            if (baseUrl) {
              const url = baseUrl.endsWith("/models") ? baseUrl : `${baseUrl}/models`;
              const headers: Record<string, string> = {};
              if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
              if (providerType === "azure") headers["api-key"] = apiKey;
              const r = await fetch(url, { headers, signal: controller.signal });
              if (r.ok) { const d: any = await r.json(); const raw = Array.isArray(d.data) ? d.data : (Array.isArray(d.models) ? d.models : []); fetchedModels = raw.map((m: any) => m.id || m.name).filter(Boolean); isRealFetched = fetchedModels.length > 0; }
              else { fetchError = `${providerType} API returned HTTP ${r.status}`; }
            }
          }
        }
      } catch (e: any) {
        fetchError = e.name === "AbortError" ? "Provider request timed out (5s)" : e.message;
      } finally { clearTimeout(tid); }

      const combined = isRealFetched ? Array.from(new Set([...fetchedModels, ...defaultModels])) : defaultModels;
      sendJSON(res, 200, { models: combined, providerType, isRealFetched, error: fetchError });
    } catch (err: any) {
      sendJSON(res, 200, { models: [], providerType: "openai", isRealFetched: false, error: err.message });
    }
    return true;
  }

  // Switch workspace
  if (pathname === "/api/switch-workspace" && req.method === "POST") {
    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr || "{}");
    const { workspace, mode } = body;
    if (!workspace) {
      sendJSON(res, 400, { error: "workspace path is required" });
      return true;
    }
    const targetWorkspace = path.resolve(workspace);
    addTrustedDirectory(targetWorkspace);
    await ensureDirectoryTrusted(targetWorkspace);

    const targetMode = mode === "multi" ? "multi" : "single";
    const targetClientMode = resolveClientMode(req, body, serverDefaultClientMode);

    let session = activeSessions.get(`${targetClientMode}:${targetWorkspace}:server`);
    if (!session || session.mode !== targetMode || session.clientMode !== targetClientMode) {
      if (session && session.agent.isAgentRunning()) session.agent.abort();

      const sessionId = Date.now().toString();
      const agent = await createAgentForMode(targetWorkspace, targetMode, targetClientMode);

      try { await agent.loadHistory(true); } catch {}

      session = {
        agent,
        workspace: targetWorkspace,
        mode: targetMode,
        clientMode: targetClientMode,
        sessionId,
        isCliSession: false
      };
      activeSessions.set(`${targetClientMode}:${targetWorkspace}:server`, session);
    } else {
      if (session.agent.isAgentRunning()) session.agent.abort();
    }

    setLastActiveWorkspace(targetWorkspace);
    sendJSON(res, 200, {
      success: true,
      sessionId: session.sessionId,
      workspace: targetWorkspace,
      mode: session.mode,
      clientMode: session.clientMode
    });
    return true;
  }

  // Fetch plan, task, walkthrough documents
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
      planPath = wsPath ? path.join(wsPath, "implementation_plan.md") : "";
      taskPath = wsPath ? path.join(wsPath, "task.md") : "";
      walkthroughPath = wsPath ? path.join(wsPath, "walkthrough.md") : "";
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

    sendJSON(res, 200, { plan: planContent, tasks: taskContent, walkthrough: walkthroughContent });
    return true;
  }

  // ─── MCP Server Config CRUD ─────────────────────────────────────────────────

  // List MCP servers + connection status
  if (pathname === "/api/config/mcp" && req.method === "GET") {
    const config = loadModelConfig();
    const mcpServers = config.mcpServers || {};
    let statusMap: Record<string, { status: string; tools: string[]; error?: string }> = {};
    try {
      const { connectedServers } = await import("./core/mcp/McpManager.js");
      for (const [name, srv] of connectedServers.entries()) {
        statusMap[name] = { status: srv.status, tools: srv.tools, error: srv.error };
      }
    } catch {}
    const servers = Object.entries(mcpServers).map(([name, cfg]) => ({
      name,
      command: cfg.command,
      args: cfg.args || [],
      env: cfg.env || {},
      ...(statusMap[name.trim().toLowerCase()] || { status: "not-connected", tools: [] })
    }));
    sendJSON(res, 200, { success: true, servers });
    return true;
  }

  // Add / update a MCP server
  if (pathname === "/api/config/mcp" && req.method === "POST") {
    try {
      const bodyStr = await readBody(req);
      const { name, command, args, env } = JSON.parse(bodyStr || "{}");
      if (!name || !command) {
        sendJSON(res, 400, { error: "name and command are required" });
        return true;
      }
      mutateModelConfig((config) => {
        if (!config.mcpServers) config.mcpServers = {};
        const entry: any = { command, args: args || [] };
        if (env && Object.keys(env).length > 0) entry.env = env;
        config.mcpServers[name] = entry;
      });
      const config = loadModelConfig();
      sendJSON(res, 200, { success: true, mcpServers: config.mcpServers || {} });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  // Reload (close all + reinit) MCP servers
  if (pathname === "/api/config/mcp/reload" && req.method === "POST") {
    try {
      const { closeMcpServers, initMcpServers, connectedServers } = await import("./core/mcp/McpManager.js");
      await closeMcpServers();
      await initMcpServers();
      const servers = Array.from(connectedServers.entries()).map(([name, srv]) => ({
        name, status: srv.status, tools: srv.tools, error: srv.error
      }));
      sendJSON(res, 200, { success: true, servers });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  // Delete a MCP server
  if (pathname.startsWith("/api/config/mcp/") && req.method === "DELETE") {
    try {
      const name = decodeURIComponent(pathname.replace("/api/config/mcp/", ""));
      if (!name) {
        sendJSON(res, 400, { error: "MCP server name is required" });
        return true;
      }
      mutateModelConfig((config) => {
        if (config.mcpServers) delete config.mcpServers[name];
      });
      const config = loadModelConfig();
      sendJSON(res, 200, { success: true, mcpServers: config.mcpServers || {} });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  // ─── Session Export / Import ─────────────────────────────────────────────────

  // Export session as JSON or Markdown
  if (pathname.startsWith("/api/history/session/") && pathname.endsWith("/export") && req.method === "GET") {
    const format = (parsedUrl.searchParams.get("format") || "json") as "json" | "markdown";
    const sessionId = decodeURIComponent(pathname.replace("/api/history/session/", "").replace("/export", ""));
    if (!sessionId) {
      sendJSON(res, 400, { error: "Session ID required" });
      return true;
    }
    const content = exportSession(sessionId, format);
    if (!content) {
      sendJSON(res, 404, { error: "Session not found" });
      return true;
    }
    const contentType = format === "markdown" ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
    return true;
  }

  // Import session from JSON body { session, messages }
  if (pathname === "/api/history/import" && req.method === "POST") {
    try {
      const bodyStr = await readBody(req);
      const { session, messages } = JSON.parse(bodyStr || "{}");
      if (!session?.id) {
        sendJSON(res, 400, { error: "session.id is required" });
        return true;
      }
      saveSessionToDb(session, messages || []);
      clearHistoryCache();
      sendJSON(res, 200, { success: true, id: session.id });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  // ─── Trusted Directory Write ─────────────────────────────────────────────────

  // Add a trusted directory
  if (pathname === "/api/config/trusted-directory" && req.method === "POST") {
    try {
      const bodyStr = await readBody(req);
      const { path: dirPath, name } = JSON.parse(bodyStr || "{}");
      if (!dirPath) {
        sendJSON(res, 400, { error: "path is required" });
        return true;
      }
      addTrustedDirectory(dirPath, name);
      sendJSON(res, 200, { success: true, trustedDirectories: getTrustedDirectories() });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  // Remove trust from a directory
  if (pathname === "/api/config/trusted-directory" && req.method === "DELETE") {
    try {
      const bodyStr = await readBody(req);
      const { path: dirPath } = JSON.parse(bodyStr || "{}");
      if (!dirPath) {
        sendJSON(res, 400, { error: "path is required" });
        return true;
      }
      const resolvedPath = path.resolve(dirPath);
      const wsId = getWorkspaceId(resolvedPath);
      saveWorkspaceToDb({ id: wsId, path: resolvedPath, isTrusted: false });
      sendJSON(res, 200, { success: true, trustedDirectories: getTrustedDirectories() });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
    }
    return true;
  }

  return false;
}
