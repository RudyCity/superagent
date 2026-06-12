import React, { useState, useEffect } from "react";
import { execSync } from "child_process";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import fs from "fs/promises";
import { 
  subagentInstances, 
  subscribeToSubagents, 
  superagentInstances,
  subscribeToSuperagents,
  backgroundTasks, 
  subscribeToTasks,
  subscribeToActiveOutput,
  notifySubagentsChanged,
  notifySuperagentsChanged,
  historicalSuperagentTokens
} from "../core/tools/state.js";
import { Agent } from "../core/agent.js";
import { wrapTextForDisplay } from "../utils/responseScroll.js";
import path from "path";
import { 
  updateEnvFile, 
  switchActiveProvider, 
  listHistorySessions, 
  fetchAndCacheModels,
  getConfiguredProviders,
  getContextWindowLimit,
  getInstalledSkills,
  getGlobalConfigDir,
  getCachedModelIds,
  getRootConfigDir
} from "../core/config.js";

import { filterSuggestions } from "../utils/text.js";
import { WizardDialog } from "./wizard-dialog.js";
import { handleSlashCommand, getDefaultModel } from "../core/slash-commands.js";
import { listCheckpointsForSession, restoreCheckpoint } from "../core/checkpoints.js";
import { allTools } from "../core/tools.js";

export interface AgentSession {
  id: string;
  type: "MASTER" | "SUPERAGENT" | "SUBAGENT" | "TASK";
  task: string;
  status: "WORKING" | "COMPLETED" | "IDLE" | "ERROR";
  tokens: number;
  logs: string[];
  branch?: string;
  worktreePath?: string;
}

