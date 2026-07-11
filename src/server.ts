import http from "http";
import { URL } from "url";
import fs from "fs";
import path from "path";
import { Agent } from "./core/agent.js";
import type { AgentEvent } from "./core/agent.js";
import { getConfig, getSettings, getConfiguredProviders, addTrustedDirectory, ensureDirectoryTrusted, getPresets, getActivePresetId, setActivePresetId, updateSettings, listHistorySessions } from "./core/config.js";
import { readChecklistTasks } from "./core/taskChecklist.js";
import { subagentInstances, superagentInstances, registerMasterAgent, subscribeToActiveOutput, subscribeToSubagents, subscribeToSuperagents } from "./core/tools/state.js";
import { setBrowserControlHandler } from "./core/tools/otherTools.js";

interface AgentSession {
  agent: Agent;
  workspace: string;
  mode: "single" | "multi";
  sessionId: string;
  isCliSession: boolean;
}

export const activeSessions = new Map<string, AgentSession>();
let lastActiveWorkspace: string = process.cwd();
let isBrowseDialogOpen = false;

function resolveSession(req: http.IncomingMessage): AgentSession | null {
  const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  let wsPath = req.headers["x-workspace-path"] as string || parsedUrl.searchParams.get("workspace");
  
  if (wsPath) {
    wsPath = path.resolve(wsPath);
    const session = activeSessions.get(wsPath);
    if (session) return session;
  }
  
  if (activeSessions.size === 1) {
    return activeSessions.values().next().value || null;
  }
  
  if (wsPath) {
    for (const [key, session] of activeSessions.entries()) {
      if (key.toLowerCase() === wsPath.toLowerCase()) {
        return session;
      }
    }
  }

  for (const session of activeSessions.values()) {
    if (session.isCliSession) return session;
  }
  
  return null;
}

export function registerCliAgent(agent: Agent, workspace: string, mode: "single" | "multi") {
  const targetWorkspace = path.resolve(workspace);
  activeSessions.set(targetWorkspace, {
    agent,
    workspace: targetWorkspace,
    mode,
    sessionId: Date.now().toString(),
    isCliSession: true
  });
  lastActiveWorkspace = targetWorkspace;
}

const sseClients = new Set<http.ServerResponse>();
const pendingPermissions = new Map<string, (approval: boolean | "session") => void>();
const pendingQuestions = new Map<string, (answer: any) => void>();
const pendingBrowserControls = new Map<string, { resolve: (val: string) => void, reject: (err: any) => void }>();

setBrowserControlHandler((action, target, value) => {
  return new Promise<string>((resolve, reject) => {
    const controlId = Math.random().toString(36).substring(2, 9);
    pendingBrowserControls.set(controlId, { resolve, reject });
    broadcastEvent({
      type: "browser_control_required",
      controlId,
      action,
      target,
      value
    });
  });
});

function broadcastEvent(event: any) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
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
    "Access-Control-Allow-Headers": "Content-Type",
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

