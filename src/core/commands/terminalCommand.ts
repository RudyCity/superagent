import fs from "fs/promises";
import fsCb from "fs";
import path from "path";
import os from "os";
import { execa } from "execa";
import { registry } from "./registry.js";
import { 
  SlashCommand, 
  formatPresetValue, 
  getPresetLabel, 
  findPreset 
} from "./types.js";
import { getGlobalConfigDir, getWorkspaceTasksLogDir } from "../config.js";
import { 
  backgroundTasks, 
  notifyTasksChanged, 
  BackgroundTask,
  isTaskInWorkspace
} from "../tools.js";
import { killProcessTree } from "../tools/shellTools.js";
function normalizeCwd(cwdPath: string): string {
  if (process.platform === "win32") {
    const msysMatch = cwdPath.match(/^\/([a-zA-Z])($|\/.*)/);
    if (msysMatch) {
      const drive = msysMatch[1].toUpperCase();
      const rest = msysMatch[2] || "";
      cwdPath = `${drive}:${rest}`;
    }
  }
  return cwdPath;
}

// /terminal command
export const terminalCommand: SlashCommand = {
  name: "terminal",
  description: "Run a command or preset in a new window or background",
  async execute(args, ctx) {
    const cwd = process.cwd();
    const now = Date.now();

    if (args.toLowerCase() === "init") {
      ctx.addLine({
        type: "user",
        content: "❯ /terminal init",
        timestamp: now
      });
      ctx.addLine({
        type: "system",
        content: "Starting interactive preset creator wizard guided by AI...",
        timestamp: now
      });
      ctx.setIsProcessing?.(true);
      ctx.agent?.sendMessage(
        "USER COMMAND: /terminal init\n\n" +
        "You are initializing terminal presets for the user's workspace. Follow these steps:\n" +
        "1. Inspect the workspace files (e.g. read package.json scripts/dependencies, Cargo.toml, go.mod, requirements.txt, or list directories) to identify the project type and find common commands.\n" +
        "2. Dynamically construct AI suggestions/recommendations of potential terminal preset commands (e.g. dev/start servers, watch processes, test suites, builds) based on your discovery.\n" +
        "3. Ask the user to select which commands they want to set up as presets. You MUST call the `ask_question` tool with `isMultiSelect: true` so the user can check/uncheck multiple suggested commands using Space and Enter.\n" +
        "4. Once selected, guide them or define the preset names, custom working directories, and env variables if needed. Note: Preset names (keys in the JSON) MUST be short, simple, lowercase, alphanumeric characters, and may use hyphens or underscores (e.g. 'dev', 'build', 'start', 'test'). EMOJIS ARE STRICTLY FORBIDDEN in preset names to ensure they are easy for the user to type in the terminal. Recommend using relative paths (e.g. '.' or './subdir') for `cwd` to keep presets portable.\n" +
        "5. Write the final configuration back to the local project file `.superagent-r/terminal-presets.json` using a file writing tool. Confirm to the user once it is completed."
      ).catch((err: any) => {
        ctx.addLine({ type: "error", content: `Wizard error: ${err.message}`, timestamp: Date.now() });
      });
      return;
    }

    if (args.toLowerCase() === "stop" || args.toLowerCase().startsWith("stop ")) {
      const stopArg = args.slice(4).trim().toLowerCase();
      const workspacePath = ctx.agent?.workingDirectory || process.cwd();
      const termTasks = Array.from(backgroundTasks.entries()).filter(([id, task]) => id.startsWith("term-") && isTaskInWorkspace(task.cwd, workspacePath));

      if (termTasks.length === 0) {
        ctx.addLine({
          type: "system",
          content: "🖥️ No running terminal processes to stop.",
          timestamp: Date.now()
        });
        return;
      }

      if (!stopArg || stopArg === "all") {
        let count = 0;
        for (const [id, task] of termTasks) {
          try { killProcessTree(task.process.pid); } catch {}
          try {
            if (task.logPath) {
              fsCb.appendFileSync(task.logPath, `\n[Process exited via force stop at ${new Date().toISOString()}]\n`);
            }
          } catch {}
          task.hasExited = true;
          backgroundTasks.delete(id);
          count++;
        }
        notifyTasksChanged();
        ctx.addLine({
          type: "system",
          content: `🛑 Stopped ${count} terminal process${count !== 1 ? "es" : ""}.`,
          timestamp: Date.now()
        });
      } else {
        const fullId = stopArg.startsWith("term-") ? stopArg : `term-${stopArg}`;
        const task = backgroundTasks.get(fullId);
        if (!task || !isTaskInWorkspace(task.cwd, workspacePath)) {
          const ids = termTasks.map(([id]) => id).join(", ");
          ctx.addLine({
            type: "error",
            content: `Error: Terminal process "${fullId}" not found.\nRunning IDs: ${ids || "(none)"}`,
            timestamp: Date.now()
          });
          return;
        }
        try { killProcessTree(task.process.pid); } catch {}
        try {
          if (task.logPath) {
            fsCb.appendFileSync(task.logPath, `\n[Process exited via force stop at ${new Date().toISOString()}]\n`);
          }
        } catch {}
        task.hasExited = true;
        backgroundTasks.delete(fullId);
        notifyTasksChanged();
        ctx.addLine({
          type: "system",
          content: `🛑 Stopped terminal process [${fullId}]: "${task.command}"`,
          timestamp: Date.now()
        });
      }
      return;
    }

    if (args.toLowerCase() === "bg" || args.toLowerCase().startsWith("bg ")) {
      const bgRaw = args.slice(2).trim();

      (async () => {
        const localPresetDir = path.join(cwd, ".superagent-r");
        const localPresetPath = path.join(localPresetDir, "terminal-presets.json");
        const localRootPresetPath = path.join(cwd, "terminal-presets.json");
        const globalPresetPath = path.join(os.homedir(), ".superagent-r", "terminal-presets.json");
        const paths = [localPresetPath, localRootPresetPath, globalPresetPath];
        let presets: Record<string, any> = {};
        for (const p of paths) {
          try {
            const content = await fs.readFile(p, "utf-8");
            const data = JSON.parse(content);
            presets = data?.presets ?? data;
            break;
          } catch { /* ignore */ }
        }

        if (!bgRaw) {
          const keys = Object.keys(presets);
          const presetsList = keys.length > 0
            ? keys.map(k => `  • ${getPresetLabel(k, presets[k])}: ${formatPresetValue(presets[k])}`).join("\n")
            : "  (No presets configured)";
          ctx.addLine({
            type: "system",
            content: [
              "🖥️ TERMINAL BG — Run preset or command silently in background",
              "Usage:",
              "  /terminal bg <command>          - Run any command in background",
              "  /terminal bg preset <name>      - Run a configured preset in background",
              "  /terminal bg <preset_name>      - Run preset directly by name",
              "",
              "Available Presets:",
              presetsList,
            ].join("\n"),
            timestamp: Date.now()
          });
          return;
        }

        let commandStr = bgRaw;
        let bgPresetName = "";
        let runCwd = cwd;
        let runEnv = { ...process.env };

        const resolveBgPreset = (val: any, label: string) => {
          bgPresetName = label;
          if (typeof val === "object" && val !== null) {
            commandStr = val.command || "";
            if (val.cwd) {
              runCwd = path.resolve(cwd, normalizeCwd(val.cwd));
            }
            if (val.env) {
              runEnv = { ...runEnv, ...val.env };
            }
          } else {
            commandStr = String(val);
          }
        };

        if (bgRaw.toLowerCase().startsWith("preset ")) {
          const requestedName = bgRaw.slice(7).trim();
          const found = findPreset(presets, requestedName);
          if (!found) {
            ctx.addLine({ type: "error", content: `Error: Preset "${requestedName}" not found.`, timestamp: Date.now() });
            return;
          }
          resolveBgPreset(found.value, getPresetLabel(found.key, found.value));
        } else {
          const found = findPreset(presets, bgRaw);
          if (found) {
            resolveBgPreset(found.value, getPresetLabel(found.key, found.value));
          }
        }

        const taskId = `term-bg-${Math.random().toString(36).substring(2, 9)}`;
        let sessionPath = process.env.SUPERAGENT_SESSION_PATH;
        try {
          const { agentLocalStorage } = await import("../agent.js");
          const activeAgent = agentLocalStorage.getStore();
          if (activeAgent) {
            sessionPath = activeAgent.getCurrentHistoryFilePath() || sessionPath;
          }
        } catch {
          // Ignored
        }

        const tasksLogDir = sessionPath
          ? path.join(path.dirname(sessionPath), "tasks")
          : getWorkspaceTasksLogDir();
        if (!fsCb.existsSync(tasksLogDir)) fsCb.mkdirSync(tasksLogDir, { recursive: true });
        const logPath = path.join(tasksLogDir, `${taskId}.log`);
        try { fsCb.writeFileSync(logPath, ""); } catch { /* ignore */ }

        let shellPath: string | boolean = true;
        if (process.platform === "win32") {
          shellPath = "powershell.exe";
        }

        const proc = execa(commandStr, {
          shell: shellPath,
          cwd: runCwd,
          env: runEnv,
          reject: false,
          all: true,
        });

        const task: BackgroundTask = {
          id: taskId,
          command: commandStr,
          process: proc,
          output: [],
          logPath,
          cwd: runCwd,
        };

        backgroundTasks.set(taskId, task);
        notifyTasksChanged();

        proc.all?.on("data", (data: Buffer) => {
          const text = data.toString();
          task.output.push(text);
          if (task.output.length > 1000) task.output.shift();
          try { fsCb.appendFileSync(logPath, text); } catch { /* ignore */ }
        });

        proc.on("close", (code: number | null) => {
          task.hasExited = true;
          task.exitCode = code;
          const exitMsg = `\n[Process exited with code ${code}]`;
          task.output.push(exitMsg);
          try { fsCb.appendFileSync(logPath, exitMsg); } catch { /* ignore */ }
          notifyTasksChanged();
        });

        ctx.addLine({
          type: "system",
          content: [
            `⚙️ Background process started [ID: ${taskId}]`,
            `  Command : ${commandStr}`,
            `  Log     : ${logPath}`,
            bgPresetName ? `  Preset  : ${bgPresetName}` : "",
            `Use /processes to monitor, or /processes stop ${taskId} to kill.`,
          ].filter(Boolean).join("\n"),
          timestamp: Date.now()
        });
      })().catch(err => {
        ctx.addLine({ type: "error", content: `Failed to start background process: ${err.message}`, timestamp: Date.now() });
      });
      return;
    }
    
    const loadPresetsAndRun = async () => {
      const localPresetDir = path.join(cwd, ".superagent-r");
      const localPresetPath = path.join(localPresetDir, "terminal-presets.json");
      const localRootPresetPath = path.join(cwd, "terminal-presets.json");
      const globalPresetPath = path.join(os.homedir(), ".superagent-r", "terminal-presets.json");

      const paths = [localPresetPath, localRootPresetPath, globalPresetPath];
      let presets: Record<string, string | string[]> = {};
      for (const p of paths) {
        try {
          const content = await fs.readFile(p, "utf-8");
          const data = JSON.parse(content);
          if (data && data.presets) {
            presets = data.presets;
          } else {
            presets = data;
          }
          break;
        } catch { /* ignore */ }
      }

      if (!args) {
        const keys = Object.keys(presets);
        const presetsList = keys.length > 0
          ? keys.map(k => `  • ${getPresetLabel(k, presets[k])}: ${formatPresetValue(presets[k])}`).join("\n")
          : "  (No presets configured)";
        ctx.addLine({
          type: "system",
          content: [
            "🖥️ TERMINAL COMMAND & PRESETS",
            "Usage:",
            "  /terminal <command>         - Run command in a new terminal window",
            "  /terminal all               - Launch ALL configured presets at once",
            "  /terminal preset <name>     - Run a configured preset",
            "  /terminal <preset_name>     - Run a preset directly (if name matches)",
            "",
            "Available Presets:",
            presetsList,
            "",
            "Presets can be configured in `.superagent-r/terminal-presets.json` or `terminal-presets.json`.",
          ].join("\n"),
          timestamp: Date.now()
        });
        return;
      }

      let commandToRun: any = args;
      let isPreset = false;
      let presetName = "";

      const runCmd = async (singleCmd: any, labelOverride?: string) => {
        let commandStr = "";
        let runCwd = cwd;
        let runEnv = { ...process.env };

        if (typeof singleCmd === "object" && singleCmd !== null) {
          commandStr = singleCmd.command || "";
          if (singleCmd.cwd) {
            runCwd = path.resolve(cwd, normalizeCwd(singleCmd.cwd));
          }
          if (singleCmd.env) {
            runEnv = { ...runEnv, ...singleCmd.env };
          }
        } else {
          commandStr = String(singleCmd);
        }

        if (!commandStr) return;

        if (ctx.runInteractiveProcess) {
          ctx.addLine({
            type: "system",
            content: `🖥️ Executing terminal command: "${commandStr}" (cwd: ${runCwd})`,
            timestamp: Date.now()
          });

          let streamedOutput = "";
          let liveLineId: number | null = null;

          const res = await ctx.runInteractiveProcess(commandStr, runCwd, runEnv, (chunk: string) => {
            streamedOutput += chunk;
            const cleaned = streamedOutput.trim();
            if (cleaned) {
              if (liveLineId === null) {
                const lineObj = {
                  type: "system" as const,
                  content: cleaned,
                  timestamp: Date.now()
                };
                ctx.addLine(lineObj);
                liveLineId = lineObj.timestamp;
              } else if (ctx.setLines) {
                ctx.setLines((prev) => 
                  prev.map((l) => l.timestamp === liveLineId ? { ...l, content: cleaned } : l)
                );
              }
            }
          });

          const exitCode = typeof res === "number" ? res : res.exitCode;
          const outputText = typeof res === "number" ? "" : res.output;

          if (!liveLineId && outputText && outputText.trim()) {
            ctx.addLine({
              type: "system",
              content: outputText.trim(),
              timestamp: Date.now()
            });
          }

          ctx.addLine({
            type: "system",
            content: exitCode === 0 
              ? `✅ Process finished with exit code 0.`
              : `❌ Process failed with exit code ${exitCode}.`,
            timestamp: Date.now()
          });
          return;
        }

        const taskId = `term-${Math.random().toString(36).substring(2, 9)}`;
        const windowLabel = labelOverride || presetName || commandStr.split(" ")[0];

        const logDir = getWorkspaceTasksLogDir();
        if (!fsCb.existsSync(logDir)) fsCb.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, `${taskId}.log`);
        const closeSignalPath = path.join(logDir, `${taskId}.closed.json`);
        fsCb.writeFileSync(logPath, `[Terminal: ${windowLabel}]\n[Command: ${commandStr}]\n[Started: ${new Date().toISOString()}]\n\n`);
        try { fsCb.rmSync(closeSignalPath, { force: true }); } catch { /* ignore */ }

        ctx.addLine({
          type: "system",
          content: `🖥️ Spawning terminal [ID: ${taskId}]: "${commandStr}" (cwd: ${runCwd})\n   Log: ${logPath}`,
          timestamp: Date.now()
        });

        let shellExe: string | boolean = true;
        if (process.platform === "win32") shellExe = "powershell.exe";

        const proc = execa(commandStr, {
          shell: shellExe,
          cwd: runCwd,
          env: runEnv,
          reject: false,
          all: true,
        });

        const task: BackgroundTask = {
          id: taskId,
          command: commandStr,
          process: proc,
          output: [],
          logPath,
          isDetachedWindow: true,
          windowLabel,
          cwd: runCwd,
        };

        backgroundTasks.set(taskId, task);
        notifyTasksChanged();

        proc.all?.on("data", (data: Buffer) => {
          const text = data.toString();
          task.output.push(text);
          if (task.output.length > 2000) task.output.shift();
          try { fsCb.appendFileSync(logPath, text); } catch { /* ignore */ }
        });

        try {
          const safeLog = logPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
          const safeTitle = windowLabel.replace(/"/g, "");
          const safeCwd = runCwd.replace(/"/g, "");

          if (process.platform === "win32") {
            const safeCloseSignal = closeSignalPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
            const viewerScript = [
              `$logPath = '${safeLog}'`,
              `$closeSignalPath = '${safeCloseSignal}'`,
              `$lastPos = 0`,
              `try {`,
              `  Write-Host "=== ${safeTitle} === (close window to stop process)" -ForegroundColor Cyan`,
              `  Write-Host ''`,
              `  while ($true) {`,
              `    try {`,
              `      $bytes = [System.IO.File]::ReadAllBytes($logPath)`,
              `      if ($bytes.Length -gt $lastPos) {`,
              `        $chunk = [System.Text.Encoding]::UTF8.GetString($bytes, $lastPos, $bytes.Length - $lastPos)`,
              `        Write-Host $chunk -NoNewline`,
              `        $lastPos = $bytes.Length`,
              `      }`,
              `      if ($lastPos -gt 0) {`,
              `        $tail = [System.Text.Encoding]::UTF8.GetString($bytes)`,
              `        if ($tail -match '\\[Process exited') { break }`,
              `      }`,
              `    } catch {}`,
              `    Start-Sleep -Milliseconds 200`,
              `  }`,
              `  Write-Host ''`,
              `  Write-Host '[Process finished. Press Enter to close.]' -ForegroundColor Green`,
              `  Read-Host`,
              `} finally {`,
              `  try {`,
              `    $payload = @{ action = 'closed'; timestamp = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress`,
              `    [System.IO.File]::WriteAllText($closeSignalPath, $payload, [System.Text.Encoding]::UTF8)`,
              `  } catch {}`,
              `  try { Remove-Item $MyInvocation.MyCommand.Path -Force } catch {}`,
              `}`,
            ].join("\n");
            const viewerScriptPath = path.join(logDir, `${taskId}-viewer.ps1`);
            fsCb.writeFileSync(viewerScriptPath, viewerScript, "utf8");

            const viewerProc = execa(
              "cmd.exe",
              ["/c", `start /wait "${safeTitle}" /D "${safeCwd}" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${viewerScriptPath}"`],
              { detached: true, stdio: "ignore", windowsVerbatimArguments: true, reject: false }
            );
            const handleViewerExit = () => {
              if (!task.hasExited) {
                const closeMsg = `\n[Terminal window closed; process killed at ${new Date().toISOString()}]`;
                task.hasExited = true;
                task.exitCode = null;
                task.output.push(closeMsg);
                try { fsCb.appendFileSync(logPath, closeMsg); } catch { /* ignore */ }
                try { killProcessTree(proc.pid); } catch { /* ignore */ }
              }
              backgroundTasks.delete(taskId);
              notifyTasksChanged();
            };
            viewerProc.on("close", handleViewerExit);
            viewerProc.on("exit", handleViewerExit);
          } else if (process.platform === "darwin") {
            const script = `tell application "Terminal" to do script "tail -f '${safeLog}'"`;
            execa("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
          } else {
            execa("x-terminal-emulator", ["-e", `bash -c "tail -f '${safeLog}'"`],
              { detached: true, stdio: "ignore", reject: false }).unref();
          }
        } catch { /* viewer optional */ }

        proc.on("close", (code: number | null) => {
          task.hasExited = true;
          task.exitCode = code;
          const exitMsg = `\n[Process exited with code ${code} at ${new Date().toISOString()}]`;
          task.output.push(exitMsg);
          try { fsCb.appendFileSync(logPath, exitMsg); } catch { /* ignore */ }
          notifyTasksChanged();
        });

        ctx.addLine({
          type: "system",
          content:
            `[TERMINAL CONTEXT] ID: ${taskId} | Label: ${windowLabel}\n` +
            `  Command : ${commandStr}\n` +
            `  Log     : ${logPath}\n` +
            `  AI can read this log file to see the live output.`,
          timestamp: Date.now(),
        });
      };

      if (args.toLowerCase() === "all") {
        const keys = Object.keys(presets);
        if (keys.length === 0) {
          ctx.addLine({
            type: "system",
            content: "No presets configured. Run `/terminal init` to set some up.",
            timestamp: Date.now()
          });
          return;
        }
        ctx.addLine({
          type: "system",
          content: `🚀 Launching all ${keys.length} preset(s)…`,
          timestamp: Date.now()
        });
        for (const k of keys) {
          const val = presets[k];
          const label = getPresetLabel(k, val);
          if (Array.isArray(val)) {
            for (const item of val) {
              await runCmd(item, label);
            }
          } else {
            await runCmd(val, label);
          }
        }
        return;
      } else if (args.toLowerCase() === "preset") {
        const keys = Object.keys(presets);
        const presetsList = keys.length > 0
          ? keys.map(k => `  • ${getPresetLabel(k, presets[k])}: ${formatPresetValue(presets[k])}`).join("\n")
          : "  (No presets configured)";
        ctx.addLine({
          type: "system",
          content: [
            "🖥️ TERMINAL COMMAND & PRESETS",
            "Usage:",
            "  /terminal preset <name>     - Run a configured preset",
            "  /terminal <preset_name>     - Run a preset directly (if name matches)",
            "",
            "Available Presets:",
            presetsList,
            "",
            "Presets can be configured in `.superagent-r/terminal-presets.json` or `terminal-presets.json`.",
            "Run `/terminal init` to set up presets with AI guidance.",
          ].join("\n"),
          timestamp: Date.now()
        });
        return;
      } else if (args.toLowerCase().startsWith("preset ")) {
        const requestedName = args.slice(7).trim();
        const found = findPreset(presets, requestedName);
        if (found) {
          commandToRun = found.value;
          isPreset = true;
          presetName = getPresetLabel(found.key, found.value);
        } else {
          ctx.addLine({
            type: "error",
            content: `Error: Preset "${requestedName}" not found. Run /terminal preset to see available presets.`,
            timestamp: Date.now()
          });
          return;
        }
      } else {
        const found = findPreset(presets, args);
        if (found) {
          commandToRun = found.value;
          isPreset = true;
          presetName = getPresetLabel(found.key, found.value);
        }
      }

      if (Array.isArray(commandToRun)) {
        ctx.addLine({
          type: "system",
          content: `Running preset "${presetName}" with ${commandToRun.length} commands...`,
          timestamp: Date.now()
        });
        for (const c of commandToRun) {
          await runCmd(c);
        }
      } else {
        await runCmd(commandToRun);
      }
    };

    return loadPresetsAndRun().catch(err => {
      ctx.addLine({
        type: "error",
        content: `Failed to execute terminal command: ${err.message}`,
        timestamp: Date.now()
      });
    });
  }
};

registry.register(terminalCommand);