export function stripSgrMouseSequences(value: string): string {
  return value.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, "")
              .replace(/\[<\d+;\d+;\d+[Mm]/g, "")
              .replace(/\{<\d+;\d+;\d+[Mm]/g, "")
              .replace(/<\d+;\d+;\d+[Mm]/g, "");
}

function renderLogInlineStyles(
  text: string,
  defaultColor: string,
  isBold: boolean,
  dimColor: boolean
): React.ReactNode {
  const parsedElements: React.ReactNode[] = [];
  let currentText = text;

  while (currentText.length > 0) {
    const boldIdx = currentText.indexOf("**");
    const codeIdx = currentText.indexOf("`");
    const linkIdx = currentText.indexOf("[");

    // Check for raw URLs (file:///, http://, https://)
    const fileUrlIdx = currentText.indexOf("file://");
    const httpUrlIdx = currentText.indexOf("http://");
    const httpsUrlIdx = currentText.indexOf("https://");

    let rawUrlIdx = -1;
    if (fileUrlIdx !== -1) rawUrlIdx = fileUrlIdx;
    if (httpUrlIdx !== -1 && (rawUrlIdx === -1 || httpUrlIdx < rawUrlIdx)) rawUrlIdx = httpUrlIdx;
    if (httpsUrlIdx !== -1 && (rawUrlIdx === -1 || httpsUrlIdx < rawUrlIdx)) rawUrlIdx = httpsUrlIdx;

    let minIdx = -1;
    let tokenType: "bold" | "code" | "link" | "rawUrl" | "none" = "none";

    if (boldIdx !== -1) {
      minIdx = boldIdx;
      tokenType = "bold";
    }

    if (codeIdx !== -1 && (minIdx === -1 || codeIdx < minIdx)) {
      minIdx = codeIdx;
      tokenType = "code";
    }

    if (linkIdx !== -1 && (minIdx === -1 || linkIdx < minIdx)) {
      const closeBracketIdx = currentText.indexOf("]", linkIdx);
      if (closeBracketIdx !== -1 && currentText[closeBracketIdx + 1] === "(") {
        const closeParenIdx = currentText.indexOf(")", closeBracketIdx + 2);
        if (closeParenIdx !== -1) {
          minIdx = linkIdx;
          tokenType = "link";
        }
      }
    }

    if (rawUrlIdx !== -1 && (minIdx === -1 || rawUrlIdx < minIdx)) {
      const remainingFromUrl = currentText.slice(rawUrlIdx);
      const match = remainingFromUrl.match(/^(file:\/\/\/[^\s`'"\(\)\[\]<>]+|https?:\/\/[^\s`'"\(\)\[\]<>]+)/);
      if (match) {
        minIdx = rawUrlIdx;
        tokenType = "rawUrl";
      }
    }

    if (tokenType === "none" || minIdx === -1) {
      parsedElements.push(
        <Text key={parsedElements.length} color={defaultColor} bold={isBold} dimColor={dimColor}>
          {currentText}
        </Text>
      );
      break;
    }

    if (minIdx > 0) {
      parsedElements.push(
        <Text key={parsedElements.length} color={defaultColor} bold={isBold} dimColor={dimColor}>
          {currentText.slice(0, minIdx)}
        </Text>
      );
    }

    currentText = currentText.slice(minIdx);

    if (tokenType === "bold") {
      const nextBoldIdx = currentText.indexOf("**", 2);
      if (nextBoldIdx !== -1) {
        const boldContent = currentText.slice(2, nextBoldIdx);
        parsedElements.push(
          <Text key={parsedElements.length} bold color="yellow">
            {boldContent}
          </Text>
        );
        currentText = currentText.slice(nextBoldIdx + 2);
      } else {
        parsedElements.push(
          <Text key={parsedElements.length} color={defaultColor} bold={isBold} dimColor={dimColor}>
            {currentText.slice(0, 2)}
          </Text>
        );
        currentText = currentText.slice(2);
      }
    } else if (tokenType === "code") {
      const nextCodeIdx = currentText.indexOf("`", 1);
      if (nextCodeIdx !== -1) {
        const codeContent = currentText.slice(1, nextCodeIdx);
        parsedElements.push(
          <Text key={parsedElements.length} color="cyan" bold>
            {codeContent}
          </Text>
        );
        currentText = currentText.slice(nextCodeIdx + 1);
      } else {
        parsedElements.push(
          <Text key={parsedElements.length} color={defaultColor} bold={isBold} dimColor={dimColor}>
            {currentText.slice(0, 1)}
          </Text>
        );
        currentText = currentText.slice(1);
      }
    } else if (tokenType === "link") {
      const closeBracketIdx = currentText.indexOf("]");
      const closeParenIdx = currentText.indexOf(")", closeBracketIdx + 2);
      const linkText = currentText.slice(1, closeBracketIdx);
      const linkUrl = currentText.slice(closeBracketIdx + 2, closeParenIdx);

      const osc8Link = `\u001B]8;;${linkUrl}\u0007${linkText}\u001B]8;;\u0007`;
      parsedElements.push(
        <Text key={parsedElements.length} color="cyan" underline>
          {osc8Link}
        </Text>
      );
      currentText = currentText.slice(closeParenIdx + 1);
    } else if (tokenType === "rawUrl") {
      const match = currentText.match(/^(file:\/\/\/[^\s`'"\(\)\[\]<>]+|https?:\/\/[^\s`'"\(\)\[\]<>]+)/);
      if (match) {
        let url = match[0];
        while (url.length > 0 && /[.,;:!?]$/.test(url)) {
          url = url.slice(0, -1);
        }
        const osc8Link = `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`;
        parsedElements.push(
          <Text key={parsedElements.length} color="cyan" underline>
            {osc8Link}
          </Text>
        );
        currentText = currentText.slice(url.length);
      } else {
        parsedElements.push(
          <Text key={parsedElements.length} color={defaultColor} bold={isBold} dimColor={dimColor}>
            {currentText[0]}
          </Text>
        );
        currentText = currentText.slice(1);
      }
    }
  }

  return <>{parsedElements}</>;
}

function ThinkingSpinner() {
  const [frame, setFrame] = useState(0);
  const spinners = ["▰▱▱▱▱▱▱", "▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱", "▰▰▰▰▱▱▱", "▰▰▰▰▰▱▱", "▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰"];
  
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % spinners.length);
    }, 150);
    return () => clearInterval(timer);
  }, []);

  return <Text color="yellow" bold>⚡ ORCHESTRATING [{spinners[frame]}] </Text>;
}

export function MultiAgentDashboard({
  agent,
  registerLogHandler,
  registerQuestionHandlerRef,
}: {
  agent: Agent;
  registerLogHandler: (handler: (msg: string) => void) => void;
  registerQuestionHandlerRef?: (setter: (q: string, opts: string[], isMultiSelect?: boolean) => Promise<string>) => void;
}) {
  const { exit } = useApp();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [focusArea, setFocusArea] = useState<"list" | "logs" | "input">("input");
  const [query, setQuery] = useState("");
  const [masterLogs, setMasterLogs] = useState<string[]>(["[MASTER] System initialised. Ready for tasks."]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [tempInput, setTempInput] = useState("");

  // Persist input history to disk so it survives restarts
  const HISTORY_FILE = path.join(getRootConfigDir(), "input-history-multi.json");
  useEffect(() => {
    fs.readFile(HISTORY_FILE, "utf8").then((raw) => {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setHistory(parsed);
      }
    }).catch(() => { /* first run or corrupt file — start fresh */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [currentTask, setCurrentTask] = useState("Idle - Ready for input");
  const [gitBranch, setGitBranch] = useState("main");
  const [cachedSessions, setCachedSessions] = useState<any[]>([]);
  const [activeWizard, setActiveWizard] = useState<{
    type: "login" | "model" | "resume" | "checkpoint" | "skills" | "permission" | "question" | "plan_approve" | "goal";
    step: number;
    data: Record<string, string>;
    isMultiSelect?: boolean;
  } | null>(null);
  const [wizardOptions, setWizardOptions] = useState<string[]>([]);
  const [wizardSelectedIndex, setWizardSelectedIndex] = useState(0);
  const [wizardSelectedSet, setWizardSelectedSet] = useState<Set<number>>(new Set());
  const [wizardAllOptions, setWizardAllOptions] = useState<string[]>([]);
  const [wizardIsLoadingModels, setWizardIsLoadingModels] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<{
    question: string;
    options: string[];
    resolve: (value: string) => void;
  } | null>(null);
  const [checkpointsList, setCheckpointsList] = useState<any[]>([]);
  const [worktreeCount, setWorktreeCount] = useState<number>(0);

  // Register the interactive question handler
  useEffect(() => {
    if (registerQuestionHandlerRef) {
      registerQuestionHandlerRef(async (question, options, isMultiSelect) => {
        return new Promise<string>((resolve) => {
          const hasOptions = Array.isArray(options) && options.length > 0;
          const allOptions = hasOptions ? [...options, "Custom..."] : [];
          setPendingQuestion({ question, options: allOptions, resolve });
          setWizardOptions(allOptions);
          setWizardSelectedIndex(0);
          setWizardSelectedSet(new Set());
          setActiveWizard({
            type: "question",
            step: hasOptions ? 1 : 2,
            data: { question },
            isMultiSelect,
          });
        });
      });
    }
  }, [registerQuestionHandlerRef]);

  // Automatically focus the input area when any wizard is active
  useEffect(() => {
    if (activeWizard) {
      setFocusArea("input");
    }
  }, [activeWizard]);

  const getSuggestions = () => {
    if (!query.startsWith("/")) return [];
    const commands = [
      "/model", "/login", "/resume", "/clear", "/new", "/exit", 
      "/quit", "/checkpoint", "/install", "/skills", "/procs", 
      "/processes", "/agents", "/worktree", "/worktrees", "/search-history", "/compact", 
      "/init", "/terminal", "/help"
    ];
    const parts = query.split(/\s+/);
    const mainCommand = parts[0].toLowerCase();
    
    if (parts.length === 1) {
      return filterSuggestions(commands, query);
    }
    
    if (mainCommand === "/model") {
      const fallbackModels = [
        "google/gemini-2.5-flash",
        "google/gemini-2.5-pro",
        "anthropic/claude-3-5-sonnet",
        "openai/gpt-4o",
        "openai/gpt-4o-mini"
      ];
      const cachedIds = getCachedModelIds();
      const modelList = cachedIds.length > 0 ? cachedIds : fallbackModels;
      const possibilities = modelList.map(m => `/model ${m}`);
      const searchTerm = query.replace(/^\/model\s*/i, "").trim();
      return searchTerm
        ? filterSuggestions(possibilities, searchTerm)
        : possibilities.slice(0, 10);
    }
    
    if (mainCommand === "/login") {
      const providers = ["openrouter", "openai", "anthropic"];
      const possibilities = providers.map(p => `/login ${p}`);
      return filterSuggestions(possibilities, query);
    }
    
    if (mainCommand === "/resume") {
      const sessionsList = listHistorySessions(true);
      const possibilities = sessionsList.map((s, idx) => `/resume ${idx + 1}`);
      return filterSuggestions(possibilities, query);
    }
    
    return [];
  };

  const suggestions = getSuggestions();

  useEffect(() => {
    try {
      const branch = execSync("git branch --show-current", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (branch) setGitBranch(branch);
    } catch {}
  }, []);

  useEffect(() => {
    const updateCount = () => {
      try {
        const output = execSync("git worktree list", {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (output) {
          const lines = output.split("\n").filter(Boolean);
          setWorktreeCount(lines.length);
        } else {
          setWorktreeCount(0);
        }
      } catch {
        setWorktreeCount(0);
      }
    };
    updateCount();
    const timer = setInterval(updateCount, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (agent) {
      try {
        const msgs = agent.getHistory().getMessages();
        const userInputs: string[] = [];
        for (const m of msgs) {
          if (m.role === "user" && m.content) {
            const content = m.content.trim();
            if (content) {
              userInputs.push(content);
            }
          }
        }
        if (userInputs.length > 0) {
          const uniqueUserInputs: string[] = [];
          for (const input of userInputs) {
            if (uniqueUserInputs.length === 0 || uniqueUserInputs[uniqueUserInputs.length - 1] !== input) {
              uniqueUserInputs.push(input);
            }
          }
          setHistory(uniqueUserInputs);
        }
      } catch {}
    }
  }, [agent]);

  const [terminalSize, setTerminalSize] = useState({
    width: process.stdout.columns || 110,
    height: process.stdout.rows || 24,
  });

  useEffect(() => {
    const handleResize = () => {
      console.clear();
      setTerminalSize({
        width: process.stdout.columns || 110,
        height: process.stdout.rows || 24,
      });
    };
    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  // Subscribe to active output from tools (master agent logs)
  useEffect(() => {
    return subscribeToActiveOutput((output) => {
      // Normalize \r\n -> \n, then strip bare \r to avoid cursor-to-col-0 bleed
      const sanitized = output.replace(/\r\n/g, "\n").replace(/\r/g, "");
      if (sanitized.trim()) {
        const newLogs = sanitized.split("\n").filter(Boolean);
        setMasterLogs((prev) => [...prev, ...newLogs].slice(-50));
      }
    });
  }, []);

  // Register the agent event log handler on mount
  useEffect(() => {
    registerLogHandler((rawMsg) => {
      // Normalize \r\n -> \n, then strip bare \r to prevent cursor-to-col-0 bleed
      const msg = rawMsg.replace(/\r\n/g, "\n").replace(/\r/g, "");

      setMasterLogs((prev) => {
        if (prev.length === 0) return [msg];
        
        const isTag = (line: string) => {
          const trimmed = line.trim();
          return (
            trimmed.startsWith("[USER]") ||
            trimmed.startsWith("[MASTER]") ||
            trimmed.startsWith("[AGENT]") ||
            trimmed.startsWith("[TOOL START]") ||
            trimmed.startsWith("[TOOL END]") ||
            trimmed.startsWith("[ERROR]") ||
            trimmed.startsWith("[AUTO-APPROVE]") ||
            trimmed.startsWith("[QUESTION]")
          );
        };

        const lastIdx = prev.length - 1;
        const last = prev[lastIdx];
        
        if (msg.startsWith("[AGENT]") && last.startsWith("[AGENT]")) {
          const updated = [...prev];
          // Strip only the tag prefix — preserve the raw token content including leading spaces
          const cleanMsg = msg.replace(/^\[AGENT\]/, "");
          // Append directly: streaming chunks already carry their own spacing/newlines
          updated[lastIdx] = last + cleanMsg;
          return updated.slice(-50);
        }

        if (!isTag(msg) && !isTag(last)) {
          const updated = [...prev];
          updated[lastIdx] = last + "\n" + msg;
          return updated.slice(-50);
        }
        
        return [...prev, msg].slice(-50);
      });
    });
  }, [registerLogHandler]);

  const handleWizardSubmit = async (value: string) => {
    if (!activeWizard) return;
    const now = Date.now();

    if (activeWizard.type === "login") {
      if (activeWizard.step === 1) {
        const choice = value.toLowerCase();
        if (choice.includes("add") || choice === "1") {
          setActiveWizard({
            type: "login",
            step: 2,
            data: {},
          });
          setWizardOptions(["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint"]);
          setWizardSelectedIndex(0);
        } else if (choice.includes("switch") || choice === "2") {
          const list = getConfiguredProviders();
          const options = list.map(p => `${p.name} (${p.type})${p.isActive ? " [Active]" : ""}`);
          setActiveWizard({
            type: "login",
            step: 5,
            data: {},
          });
          setWizardOptions(options);
          setWizardSelectedIndex(0);
        } else {
          const list = getConfiguredProviders();
          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Configured Providers:\n` + list.map(p => `- ${p.name} (${p.type})${p.isActive ? " [Active]" : ""}`).join("\n")
          ].slice(-50));
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        }
      } else if (activeWizard.step === 2) {
        const choice = value.toLowerCase();
        let provider = "";
        if (choice === "1" || choice.includes("openrouter")) {
          provider = "openrouter";
        } else if (choice === "2" || choice.includes("openai")) {
          provider = "openai";
        } else if (choice === "3" || choice.includes("anthropic")) {
          provider = "anthropic";
        } else if (choice === "4" || choice.includes("custom")) {
          provider = "custom";
        } else {
          setMasterLogs((prev) => [...prev, `[ERROR] Invalid choice. Please select 1, 2, 3, or 4.`].slice(-50));
          return;
        }

        setMasterLogs((prev) => [
          ...prev,
          `[MASTER] Selected provider type: ${provider}\nStep 3: Enter config profile name (e.g. ${provider}, deepseek, or press Enter for default):`
        ].slice(-50));

        setActiveWizard({
          type: "login",
          step: 3,
          data: { provider },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 3) {
        const provider = activeWizard.data.provider;
        const nameInput = value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
        const profileName = nameInput || provider;

        if (provider === "custom") {
          setMasterLogs((prev) => [
            ...prev,
            `[MASTER] Config Name: ${profileName}\nStep 4: Please enter your Base URL (e.g. http://localhost:11434/v1):`
          ].slice(-50));
          setActiveWizard({
            type: "login",
            step: 4,
            data: { provider, name: profileName },
          });
        } else {
          setMasterLogs((prev) => [
            ...prev,
            `[MASTER] Config Name: ${profileName}\nStep 6: Please enter your API Key:`
          ].slice(-50));
          setActiveWizard({
            type: "login",
            step: 6,
            data: { provider, name: profileName },
          });
        }
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 4) {
        const provider = activeWizard.data.provider;
        const profileName = activeWizard.data.name;
        const baseUrl = value.trim();

        setMasterLogs((prev) => [
          ...prev,
          `[MASTER] Entered Base URL: ${baseUrl}\nStep 6: Please enter your API Key:`
        ].slice(-50));
        setActiveWizard({
          type: "login",
          step: 6,
          data: { provider, name: profileName, baseUrl },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 5) {
        const list = getConfiguredProviders();
        const cleanVal = value.replace(/^\d+\.\s*/, "").split(" (")[0].trim();
        const chosen = list.find(p => p.name.toLowerCase() === cleanVal.toLowerCase());
        if (chosen) {
          try {
            const envPath = switchActiveProvider(chosen.name);
            setMasterLogs((prev) => [
              ...prev,
              `[SYSTEM] Switched active provider to: ${chosen.name}\nSaved to: ${envPath}`
            ].slice(-50));
          } catch (err: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to switch provider: ${err.message}`].slice(-50));
          }
        } else {
          setMasterLogs((prev) => [...prev, `[ERROR] Provider "${value}" not found in configured list.`].slice(-50));
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 6) {
        const provider = activeWizard.data.provider;
        const profileName = activeWizard.data.name;
        const baseUrl = activeWizard.data.baseUrl;
        const apiKey = value.trim();

        const prefix = `PROVIDER_${profileName.toUpperCase()}`;
        const updates: Record<string, string> = {
          ACTIVE_PROVIDER: profileName,
          [`${prefix}_TYPE`]: provider,
          [`${prefix}_API_KEY`]: apiKey,
        };

        if (baseUrl) {
          updates[`${prefix}_BASE_URL`] = baseUrl;
        } else if (provider === "openrouter") {
          updates[`${prefix}_BASE_URL`] = "https://openrouter.ai/api/v1";
        }

        try {
          updateEnvFile(updates);
          const envPath = switchActiveProvider(profileName);

          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Successfully configured and activated provider profile: ${profileName} (${provider})!\nSaved to: ${envPath}`
          ].slice(-50));

          if (provider === "openrouter" && !process.env.MODEL) {
            updateEnvFile({ MODEL: "google/gemini-2.5-flash" });
          }

          fetchAndCacheModels().catch(() => {});
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to save credentials: ${err.message}`].slice(-50));
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 10) {
        const choice = value.toLowerCase();
        if (choice.includes("ask ai") || choice.startsWith("6")) {
          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Selected AI-Assisted Initialization.\nStep 13: Briefly describe what you want to build (e.g. "A simple markdown parser command line tool in TypeScript"):`
          ].slice(-50));
          setActiveWizard({
            type: "login",
            step: 13,
            data: activeWizard.data,
          });
        } else {
          let stack = "TypeScript";
          if (choice.includes("javascript")) stack = "JavaScript";
          else if (choice.includes("python")) stack = "Python";
          else if (choice.includes("rust")) stack = "Rust";
          else if (choice.includes("go")) stack = "Go";

          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Selected Stack: ${stack}\nStep 11: Enter Project Name (or press Enter for default "${path.basename(process.cwd())}"):`
          ].slice(-50));
          setActiveWizard({
            type: "login",
            step: 11,
            data: { ...activeWizard.data, stack },
          });
        }
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 11) {
        const projectName = value.trim() || path.basename(process.cwd());
        setMasterLogs((prev) => [
          ...prev,
          `[SYSTEM] Project Name: ${projectName}\nStep 12: Enter a short Project Description:`
        ].slice(-50));
        setActiveWizard({
          type: "login",
          step: 12,
          data: { ...activeWizard.data, projectName },
        });
      } else if (activeWizard.step === 12) {
        const projectDesc = value.trim() || "A software project.";
        const projectName = activeWizard.data.projectName;
        const projectTech = activeWizard.data.stack;
        const cwd = process.cwd();

        (async () => {
          // Write agents.md
          const agentsPath = path.resolve(cwd, "agents.md");
          const defaultContent = [
            `# Project Specifications (agents.md)`,
            ``,
            `This file contains key information about the project for AI agents to study and align with.`,
            ``,
            `## Project Overview`,
            `- **Name**: ${projectName}`,
            `- **Description**: ${projectDesc}`,
            `- **Technology Stack**: ${projectTech}`,
            ``,
            `## Coding Guidelines`,
            `- On Windows, statement separator for terminal commands is ';' instead of '&&'.`,
            `- Always verify compilation and run tests before committing.`,
            ``,
          ].join("\n");

          await fs.writeFile(agentsPath, defaultContent, "utf-8");
          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] 📄 Generated agents.md (created: ${projectName}, ${projectTech})`
          ].slice(-50));

          // Run audit/git setup summary
          const gitStatusLabel = activeWizard.data.gitStatus === "ACTIVE" ? "✓ ACTIVE" : activeWizard.data.gitStatus === "INITIALIZED" ? "✓ INITIALIZED (new)" : `✗ ${activeWizard.data.gitStatus}`;
          const modelName = process.env.MODEL || getDefaultModel();
          const limit = getContextWindowLimit(modelName);

          const auditLines = [
            "┌───[ ⚙️ SYSTEM AUDIT & AGENT INITIALIZATION ]",
            "│ ",
            "│ [HOST INFO]",
            `│ 🖥️ OS Platform   : ${process.platform}`,
            `│ 📦 Node Version   : ${process.version}`,
            `│ 📂 Workspace      : ${cwd}`,
            "│ ",
            "│ [VERSION CONTROL]",
            `│ 🔀 Git Status     : ${gitStatusLabel}`,
            ...(activeWizard.data.gitBranch ? [`│ 🌿 Branch         : ${activeWizard.data.gitBranch}`] : []),
            ...(activeWizard.data.gitSha ? [`│ 📌 HEAD           : ${activeWizard.data.gitSha}`] : []),
            "│ ",
            "│ [COGNITIVE CORE]",
            `│ ✦ Provider        : ${process.env.CUSTOM_BASE_URL ? "custom" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai"}`,
            `│ ✦ Active Model    : ${modelName}`,
            `│ ✦ Context Limit   : ${limit.toLocaleString()} tokens`,
            `│ ✦ Streaming       : ${process.env.DISABLE_STREAMING === "true" ? "DISABLED" : "ENABLED"}`,
            "│ ",
            "│ [PROJECT METADATA]",
            `│ 📄 Registry File  : CREATED (${agentsPath})`,
            `│ 📂 Project Name   : ${projectName}`,
            `│ 🛠️ Tech Stack      : ${projectTech}`,
            "│ ",
            "│ [SYSTEM TOOLS]",
            `│ 🛠️ Loaded Tools (${allTools.length}): ${allTools.map(t => t.name).join(", ")}`,
            "│ ",
            "└──────────────────────────────────────────────"
          ];
          setMasterLogs((prev) => [...prev, `[SYSTEM] ${auditLines.join("\n")}`].slice(-50));
        })().catch(err => {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to complete project initialization: ${err.message}`].slice(-50));
        });

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 13) {
        const goal = value.trim();
        if (!goal) {
          setMasterLogs((prev) => [...prev, `[ERROR] AI prompt cannot be empty. Initialization cancelled.`].slice(-50));
          setActiveWizard(null);
          return;
        }

        setMasterLogs((prev) => [...prev, `[SYSTEM] 🤖 Consulting AI to formulate project structure...`].slice(-50));
        setCurrentTask("Consulting AI for project structure...");

        (async () => {
          try {
            const prompt = `You are a software architect. Build a specifications file named 'agents.md' for this new project based on the user's goal: "${goal}".
Generate ONLY a raw markdown document that maps precisely to this structure:

# Project Specifications (agents.md)

## Project Overview
- **Name**: [a suitable name for the project]
- **Description**: [one-sentence clear description]
- **Technology Stack**: [a list of key libraries and language, e.g. TypeScript, React, Vite]

## Coding Guidelines
- On Windows, statement separator for terminal commands is ';' instead of '&&'.
- Always verify compilation and run tests before committing.
[Add 2-3 specific custom guidelines for the target stack if helpful]`;

            // Make direct completion request to active provider/model
            const { generateText } = await import("ai");
            const modelConfig = (agent as any).getModel();
            const response = await generateText({
              model: modelConfig,
              prompt: prompt,
            });

            const content = response.text || "";
            const cwd = process.cwd();
            const agentsPath = path.resolve(cwd, "agents.md");
            await fs.writeFile(agentsPath, content, "utf-8");
            setMasterLogs((prev) => [...prev, `[SYSTEM] 📄 Generated agents.md successfully!`].slice(-50));

            // Extract project details dynamically from AI generated content
            let projectName = path.basename(cwd);
            let projectTech = "Unknown";
            const nameMatch = content.match(/-\s*\*\*Name\*\*:\s*(.*)/i);
            if (nameMatch) projectName = nameMatch[1].trim();
            const techMatch = content.match(/-\s*\*\*Technology Stack\*\*:\s*(.*)/i);
            if (techMatch) projectTech = techMatch[1].trim();

            const gitStatusLabel = activeWizard.data.gitStatus === "ACTIVE" ? "✓ ACTIVE" : activeWizard.data.gitStatus === "INITIALIZED" ? "✓ INITIALIZED (new)" : `✗ ${activeWizard.data.gitStatus}`;
            const modelName = process.env.MODEL || getDefaultModel();
            const limit = getContextWindowLimit(modelName);

            const auditLines = [
              "┌───[ ⚙️ SYSTEM AUDIT & AGENT INITIALIZATION ]",
              "│ ",
              "│ [HOST INFO]",
              `│ 🖥️ OS Platform   : ${process.platform}`,
              `│ 📦 Node Version   : ${process.version}`,
              `│ 📂 Workspace      : ${cwd}`,
              "│ ",
              "│ [VERSION CONTROL]",
              `│ 🔀 Git Status     : ${gitStatusLabel}`,
              ...(activeWizard.data.gitBranch ? [`│ 🌿 Branch         : ${activeWizard.data.gitBranch}`] : []),
              ...(activeWizard.data.gitSha ? [`│ 📌 HEAD           : ${activeWizard.data.gitSha}`] : []),
              "│ ",
              "│ [COGNITIVE CORE]",
              `│ ✦ Provider        : ${process.env.CUSTOM_BASE_URL ? "custom" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai"}`,
              `│ ✦ Active Model    : ${modelName}`,
              `│ ✦ Context Limit   : ${limit.toLocaleString()} tokens`,
              `│ ✦ Streaming       : ${process.env.DISABLE_STREAMING === "true" ? "DISABLED" : "ENABLED"}`,
              "│ ",
              "│ [PROJECT METADATA]",
              `│ 📄 Registry File  : CREATED (${agentsPath})`,
              `│ 📂 Project Name   : ${projectName}`,
              `│ 🛠️ Tech Stack      : ${projectTech}`,
              "│ ",
              "│ [SYSTEM TOOLS]",
              `│ 🛠️ Loaded Tools (${allTools.length}): ${allTools.map(t => t.name).join(", ")}`,
              "│ ",
              "└──────────────────────────────────────────────"
            ];
            setMasterLogs((prev) => [...prev, `[SYSTEM] ${auditLines.join("\n")}`].slice(-50));
          } catch (aiErr: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] AI code completion request failed: ${aiErr.message}. Falling back to default project structure.`].slice(-50));
            
            // Fallback content write
            const cwd = process.cwd();
            const agentsPath = path.resolve(cwd, "agents.md");
            const fallbackContent = [
              `# Project Specifications (agents.md)`,
              ``,
              `## Project Overview`,
              `- **Name**: ${path.basename(cwd)}`,
              `- **Description**: A new software project.`,
              `- **Technology Stack**: Custom Stack`,
              ``,
              `## Coding Guidelines`,
              `- On Windows, statement separator for terminal commands is ';' instead of '&&'.`,
              `- Always verify compilation and run tests before committing.`,
            ].join("\n");
            await fs.writeFile(agentsPath, fallbackContent, "utf-8");
          } finally {
            setCurrentTask("Idle");
          }
        })();

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      }
    } else if (activeWizard.type === "model") {
      if (activeWizard.step === 1) {
        // Parse the provider TYPE from the option string format: "name (type - url) [Active]"
        // This is more reliable than keyword matching since profile names can be anything
        const typeMatch = value.match(/\(([^)]+)/);
        const rawType = typeMatch ? typeMatch[1].split("-")[0].trim().toLowerCase() : value.toLowerCase();
        let provider = "";
        if (rawType === "openrouter") {
          provider = "openrouter";
        } else if (rawType === "openai") {
          provider = "openai";
        } else if (rawType === "anthropic") {
          provider = "anthropic";
        } else if (rawType === "custom") {
          provider = "custom";
        } else {
          // Fallback: try the configured providers list to find the actual type
          const list = getConfiguredProviders();
          const cleanName = value.replace(/\s*\[Active\]\s*$/, "").split(" (")[0].trim();
          const found = list.find(p => p.name === cleanName);
          provider = found?.type || "openrouter";
        }

        setActiveWizard({
          type: "model",
          step: 2,
          data: { provider },
        });

        // Static fallback models per provider (shown while API fetch is in-flight)
        const initialModels: string[] =
          provider === "openrouter" ? [
            "google/gemini-2.5-flash",
            "meta-llama/llama-3.3-70b-instruct",
            "deepseek/deepseek-chat",
            "anthropic/claude-3.5-sonnet",
          ] :
          provider === "openai" ? [
            "gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "o1-preview", "o3-mini",
          ] :
          provider === "anthropic" ? [
            "claude-opus-4-5",
            "claude-sonnet-4-5",
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
            "claude-3-opus-20240229",
          ] :
          provider === "custom" ? [
            "deepseek-chat", "llama-3.3-70b-instruct",
          ] : [];

        setWizardAllOptions(initialModels);
        setWizardOptions([]);  // not used for model step 2 — filtering done at render time
        setWizardSelectedIndex(0);
        setQuery("");  // clear main input so user can type to search (same as single agent)

        if (provider === "openrouter") {
          setWizardIsLoadingModels(true);
          fetch("https://openrouter.ai/api/v1/models")
            .then(async (res) => {
              if (res.ok) {
                const data = await res.json() as any;
                if (data && Array.isArray(data.data)) {
                  const modelsList: string[] = data.data.map((m: any) => m.id);
                  setWizardAllOptions(modelsList);
                }
              }
            })
            .catch(() => {})
            .finally(() => setWizardIsLoadingModels(false));
        } else if (provider === "openai") {
          const apiKey = process.env.OPENAI_API_KEY || process.env.CUSTOM_API_KEY;
          if (apiKey) {
            setWizardIsLoadingModels(true);
            fetch("https://api.openai.com/v1/models", {
              headers: { Authorization: `Bearer ${apiKey}` }
            })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList: string[] = data.data.map((m: any) => m.id);
                    setWizardAllOptions(modelsList);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        } else if (provider === "custom") {
          const baseUrl = process.env.CUSTOM_BASE_URL;
          const apiKey = process.env.CUSTOM_API_KEY || process.env.OPENAI_API_KEY;
          if (baseUrl) {
            setWizardIsLoadingModels(true);
            const headers: Record<string, string> = {};
            if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
            fetch(`${baseUrl}/models`, { headers })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList: string[] = data.data.map((m: any) => m.id);
                    setWizardAllOptions(modelsList);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        }

        setMasterLogs((prev) => [...prev, `[MASTER] Provider ${provider} selected. Choose a model below:`].slice(-50));
      } else {
        const modelName = value;
        try {
          const envPath = updateEnvFile({ MODEL: modelName });
          const limit = getContextWindowLimit(modelName);
          setMasterLogs((prev) => [
            ...prev,
            `[MASTER] Model successfully changed to: ${modelName}`,
            `[MASTER] Context Limit: ${limit.toLocaleString()} tokens`,
            `[MASTER] Saved to: ${envPath}`
          ].slice(-50));
          fetchAndCacheModels().catch(() => {});
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to set model: ${err.message}`].slice(-50));
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardAllOptions([]);
        setWizardIsLoadingModels(false);
        setQuery("");
      }
    } else if (activeWizard.type === "resume") {
      const chosen = cachedSessions[wizardSelectedIndex];
      if (!chosen) return;
      try {
        await agent.loadHistoryFromPath(chosen.filePath);
        const msgs = agent.getHistory().getMessages();
        const loadedLogs: string[] = [];
        for (const m of msgs) {
          if (m.role === "user") {
            loadedLogs.push(`[USER] ${m.content}`);
          } else if (m.role === "assistant") {
            if (m.content) {
              loadedLogs.push(`[AGENT] ${m.content}`);
            }
          }
        }
        setMasterLogs(loadedLogs.slice(-50));
        setMasterLogs((prev) => [...prev, `[MASTER] Successfully resumed session: ${chosen.displayName}`].slice(-50));
      } catch (err: any) {
        setMasterLogs((prev) => [...prev, `[ERROR] Failed to resume session: ${err.message}`].slice(-50));
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    } else if (activeWizard.type === "skills") {
      if (activeWizard.step === 1) {
        setActiveWizard({
          type: "skills",
          step: 2,
          data: { skillIndex: String(wizardSelectedIndex) },
        });
        setWizardOptions([
          "✓ Use / Activate Skill",
          "ℹ View Details",
          "← Back to List",
        ]);
        setWizardSelectedIndex(0);
      } else {
        const skillIndex = parseInt(activeWizard.data.skillIndex || "0", 10);
        const skillsList = getInstalledSkills();
        const chosen = skillsList[skillIndex];
        if (!chosen) return;

        if (wizardSelectedIndex === 0) {
          // Use / Activate Skill
          const slug = chosen.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
          setMasterLogs((prev) => [...prev, `[USER] /skill-${slug}`, `[MASTER] Activating skill "${chosen.name}"...\nInstruction path: ${chosen.path}`].slice(-50));
          agent.sendMessage(
            `I would like you to use the following skill: "${chosen.name}".\nPlease read its instruction file at "${chosen.path}" using a file read tool first, and then help me with my request based on its instructions.`
          ).catch((err: any) => {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to send message: ${err.message}`].slice(-50));
          });
        } else if (wizardSelectedIndex === 1) {
          // View Details
          setMasterLogs((prev) => [
            ...prev,
            `[MASTER] Skill Details: ${chosen.name}`,
            `[MASTER] Description: ${chosen.description}`,
            `[MASTER] Path: ${chosen.path}`
          ].slice(-50));
        }

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      }
    } else if (activeWizard.type === "checkpoint") {
      if (activeWizard.step === 1) {
        const chosen = checkpointsList[wizardSelectedIndex];
        if (!chosen) return;

        if (chosen.gitSha) {
          setActiveWizard({ type: "checkpoint", step: 2, data: { checkpointIndex: String(wizardSelectedIndex) } });
          setWizardOptions(["✓ Ya, pulihkan workspace ke commit ini (git stash & checkout)", "✗ Tidak, hanya pulihkan riwayat percakapan saja"]);
          setWizardSelectedIndex(0);
          return;
        }

        const sessionPath = agent.getCurrentHistoryFilePath();
        if (!sessionPath) return;
        const checkpointsDir = path.join(path.dirname(sessionPath), "checkpoints");
        const chkPath = path.join(checkpointsDir, `checkpoint_${chosen.timestamp}.json`);

        restoreCheckpoint(chkPath, sessionPath)
          .then(async () => {
            await agent.loadHistoryFromPath(sessionPath);
            const msgs = agent.getHistory().getMessages();
            const loadedLogs: string[] = [];
            for (const m of msgs) {
              if (m.role === "user") loadedLogs.push(`[USER] ${m.content}`);
              else if (m.role === "assistant" && m.content) loadedLogs.push(`[AGENT] ${m.content}`);
            }
            setMasterLogs(loadedLogs.slice(-50));
            setMasterLogs((prev) => [...prev, `[MASTER] Checkpoint "${chosen.name}" successfully restored! (${chosen.messages.length} messages)`].slice(-50));
          })
          .catch((err: any) => {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to restore checkpoint: ${err.message}`].slice(-50));
          });

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setCheckpointsList([]);
      } else if (activeWizard.step === 2) {
        const chkIndex = parseInt(activeWizard.data.checkpointIndex || "0", 10);
        const chosen = checkpointsList[chkIndex];
        if (!chosen) return;
        const doGitRestore = wizardSelectedIndex === 0;
        const sessionPath = agent.getCurrentHistoryFilePath();
        if (!sessionPath) return;

        const checkpointsDir = path.join(path.dirname(sessionPath), "checkpoints");
        const chkPath = path.join(checkpointsDir, `checkpoint_${chosen.timestamp}.json`);

        (async () => {
          try {
            if (doGitRestore && chosen.gitSha) {
              try {
                const { execa: execaFn } = await import("execa");
                const targetCwd = agent.workingDirectory || process.cwd();
                await execaFn("git", ["stash", "--include-untracked"], { cwd: targetCwd, reject: false });
                const checkoutRes = await execaFn("git", ["checkout", chosen.gitSha], { cwd: targetCwd, reject: false });
                if (checkoutRes.failed) {
                  setMasterLogs((prev) => [...prev, `[ERROR] Git restore failed: ${checkoutRes.stderr || checkoutRes.message}. Conversation history restored anyway.`].slice(-50));
                } else {
                  setMasterLogs((prev) => [...prev, `[MASTER] Workspace restored to Git commit: ${chosen.gitSha}`].slice(-50));
                }
              } catch (gitErr: any) {
                setMasterLogs((prev) => [...prev, `[ERROR] Git restore error: ${gitErr.message}. Conversation history restored anyway.`].slice(-50));
              }
            }

            await restoreCheckpoint(chkPath, sessionPath);
            await agent.loadHistoryFromPath(sessionPath);
            const msgs = agent.getHistory().getMessages();
            const loadedLogs: string[] = [];
            for (const m of msgs) {
              if (m.role === "user") loadedLogs.push(`[USER] ${m.content}`);
              else if (m.role === "assistant" && m.content) loadedLogs.push(`[AGENT] ${m.content}`);
            }
            setMasterLogs(loadedLogs.slice(-50));
            setMasterLogs((prev) => [...prev, `[MASTER] Checkpoint "${chosen.name}" successfully restored! (${chosen.messages.length} messages)`].slice(-50));
          } catch (err: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to restore checkpoint: ${err.message}`].slice(-50));
          }
        })();

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setCheckpointsList([]);
      }
    } else if (activeWizard.type === "question") {
      if (activeWizard.step === 1) {
        const selectedOption = value;
        if (selectedOption === "Custom...") {
          setActiveWizard({
            type: "question",
            step: 2,
            data: { question: pendingQuestion?.question || "" },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        if (pendingQuestion) {
          pendingQuestion.resolve(selectedOption);
          setMasterLogs((prev) => [...prev, `[MASTER] ❓ Answered: "${selectedOption}"`].slice(-50));
        }
      } else {
        if (pendingQuestion) {
          pendingQuestion.resolve(value);
          setMasterLogs((prev) => [...prev, `[MASTER] ❓ Answered: "${value}"`].slice(-50));
        }
      }

      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setWizardSelectedSet(new Set());
      setPendingQuestion(null);
    }
  };

  const handleQuerySubmit = (val: string) => {
    const cleanVal = val.trim();

    if (activeWizard) {
      if (activeWizard.type === "question" && activeWizard.isMultiSelect) {
        const selectedList = Array.from(wizardSelectedSet).map(idx => wizardOptions[idx]).filter(Boolean);
        const answer = selectedList.join(", ");
        if (pendingQuestion) {
          pendingQuestion.resolve(answer);
          setMasterLogs((prev) => [...prev, `[MASTER] ❓ Answered: "${answer}"`].slice(-50));
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardSelectedSet(new Set());
        setPendingQuestion(null);
        setQuery("");
        return;
      }

      // Special case: model step 2 uses wizardAllOptions (filtered by query) instead of wizardOptions
      // because wizardOptions is intentionally set to [] for step 2 (filtering done at render time)
      let finalValue: string;
      if (activeWizard.type === "model" && activeWizard.step === 2) {
        const lc = query.trim().toLowerCase();
        const filteredModels = lc
          ? wizardAllOptions.filter(m => m.toLowerCase().includes(lc))
          : wizardAllOptions;
        const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredModels.length - 1));
        finalValue = filteredModels[clampedIndex] || cleanVal;
      } else {
        const hasOptions = wizardOptions.length > 0;
        finalValue = hasOptions && wizardSelectedIndex >= 0 && wizardSelectedIndex < wizardOptions.length
          ? wizardOptions[wizardSelectedIndex]
          : cleanVal;
      }

      handleWizardSubmit(finalValue);
      setQuery("");
      return;
    }

    if (!cleanVal) return;

    // Save to history (in-memory + disk)
    setHistory((prev) => {
      if (prev.length > 0 && prev[prev.length - 1] === cleanVal) {
        return prev;
      }
      const next = [...prev, cleanVal].slice(-200); // keep last 200 entries
      // Persist to disk asynchronously (best-effort)
      fs.writeFile(HISTORY_FILE, JSON.stringify(next, null, 2), "utf8").catch(() => {});
      return next;
    });
    setHistoryIndex(-1);


    const commandInput = cleanVal.startsWith("!") ? `/terminal ${cleanVal.slice(1).trim()}` : cleanVal;

    if (commandInput.startsWith("/")) {
      if (commandInput.toLowerCase().startsWith("/goal")) {
        setMasterLogs((prev) => [...prev, `[USER] ${commandInput}`, `[ERROR] /goal command is disabled in Multi-Agent Dashboard.`].slice(-50));
        setQuery("");
        return;
      }

      if (commandInput.toLowerCase().startsWith("/checkpoint")) {
        const sessionFilePath = agent.getCurrentHistoryFilePath();
        listCheckpointsForSession(sessionFilePath)
          .then((list) => {
            setCheckpointsList(list);
          })
          .catch(() => {});
      }

      handleSlashCommand(commandInput, {
        addLine: (line) => setMasterLogs((prev) => [...prev, `[${line.type.toUpperCase()}] ${line.content}`].slice(-50)),
        exit,
        agent,
        clearLines: () => setMasterLogs([]),
        setContextLimit: () => {},
        setActiveWizard: (val) => {
          if (val && val.type === "goal") return;
          setActiveWizard(val);
          if (val && val.type === "resume") {
            setCachedSessions(listHistorySessions(true));
          }
        },
        setWizardOptions,
        setWizardSelectedIndex,
        setPlanState: () => {},
        setGoalMode: () => {},
        setIsProcessing: () => {},
        resumeSession: async () => {}
      });
      setQuery("");
      return;
    }

    setMasterLogs((prev) => [...prev, `[USER] ${commandInput}`].slice(-50));
    setQuery("");
    setCurrentTask(commandInput);

    agent.sendMessage(commandInput)
      .then(() => {
        setCurrentTask(`Idle - Completed: ${commandInput}`);
      })
      .catch((err) => {
        setCurrentTask(`Error: ${err.message || err}`);
        setMasterLogs((prev) => [...prev, `[ERROR] ${err.message || err}`].slice(-50));
      });
  };

  // Update sessions list from live state
  useEffect(() => {
    const update = () => {
      const list: AgentSession[] = [];

      // 1. Master Orchestrator — real token accumulation from all events
      const superagentTokens = [...superagentInstances.values()]
        .reduce((acc, i) => acc + (i.tokenUsage?.prompt ?? 0) + (i.tokenUsage?.completion ?? 0), 0);
      const subagentTokens = [...subagentInstances.values()]
        .reduce((acc, i) => acc + (i.tokenUsage?.prompt ?? 0) + (i.tokenUsage?.completion ?? 0), 0);

      list.push({
        id: "master-orchestrator",
        type: "MASTER",
        task: currentTask,
        status: currentTask.startsWith("Idle") ? "IDLE" : currentTask.startsWith("Error") ? "ERROR" : "WORKING",
        tokens: superagentTokens + subagentTokens,
        logs: masterLogs,
        branch: gitBranch,
      });

      // 2. Superagent instances (depth 1 — feature developers in worktrees)
      for (const [id, instance] of superagentInstances.entries()) {
        list.push({
          id: `sa-${instance.role}-${id}`,
          type: "SUPERAGENT",
          task: `[${instance.role}] ${instance.task.slice(0, 60)}`,
          status: instance.status === "running" ? "WORKING"
                : instance.status === "completed" ? "COMPLETED"
                : "ERROR",
          tokens: (instance.tokenUsage?.prompt ?? 0) + (instance.tokenUsage?.completion ?? 0),
          logs: instance.logs.length > 0 ? instance.logs : ["Superagent initialising..."],
          branch: instance.branch,
          worktreePath: instance.worktreePath,
        });
      }

      // 3. Subagent instances (depth 2 — specialized workers)
      for (const [id, instance] of subagentInstances.entries()) {
        list.push({
          id: `${instance.typeName}-${id}`,
          type: "SUBAGENT",
          task: `Role: ${instance.role}`,
          status: instance.status === "running" ? "WORKING" : instance.status === "completed" ? "COMPLETED" : "IDLE",
          tokens: (instance.tokenUsage?.prompt ?? 0) + (instance.tokenUsage?.completion ?? 0),
          logs: instance.logs && instance.logs.length > 0 ? instance.logs : ["Awaiting output..."],
          branch: "worktree",
        });
      }

      // 4. Active background tasks
      for (const [id, task] of backgroundTasks.entries()) {
        list.push({
          id: `task-${id}`,
          type: "TASK",
          task: `Command: ${task.command}`,
          status: task.hasExited ? (task.exitCode === 0 ? "COMPLETED" : "ERROR") : "WORKING",
          tokens: 0,
          logs: task.output && task.output.length > 0 ? task.output : ["Running task..."],
          branch: "main",
        });
      }

      setSessions(list);
    };

    update();

    const unsubSubagents = subscribeToSubagents(update);
    const unsubSuperagents = subscribeToSuperagents(update);
    const unsubTasks = subscribeToTasks(update);

    return () => {
      unsubSubagents();
      unsubSuperagents();
      unsubTasks();
    };
  }, [masterLogs, currentTask, gitBranch]);

  const [logScrollOffset, setLogScrollOffset] = useState(0);

  // Reset scroll offset when switching sessions
  useEffect(() => {
    setLogScrollOffset(0);
  }, [selectedIndex]);

  // Adjust selection bounds when sessions length changes
  useEffect(() => {
    if (selectedIndex >= sessions.length && sessions.length > 0) {
      setSelectedIndex(sessions.length - 1);
    }
  }, [sessions.length, selectedIndex]);

  const selectedSession = sessions[selectedIndex] || {
    id: "N/A",
    type: "MASTER",
    task: "No session active",
    status: "IDLE",
    tokens: 0,
    logs: ["No logs available."],
    branch: "N/A",
  };

  const workspaceHeight = Math.max(10, terminalSize.height - 10);
  const leftTopHeight = Math.max(5, workspaceHeight - 7);
  const logBoxHeight = Math.max(5, workspaceHeight - 4);
  const showCursor = selectedSession.status === "WORKING" && logScrollOffset === 0;
  const logsCount = showCursor ? Math.max(1, logBoxHeight - 1) : logBoxHeight;

  const feedWidth = Math.max(10, Math.floor(terminalSize.width * 0.58) - 4);
  const wrappedLines: React.ReactNode[] = [];

  const activeLogs = selectedSession.logs.map(l => l.trim()).filter(Boolean);


  for (let logIdx = 0; logIdx < activeLogs.length; logIdx++) {
    const logStr = activeLogs[logIdx];

    // Check if it's a box line (e.g. from subagents)
    const isBoxLine = /^[┌├│└─]/.test(logStr);

    if (isBoxLine) {
      // For box lines, render directly without any label or border wrapping
      const subLines = wrapTextForDisplay(logStr, feedWidth);
      for (let i = 0; i < subLines.length; i++) {
        const lineText = subLines[i];
        wrappedLines.push(
          <Box flexDirection="row" key={`log-line-${logIdx}-${i}`} width={feedWidth}>
            <Text color={selectedSession.type === "SUBAGENT" ? "green" : "gray"}>{lineText}</Text>
          </Box>
        );
      }
      continue;
    }

    let label = "INFO";
    let content = logStr;
    let color = "green";
    let isBold = false;
    let dimColor = false;
    let parseMarkdown = false;

    if (logStr.startsWith("[USER]")) {
      label = "👤 USER";
      content = logStr.replace("[USER]", "").trim();
      color = "cyan";
      isBold = true;
    } else if (logStr.startsWith("[MASTER]")) {
      label = "🤖 SYSTEM";
      content = logStr.replace("[MASTER]", "").trim();
      color = "yellow";
      dimColor = true;
    } else if (logStr.startsWith("[AGENT]")) {
      label = "🧠 AGENT";
      content = logStr.replace("[AGENT]", "").trim();
      color = "white";
      isBold = false;
      parseMarkdown = true;
    } else if (logStr.startsWith("[TOOL START]")) {
      label = "🔧 TOOL START";
      content = logStr.replace("[TOOL START]", "").trim();
      color = "magenta";
    } else if (logStr.startsWith("[TOOL END]")) {
      label = "✅ TOOL DONE";
      content = logStr.replace("[TOOL END]", "").trim();
      color = "gray";
    } else if (logStr.startsWith("[ERROR]")) {
      label = "🚨 ERROR";
      content = logStr.replace("[ERROR]", "").trim();
      color = "red";
      isBold = true;
    } else if (logStr.startsWith("[AUTO-APPROVE]")) {
      label = "⚙️ AUTO-APPROVE";
      content = logStr.replace("[AUTO-APPROVE]", "").trim();
      color = "blue";
      dimColor = true;
    } else if (logStr.startsWith("[QUESTION]")) {
      label = "❓ QUESTION";
      content = logStr.replace("[QUESTION]", "").trim();
      color = "magenta";
    } else if (logStr.startsWith("[THINK]")) {
      label = "🧠 THINK";
      content = logStr.replace("[THINK]", "").trim();
      color = "magenta";
      dimColor = true;
      parseMarkdown = true;
    } else if (logStr.startsWith("[TOOL:START]")) {
      label = "🔧 TOOL START";
      content = logStr.replace("[TOOL:START]", "").trim();
      color = "cyan";
    } else if (logStr.startsWith("[TOOL:OK]")) {
      label = "✅ TOOL OK";
      content = logStr.replace("[TOOL:OK]", "").trim();
      color = "gray";
      dimColor = true;
    } else if (logStr.startsWith("[TOOL:FAIL]")) {
      label = "🚨 TOOL FAIL";
      content = logStr.replace("[TOOL:FAIL]", "").trim();
      color = "red";
      isBold = true;
    }

    const prefix = logIdx === 0 ? "┌───" : (logIdx === activeLogs.length - 1 ? "└───" : "├───");
    const subLinePrefix = logIdx === activeLogs.length - 1 ? "    " : "│   ";

    // Format header border line
    wrappedLines.push(
      <Box flexDirection="row" key={`log-header-${logIdx}`} width={feedWidth}>
        <Text color={color === "gray" ? "gray" : color} bold>
          {prefix} <Text color="white" bold>[ </Text>
          <Text color={color === "gray" ? "gray" : color} bold>{label}</Text>
          <Text color="white" bold> ]</Text>
        </Text>
      </Box>
    );

    // Format content lines
    // We indent with the subLinePrefix (4 chars: "│   " or "    ")
    const subLines = wrapTextForDisplay(content, Math.max(10, feedWidth - 4));
    let inCode = false;

    for (let i = 0; i < subLines.length; i++) {
      const lineText = subLines[i];
      const trimmed = lineText.trim();

      if (parseMarkdown) {
        // Code Block detection
        if (trimmed.startsWith("```")) {
          inCode = !inCode;
          const codeLang = trimmed.slice(3).trim() || "TEXT";
          wrappedLines.push(
            <Box flexDirection="row" key={`log-line-${logIdx}-${i}`} width={feedWidth}>
              <Text color={color === "gray" ? "gray" : color} dimColor={dimColor}>{subLinePrefix}</Text>
              <Text color="gray" italic>{inCode ? `┌─── [ CODE: ${codeLang} ]` : "└─── [ END CODE ]"}</Text>
            </Box>
          );
          continue;
        }

        if (inCode) {
          wrappedLines.push(
            <Box flexDirection="row" key={`log-line-${logIdx}-${i}`} width={feedWidth}>
              <Text color={color === "gray" ? "gray" : color} dimColor={dimColor}>{subLinePrefix}</Text>
              <Text color="green">{lineText}</Text>
            </Box>
          );
          continue;
        }

        // Header lines
        if (trimmed.startsWith("# ")) {
          wrappedLines.push(
            <Box flexDirection="row" key={`log-line-${logIdx}-${i}`} width={feedWidth}>
              <Text color={color === "gray" ? "gray" : color} dimColor={dimColor}>{subLinePrefix}</Text>
              <Text bold color="yellow">{lineText.slice(2)}</Text>
            </Box>
          );
          continue;
        }
        if (trimmed.startsWith("## ")) {
          wrappedLines.push(
            <Box flexDirection="row" key={`log-line-${logIdx}-${i}`} width={feedWidth}>
              <Text color={color === "gray" ? "gray" : color} dimColor={dimColor}>{subLinePrefix}</Text>
              <Text bold color="cyan">{lineText.slice(3)}</Text>
            </Box>
          );
          continue;
        }
        if (trimmed.startsWith("### ")) {
          wrappedLines.push(
            <Box flexDirection="row" key={`log-line-${logIdx}-${i}`} width={feedWidth}>
              <Text color={color === "gray" ? "gray" : color} dimColor={dimColor}>{subLinePrefix}</Text>
              <Text bold color="blue">{lineText.slice(4)}</Text>
            </Box>
          );
          continue;
        }

        // List item checking
        let listPrefix = "";
        let remainingLine = lineText;
        if (trimmed.startsWith("- ")) {
          const indent = lineText.indexOf("- ");
          listPrefix = " ".repeat(indent) + "• ";
          remainingLine = lineText.slice(indent + 2);
        } else if (trimmed.startsWith("* ")) {
          const indent = lineText.indexOf("* ");
          listPrefix = " ".repeat(indent) + "• ";
          remainingLine = lineText.slice(indent + 2);
        } else if (/^\d+\.\s/.test(trimmed)) {
          const match = lineText.match(/^(\s*)(\d+\.\s)(.*)/);
          if (match) {
            listPrefix = match[1] + match[2];
            remainingLine = match[3];
          }
        }

        wrappedLines.push(
          <Box flexDirection="row" key={`log-line-${logIdx}-${i}`} width={feedWidth}>
            <Text color={color === "gray" ? "gray" : color} dimColor={dimColor}>{subLinePrefix}</Text>
            {listPrefix ? <Text color="magenta" bold>{listPrefix}</Text> : null}
            <Box flexShrink={1}>
              {renderLogInlineStyles(remainingLine, color === "gray" ? "gray" : color, isBold, dimColor)}
            </Box>
          </Box>
        );
      } else {
        // Plain text or standard rendering without full markdown parsing
        wrappedLines.push(
          <Box flexDirection="row" key={`log-line-${logIdx}-${i}`} width={feedWidth}>
            <Text color={color === "gray" ? "gray" : color} dimColor={dimColor}>{subLinePrefix}</Text>
            <Text color={color === "gray" ? "gray" : color} bold={isBold} dimColor={dimColor} wrap="truncate-end">{lineText}</Text>
          </Box>
        );
      }
    }

    // Add empty space/separator line between logs if it's not the last one
    if (logIdx < activeLogs.length - 1) {
      wrappedLines.push(
        <Box flexDirection="row" key={`log-sep-${logIdx}`}>
          <Text color={color === "gray" ? "gray" : color} dimColor={dimColor}>{subLinePrefix}</Text>
        </Box>
      );
    }
  }

  const endIdxLogs = Math.max(0, wrappedLines.length - logScrollOffset);
  const startIdxLogs = Math.max(0, endIdxLogs - logsCount);
  const visibleLogs = wrappedLines.slice(startIdxLogs, endIdxLogs);

  useEffect(() => {
    const enableMouseTracking = "\x1b[?1000h\x1b[?1006h";
    const disableMouseTracking = "\x1b[?1006l\x1b[?1000l";

    const handleMouseInput = (data: Buffer) => {
      const text = data.toString("utf8");
      const matches = text.matchAll(/\x1b\[<(?<btn>\d+);(?<col>\d+);(?<row>\d+)(?<action>[Mm])/g);

      for (const match of matches) {
        const btn = match.groups?.btn;
        const colStr = match.groups?.col;
        const rowStr = match.groups?.row;
        const action = match.groups?.action;

        if (btn === "64") {
          // Wheel Up
          setLogScrollOffset((prev) => {
            const maxScroll = Math.max(0, wrappedLines.length - logsCount);
            return Math.min(prev + 1, maxScroll);
          });
        } else if (btn === "65") {
          // Wheel Down
          setLogScrollOffset((prev) => Math.max(0, prev - 1));
        } else if (btn === "0" && action === "M" && colStr && rowStr) {
          // Left click press
          const x = parseInt(colStr, 10);
          const y = parseInt(rowStr, 10);
          const leftLimit = Math.floor(terminalSize.width * 0.40);
          const rightStart = Math.floor(terminalSize.width * 0.42);

          if (x <= leftLimit) {
            if (activeWizard) {
              setFocusArea("input");

              // Handle wizard option clicking
              let options = wizardOptions;
              let maxVisible = 5;
              if (activeWizard.type === "model" && activeWizard.step === 2) {
                const lc = query.trim().toLowerCase();
                options = lc
                  ? wizardAllOptions.filter(m => m.toLowerCase().includes(lc))
                  : wizardAllOptions;
                maxVisible = 8;
              }

              const total = options.length;
              if (total > 0) {
                let start = 0;
                if (total > maxVisible) {
                  start = Math.max(0, wizardSelectedIndex - Math.floor(maxVisible / 2));
                  const end = start + maxVisible;
                  if (end > total) {
                    start = Math.max(0, total - maxVisible);
                  }
                }
                const visibleCount = Math.min(total, maxVisible);
                const y_bottom = 6 + workspaceHeight;
                const optStartRow = y_bottom - 2 - visibleCount;
                const optEndRow = y_bottom - 3;

                if (y >= optStartRow && y <= optEndRow) {
                  const idx = y - optStartRow;
                  const targetIndex = start + idx;
                  if (
                    targetIndex >= 0 &&
                    targetIndex < total &&
                    options[targetIndex] !== "(no results — try different search)"
                  ) {
                    if (activeWizard.isMultiSelect) {
                      setWizardSelectedSet((prev) => {
                        const next = new Set(prev);
                        if (next.has(targetIndex)) {
                          next.delete(targetIndex);
                        } else {
                          next.add(targetIndex);
                        }
                        return next;
                      });
                    } else {
                      setWizardSelectedIndex(targetIndex);
                      const selectedOption = options[targetIndex];
                      if (selectedOption === "Custom...") {
                        setActiveWizard({
                          type: "question",
                          step: 2,
                          data: { question: pendingQuestion?.question || "" },
                        });
                        setWizardOptions([]);
                        setWizardSelectedIndex(0);
                        setQuery("");
                      } else {
                        handleWizardSubmit(selectedOption);
                      }
                    }
                  }
                }
              }
            } else {
              const promptStartRow = 3 + workspaceHeight - 2;
              if (y >= promptStartRow) {
                setFocusArea("input");
              } else {
                setFocusArea("list");
              }
            }
          } else if (x >= rightStart) {
            setFocusArea("logs");
          }
        }
      }
    };

    process.stdout.write(enableMouseTracking);
    process.stdin.on("data", handleMouseInput);

    return () => {
      process.stdin.off("data", handleMouseInput);
      process.stdout.write(disableMouseTracking);
    };
  }, [
    wrappedLines.length,
    logsCount,
    terminalSize.width,
    terminalSize.height,
    activeWizard,
    wizardOptions,
    wizardSelectedIndex,
    pendingQuestion,
    handleWizardSubmit,
    query,
    wizardAllOptions,
    workspaceHeight,
  ]);

  const stopAllRunningAgents = () => {
    let count = 0;
    
    // Abort running subagents
    for (const inst of subagentInstances.values()) {
      if (inst.status === "running") {
        try {
          inst.agent.abort();
        } catch {}
        inst.status = "completed";
        inst.result = "[Cancelled by user (Ctrl+C)]";
        count++;
      }
    }
    
    // Abort running superagents
    for (const inst of superagentInstances.values()) {
      if (inst.status === "running") {
        try {
          inst.agent.abort();
        } catch {}
        superagentInstances.set(inst.id, {
          ...inst,
          status: "error",
          result: "[Cancelled by user (Ctrl+C)]",
          completedAt: Date.now()
        });
        count++;
      }
    }
    
    // Abort master agent
    if (agent) {
      try {
        agent.abort();
      } catch {}
    }

    if (count > 0) {
      notifySubagentsChanged();
      notifySuperagentsChanged();
      setMasterLogs((prev) => [...prev, `[SYSTEM] 🛑 Interrupted ${count} running agent(s) via Ctrl+C.`].slice(-50));
    }
    return count;
  };

  // Handle user inputs
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (stopAllRunningAgents() > 0) {
        setCurrentTask("Idle - Interrupted");
        return;
      }
      exit();
      return;
    }

    if (focusArea === "input" && !activeWizard) {
      if (key.escape) {
        setQuery("");
        setHistoryIndex(-1);
        setLogScrollOffset(0);
        return;
      }

      if (key.upArrow && history.length > 0) {
        let newIndex = historyIndex;
        if (historyIndex === -1) {
          setTempInput(query);
          newIndex = history.length - 1;
        } else if (historyIndex > 0) {
          newIndex = historyIndex - 1;
        }
        setHistoryIndex(newIndex);
        setQuery(history[newIndex]);
        return;
      }

      if (key.downArrow) {
        if (historyIndex !== -1) {
          if (historyIndex === history.length - 1) {
            setHistoryIndex(-1);
            setQuery(tempInput);
          } else {
            const newIndex = historyIndex + 1;
            setHistoryIndex(newIndex);
            setQuery(history[newIndex]);
          }
        }
        return;
      }
    }

    if (activeWizard) {
      if (key.upArrow) {
        setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        // For model step 2: navigate within filtered results based on current query
        if (activeWizard.type === "model" && activeWizard.step === 2) {
          const lc = query.toLowerCase();
          const len = lc
            ? wizardAllOptions.filter(m => m.toLowerCase().includes(lc)).length
            : wizardAllOptions.length;
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, len - 1), prev + 1));
        } else {
          setWizardSelectedIndex((prev) => Math.min(wizardOptions.length - 1, prev + 1));
        }
        return;
      }
      if (activeWizard.isMultiSelect && input === " ") {
        setWizardSelectedSet((prev) => {
          const next = new Set(prev);
          if (next.has(wizardSelectedIndex)) {
            next.delete(wizardSelectedIndex);
          } else {
            next.add(wizardSelectedIndex);
          }
          return next;
        });
        return;
      }
      if (key.escape) {
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardSelectedSet(new Set());
        setWizardAllOptions([]);
        setWizardIsLoadingModels(false);
        setQuery("");
        if (pendingQuestion) {
          pendingQuestion.resolve("");
          setPendingQuestion(null);
        }
        return;
      }
    } // end if (activeWizard)

    if (key.tab) {
      if (focusArea === "input" && query.startsWith("/")) {
        if (suggestions.length > 0) {
          const currentMatchIndex = suggestions.indexOf(query);
          let nextIndex = 0;
          if (currentMatchIndex !== -1) {
            nextIndex = (currentMatchIndex + 1) % suggestions.length;
          }
          setQuery(suggestions[nextIndex]);
          return;
        }
      }
      
      if (focusArea === "input") {
        setFocusArea("list");
      } else if (focusArea === "list") {
        setFocusArea("logs");
      } else {
        setFocusArea("input");
      }
      return;
    }

    if (focusArea === "list") {
      if (key.upArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, sessions.length - 1)));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => (prev < sessions.length - 1 ? prev + 1 : 0));
      } else if (key.return) {
        setFocusArea("logs");
      } else if (input >= "1" && input <= "9") {
        const targetIndex = parseInt(input, 10) - 1;
        if (targetIndex < sessions.length) {
          setSelectedIndex(targetIndex);
        }
      }
    } else if (focusArea === "logs") {
      if (key.upArrow) {
        setLogScrollOffset((prev) => {
          const maxScroll = Math.max(0, wrappedLines.length - logsCount);
          return Math.min(prev + 1, maxScroll);
        });
      } else if (key.downArrow) {
        setLogScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.escape) {
        setLogScrollOffset(0);
        setFocusArea("list");
      }
    }
  });

  const renderStatusBadge = (status: AgentSession["status"]) => {
    if (status === "WORKING") return <Text color="black" backgroundColor="yellow" bold> ACTIVE </Text>;
    if (status === "COMPLETED") return <Text color="black" backgroundColor="green" bold> DONE </Text>;
    if (status === "ERROR") return <Text color="black" backgroundColor="red" bold> FAIL </Text>;
    return <Text color="black" backgroundColor="gray" bold> IDLE </Text>;
  };

  // Tier prefix icons for hierarchy tree display
  const tierIcon: Record<AgentSession["type"], string> = {
    MASTER:     "◉",
    SUPERAGENT: " ▶",
    SUBAGENT:   "   ·",
    TASK:       " ⚙",
  };

  // Tier colors
  const tierColor: Record<AgentSession["type"], string> = {
    MASTER:     "magenta",
    SUPERAGENT: "cyan",
    SUBAGENT:   "yellow",
    TASK:       "gray",
  };

  const maxVisibleSessions = Math.max(3, leftTopHeight - 3);
  let startIdx = 0;
  if (selectedIndex >= maxVisibleSessions) {
    startIdx = selectedIndex - maxVisibleSessions + 1;
  }
  const visibleSessions = sessions.slice(startIdx, startIdx + maxVisibleSessions);

  const activeWTs = [...superagentInstances.values()]
    .filter((i) => i.status === "running")
    .map((i) => i.branch);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0} width={terminalSize.width} height={terminalSize.height}>
      {/* Header Banner - High Tech Cyberpunk Style */}
      <Box flexDirection="row" justifyContent="space-between" paddingX={0} marginBottom={2} alignItems="center">
        <Box flexDirection="row" alignItems="center">
          {/* Mascot Column - Simple Garuda Mascot (Yellow/Gold) */}
          <Box flexDirection="column" marginRight={3} alignItems="center">
            <Box flexDirection="row">
              <Text color="yellow" bold> ◥█◣  ▲  ◢█◤ </Text>
            </Box>
            <Box flexDirection="row">
              <Text color="yellow" bold>  ◥██ █ ██◤  </Text>
            </Box>
            <Box flexDirection="row">
              <Text color="yellow" bold>   ◥█████◤   </Text>
            </Box>
            <Box flexDirection="row">
              <Text color="yellow" bold>     ◥█◤     </Text>
            </Box>
          </Box>

          {/* Info Column */}
          <Box flexDirection="column" justifyContent="center">
            <Box flexDirection="row" alignItems="center">
              <Text color="red" bold>S U P E R</Text>
              <Text color="white" bold>A G E N T</Text>
              <Text color="gray"> │ </Text>
              <Text color="yellow" bold>MULTI-AGENT SYSTEM</Text>
              <Text color="gray"> │ </Text>
              <Text color="magenta" bold>Branch: {gitBranch}</Text>
              <Text color="gray"> │ </Text>
              <Text color="cyan" bold>Threads: {sessions.length}</Text>
            </Box>
          </Box>
        </Box>
        <Text color="green" bold>● ONLINE</Text>
      </Box>

      {/* Main Workspace Split */}
      <Box flexDirection="row" height={workspaceHeight}>
        {/* Left Column (Registry + Shortcuts + Console Input) */}
        <Box flexDirection="column" width="40%" height={workspaceHeight}>
          {/* Top Left: Workspace Registry */}
          <Box flexDirection="column" flexGrow={1}>
            <Box marginBottom={1}>
              <Text bold color={focusArea === "list" ? "green" : "cyan"}>📡 WORKSPACE REGISTRY</Text>
            </Box>
            {sessions.length === 0 ? (
              <Box flexDirection="row" marginTop={0}>
                <Text color="cyan" dimColor>│ </Text>
                <Text color="gray" dimColor>No active agent threads detected</Text>
              </Box>
            ) : (
              visibleSessions.map((session, index) => {
                const globalIndex = startIdx + index;
                const isSelected = globalIndex === selectedIndex;
                const color = isSelected ? "cyan" : tierColor[session.type];
                return (
                  <Box key={session.id} flexDirection="row" justifyContent="space-between" marginTop={0}>
                    <Box flexDirection="row" flexShrink={1}>
                      <Text color="cyan" dimColor>├── </Text>
                      <Text bold={isSelected} color={color} wrap="truncate-end">
                        {isSelected ? "▶ " : "  "}
                        {tierIcon[session.type]} [{globalIndex + 1}] {session.id.slice(0, 14)}
                      </Text>
                    </Box>
                    <Box flexShrink={0}>
                      {renderStatusBadge(session.status)}
                      {session.tokens > 0 
                        ? <Text color="cyan" dimColor> {session.tokens.toLocaleString()}t</Text>
                        : <Text color="gray" dimColor> --</Text>
                      }
                    </Box>
                  </Box>
                );
              })
            )}
            <Box flexDirection="row" marginTop={0}>
              <Text color="cyan" dimColor>│</Text>
            </Box>
          </Box>

          {/* Wizard Dialog (if active) */}
          {activeWizard && (() => {
            const wizardBorderColor = "cyan";
            return (
              <Box flexDirection="column" marginY={0}>
                <Box flexDirection="row" marginTop={0}>
                  <Text color={wizardBorderColor}>│</Text>
                </Box>
                {/* Model step 2: split out to handle query-based filtering like single agent */}
                {activeWizard.type === "model" && activeWizard.step === 2 && (() => {
                  const lc = query.trim().toLowerCase();
                  const filteredModels = lc
                    ? wizardAllOptions.filter(m => m.toLowerCase().includes(lc))
                    : wizardAllOptions;
                  const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredModels.length - 1));
                  const searchTitle = wizardIsLoadingModels
                    ? `⚙️ SELECT MODEL — ⏳ loading...`
                    : lc
                      ? `⚙️ SELECT MODEL — 🔍 "${query.trim()}" (${filteredModels.length}/${wizardAllOptions.length} results):`
                      : `⚙️ SELECT MODEL (${wizardAllOptions.length} available — type to filter, ↑/↓ navigate, Enter select):`;
                  return (
                    <WizardDialog
                      title={searchTitle}
                      borderColor={wizardBorderColor}
                      options={filteredModels.length > 0 ? filteredModels : ["(no results — try different search)"]}
                      selectedIndex={clampedIndex}
                      maxVisible={8}
                      marginY={0}
                      isLoading={wizardIsLoadingModels}
                    />
                  );
                })()}

                {/* All other wizard types */}
                {(activeWizard.type !== "model" || activeWizard.step !== 2) && (
                  <WizardDialog
                    title={
                      activeWizard.type === "model" && activeWizard.step === 1 ? `⚙️ SELECT MODEL PROVIDER:` :
                      activeWizard.type === "resume" ? `📁 SELECT SESSION TO RESUME:` :
                      activeWizard.type === "skills" ? `🛠️ SKILLS MANAGER (Step ${activeWizard.step}):` :
                      activeWizard.type === "checkpoint" ? `📋 CHECKPOINT MANAGER (Step ${activeWizard.step}):` :
                      activeWizard.type === "question" ? (
                        activeWizard.step === 2
                          ? "❓ ENTER CUSTOM ANSWER (Type and press Enter):"
                          : (activeWizard.isMultiSelect
                              ? "❓ QUESTION FROM AGENT (Arrows: navigate, Space: select, Enter: submit):"
                              : "❓ QUESTION FROM AGENT (Use Arrow Keys Up/Down & Enter):")
                      ) :
                      activeWizard.type === "login" && activeWizard.step === 1 ? "🔑 PROVIDER MANAGER (Use Arrow Keys Up/Down & Enter):" :
                      activeWizard.type === "login" && activeWizard.step === 2 ? "🔑 SELECT PROVIDER TEMPLATE (Use Arrow Keys Up/Down & Enter):" :
                      activeWizard.type === "login" && activeWizard.step === 5 ? "🔑 SWITCH ACTIVE PROVIDER (Use Arrow Keys Up/Down & Enter):" :
                      activeWizard.type === "login" && activeWizard.step === 10 ? "🛠️ PROJECT INITIALIZATION — Select Technology Stack (Arrows & Enter):" :
                      activeWizard.type === "login" && activeWizard.step === 11 ? "🛠️ PROJECT INITIALIZATION — Enter Project Name (Type & Enter):" :
                      activeWizard.type === "login" && activeWizard.step === 12 ? "🛠️ PROJECT INITIALIZATION — Enter Project Description (Type & Enter):" :
                      activeWizard.type === "login" && activeWizard.step === 13 ? "🤖 AI PROJECT INITIALIZATION — Describe Project Goal (Type & Enter):" :
                      `🔑 PROVIDER CREDENTIALS (Step ${activeWizard.step}):`
                    }
                    description={
                      activeWizard.type === "question" ? (pendingQuestion?.question || "") :
                      activeWizard.type === "login" && activeWizard.step === 10 ? "Choose a template catalog stack or let AI dynamically design your project details:" :
                      activeWizard.type === "login" && activeWizard.step === 11 ? "Specify the name for this workspace:" :
                      activeWizard.type === "login" && activeWizard.step === 12 ? "Give a one-sentence overview description of this software:" :
                      activeWizard.type === "login" && activeWizard.step === 13 ? "State what you want to build (e.g. 'A command-line text editor in Rust'). AI will construct agents.md specs:" :
                      undefined
                    }
                    borderColor={wizardBorderColor}
                    options={wizardOptions}
                    selectedIndex={wizardSelectedIndex}
                    maxVisible={5}
                    isMultiSelect={activeWizard.isMultiSelect}
                    selectedSet={wizardSelectedSet}
                    marginY={0}
                  />
                )}
                <Box flexDirection="row" marginTop={0}>
                  <Text color={wizardBorderColor}>│</Text>
                </Box>
              </Box>
            );
          })()}

          {/* Bottom Left: Interactive Console Prompt */}
          <Box flexDirection="column" width="100%" marginTop={0}>

            {focusArea === "input" && query.startsWith("/") && suggestions.length > 0 && (
              <Box flexDirection="row" marginBottom={1}>
                <Text color="cyan" dimColor>│   </Text>
                <Text color="gray" dimColor>Suggestions: </Text>
                {suggestions.slice(0, 3).map((s, idx) => (
                  <Text key={s} color={s === query ? "cyan" : "gray"} bold={s === query} underline={s === query}>
                    {s}{idx < Math.min(suggestions.length, 3) - 1 ? "  " : ""}
                  </Text>
                ))}
                {suggestions.length > 3 && <Text color="gray" dimColor> (+{suggestions.length - 3} more)</Text>}
              </Box>
            )}
            <Box flexDirection="row" marginTop={0} width="100%">
              <Box flexShrink={0}>
                <Text bold color={focusArea === "input" ? "green" : "cyan"}>
                  {activeWizard?.type === "model" && activeWizard.step === 2
                    ? "└──[ MODEL ] ❯ "
                    : activeWizard?.type === "model" && activeWizard.step === 1
                    ? "└──[ PROVIDER ] ❯ "
                    : activeWizard?.type === "login"
                    ? `└──[ LOGIN:${activeWizard.step} ] ❯ `
                    : activeWizard?.type === "resume"
                    ? "└──[ RESUME ] ❯ "
                    : activeWizard?.type === "question"
                    ? "└──[ ANSWER ] ❯ "
                    : activeWizard?.type === "skills"
                    ? `└──[ SKILLS:${activeWizard.step} ] ❯ `
                    : activeWizard?.type === "checkpoint"
                    ? "└──[ CHECKPOINT ] ❯ "
                    : "└───[ ⚡ PROMPT ] ❯ "}
                </Text>
              </Box>
              <Box width={Math.max(10, Math.floor(terminalSize.width * 0.40) - 22)}>
                <TextInput
                  value={query}
                  onChange={(val) => setQuery(stripSgrMouseSequences(val))}
                  onSubmit={handleQuerySubmit}
                  focus={focusArea === "input"}
                />
              </Box>
            </Box>
          </Box>
        </Box>

        {/* Vertical Spacer */}
        <Box width="2%" />

        {/* Right Column: Log Console Inspector (Full Height) */}
        <Box
          flexDirection="column"
          width="58%"
          height={workspaceHeight}
          justifyContent="flex-start"
        >
          <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
            <Box flexDirection="row">
              <Text bold color={focusArea === "logs" ? "green" : "cyan"}>🔎 INSPECT: {selectedSession.id.slice(0, 20)}</Text>
              {logScrollOffset > 0 && (
                <Text color="yellow" bold> [Scroll: -{logScrollOffset} - Esc to snap bottom]</Text>
              )}
            </Box>
            <Box flexDirection="column" alignItems="flex-end">
              <Text color="magenta" bold>({selectedSession.branch || "main"})</Text>
              {selectedSession.type === "SUPERAGENT" && selectedSession.worktreePath && (
                <Text color="gray" dimColor>wt: ...{selectedSession.worktreePath.slice(-30)}</Text>
              )}
            </Box>
          </Box>
          
          <Text color="white" bold wrap="truncate-end">Task: <Text color="gray" bold={false}>{selectedSession.task}</Text></Text>

          {/* Log Window */}
          <Box flexDirection="column" marginTop={1} height={logBoxHeight} paddingX={1} justifyContent="flex-start">
            {visibleLogs}
            {selectedSession.status === "WORKING" && logScrollOffset === 0 && (
              <Box flexDirection="row" marginTop={1}>
                <ThinkingSpinner />
                <Text color="green" bold>▮</Text>
              </Box>
            )}
          </Box>
        </Box>
      </Box>

      {/* Footer System statistics & shortcuts */}
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box>
            <Text>
              <Text color="green" bold>🟢 ONLINE</Text>
              <Text color="gray"> │ </Text>
              <Text color="yellow" bold>{process.env.MODEL || "google/gemini-2.5-flash"}</Text>
              <Text color="gray"> │ </Text>
              <Text color="magenta" bold>Master: {sessions.find(s => s.type === "MASTER")?.tokens.toLocaleString() ?? 0}t</Text>
              <Text color="gray"> │ </Text>
              <Text color="cyan" bold>Superagents({[...superagentInstances.values()].filter(i => i.status === "running").length} active): {historicalSuperagentTokens.toLocaleString()}t</Text>
              <Text color="gray"> │ </Text>
              <Text color="blue" bold>Worktrees: {worktreeCount}</Text>
            </Text>
          </Box>
        </Box>
        <Box flexDirection="row" justifyContent="space-between" marginTop={0}>
          <Box>
            <Text>
              <Text color="gray">Workspace: </Text>
              <Text color="white" bold>{process.cwd()}</Text>
            </Text>
          </Box>
        </Box>
        {activeWTs.length > 0 && (
          <Box flexDirection="row" marginTop={0}>
            <Text color="gray">Active branches: </Text>
            <Text color="cyan" bold>{activeWTs.join(", ")}</Text>
          </Box>
        )}
        <Box flexDirection="row" marginTop={0}>
          <Text color="gray" dimColor>[Tab] Cycle Focus  [▲/▼] Navigate/Scroll  [Esc] Snap Bottom  [Ctrl+C] Exit</Text>
        </Box>
      </Box>
    </Box>
  );
}
