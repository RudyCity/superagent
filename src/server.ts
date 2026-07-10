import http from "http";
import { URL } from "url";
import fs from "fs";
import path from "path";
import { Agent } from "./core/agent.js";
import type { AgentEvent } from "./core/agent.js";
import { getConfig, getSettings, getConfiguredProviders, addTrustedDirectory, ensureDirectoryTrusted } from "./core/config.js";
import { readChecklistTasks } from "./core/taskChecklist.js";
import { subagentInstances, superagentInstances, registerMasterAgent } from "./core/tools/state.js";
import { setBrowserControlHandler } from "./core/tools/otherTools.js";

let activeAgent: Agent | null = null;
let activeSessionId: string | null = null;
let activeMode: "single" | "multi" = "single";
let activeWorkspace: string = process.cwd();

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
const onEvent = (event: AgentEvent) => {
  broadcastEvent({ type: "agent_event", event });
};

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

export async function runServer(port: number) {
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
        sendJSON(res, 200, {
          status: "online",
          workspace: activeWorkspace,
          mode: activeMode,
          sessionId: activeSessionId,
          agentActive: !!activeAgent,
          agentRunning: activeAgent ? activeAgent.isAgentRunning() : false,
        });
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

        activeWorkspace = targetWorkspace;
        process.chdir(targetWorkspace);

        if (activeAgent && activeAgent.isAgentRunning()) {
          activeAgent.abort();
        }

        activeMode = mode === "multi" ? "multi" : "single";
        activeSessionId = Date.now().toString();

        let customSystemPrompt: string | undefined = undefined;
        let customTools: any[] | undefined = undefined;

        if (activeMode === "multi") {
          const { MASTER_AGENT_SYSTEM_PROMPT } = await import("./core/prompts.js");
          const { masterToolset } = await import("./core/tools/toolsets.js");
          customSystemPrompt = MASTER_AGENT_SYSTEM_PROMPT;
          customTools = masterToolset;
        }

        activeAgent = new Agent(
          onEvent,
          onPermission,
          onQuestion,
          customSystemPrompt,
          customTools,
          targetWorkspace
        );

        if (activeMode === "multi") {
          activeAgent.tier = "master";
          activeAgent.isMultiAgent = true;
          registerMasterAgent(activeAgent);
        } else {
          activeAgent.tier = "single";
        }

        pendingPermissions.clear();
        pendingQuestions.clear();

        if (resume) {
          try {
            await activeAgent.loadHistory(resume);
          } catch {}
        }

        sendJSON(res, 200, { success: true, sessionId: activeSessionId });

        if (initialPrompt && initialPrompt.trim()) {
          // Process initial prompt in the background
          setTimeout(() => {
            if (activeAgent) {
              activeAgent.sendMessage(initialPrompt).catch(err => {
                broadcastEvent({ type: "error", message: err.message || String(err) });
              });
            }
          }, 100);
        }
        return;
      }

      // Send chat message
      if (pathname === "/api/chat" && req.method === "POST") {
        if (!activeAgent) {
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
        activeAgent.sendMessage(message).catch(err => {
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
                const outputPath = path.join(activeWorkspace, "chrome_screenshot.png");
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
        if (activeAgent) {
          activeAgent.abort();
          sendJSON(res, 200, { success: true });
        } else {
          sendJSON(res, 400, { error: "No active agent to abort" });
        }
        return;
      }

      // Fetch Tasks
      if (pathname === "/api/tasks" && req.method === "GET") {
        const taskFile = activeMode === "multi" ? "_task.md" : "task.md";
        const taskPath = path.join(activeWorkspace, taskFile);
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
        sendJSON(res, 200, { settings, providers });
        return;
      }

      // Browse directory dialog
      if (pathname === "/api/browse" && req.method === "GET") {
        try {
          const { execSync } = await import("child_process");
          let selectedPath = "";
          const platform = process.platform;

          if (platform === "win32") {
            const commands = [
              'Add-Type -AssemblyName System.Windows.Forms',
              '$form = New-Object System.Windows.Forms.Form',
              '$form.TopMost = $true',
              '$form.TopLevel = $true',
              '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
              '$f.Description = \'Select Local Workspace Folder\'',
              '$f.ShowNewFolderButton = $true',
              '$res = $f.ShowDialog($form)',
              'if ($res -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }'
            ];
            const commandLine = commands.join('; ');
            try {
              const stdout = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${commandLine}"`, { encoding: "utf8" });
              selectedPath = stdout.trim();
            } catch (err: any) {
              console.warn("Folder dialog closed or failed:", err.message);
            }
          } else if (platform === "darwin") {
            try {
              const script = 'tell application "Finder" to set selectedFolder to choose folder with prompt "Select Local Workspace Folder"\nPOSIX path of selectedFolder';
              const stdout = execSync(`osascript -e ${JSON.stringify(script)}`, { encoding: "utf8" });
              selectedPath = stdout.trim();
            } catch (err: any) {
              console.warn("macOS folder picker cancelled or failed:", err.message);
            }
          } else {
            try {
              const stdout = execSync('zenity --file-selection --directory --title="Select Local Workspace Folder"', { encoding: "utf8" });
              selectedPath = stdout.trim();
            } catch {
              try {
                const stdout = execSync('kdialog --getexistingdirectory', { encoding: "utf8" });
                selectedPath = stdout.trim();
              } catch (err: any) {
                console.warn("Linux folder picker cancelled or failed:", err.message);
              }
            }
          }

          sendJSON(res, 200, { success: true, path: selectedPath });
        } catch (err: any) {
          sendJSON(res, 500, { success: false, error: err.message || String(err) });
        }
        return;
      }

      // Default 404
      sendJSON(res, 404, { error: "Not Found" });

    } catch (err: any) {
      console.error("[SERVER ERROR]", err);
      sendJSON(res, 500, { error: err.message || String(err) });
    }
  });

  server.listen(port, () => {
    console.log(`\n🚀 Superagent Extension Server is running at http://localhost:${port}`);
    console.log(`💡 Mode: REST API & Server-Sent Events (SSE)`);
    console.log(`📂 Current Workspace: ${activeWorkspace}\n`);
  });
}
