import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { getConfig, closeHistoryDb } from "./core/config.js";
import { isDirectoryTrusted, addTrustedDirectory, ensureDirectoryTrusted } from "./core/config/jsonConfig.js";
import { backgroundTasks, isTaskInWorkspace, subagentInstances, superagentInstances, masterAgentRef } from "./core/tools/state.js";
import { killProcessTree } from "./core/tools/shellTools.js";
import { closeMcpServers } from "./core/mcp/McpManager.js";

function cleanupBackgroundTasks() {
  try {
    closeMcpServers().catch(() => {});
  } catch {}

  const workspacePath = process.cwd();
  for (const [id, task] of backgroundTasks.entries()) {
    if (isTaskInWorkspace(task.cwd, workspacePath)) {
      try {
        killProcessTree(task.process.pid);
      } catch {
        // Ignore errors during exit cleanup
      }
    }
  }
}

function hideCursor() {
  if (process.stdin.isTTY) {
    process.stdout.write("\x1b[?25l");
  }
}

// Disable all mouse tracking modes and restore cursor.
// Must be synchronous — called from signal handlers and exit.
function restoreTerminal() {
  try {
    if (process.stdout.isTTY) {
      // Disable SGR mouse + button-event tracking + any-event tracking
      process.stdout.write(
        "\x1b[?1006l" + // SGR mouse off
        "\x1b[?1003l" + // any-event off
        "\x1b[?1002l" + // button-event off
        "\x1b[?1000l" + // normal mouse off
        "\x1b[?25h"    // show cursor
      );
    }
  } catch {
    // Ignore if stdout already closed
  }
}

function abortAllAgents() {
  // Abort all running subagents
  for (const inst of subagentInstances.values()) {
    if (inst.status === "running") {
      try { inst.agent.abort(); } catch {}
      inst.status = "completed";
      inst.result = "[Cancelled by user (SIGINT)]";
      try { inst.agent.saveHistorySync(); } catch {}
    }
  }
  // Abort all running superagents
  for (const inst of superagentInstances.values()) {
    if (inst.status === "running") {
      try { inst.agent.abort(); } catch {}
      inst.status = "error";
      inst.result = "[Cancelled by user (SIGINT)]";
      inst.completedAt = Date.now();
      try { inst.agent.saveHistorySync(); } catch {}
    }
  }
  // Abort master agent
  if (masterAgentRef && masterAgentRef.isAgentRunning && masterAgentRef.isAgentRunning()) {
    try { masterAgentRef.abort(); } catch {}
    try { masterAgentRef.saveHistorySync(); } catch {}
  }
}

let sigintCount = 0;