// Global Agent Event Handlers
const onEvent = (event: AgentEvent, agentRef?: Agent) => {
  broadcastEvent({ type: "agent_event", event });
  // When agent finishes a turn and is waiting for plan approval, notify extension clients
  if (event.type === "done" && agentRef && agentRef.planState === "PLANNING_PENDING") {
    broadcastEvent({ type: "plan_approval_required", planState: "PLANNING_PENDING" });
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

export async function runServer(port: number, silent = false) {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
        "Access-Control-Allow-Headers": "Content-Type",
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

        // Keep SSE connection alive
        const keepAliveInterval = setInterval(() => {
          res.write(": keepalive\n\n");
        }, 15000);

        req.on("close", () => {
          clearInterval(keepAliveInterval);
          sseClients.delete(res);
        });
        return;
      }

      // Status
      if (pathname === "/api/status" && req.method === "GET") {
        const session = resolveSession(req);
        sendJSON(res, 200, {
          status: "online",
          workspace: session ? session.workspace : lastActiveWorkspace,
          mode: session ? session.mode : "single",
          sessionId: session ? session.sessionId : null,
          agentActive: !!session,
          agentRunning: session ? session.agent.isAgentRunning() : false,
          isCliSession: session ? session.isCliSession : false,
          planState: session ? session.agent.planState : "IDLE",
        });
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
        const session = resolveSession(req);
        const workspacePath = session ? session.workspace : lastActiveWorkspace;
        const mode = session ? session.mode : "single";
        const isMulti = mode === "multi";
        if (!workspacePath) {
          sendJSON(res, 200, { success: true, sessions: [] });
          return;
        }
        const sessions = listHistorySessions(isMulti, false, workspacePath);
        sendJSON(res, 200, { success: true, sessions });
        return;
      }

      // Initialize session
      if (pathname === "/api/init" && req.method === "POST") {
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr || "{}");
        const { mode, workspace, resume, initialPrompt } = body;

        const targetWorkspace = workspace ? path.resolve(workspace) : process.cwd();
        
        // Trust the directory automatically for the extension server usage
        addTrustedDirectory(targetWorkspace);
        await ensureDirectoryTrusted(targetWorkspace);

        const existingSession = activeSessions.get(targetWorkspace);
        if (existingSession && existingSession.agent.isAgentRunning()) {
          existingSession.agent.abort();
        }

        const targetMode = mode === "multi" ? "multi" : "single";
        const sessionId = Date.now().toString();

        let customSystemPrompt: string | undefined = undefined;
        let customTools: any[] | undefined = undefined;

        if (targetMode === "multi") {
          const { MASTER_AGENT_SYSTEM_PROMPT } = await import("./core/prompts.js");
          const { masterToolset } = await import("./core/tools/toolsets.js");
          customSystemPrompt = MASTER_AGENT_SYSTEM_PROMPT;
          customTools = masterToolset;
        } else {
          const { CHROME_EXTENSION_SYSTEM_PROMPT } = await import("./core/prompts.js");
          const { chromeExtensionToolset } = await import("./core/tools/toolsets.js");
          customSystemPrompt = CHROME_EXTENSION_SYSTEM_PROMPT;
          customTools = chromeExtensionToolset;
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
          sessionId,
          isCliSession: false
        });
        lastActiveWorkspace = targetWorkspace;

        sendJSON(res, 200, { success: true, sessionId });

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
        const session = resolveSession(req);
        if (!session) {
          sendJSON(res, 400, { error: "Session not initialized" });
          return;
        }
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr || "{}");
        const { message } = body;

        if (!message) {
          sendJSON(res, 400, { error: "Empty message" });
          return;
        }

        // Run message in the background so HTTP finishes quickly
        // Client receives output via SSE
        session.agent.sendMessage(message).catch(err => {
          broadcastEvent({ type: "error", message: err.message || String(err) });
        });

        sendJSON(res, 200, { success: true });
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
                const session = resolveSession(req);
                const wsPath = session ? session.workspace : lastActiveWorkspace;
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

      // Abort agent execution
      if (pathname === "/api/abort" && req.method === "POST") {
        const session = resolveSession(req);
        if (session) {
          session.agent.abort();
          sendJSON(res, 200, { success: true });
        } else {
          sendJSON(res, 400, { error: "No active agent to abort" });
        }
        return;
      }

      // Shutdown server process
      if (pathname === "/api/shutdown" && req.method === "POST") {
        sendJSON(res, 200, { success: true, message: "Server shutting down..." });
        setTimeout(() => {
          process.exit(0);
        }, 500);
        return;
      }

      // Fetch Tasks
      if (pathname === "/api/tasks" && req.method === "GET") {
        const session = resolveSession(req);
        const wsPath = session ? session.workspace : lastActiveWorkspace;
        const wsMode = session ? session.mode : "single";
        const taskFile = wsMode === "multi" ? "_task.md" : "task.md";
        const taskPath = path.join(wsPath, taskFile);
        const taskData = await readChecklistTasks(taskPath);
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

      // Fetch Config / Models
      if (pathname === "/api/config" && req.method === "GET") {
        const settings = getSettings();
        const providers = getConfiguredProviders();
        const singlePresets = getPresets("single");
        const multiPresets = getPresets("multi");
        const activeSinglePresetId = getActivePresetId("single");
        const activeMultiPresetId = getActivePresetId("multi");
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
          }
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

        let session = activeSessions.get(targetWorkspace);
        if (!session) {
          const targetMode = mode === "multi" ? "multi" : "single";
          const sessionId = Date.now().toString();

          let customSystemPrompt: string | undefined = undefined;
          let customTools: any[] | undefined = undefined;

          if (targetMode === "multi") {
            const { MASTER_AGENT_SYSTEM_PROMPT } = await import("./core/prompts.js");
            const { masterToolset } = await import("./core/tools/toolsets.js");
            customSystemPrompt = MASTER_AGENT_SYSTEM_PROMPT;
            customTools = masterToolset;
          } else {
            const { CHROME_EXTENSION_SYSTEM_PROMPT } = await import("./core/prompts.js");
            const { chromeExtensionToolset } = await import("./core/tools/toolsets.js");
            customSystemPrompt = CHROME_EXTENSION_SYSTEM_PROMPT;
            customTools = chromeExtensionToolset;
          }

          const agent = new Agent(
            onEvent,
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

          session = {
            agent,
            workspace: targetWorkspace,
            mode: targetMode,
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
          mode: session.mode
        });
        return;
      }

      // Fetch plan, task, and walkthrough markdown content
      if (pathname === "/api/documents" && req.method === "GET") {
        const session = resolveSession(req);
        const wsPath = session ? session.workspace : lastActiveWorkspace;
        const wsMode = session ? session.mode : "single";

        const planFile = wsMode === "multi" ? "_plan.md" : "plan.md";
        const taskFile = wsMode === "multi" ? "_task.md" : "task.md";
        const walkthroughFile = wsMode === "multi" ? "_walkthrough.md" : "walkthrough.md";

        const planPath = path.join(wsPath, planFile);
        const taskPath = path.join(wsPath, taskFile);
        const walkthroughPath = path.join(wsPath, walkthroughFile);

        const readMarkdown = async (filePath: string): Promise<string> => {
          try {
            if (fs.existsSync(filePath)) {
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
      console.error("[Extension Server Error]", err);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    if (!silent) {
      console.log(`\n🚀 Superagent Extension Server is running at http://localhost:${port}`);
      console.log(`💡 Mode: REST API & Server-Sent Events (SSE)`);
      console.log(`📂 Current Workspace: ${lastActiveWorkspace}\n`);
    }
  });
}
