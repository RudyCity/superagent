import http from "http";
import path from "path";
import fs from "fs";
import { URL } from "url";
import type { Agent } from "./core/agent.js";
import { 
  getSettings, 
  getConfiguredProviders, 
  addTrustedDirectory, 
  ensureDirectoryTrusted, 
  getPresets, 
  getActivePresetId, 
  setActivePresetId, 
  updateSettings, 
  listHistorySessions, 
  getTrustedDirectories, 
  generateSessionId, 
  getInstalledSkills 
} from "./core/config.js";
import { readChecklistTasks, ReadChecklistResult } from "./core/taskChecklist.js";
import { subagentInstances, superagentInstances } from "./core/tools/state.js";
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
    return true;
  }

  // Get chat history
  if (pathname === "/api/history" && req.method === "GET") {
    const session = resolveSession(req);
    if (!session) {
      sendJSON(res, 200, { success: true, messages: [] });
      return true;
    }
    const messages = session.agent.getConversationMessages();
    sendJSON(res, 200, { success: true, messages });
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

    activeSessions.set(targetWorkspace, {
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
      setTimeout(() => {
        agent.sendMessage(initialPrompt).catch((err: any) => {
          broadcastEvent({ type: "error", message: err.message || String(err) });
        });
      }, 100);
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

  // Fetch active subagents/superagents instances
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
      role: inst.role,
      status: inst.status,
      result: inst.result,
      logs: inst.logs || [],
      prompt: inst.task,
      completedAt: inst.completedAt
    }));
    sendJSON(res, 200, { subagents, superagents });
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

  // Fetch Config
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
      presets: { single: singlePresets, multi: multiPresets },
      activePresetId: { single: activeSinglePresetId, multi: activeMultiPresetId },
      trustedDirectories
    });
    return true;
  }

  // Update Config
  if (pathname === "/api/config" && req.method === "POST") {
    try {
      const bodyStr = await readBody(req);
      const body = JSON.parse(bodyStr || "{}");
      if (body.settings) updateSettings(body.settings);
      if (body.activePresetId) {
        if (body.activePresetId.single) setActivePresetId("single", body.activePresetId.single);
        if (body.activePresetId.multi) setActivePresetId("multi", body.activePresetId.multi);
      }
      sendJSON(res, 200, { success: true });
    } catch (err: any) {
      sendJSON(res, 400, { success: false, error: err.message || String(err) });
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

    let session = activeSessions.get(targetWorkspace);
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
      activeSessions.set(targetWorkspace, session);
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

  return false;
}