export async function runCli() {
  // Purge empty draft sessions in background on startup
  try {
    const { purgeEmptySessions } = await import("./core/config.js");
    purgeEmptySessions(24);
  } catch {}

  // Start extension server silently in the background
  try {
    const { runServer } = await import("./server.js");
    runServer(7888, true).catch(() => {});
  } catch {}

  // Check for --workspace-ssh flag
  const sshFlagIdx = process.argv.findIndex((arg) => arg === "--workspace-ssh" || arg === "-ws");
  if (sshFlagIdx !== -1 && process.argv[sshFlagIdx + 1]) {
    const sshTarget = process.argv[sshFlagIdx + 1];
    const { workspaceMode } = await import("./core/ssh/workspaceMode.js");
    const { sshProxy } = await import("./core/ssh/sshProxy.js");
    const parsed = workspaceMode.parseSshTarget(sshTarget);
    if (parsed) {
      workspaceMode.setSshMode(parsed);
      sshProxy.setPasswordHandler(async () => {
        const readline = await import("readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        return new Promise<string>((resolve) => {
          rl.question(`Enter SSH password for ${parsed.username}@${parsed.host}: `, (answer) => {
            rl.close();
            resolve(answer.trim());
          });
        });
      });
      try {
        console.log(`Connecting to SSH proxy workspace ${parsed.username}@${parsed.host}:${parsed.port}...`);
        await sshProxy.connect(parsed);
        console.log(`Connected to SSH remote workspace: ${parsed.remoteCwd}`);
      } catch (err: any) {
        console.error(`Failed to connect to SSH target ${sshTarget}: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error(`Invalid --workspace-ssh format. Use: user@host[:port]:/remote/path or ssh://user@host/path`);
      process.exit(1);
    }
  }


  process.on("exit", () => {
    if (masterAgentRef) {
      try { masterAgentRef.saveHistorySync(); } catch {}
    }
    cleanupBackgroundTasks();
    restoreTerminal();
    try {
      closeHistoryDb();
    } catch {}
  });
  process.on("SIGINT", () => {
    if (process.stdin.isTTY) {
      // First Ctrl+C: abort all running agents & kill background procs.
      // Second Ctrl+C within 2 seconds: force exit.
      sigintCount++;
      if (sigintCount === 1) {
        abortAllAgents();
        cleanupBackgroundTasks();
        // Reset counter after 2 seconds so a later Ctrl+C is treated as first
        setTimeout(() => { sigintCount = 0; }, 2000);
      } else {
        restoreTerminal();
        cleanupBackgroundTasks();
        process.exit(130);
      }
      return;
    }
    restoreTerminal();
    cleanupBackgroundTasks();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restoreTerminal();
    abortAllAgents();
    cleanupBackgroundTasks();
    process.exit(143);
  });
  process.on("SIGHUP", () => {
    restoreTerminal();
    cleanupBackgroundTasks();
    process.exit(1);
  });

  const config = getConfig();
  const apiKey = config.apiKey;
  const hasCustomEndpoint = !!config.baseUrl;

  if (!apiKey && !hasCustomEndpoint && !process.stdin.isTTY) {
    console.error(
      "Error: No API key configured. Run superagent and use /login add to configure a provider."
    );
    process.exit(1);
  }



  if (!process.stdin.isTTY) {
    // Auto-setup ripgrep and Android CLI asynchronously on startup
    const { ensureRgInstalled, ensureAndroidCliInstalled, ensureUvInstalled, ensurePythonInstalled } = await import("./core/androidSetup.js");
    ensureRgInstalled().catch(() => {});
    ensureAndroidCliInstalled().catch(() => {});
    ensureUvInstalled().catch(() => {});
    ensurePythonInstalled().catch(() => {});

    // Auto-setup RMemory Gateway if enabled
    const { runRmemorySetup } = await import("./core/rmemorySetup.js");
    runRmemorySetup().catch(() => {});

    // Initialize MCP Servers in background
    const { initMcpServers } = await import("./core/mcp/McpManager.js");
    initMcpServers().catch((err) => {
      console.error("[MCP] Error initializing servers during startup:", err);
    });
  }

  const { Agent } = await import("./core/agent.js");
  const { registerQuestionHandler, addMasterTokens, subscribeToMasterLogs, registerMasterAgent } = await import("./core/tools/index.js");

  if (process.stdin.isTTY) {
    // Confirm directory trust before starting the application
    const currentDir = path.resolve(process.cwd());
    const confirmTrust = async (dir: string): Promise<boolean> => {
      const React = (await import("react")).default;
      const { render } = await import("ink");
      const { TrustPrompt } = await import("./components/trust-prompt.js");
      return new Promise<boolean>((resolve) => {
        const { unmount } = render(
          React.createElement(TrustPrompt, {
            directoryPath: dir,
            onAccept: () => {
              unmount();
              resolve(true);
            },
            onReject: () => {
              unmount();
              resolve(false);
            }
          })
        );
      });
    };

    const isTrusted = isDirectoryTrusted(currentDir);
    if (isTrusted) {
      // Already trusted, skip prompt and ensure configured in Git asynchronously
      ensureDirectoryTrusted(currentDir).catch(() => {});
    } else {
      const trusted = await confirmTrust(currentDir);
      if (!trusted) {
        console.log("\n❌ Project folder not trusted. Exiting superagent.\n");
        process.exit(1);
      }
      addTrustedDirectory(currentDir);
      await ensureDirectoryTrusted(currentDir);
    }

    // Run startup checks with progress bar UI
    const runStartupChecks = async (): Promise<void> => {
      const React = (await import("react")).default;
      const { render } = await import("ink");
      const { StartupChecker } = await import("./components/startup-checker.js");
      return new Promise<void>((resolve) => {
        const { unmount } = render(
          React.createElement(StartupChecker, {
            onComplete: () => {
              unmount();
              resolve();
            }
          })
        );
      });
    };
    await runStartupChecks();

    const resumeIndex = process.argv.findIndex(arg => arg === "--resume" || arg === "-r");
    let resumeVal: string | undefined = undefined;
    if (resumeIndex !== -1 && resumeIndex + 1 < process.argv.length) {
      const nextArg = process.argv[resumeIndex + 1];
      if (!nextArg.startsWith("-")) {
        resumeVal = nextArg;
      }
    }
    const autoResume = resumeVal !== undefined ? resumeVal : (resumeIndex !== -1 ? true : false);

    const flags = ["--resume", "-r", "--help", "-h", "--multi"];
    const positionalArgs = process.argv.slice(2).filter((arg, idx) => {
      if (flags.includes(arg)) return false;
      if (resumeVal && arg === resumeVal) {
        const prevArg = process.argv[2 + idx - 1];
        if (prevArg === "--resume" || prevArg === "-r") {
          return false;
        }
      }
      return true;
    });
    const initialPrompt = positionalArgs.join(" ");

    const isMulti = process.argv.includes("--multi");

    let hasCurrentHistory = false;
    let sessionPath = "";
    console.clear();
    hideCursor();

    if (isMulti) {
      const React = (await import("react")).default;
      const { render } = await import("ink");
      const { MASTER_AGENT_SYSTEM_PROMPT } = await import("./core/prompts.js");
      const { masterToolset } = await import("./core/tools/toolsets.js");

      let logHandler: ((msg: string) => void) | null = null;
      let eventHandler: ((event: any) => void) | null = null;

      // Question handler: forward to dashboard's interactive wizard
      // This is registered so subagents can also ask the user questions
      const questionHandlerRef: { current: ((q: string | any[], opts?: string[], isMultiSelect?: boolean) => Promise<string | string[]>) | null } = { current: null };

      const agent = new Agent(
        (event: any) => {
          if (eventHandler) {
            eventHandler(event);
          }
          if (event.type === "text" && event.content !== "") {
            logHandler?.(`[AGENT]${event.content}`);
          } else if (event.type === "reasoning" && event.content !== "") {
            logHandler?.(`[REASONING]${event.content}`);
          } else if (event.type === "tool_start") {
            logHandler?.(`[TOOL START] ${event.description}`);
          } else if (event.type === "tool_end") {
            const r = event.toolResult;
            const status = r.isError ? "Failed" : "Completed";
            const prefix = r.isError ? "✗" : "✓";
            const snippet = r.result.slice(0, 500) + (r.result.length > 500 ? "..." : "");
            const resultStr = r.isError 
              ? `${prefix} ${status} - ${event.description}\nDetail: ${r.result}`
              : `${prefix} ${status} - ${event.description}\nOutput: ${snippet}`;
            logHandler?.(`[TOOL END] ${resultStr}`);
          } else if (event.type === "error") {
            logHandler?.(`[ERROR] ${event.message}`);
          } else if (event.type === "token_usage") {
            addMasterTokens(event.promptTokens || 0, event.completionTokens || 0);
          }
        },
        async (toolCall, description) => {
          logHandler?.(`[AUTO-APPROVE] ${description}`);
          return true;
        },
        async (question, options, isMultiSelect) => {
          if (questionHandlerRef.current) {
            return questionHandlerRef.current(question, options, isMultiSelect);
          }
          if (Array.isArray(question)) {
            logHandler?.(`[QUESTION] Multi-question requested (auto-selecting first option for each)`);
            return question.map(q => q.options[0] ?? "");
          }
          logHandler?.(`[QUESTION] ${question} (auto-selected: ${options?.[0]})`);
          return options?.[0] ?? "";
        },
        MASTER_AGENT_SYSTEM_PROMPT,  // Master orchestrator system prompt
        masterToolset                // Master-only toolset (no direct coding tools)
      );

      // Set master tier
      agent.tier = "master";
      agent.isMultiAgent = true;
      registerMasterAgent(agent);

      // Register with extension server
      try {
        const { registerCliAgent } = await import("./server.js");
        registerCliAgent(agent, process.cwd(), "multi");
      } catch {}

      if (autoResume) {
        try {
          await agent.loadHistory(autoResume);
        } catch (err: any) {
          // Ignore and start clean if history load fails
        }
      }

      // Register question handler so subagents/superagents can ask user questions
      registerQuestionHandler(async (question, options, isMultiSelect) => {
        if (questionHandlerRef.current) {
          return questionHandlerRef.current(question, options, isMultiSelect);
        }
        if (Array.isArray(question)) {
          return question.map(q => q.options[0] ?? "");
        }
        return options?.[0] ?? "";
      });

      const { MultiAgentDashboard } = await import("./components/multi-agent-dashboard.js");
      const { waitUntilExit } = render(
        React.createElement(MultiAgentDashboard, {
          agent,
          autoResume,
          registerLogHandler: (handler) => {
            logHandler = handler;
            subscribeToMasterLogs((msg) => {
              handler(msg);
            });
          },
          registerEventHandler: (handler) => {
            eventHandler = handler;
          },
          registerQuestionHandlerRef: (setter) => {
            questionHandlerRef.current = setter;
          },
        })
      );
      waitUntilExit().then(() => {
        const hasHistory = agent.getHistory().getMessages().length > 0;
        if (hasHistory) {
          const historyPath = agent.getCurrentHistoryFilePath();
          let resumeMsg = "\n💡 You can resume this session later by running /resume inside superagent, or by starting with: `superagent --multi --resume` or `superagent --multi -r`";
          if (historyPath) {
            const sessionId = path.basename(historyPath, ".json");
            const parts = sessionId.split("_");
            const timestamp = parts[parts.length - 1];
            if (timestamp && /^\d+$/.test(timestamp)) {
              resumeMsg += `\n   Specifically for this session: \`superagent -r ${timestamp} --multi\``;
            } else {
              resumeMsg += `\n   Specifically for this session: \`superagent -r ${sessionId} --multi\``;
            }
          }
          console.log(resumeMsg + "\n");
        }
        process.exit(0);
      });
    } else {
      const React = (await import("react")).default;
      const { render } = await import("ink");
      const { App } = await import("./app.js");
      const { waitUntilExit } = render(
        React.createElement(App, {
          autoResume,
          initialPrompt,
          onHistoryChange: (exists) => {
            hasCurrentHistory = exists;
          },
          onSessionPath: (path) => {
            sessionPath = path;
          },
        })
      );
      waitUntilExit().then(() => {
        if (hasCurrentHistory) {
          let resumeMsg = "\n💡 You can resume this session later by running /resume inside superagent, or by starting with: `superagent --resume` or `superagent -r`";
          if (sessionPath) {
            const sessionId = path.basename(sessionPath, ".json");
            const parts = sessionId.split("_");
            const timestamp = parts[parts.length - 1];
            if (timestamp && /^\d+$/.test(timestamp)) {
              resumeMsg += `\n   Specifically for this session: \`superagent -r ${timestamp}\``;
            } else {
              resumeMsg += `\n   Specifically for this session: \`superagent -r ${sessionId}\``;
            }
          }
          console.log(resumeMsg + "\n");
        }
        process.exit(0);
      });
    }
  } else {
    const readline = (await import("readline")).default;
    let inReasoning = false;
    const agent = new Agent(
      (event: any) => {
        switch (event.type) {
          case "text":
            if (inReasoning) {
              process.stdout.write("\n[/Reasoning]\n");
              inReasoning = false;
            }
            process.stdout.write(event.content);
            break;
          case "reasoning":
            if (!inReasoning) {
              process.stdout.write("\n [Reasoning]\n   ");
              inReasoning = true;
            }
            process.stdout.write(event.content.replace(/\n/g, "\n   "));
            break;
          case "tool_start":
            if (inReasoning) {
              process.stdout.write("\n[/Reasoning]\n");
              inReasoning = false;
            }
            console.log(`\n⚡ ${event.description}`);
            break;
          case "tool_end":
            const r = event.toolResult;
            if (r.isError) {
              console.log(`✗ Failed - ${event.description}\nDetail: ${r.result}`);
            } else {
              console.log(`✓ Completed - ${event.description}\nOutput: ${r.result.slice(0, 200)}${r.result.length > 200 ? "..." : ""}`);
            }
            break;
          case "error":
            if (inReasoning) {
              process.stdout.write("\n[/Reasoning]\n");
              inReasoning = false;
            }
            console.error(`\nError: ${event.message}`);
            break;
          case "done":
            if (inReasoning) {
              process.stdout.write("\n[/Reasoning]\n");
              inReasoning = false;
            }
            process.stdout.write("\n❯ ");
            break;
          case "token_usage":
            // Quietly ignore or log in non-TTY mode
            break;
          case "model_download":
            if (event.status === "downloading") {
              process.stdout.write(`\n[INFO] Downloading local ${event.modelName} model to cache...\n`);
            } else if (event.status === "progress" && typeof event.progress === "number") {
              process.stdout.write(`\r[INFO] Downloading ${event.modelName} model: ${event.progress.toFixed(1)}%`);
            } else if (event.status === "loaded") {
              process.stdout.write(`\n[INFO] ${event.modelName} model loaded successfully.\n`);
            }
            break;
        }
      },
      async (toolCall, description) => {
        // In non-interactive mode: auto-approve shell/read tools but BLOCK out-of-bounds file writes.
        // File write tools outside the workspace must never silently succeed in headless mode.
        const FILE_WRITE_TOOLS = [
          "write", "write_to_file", "edit",
          "replace_file_content", "multi_replace_file_content", "apply_patch",
        ];
        if (FILE_WRITE_TOOLS.includes(toolCall.name)) {
          console.error(
            `\n🚫 Blocked out-of-bounds FILE WRITE in non-TTY mode: ${description}\n` +
            `   Tool "${toolCall.name}" attempted to write outside the workspace. Denied.`
          );
          return false;
        }
        console.log(`\n⚠ Auto-approving permission in non-TTY: ${description}`);
        return true;
      },
      async (question, options) => {
        console.log(`\n❓ Question in non-TTY: ${question}`);
        if (Array.isArray(question)) {
          return question.map(q => q.options?.[0] ?? "");
        }
        const firstOpt = options?.[0] ?? "";
        console.log(`Auto-selecting first option: "${firstOpt}"`);
        return firstOpt;
      }
    );
    agent.tier = "single";

    // Register with extension server
    try {
      const { registerCliAgent } = await import("./server.js");
      registerCliAgent(agent, process.cwd(), "single");
    } catch {}

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    process.stdout.write("❯ ");

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        process.stdout.write("❯ ");
        return;
      }

      if (trimmed === "/exit" || trimmed === "/quit") {
        rl.close();
        process.exit(0);
      }

      if (trimmed === "/clear" || trimmed === "/new") {
        agent.clearHistory();
        console.log("Conversation cleared.");
        process.stdout.write("❯ ");
        return;
      }

      if (trimmed === "/help") {
        console.log("Commands:\n  /advisor - Show Advisor metrics & event log summary (Subcommands: config, clear, export)\n  /new     - Clear conversation history\n  /clear   - Clear conversation history\n  /quit    - Exit the app");
        process.stdout.write("❯ ");
        return;
      }

      if (trimmed.startsWith("/advisor")) {
        const { getAdvisorMetrics, getAdvisorEvents, clearAdvisorEvents, exportAdvisorEvents } = await import("./core/advisorLogger.js");
        const { updateSettings, getSettings } = await import("./core/config/jsonConfig.js");
        const parts = trimmed.split(" ").filter(Boolean);
        const sub = parts[1]?.toLowerCase();

        if (sub === "clear") {
          clearAdvisorEvents();
          console.log("\nAdvisor event logs cleared successfully.\n");
          process.stdout.write("❯ ");
          return;
        }

        if (sub === "export") {
          const targetPath = parts[2];
          const exportedPath = exportAdvisorEvents(targetPath);
          if (exportedPath) {
            console.log(`\nAdvisor events exported successfully to: ${exportedPath}\n`);
          } else {
            console.log("\nFailed to export advisor events or no events recorded.\n");
          }
          process.stdout.write("❯ ");
          return;
        }

        if (sub === "config") {
          const warn = parseInt(parts[2], 10);
          const pause = parseInt(parts[3], 10);
          const err = parseInt(parts[4], 10);

          if (!isNaN(warn) && !isNaN(pause) && !isNaN(err)) {
            updateSettings({
              advisorWarningThreshold: warn,
              advisorPauseThreshold: pause,
              advisorErrorThreshold: err,
            });
            console.log(`\nUpdated Advisor Thresholds:\n  Warning Threshold: ${warn}\n  Pause Threshold  : ${pause}\n  Error Threshold  : ${err}\n`);
          } else {
            const current = getSettings();
            console.log(`\nCurrent Advisor Config:\n  Warning Threshold: ${current.advisorWarningThreshold ?? 3}\n  Pause Threshold  : ${current.advisorPauseThreshold ?? 5}\n  Error Threshold  : ${current.advisorErrorThreshold ?? 5}`);
            console.log("Usage: /advisor config <warnThreshold> <pauseThreshold> <errorThreshold>\n");
          }
          process.stdout.write("❯ ");
          return;
        }

        const metrics = getAdvisorMetrics();
        const events = getAdvisorEvents(5);
        console.log("\n--- RealtimeAdvisor Status & Metrics ---");
        console.log(`Total Events Logged: ${metrics.totalEvents}`);
        console.log(`Warnings Issued    : ${metrics.totalWarnings}`);
        console.log(`Pauses Triggered   : ${metrics.totalPauses}`);
        if (metrics.topLoopTools.length > 0) {
          console.log("\nTop Looped Tools:");
          for (const item of metrics.topLoopTools) {
            console.log(`  - ${item.tool}: ${item.count} times`);
          }
        }
        if (events.length > 0) {
          console.log("\nRecent Advisor Events:");
          for (const e of events) {
            console.log(`  [${e.timestamp}] [${e.action.toUpperCase()}] ${e.reason}`);
            console.log(`  Message: ${e.message}`);
            if (e.suggestion) {
              console.log(`  Suggestion: ${e.suggestion}`);
            }
          }
        } else {
          console.log("\nNo advisor warning/pause events recorded yet.");
        }
        console.log("Subcommands: /advisor config <warn> <pause> <err> | /advisor clear | /advisor export [path]");
        console.log("----------------------------------------\n");
        process.stdout.write("❯ ");
        return;
      }

      await agent.sendMessage(trimmed);
    });
  }
}
