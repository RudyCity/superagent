#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import React from "react";
import { render } from "ink";
import { App } from "./app.js";

import { getConfig } from "./core/config.js";
import { backgroundTasks, killProcessTree } from "./core/tools/index.js";
import { subagentInstances, superagentInstances, masterAgentRef } from "./core/tools/state.js";

function cleanupBackgroundTasks() {
  for (const [id, task] of backgroundTasks.entries()) {
    try {
      killProcessTree(task.process.pid);
    } catch {
      // Ignore errors during exit cleanup
    }
  }
}

function abortAllAgents() {
  // Abort all running subagents
  for (const inst of subagentInstances.values()) {
    if (inst.status === "running") {
      try { inst.agent.abort(); } catch {}
      inst.status = "completed";
      inst.result = "[Cancelled by user (SIGINT)]";
    }
  }
  // Abort all running superagents
  for (const inst of superagentInstances.values()) {
    if (inst.status === "running") {
      try { inst.agent.abort(); } catch {}
      inst.status = "error";
      inst.result = "[Cancelled by user (SIGINT)]";
      inst.completedAt = Date.now();
    }
  }
  // Abort master agent
  if (masterAgentRef && masterAgentRef.isAgentRunning && masterAgentRef.isAgentRunning()) {
    try { masterAgentRef.abort(); } catch {}
  }
}

let sigintCount = 0;
process.on("exit", cleanupBackgroundTasks);
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
      cleanupBackgroundTasks();
      process.exit(130);
    }
    return;
  }
  cleanupBackgroundTasks();
  process.exit(130);
});
process.on("SIGTERM", () => {
  abortAllAgents();
  cleanupBackgroundTasks();
  process.exit(143);
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

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Usage: superagent [options] [prompt]

Options:
  -r, --resume    Resume the last active session
  --multi         Start in Multi Superagent master orchestrator mode
  -h, --help      Show this help message and exit

Examples:
  superagent
  superagent --resume
  superagent --multi
  superagent "explain quantum computing in simple terms"
`);
  process.exit(0);
}

// Auto-setup FastContext on first run (portable Python + vendor source)
import { runFastContextSetup } from "./core/fastcontextSetup.js";
runFastContextSetup();

import readline from "readline";
import { Agent } from "./core/agent.js";
import type { AgentEvent } from "./core/agent.js";
import { MASTER_AGENT_SYSTEM_PROMPT } from "./core/prompts.js";
import { masterToolset } from "./core/tools/toolsets.js";
import { registerQuestionHandler, addMasterTokens, subscribeToMasterLogs, registerMasterAgent } from "./core/tools/index.js";

if (process.stdin.isTTY) {
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

  if (isMulti) {
    let logHandler: ((msg: string) => void) | null = null;
    let eventHandler: ((event: AgentEvent) => void) | null = null;

    // Question handler: forward to dashboard's interactive wizard
    // This is registered so subagents can also ask the user questions
    const questionHandlerRef: { current: ((q: string, opts: string[], isMultiSelect?: boolean) => Promise<string>) | null } = { current: null };

    const agent = new Agent(
      (event: AgentEvent) => {
        if (eventHandler) {
          eventHandler(event);
        }
        if (event.type === "text" && event.content !== "") {
          logHandler?.(`[AGENT]${event.content}`);
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
        logHandler?.(`[QUESTION] ${question} (auto-selected: ${options[0]})`);
        return options[0];
      },
      MASTER_AGENT_SYSTEM_PROMPT,  // Master orchestrator system prompt
      masterToolset                // Master-only toolset (no direct coding tools)
    );

    // Set master tier
    agent.tier = "master";
    agent.isMultiAgent = true;
    registerMasterAgent(agent);

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
      return options[0] ?? "";
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
  const agent = new Agent(
    (event: AgentEvent) => {
      switch (event.type) {
        case "text":
          process.stdout.write(event.content);
          break;
        case "tool_start":
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
          console.error(`\nError: ${event.message}`);
          break;
        case "done":
          process.stdout.write("\n❯ ");
          break;
        case "token_usage":
          // Quietly ignore or log in non-TTY mode
          break;
      }
    },
    async (toolCall, description) => {
      console.log(`\n⚠ Auto-approving permission in non-TTY: ${description}`);
      return true;
    },
    async (question, options) => {
      console.log(`\n❓ Question in non-TTY: ${question}`);
      console.log(`Auto-selecting first option: "${options[0]}"`);
      return options[0];
    }
  );
  agent.tier = "single";

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
      console.log("Commands:\n  /new   - Clear conversation history\n  /clear - Clear conversation history\n  /quit  - Exit the app");
      process.stdout.write("❯ ");
      return;
    }

    await agent.sendMessage(trimmed);
  });
}
