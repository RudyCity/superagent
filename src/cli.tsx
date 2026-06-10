#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import os from "os";

// Load global .env first
dotenv.config({ path: path.join(os.homedir(), ".superagent-r", ".env") });
// Load local .env from current working directory to allow project-level overrides
dotenv.config();
import React from "react";
import { render } from "ink";
import { App } from "./app.js";

const apiKey =
  process.env.ANTHROPIC_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.CUSTOM_API_KEY ||
  "";

const hasCustomEndpoint = !!process.env.CUSTOM_BASE_URL;

if (!apiKey && !hasCustomEndpoint) {
  console.error(
    "Error: Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, or CUSTOM_BASE_URL"
  );
  console.error("  cp .env.example .env  # then edit .env");
  process.exit(1);
}

import readline from "readline";
import { Agent } from "./core/agent.js";
import type { AgentEvent } from "./core/agent.js";

if (process.stdin.isTTY) {
  const autoResume = process.argv.includes("--resume") || process.argv.includes("-r");
  let hasCurrentHistory = false;
  console.clear();
  const { waitUntilExit } = render(
    React.createElement(App, {
      autoResume,
      onHistoryChange: (exists) => {
        hasCurrentHistory = exists;
      },
    })
  );
  waitUntilExit().then(() => {
    if (hasCurrentHistory) {
      console.log("\n💡 You can resume this session later by running /resume inside superagent, or by starting with: `superagent --resume` or `superagent -r`\n");
    }
  });
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
    }
  );

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
