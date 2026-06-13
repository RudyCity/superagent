import React, { useState, useEffect, useCallback } from "react";
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
  historicalSuperagentTokens,
  masterPromptTokens,
  masterCompletionTokens,
  lastMasterPromptTokens
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

import { filterSuggestions, formatCompactNumber } from "../utils/text.js";
import { WizardDialog } from "./wizard-dialog.js";
import { handleSlashCommand, getDefaultModel } from "../core/slash-commands.js";
import { listCheckpointsForSession, restoreCheckpoint } from "../core/checkpoints.js";
import { allTools } from "../core/tools.js";
import { readChecklistTasks } from "../core/taskChecklist.js";

export interface AgentSession {
  id: string;
  type: "MASTER" | "SUPERAGENT" | "SUBAGENT" | "TASK";
  task: string;
  status: "WORKING" | "COMPLETED" | "IDLE" | "ERROR";
  tokens: number;
  logs: string[];
  branch?: string;
  worktreePath?: string;
  speed?: number;
}

export function stripSgrMouseSequences(value: string): string {
  return value.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, "")
              .replace(/\[<\d+;\d+;\d+[Mm]/g, "")
              .replace(/\{<\d+;\d+;\d+[Mm]/g, "")
              .replace(/<\d+;\d+;\d+[Mm]/g, "");
}

export function getInsertion(oldVal: string, newVal: string): { prefix: string; inserted: string; suffix: string } {
  let start = 0;
  while (start < oldVal.length && start < newVal.length && oldVal[start] === newVal[start]) {
    start++;
  }
  let endOld = oldVal.length - 1;
  let endNew = newVal.length - 1;
  while (endOld >= start && endNew >= start && oldVal[endOld] === newVal[endNew]) {
    endOld--;
    endNew--;
  }
  const prefix = oldVal.slice(0, start);
  const inserted = newVal.slice(start, endNew + 1);
  const suffix = oldVal.slice(endOld + 1);
  return { prefix, inserted, suffix };
}

export function getPasteSplit(currentInput: string, prefixLen: number, suffixLen: number) {
  const prefix = currentInput.slice(0, Math.min(currentInput.length, prefixLen));
  const suffix = suffixLen > 0 ? currentInput.slice(Math.max(prefix.length, currentInput.length - suffixLen)) : "";
  const inserted = currentInput.slice(prefix.length, currentInput.length - suffix.length);
  return { prefix, inserted, suffix };
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

function ThinkingSpinner({ type = "orchestrating" }: { type?: "orchestrating" | "processing" }) {
  const [frame, setFrame] = useState(0);
  const spinners = ["▰▱▱▱▱▱▱", "▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱", "▰▰▰▰▱▱▱", "▰▰▰▰▰▱▱", "▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰"];
  
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % spinners.length);
    }, 150);
    return () => clearInterval(timer);
  }, []);

  const label = type === "orchestrating" ? "ORCHESTRATING" : "PROCESSING";
  return <Text color="yellow" bold>⚡ {label} [{spinners[frame]}] </Text>;
}

function ToolLoadingIndicator() {
  const [frame, setFrame] = useState(0);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % frames.length);
    }, 120);
    return () => clearInterval(interval);
  }, []);

  return <Text color="yellow">{frames[frame]} Running system tool...</Text>;
}

export function MultiAgentDashboard({
  agent,
  autoResume = false,
  registerLogHandler,
  registerEventHandler,
  registerQuestionHandlerRef,
}: {
  agent: Agent;
  autoResume?: boolean | string;
  registerLogHandler: (handler: (msg: string) => void) => void;
  registerEventHandler?: (handler: (event: any) => void) => void;
  registerQuestionHandlerRef?: (setter: (q: string, opts: string[], isMultiSelect?: boolean) => Promise<string>) => void;
}) {
  const { exit } = useApp();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [focusArea, setFocusArea] = useState<"list" | "logs" | "input" | "checklist" | "agents" | "procs">("input");
  const [query, setQuery] = useState("");
  const [masterLogs, setMasterLogs] = useState<string[]>(["[MASTER] System initialised. Ready for tasks."]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [tempInput, setTempInput] = useState("");
  const [isPasted, setIsPasted] = useState(false);
  const [pastePrefixLength, setPastePrefixLength] = useState(0);
  const [pasteSuffixLength, setPasteSuffixLength] = useState(0);
  const [activeModel, setActiveModel] = useState(() => {
    return process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel();
  });
  const [lastSpeed, setLastSpeed] = useState<number | null>(null);
  const [isExecutingTool, setIsExecutingTool] = useState(false);
  const [activeToolOutput, setActiveToolOutput] = useState("");
  const [toolTimeout, setToolTimeout] = useState<number | null>(null);
  const [toolStartTime, setToolStartTime] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [executingToolDescription, setExecutingToolDescription] = useState("");
  const [contextLimit, setContextLimit] = useState(() => {
    const modelName = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel();
    let initialLimit = getContextWindowLimit(modelName);
    if (process.env.CONTEXT_WINDOW_LIMIT) {
      const parsed = parseInt(process.env.CONTEXT_WINDOW_LIMIT, 10);
      if (!isNaN(parsed)) initialLimit = parsed;
    } else if (process.env.MAX_CONTEXT_TOKENS) {
      const parsed = parseInt(process.env.MAX_CONTEXT_TOKENS, 10);
      if (!isNaN(parsed)) initialLimit = parsed;
    }
    return initialLimit;
  });

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
  const [isHistoryTruncated, setIsHistoryTruncated] = useState(true);
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
  const [listSpinnerFrame, setListSpinnerFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setListSpinnerFrame((prev) => (prev + 1) % 10);
    }, 120);
    return () => clearInterval(timer);
  }, []);

  const handleQueryChange = useCallback((val: string) => {
    const sanitizedVal = stripSgrMouseSequences(val);
    const lengthDiff = sanitizedVal.length - query.length;
    const containsNewline = sanitizedVal.includes("\n");
    if (lengthDiff < 0) {
      setIsPasted(false);
    } else if (lengthDiff > 15 || containsNewline) {
      setIsPasted(true);
      const { prefix, suffix } = getInsertion(query, sanitizedVal);
      setPastePrefixLength(prefix.length);
      setPasteSuffixLength(suffix.length);
    } else if (sanitizedVal.length === 0 || (sanitizedVal.length <= 200 && !containsNewline)) {
      setIsPasted(false);
    }
    setQuery(sanitizedVal);
    if (activeWizard?.type === "model" && wizardOptions.length > 0) {
      setWizardSelectedIndex(0);
    }
  }, [query, activeWizard, wizardOptions]);
  const [wizardAllOptions, setWizardAllOptions] = useState<string[]>([]);
  const [wizardIsLoadingModels, setWizardIsLoadingModels] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<{
    question: string;
    options: string[];
    resolve: (value: string) => void;
  } | null>(null);
  const [checkpointsList, setCheckpointsList] = useState<any[]>([]);
  const [worktreeCount, setWorktreeCount] = useState<number>(0);
  const [planState, setPlanState] = useState<"IDLE" | "PLANNING_PENDING" | "APPROVED">("IDLE");
  const [checklistTasks, setChecklistTasks] = useState<{ status: string; text: string }[]>([]);

  const [checklistScrollOffset, setChecklistScrollOffset] = useState(0);
  const [agentsScrollOffset, setAgentsScrollOffset] = useState(0);
  const [procsScrollOffset, setProcsScrollOffset] = useState(0);

  const maxChecklistVisible = 5;
  const maxAgentsVisible = 3;
  const maxProcsVisible = 5;

  const [activeBlink, setActiveBlink] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveBlink((prev) => !prev);
    }, 600);
    return () => clearInterval(timer);
  }, []);

  // Safeguard scroll offsets when lists shrink
  useEffect(() => {
    if (checklistScrollOffset >= checklistTasks.length && checklistTasks.length > 0) {
      setChecklistScrollOffset(Math.max(0, checklistTasks.length - maxChecklistVisible));
    }
  }, [checklistTasks.length, checklistScrollOffset]);

  useEffect(() => {
    const runningAgentsCount = [...subagentInstances.values()].filter((s) => s.status === "running").length;
    if (agentsScrollOffset >= runningAgentsCount && runningAgentsCount > 0) {
      setAgentsScrollOffset(Math.max(0, runningAgentsCount - maxAgentsVisible));
    }
  }, [sessions, agentsScrollOffset]);

  useEffect(() => {
    const runningTasksCount = [...backgroundTasks.values()].filter((t) => t.isDetachedWindow || !t.hasExited).length;
    if (procsScrollOffset >= runningTasksCount && runningTasksCount > 0) {
      setProcsScrollOffset(Math.max(0, runningTasksCount - maxProcsVisible));
    }
  }, [sessions, procsScrollOffset]);

  // Periodic sync of agent properties (e.g. planState)
  useEffect(() => {
    const timer = setInterval(() => {
      if (agent) {
        const currentPlanState = agent.planState;
        setPlanState((prev) => {
          if (prev !== currentPlanState) {
            if (currentPlanState === "PLANNING_PENDING" && activeWizard?.type !== "plan_approve") {
              setWizardOptions(["Approve Plan & Proceed", "Reject Plan / Give Feedback"]);
              setWizardSelectedIndex(0);
              setActiveWizard({
                type: "plan_approve",
                step: 1,
                data: {},
              });
            }
            return currentPlanState;
          }
          return prev;
        });
      }
    }, 250);
    return () => clearInterval(timer);
  }, [agent, activeWizard]);

  useEffect(() => {
    let active = true;
    let intervalId: NodeJS.Timeout | null = null;

    const check = async () => {
      const taskPath = agent ? agent.getTaskFilePath() : null;
      if (!taskPath) return;
      try {
        const result = await readChecklistTasks(taskPath);
        if (!active) return;
        setChecklistTasks(result.tasks);
      } catch (err: any) {
        if (agent) {
          agent.writeToLogFile("WARN", `Failed to read task checklist file from path '${taskPath}': ${err.message}`);
        }
        if (active) {
          setChecklistTasks([]);
        }
      }
    };

    if (planState === "APPROVED") {
      check();
      intervalId = setInterval(check, 2000);
    } else {
      setChecklistTasks([]);
    }

    return () => {
      active = false;
      if (intervalId) clearInterval(intervalId);
    };
  }, [planState, agent]);

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
        const loadedLogs: string[] = [];
        for (const m of msgs) {
          if (m.role === "user" && m.content) {
            const content = m.content.trim();
            if (content) {
              userInputs.push(content);
            }
            loadedLogs.push(`[USER] ${m.content}`);
          } else if (m.role === "assistant") {
            if (m.content) {
              loadedLogs.push(`[AGENT] ${m.content}`);
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
        if (loadedLogs.length > 0) {
          setMasterLogs(loadedLogs.slice(-500));
          setMasterLogs((prev) => [...prev, "[MASTER] Successfully resumed session"].slice(-500));
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
      setActiveToolOutput(output);
    });
  }, []);

  useEffect(() => {
    if (!isExecutingTool || !toolTimeout || !toolStartTime) {
      return;
    }

    const interval = setInterval(() => {
      const elapsed = Date.now() - toolStartTime;
      const remaining = Math.max(0, Math.ceil((toolTimeout - elapsed) / 1000));
      setTimeLeft(remaining);
    }, 1000);

    return () => clearInterval(interval);
  }, [isExecutingTool, toolTimeout, toolStartTime]);

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
          return updated.slice(-500);
        }

        if (!isTag(msg) && !isTag(last)) {
          const updated = [...prev];
          updated[lastIdx] = last + "\n" + msg;
          return updated.slice(-500);
        }
        
        return [...prev, msg].slice(-500);
      });
    });
  }, [registerLogHandler]);

  // Register the agent event handler on mount
  useEffect(() => {
    if (registerEventHandler) {
      registerEventHandler((event) => {
        if (event.type === "token_usage") {
          if (event.durationMs && event.completionTokens > 0) {
            const speed = event.completionTokens / (event.durationMs / 1000);
            setLastSpeed(speed);
          }
        } else if (event.type === "tool_start") {
          setIsExecutingTool(true);
          setExecutingToolDescription(event.description || event.toolCall.name);
          const timeoutArg = event.toolCall.args?.timeout;
          if (typeof timeoutArg === "number") {
            setToolTimeout(timeoutArg);
            setToolStartTime(Date.now());
            setTimeLeft(Math.ceil(timeoutArg / 1000));
          } else {
            setToolTimeout(null);
            setToolStartTime(null);
            setTimeLeft(null);
          }
        } else if (event.type === "tool_end" || event.type === "error" || event.type === "done") {
          setIsExecutingTool(false);
          setToolTimeout(null);
          setToolStartTime(null);
          setTimeLeft(null);
        }
      });
    }
  }, [registerEventHandler]);

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
          ].slice(-500));
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
          setMasterLogs((prev) => [...prev, `[ERROR] Invalid choice. Please select 1, 2, 3, or 4.`].slice(-500));
          return;
        }

        setMasterLogs((prev) => [
          ...prev,
          `[MASTER] Selected provider type: ${provider}\nStep 3: Enter config profile name (e.g. ${provider}, deepseek, or press Enter for default):`
        ].slice(-500));

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
          ].slice(-500));
          setActiveWizard({
            type: "login",
            step: 4,
            data: { provider, name: profileName },
          });
        } else {
          setMasterLogs((prev) => [
            ...prev,
            `[MASTER] Config Name: ${profileName}\nStep 6: Please enter your API Key:`
          ].slice(-500));
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
        ].slice(-500));
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
            ].slice(-500));
            fetchAndCacheModels()
              .then(() => {
                const currentModel = process.env.MODEL || getDefaultModel();
                setActiveModel(currentModel);
              })
              .catch(() => {});
          } catch (err: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to switch provider: ${err.message}`].slice(-500));
          }
        } else {
          setMasterLogs((prev) => [...prev, `[ERROR] Provider "${value}" not found in configured list.`].slice(-500));
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
          ].slice(-500));

          if (provider === "openrouter" && !process.env.MODEL) {
            updateEnvFile({ MODEL: "google/gemini-2.5-flash" });
          }

          fetchAndCacheModels()
            .then(() => {
              const currentModel = process.env.MODEL || getDefaultModel();
              setActiveModel(currentModel);
            })
            .catch(() => {});
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to save credentials: ${err.message}`].slice(-500));
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
          ].slice(-500));
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
          ].slice(-500));
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
        ].slice(-500));
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
          ].slice(-500));

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
          setMasterLogs((prev) => [...prev, `[SYSTEM] ${auditLines.join("\n")}`].slice(-500));
        })().catch(err => {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to complete project initialization: ${err.message}`].slice(-500));
        });

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 13) {
        const goal = value.trim();
        if (!goal) {
          setMasterLogs((prev) => [...prev, `[ERROR] AI prompt cannot be empty. Initialization cancelled.`].slice(-500));
          setActiveWizard(null);
          return;
        }

        setMasterLogs((prev) => [...prev, `[SYSTEM] 🤖 Consulting AI to formulate project structure...`].slice(-500));
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
            setMasterLogs((prev) => [...prev, `[SYSTEM] 📄 Generated agents.md successfully!`].slice(-500));

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
            setMasterLogs((prev) => [...prev, `[SYSTEM] ${auditLines.join("\n")}`].slice(-500));
          } catch (aiErr: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] AI code completion request failed: ${aiErr.message}. Falling back to default project structure.`].slice(-500));
            
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
        const choice = value.toLowerCase();
        let tier = "";
        if (choice.includes("master") || choice.includes("depth 0")) {
          tier = "master";
        } else if (choice.includes("superagent") || choice.includes("depth 1")) {
          tier = "superagent";
        } else if (choice.includes("subagents") || choice.includes("depth 2")) {
          tier = "subagent";
        } else if (choice.includes("researcher")) {
          tier = "researcher";
        } else if (choice.includes("coder")) {
          tier = "coder";
        } else if (choice.includes("reviewer")) {
          tier = "reviewer";
        } else if (choice.includes("all")) {
          tier = "all";
        } else {
          const tiers = ["master", "superagent", "subagent", "researcher", "coder", "reviewer", "all"];
          const idx = wizardSelectedIndex >= 0 ? wizardSelectedIndex : 0;
          tier = tiers[idx] || "master";
        }

        setActiveWizard({
          type: "model",
          step: 2,
          data: { tier },
        });

        const list = getConfiguredProviders();
        const options = list.map(p => `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${p.isActive ? " [Active]" : ""}`);
        setWizardOptions(options.length > 0 ? options : ["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint"]);
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 2) {
        const list = getConfiguredProviders();
        const cleanName = value.replace(/\s*\[Active\]\s*$/, "").split(" (")[0].trim();
        const nameWithoutNumber = cleanName.replace(/^\d+\.\s*/, "").trim();
        const found = list.find(p => p.name.toLowerCase() === nameWithoutNumber.toLowerCase());

        let providerProfileName = "";
        let providerType = "";
        let resolvedApiKey = "";
        let resolvedBaseUrl = "";

        if (found) {
          providerProfileName = found.name;
          providerType = found.type;
          resolvedBaseUrl = found.baseUrl || "";
          
          const prefix = `PROVIDER_${found.name.toUpperCase()}`;
          resolvedApiKey = process.env[`${prefix}_API_KEY`] || "";
          
          if (!resolvedApiKey) {
            if (found.name.toLowerCase() === "openai") {
              resolvedApiKey = process.env.OPENAI_API_KEY || "";
            } else if (found.name.toLowerCase() === "anthropic") {
              resolvedApiKey = process.env.ANTHROPIC_API_KEY || "";
            } else if (found.name.toLowerCase() === "openrouter") {
              resolvedApiKey = process.env.CUSTOM_API_KEY || "";
            } else if (found.type === "custom") {
              resolvedApiKey = process.env.CUSTOM_API_KEY || "";
            }
          }
          
          if (found.name.toLowerCase() === "openrouter") {
            providerType = "openrouter";
          }
        } else {
          const lowerName = nameWithoutNumber.toLowerCase();
          if (lowerName.includes("openrouter")) {
            providerProfileName = "openrouter";
            providerType = "openrouter";
            resolvedApiKey = process.env.CUSTOM_API_KEY || "";
          } else if (lowerName.includes("openai")) {
            providerProfileName = "openai";
            providerType = "openai";
            resolvedApiKey = process.env.OPENAI_API_KEY || "";
          } else if (lowerName.includes("anthropic")) {
            providerProfileName = "anthropic";
            providerType = "anthropic";
            resolvedApiKey = process.env.ANTHROPIC_API_KEY || "";
          } else if (lowerName.includes("custom")) {
            providerProfileName = "custom";
            providerType = "custom";
            resolvedBaseUrl = process.env.CUSTOM_BASE_URL || "";
            resolvedApiKey = process.env.CUSTOM_API_KEY || "";
          } else {
            providerProfileName = "openrouter";
            providerType = "openrouter";
          }
        }

        setActiveWizard({
          type: "model",
          step: 3,
          data: { ...activeWizard.data, provider: providerProfileName },
        });

        const initialModels: string[] =
          providerType === "openrouter" ? [
            "google/gemini-2.5-flash",
            "meta-llama/llama-3.3-70b-instruct",
            "deepseek/deepseek-chat",
            "anthropic/claude-3.5-sonnet",
          ] :
          providerType === "openai" ? [
            "gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "o1-preview", "o3-mini",
          ] :
          providerType === "anthropic" ? [
            "claude-opus-4-5",
            "claude-sonnet-4-5",
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
            "claude-3-opus-20240229",
          ] :
          providerType === "custom" ? [
            "deepseek-chat", "llama-3.3-70b-instruct",
          ] : [];

        setWizardAllOptions(initialModels);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setQuery("");

        if (providerType === "openrouter") {
          setWizardIsLoadingModels(true);
          const headers: Record<string, string> = {};
          if (resolvedApiKey) headers["Authorization"] = `Bearer ${resolvedApiKey}`;
          fetch("https://openrouter.ai/api/v1/models", { headers })
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
        } else if (providerType === "openai") {
          if (resolvedApiKey) {
            setWizardIsLoadingModels(true);
            fetch("https://api.openai.com/v1/models", {
              headers: { Authorization: `Bearer ${resolvedApiKey}` }
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
        } else if (providerType === "custom") {
          if (resolvedBaseUrl) {
            setWizardIsLoadingModels(true);
            const headers: Record<string, string> = {};
            if (resolvedApiKey) headers["Authorization"] = `Bearer ${resolvedApiKey}`;
            fetch(`${resolvedBaseUrl}/models`, { headers })
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

        setMasterLogs((prev) => [...prev, `[MASTER] Provider profile "${providerProfileName}" selected. Choose a model below:`].slice(-500));
      } else {
        const selectedModel = value;
        const tier = activeWizard.data.tier;
        const provider = activeWizard.data.provider;

        try {
          let updates: Record<string, string> = {};
          let targetLabel = "";

          if (tier === "default") {
            updates = { 
              MODEL: selectedModel,
              [`PROVIDER_${provider.toUpperCase()}_MODEL`]: selectedModel
            };
            targetLabel = "Default Model";
            switchActiveProvider(provider);
          } else if (tier === "all") {
            const activeProvider = process.env.ACTIVE_PROVIDER || "";
            const finalModelName = provider.toLowerCase() !== activeProvider.toLowerCase()
              ? `${provider.toLowerCase()}:${selectedModel}`
              : selectedModel;
            updates = {
              MODEL: selectedModel,
              MODEL_DEPTH_0: finalModelName,
              MODEL_DEPT0: finalModelName,
              MODEL_DEPTH_1: finalModelName,
              MODEL_DEPT1: finalModelName,
              MODEL_DEPTH_2: finalModelName,
              MODEL_DEPT2: finalModelName,
              MODEL_SUBAGENT_RESEARCHER: finalModelName,
              MODEL_RESEARCHER: finalModelName,
              MODEL_SUBAGENT_CODER: finalModelName,
              MODEL_CODER: finalModelName,
              MODEL_SUBAGENT_REVIEWER: finalModelName,
              MODEL_REVIEWER: finalModelName
            };
            targetLabel = "All Tiers & Subagents";
            switchActiveProvider(provider);
          } else {
            const activeProvider = process.env.ACTIVE_PROVIDER || "";
            const finalModelName = provider.toLowerCase() !== activeProvider.toLowerCase()
              ? `${provider.toLowerCase()}:${selectedModel}`
              : selectedModel;

            if (tier === "master") {
              updates = { MODEL_DEPTH_0: finalModelName, MODEL_DEPT0: finalModelName };
              targetLabel = "Master Agent (depth 0) Model";
            } else if (tier === "superagent") {
              updates = { MODEL_DEPTH_1: finalModelName, MODEL_DEPT1: finalModelName };
              targetLabel = "Superagent (depth 1) Model";
            } else if (tier === "subagent") {
              updates = { MODEL_DEPTH_2: finalModelName, MODEL_DEPT2: finalModelName };
              targetLabel = "Subagent (depth 2) Model";
            } else {
              const typeUpper = tier.toUpperCase();
              updates = {
                [`MODEL_SUBAGENT_${typeUpper}`]: finalModelName,
                [`MODEL_${typeUpper}`]: finalModelName
              };
              targetLabel = `Subagent "${tier}" Model`;
            }
          }

          const envPath = updateEnvFile(updates);
          const effectiveMasterModel = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel();
          setActiveModel(effectiveMasterModel);
          const limit = getContextWindowLimit(selectedModel);
          const currentModel = process.env.MODEL || getDefaultModel();
          const masterModel = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "(use default)";
          const superagentModel = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "(use default)";
          const subagentModel = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "(use default)";
          
          const updatedLogs = [
            `[MASTER] Updated Models:`,
            `[MASTER]   Default Model: ${currentModel}`,
            `[MASTER]   Master Agent (depth 0): ${masterModel}`,
            `[MASTER]   Superagent (depth 1): ${superagentModel}`,
            `[MASTER]   Subagent (depth 2): ${subagentModel}`,
          ];

          for (const [key, value] of Object.entries(process.env)) {
            if (value && key.startsWith("MODEL_SUBAGENT_")) {
              const name = key.replace("MODEL_SUBAGENT_", "").toLowerCase();
              updatedLogs.push(`[MASTER]   Subagent "${name}": ${value}`);
            }
          }

          setMasterLogs((prev) => [
            ...prev,
            `[MASTER] ${targetLabel} successfully changed to: ${selectedModel}`,
            `[MASTER] Context Limit: ${limit.toLocaleString()} tokens`,
            `[MASTER] Saved to: ${envPath}`,
            ...updatedLogs
          ].slice(-500));
          
          if (tier === "default") {
            fetchAndCacheModels().catch(() => {});
          }
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to set model: ${err.message}`].slice(-500));
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
            const skillPrefixMatch = m.content.match(/^I would like you to use the following skill:\s*"(.*?)"\.\nPlease read its instruction file at\s*"(.*?)"/);
            if (skillPrefixMatch) {
              loadedLogs.push(`[USER] 🛠️ [SKILL USE] ${skillPrefixMatch[1]} (${skillPrefixMatch[2]})`);
            } else {
              loadedLogs.push(`[USER] ${m.content}`);
            }
          } else if (m.role === "assistant") {
            if (m.content) {
              loadedLogs.push(`[AGENT] ${m.content}`);
            }
          }
        }
        setMasterLogs(loadedLogs.slice(-500));
        setMasterLogs((prev) => [...prev, `[MASTER] Successfully resumed session: ${chosen.displayName}`].slice(-500));
      } catch (err: any) {
        setMasterLogs((prev) => [...prev, `[ERROR] Failed to resume session: ${err.message}`].slice(-500));
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
          setMasterLogs((prev) => [...prev, `[USER] 🛠️ [SKILL USE] ${chosen.name} (${chosen.path})`, `[MASTER] Activating skill "${chosen.name}"...\nInstruction path: ${chosen.path}`].slice(-500));
          agent.sendMessage(
            `I would like you to use the following skill: "${chosen.name}".\nPlease read its instruction file at "${chosen.path}" using a file read tool first, and then help me with my request based on its instructions.`
          ).catch((err: any) => {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to send message: ${err.message}`].slice(-500));
          });
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        } else if (wizardSelectedIndex === 1) {
          // View Details
          setMasterLogs((prev) => [
            ...prev,
            `[MASTER] Skill Details: ${chosen.name}`,
            `[MASTER] Description: ${chosen.description}`,
            `[MASTER] Path: ${chosen.path}`
          ].slice(-500));
        } else {
          // Back to List
          const options = skillsList.map((s) => `• ${s.name} - ${s.description.slice(0, 50)}${s.description.length > 50 ? "..." : ""}`);
          setActiveWizard({
            type: "skills",
            step: 1,
            data: {},
          });
          setWizardOptions(options);
          setWizardSelectedIndex(skillIndex);
        }
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
              if (m.role === "user") {
                const skillPrefixMatch = m.content.match(/^I would like you to use the following skill:\s*"(.*?)"\.\nPlease read its instruction file at\s*"(.*?)"/);
                if (skillPrefixMatch) {
                  loadedLogs.push(`[USER] 🛠️ [SKILL USE] ${skillPrefixMatch[1]} (${skillPrefixMatch[2]})`);
                } else {
                  loadedLogs.push(`[USER] ${m.content}`);
                }
              } else if (m.role === "assistant" && m.content) {
                loadedLogs.push(`[AGENT] ${m.content}`);
              }
            }
            setMasterLogs(loadedLogs.slice(-500));
            setMasterLogs((prev) => [...prev, `[MASTER] Checkpoint "${chosen.name}" successfully restored! (${chosen.messages.length} messages)`].slice(-500));
          })
          .catch((err: any) => {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to restore checkpoint: ${err.message}`].slice(-500));
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
                  setMasterLogs((prev) => [...prev, `[ERROR] Git restore failed: ${checkoutRes.stderr || checkoutRes.message}. Conversation history restored anyway.`].slice(-500));
                } else {
                  setMasterLogs((prev) => [...prev, `[MASTER] Workspace restored to Git commit: ${chosen.gitSha}`].slice(-500));
                }
              } catch (gitErr: any) {
                setMasterLogs((prev) => [...prev, `[ERROR] Git restore error: ${gitErr.message}. Conversation history restored anyway.`].slice(-500));
              }
            }

            await restoreCheckpoint(chkPath, sessionPath);
            await agent.loadHistoryFromPath(sessionPath);
            const msgs = agent.getHistory().getMessages();
            const loadedLogs: string[] = [];
            for (const m of msgs) {
              if (m.role === "user") {
                const skillPrefixMatch = m.content.match(/^I would like you to use the following skill:\s*"(.*?)"\.\nPlease read its instruction file at\s*"(.*?)"/);
                if (skillPrefixMatch) {
                  loadedLogs.push(`[USER] 🛠️ [SKILL USE] ${skillPrefixMatch[1]} (${skillPrefixMatch[2]})`);
                } else {
                  loadedLogs.push(`[USER] ${m.content}`);
                }
              } else if (m.role === "assistant" && m.content) {
                loadedLogs.push(`[AGENT] ${m.content}`);
              }
            }
            setMasterLogs(loadedLogs.slice(-500));
            setMasterLogs((prev) => [...prev, `[MASTER] Checkpoint "${chosen.name}" successfully restored! (${chosen.messages.length} messages)`].slice(-500));
          } catch (err: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to restore checkpoint: ${err.message}`].slice(-500));
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
          setMasterLogs((prev) => [...prev, `[MASTER] ❓ Answered: "${selectedOption}"`].slice(-500));
        }
      } else {
        if (pendingQuestion) {
          pendingQuestion.resolve(value);
          setMasterLogs((prev) => [...prev, `[MASTER] ❓ Answered: "${value}"`].slice(-500));
        }
      }

      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setWizardSelectedSet(new Set());
      setPendingQuestion(null);
    } else if (activeWizard.type === "plan_approve") {
      const approved = value === "Approve Plan & Proceed";
      // Guard: skip if already approved (prevent double-fire)
      if (approved && planState === "APPROVED") return;
      if (approved) {
        agent.approvePlan();
        setPlanState("APPROVED");
        setMasterLogs((prev) => [...prev, "✓ Implementation plan approved! Continuing with the approved plan now."].slice(-500));
        agent.sendMessage("Implementation plan approved via interactive approval wizard. Continue with the approved plan now.").catch((err: any) => {
          setMasterLogs((prev) => [...prev, `[ERROR] Plan approval resume error: ${err.message}`].slice(-500));
        });
      } else {
        agent.planState = "IDLE";
        setPlanState("IDLE");
        setMasterLogs((prev) => [...prev, "✗ Implementation plan rejected. Please type your feedback below and press Enter to send it to the agent."].slice(-500));
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    }
  };

  const handleQuerySubmit = (val: string) => {
    setIsPasted(false);
    const cleanVal = val.trim();

    if (activeWizard) {
      if (activeWizard.type === "question" && activeWizard.isMultiSelect) {
        const selectedList = Array.from(wizardSelectedSet).map(idx => wizardOptions[idx]).filter(Boolean);
        const answer = selectedList.join(", ");
        if (pendingQuestion) {
          pendingQuestion.resolve(answer);
          setMasterLogs((prev) => [...prev, `[MASTER] ❓ Answered: "${answer}"`].slice(-500));
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
      if (activeWizard.type === "model" && activeWizard.step === 3) {
        const lc = query.trim();
        const filteredModels = lc
          ? filterSuggestions(wizardAllOptions, lc)
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

    if (planState === "PLANNING_PENDING") {
      setWizardOptions(["Approve Plan & Proceed", "Reject Plan / Give Feedback"]);
      setWizardSelectedIndex(0);
      setActiveWizard({
        type: "plan_approve",
        step: 1,
        data: {},
      });
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
        setMasterLogs((prev) => [...prev, `[USER] ${commandInput}`, `[ERROR] /goal command is disabled in Multi-Agent Dashboard.`].slice(-500));
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
        addLine: (line) => setMasterLogs((prev) => [...prev, `[${line.type.toUpperCase()}] ${line.content}`].slice(-500)),
        exit,
        agent,
        clearLines: () => {
          setMasterLogs([]);
          setLastSpeed(null);
        },
        setContextLimit,
        setActiveModel,
        setActiveWizard: (val) => {
          if (val && val.type === "goal") return;
          setActiveWizard(val);
          if (val && val.type === "resume") {
            setCachedSessions(listHistorySessions(true));
          }
        },
        setWizardOptions,
        setWizardSelectedIndex,
        setPlanState,
        setGoalMode: () => {},
        setIsProcessing: () => {},
        resumeSession: async () => {},
        resumeFromPath: async (filePath: string) => {
          try {
            await agent.loadHistoryFromPath(filePath);
            const msgs = agent.getHistory().getMessages();
            const loadedLogs: string[] = [];
            for (const m of msgs) {
              if (m.role === "user" && m.content) {
                const skillPrefixMatch = m.content.match(/^I would like you to use the following skill:\s*"(.*?)"\.\nPlease read its instruction file at\s*"(.*?)"/);
                if (skillPrefixMatch) {
                  loadedLogs.push(`[USER] 🛠️ [SKILL USE] ${skillPrefixMatch[1]} (${skillPrefixMatch[2]})`);
                } else {
                  loadedLogs.push(`[USER] ${m.content}`);
                }
              } else if (m.role === "assistant") {
                if (m.content) {
                  loadedLogs.push(`[AGENT] ${m.content}`);
                }
              }
            }
            setMasterLogs(loadedLogs.slice(-500));
            setMasterLogs((prev) => [...prev, `[MASTER] Successfully loaded session history from: ${filePath}`].slice(-500));
          } catch (err: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to load session from path: ${err.message}`].slice(-500));
          }
        }
      });
      setQuery("");
      return;
    }

    setMasterLogs((prev) => [...prev, `[USER] ${commandInput}`].slice(-500));
    setQuery("");
    setCurrentTask(commandInput);

    agent.sendMessage(commandInput)
      .then(() => {
        setCurrentTask(`Idle - Completed: ${commandInput}`);
      })
      .catch((err) => {
        setCurrentTask(`Error: ${err.message || err}`);
        setMasterLogs((prev) => [...prev, `[ERROR] ${err.message || err}`].slice(-500));
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

      // Prepare subagents grouped by parentId
      const subagentSessionsMap = new Map<string, AgentSession[]>();
      for (const [id, instance] of subagentInstances.entries()) {
        const parentId = (instance as any).parentId || "master";
        if (!subagentSessionsMap.has(parentId)) {
          subagentSessionsMap.set(parentId, []);
        }
        subagentSessionsMap.get(parentId)!.push({
          id: `${instance.typeName}-${id}`,
          type: "SUBAGENT",
          task: `Role: ${instance.role}`,
          status: instance.status === "running" ? "WORKING" : instance.status === "completed" ? "COMPLETED" : "IDLE",
          tokens: (instance.tokenUsage?.prompt ?? 0) + (instance.tokenUsage?.completion ?? 0),
          logs: instance.logs && instance.logs.length > 0 ? instance.logs : ["Awaiting output..."],
          branch: "worktree",
          speed: instance.speed,
        });
      }

      // 1. Master session
      const hasActiveAgentsOrTasks =
        [...superagentInstances.values()].some((i) => i.status === "running") ||
        [...subagentInstances.values()].some((s) => s.status === "running") ||
        [...backgroundTasks.values()].some((t) => t.isDetachedWindow || !t.hasExited);

      list.push({
        id: "master-orchestrator",
        type: "MASTER",
        task: currentTask,
        status: hasActiveAgentsOrTasks 
          ? "WORKING"
          : (currentTask.startsWith("Idle") ? "IDLE" : (currentTask.startsWith("Error") ? "ERROR" : "WORKING")),
        tokens: masterPromptTokens + masterCompletionTokens,
        logs: masterLogs,
        branch: gitBranch,
      });

      // Immediately push all subagent sessions belonging to "master"
      const masterSubs = subagentSessionsMap.get("master") || [];
      list.push(...masterSubs);

      // 2. Superagent instances (depth 1 — feature developers in worktrees)
      for (const [id, instance] of superagentInstances.entries()) {
        list.push({
          id: `sa-${instance.role}-${id}`,
          type: "SUPERAGENT",
          task: `[${instance.role}] ${instance.task}`,
          status: instance.status === "running" ? "WORKING"
                : instance.status === "completed" ? "COMPLETED"
                : "ERROR",
          tokens: (instance.tokenUsage?.prompt ?? 0) + (instance.tokenUsage?.completion ?? 0),
          logs: instance.logs.length > 0 ? instance.logs : ["Superagent initialising..."],
          branch: instance.branch,
          worktreePath: instance.worktreePath,
          speed: instance.speed,
        });

        // Immediately push all subagent sessions belonging to this superagent
        const saSubs = subagentSessionsMap.get(id) || [];
        list.push(...saSubs);
      }

      // 3. Fallback: Any remaining Subagents (just in case parentId doesn't match keys)
      for (const [parentId, subs] of subagentSessionsMap.entries()) {
        if (parentId !== "master" && !superagentInstances.has(parentId)) {
          list.push(...subs);
        }
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

  const runningTasksCount = [...backgroundTasks.values()]
    .filter((t) => t.isDetachedWindow || !t.hasExited).length;

  const runningSubagentsCount = [...subagentInstances.values()]
    .filter((s) => s.status === "running").length;

  let liveListHeight = 0;
  if (runningSubagentsCount > 0 || runningTasksCount > 0) {
    liveListHeight += 1; // padding/margin
    if (runningSubagentsCount > 0) {
      liveListHeight += 1; // header
      const agentsCount = Math.min(runningSubagentsCount, maxAgentsVisible);
      liveListHeight += agentsCount * 2; // Each subagent takes 2 lines
    }
    if (runningTasksCount > 0) {
      liveListHeight += 1; // header
      const procsCount = Math.min(runningTasksCount, maxProcsVisible);
      liveListHeight += procsCount; // Each task is 1 line
      if (runningSubagentsCount > 0) {
        liveListHeight += 1; // marginTop
      }
    }
  }

  let bottomPromptHeight = 1; // Prompt input row
  if (focusArea === "input" && query.startsWith("/") && suggestions.length > 0) {
    bottomPromptHeight += 2;
  }
  let wizardHeight = 0;
  if (activeWizard) {
    const maxVis = activeWizard.type === "model" && activeWizard.step === 3 ? 8 : 10;
    let start = 0;
    let end = wizardOptions.length;
    if (wizardOptions.length > maxVis) {
      start = Math.max(0, wizardSelectedIndex - Math.floor(maxVis / 2));
      end = start + maxVis;
      if (end > wizardOptions.length) {
        end = wizardOptions.length;
        start = Math.max(0, end - maxVis);
      }
    }
    const optCount = end - start;
    const hasAbove = start > 0;
    const hasBelow = end < wizardOptions.length;

    let wizardDescription = "";
    if (activeWizard.type === "plan_approve") {
      wizardDescription = `Model AI telah merancang rencana di file: file:///${path.resolve(agent.getPlanFilePath()).replace(/\\/g, "/")}`;
    } else if (activeWizard.type === "question") {
      wizardDescription = pendingQuestion?.question || "";
    } else if (activeWizard.type === "login" && activeWizard.step === 10) {
      wizardDescription = "Choose a template catalog stack or let AI dynamically design your project details:";
    } else if (activeWizard.type === "login" && activeWizard.step === 11) {
      wizardDescription = "Specify the name for this workspace:";
    } else if (activeWizard.type === "login" && activeWizard.step === 12) {
      wizardDescription = "Give a one-sentence overview description of this software:";
    } else if (activeWizard.type === "login" && activeWizard.step === 13) {
      wizardDescription = "State what you want to build (e.g. 'A command-line text editor in Rust'). AI will construct agents.md specs:";
    }

    const descLines = wizardDescription
      ? wrapTextForDisplay(wizardDescription, Math.max(10, terminalSize.width - 4)).length
      : 0;

    const hasLoading = activeWizard.type === "model" && activeWizard.step === 3 && wizardIsLoadingModels;

    wizardHeight += 1; // Outer top border │
    wizardHeight += 1; // Title line
    if (descLines > 0) {
      wizardHeight += descLines + 1; // Description lines + spacer │
    }
    if (hasLoading) {
      wizardHeight += 2; // Loading spinner + spacer
    }
    if (hasAbove) {
      wizardHeight += 1;
    }
    wizardHeight += optCount;
    if (hasBelow) {
      wizardHeight += 1;
    }
  }
  const workspaceHeight = Math.max(10, terminalSize.height - 9 - bottomPromptHeight - liveListHeight - wizardHeight);
  let checklistHeight = 0;
  if (planState === "APPROVED" && checklistTasks.length > 0) {
    const checklistCount = Math.min(checklistTasks.length, maxChecklistVisible);
    checklistHeight += 3 + checklistCount;
  }

  const leftTopHeight = Math.max(5, workspaceHeight - 2 - checklistHeight);
  const logBoxHeight = Math.max(5, workspaceHeight - 4);
  const showCursor = selectedSession.status === "WORKING" && logScrollOffset === 0;
  let executingToolHeight = 0;
  const activeToolLines = (selectedSession.type === "MASTER" && isExecutingTool && activeToolOutput) 
    ? activeToolOutput.trim().split("\n").slice(-8) 
    : [];
  if (selectedSession.type === "MASTER" && isExecutingTool) {
    executingToolHeight += 2; // Header border + spinner line
    if (activeToolLines.length > 0) {
      executingToolHeight += activeToolLines.length + 1; // Header + lines
    }
  }

  let logsCount = showCursor ? Math.max(1, logBoxHeight - 1) : logBoxHeight;
  if (selectedSession.type === "MASTER" && isExecutingTool) {
    logsCount = Math.max(1, logsCount - executingToolHeight);
  }

  const feedWidth = Math.max(10, Math.floor(terminalSize.width * 0.58) - 4);
  const wrappedLines: React.ReactNode[] = [];

  const activeLogs = selectedSession.logs.map(l => l.trim()).filter(Boolean);

  interface LogGroup {
    isBox: boolean;
    label: string;
    color: string;
    isBold: boolean;
    dimColor: boolean;
    parseMarkdown: boolean;
    rawLines: string[];
  }

  const groups: LogGroup[] = [];
  for (let logIdx = 0; logIdx < activeLogs.length; logIdx++) {
    const logStr = activeLogs[logIdx];
    const isBoxLine = /^[┌├│└─]/.test(logStr);

    if (isBoxLine) {
      groups.push({
        isBox: true,
        label: "",
        color: selectedSession.type === "SUBAGENT" ? "green" : "gray",
        isBold: false,
        dimColor: false,
        parseMarkdown: false,
        rawLines: [logStr],
      });
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

    const lastGroup = groups[groups.length - 1];
    if (
      lastGroup &&
      !lastGroup.isBox &&
      lastGroup.label === label &&
      lastGroup.color === color &&
      lastGroup.isBold === isBold &&
      lastGroup.dimColor === dimColor &&
      lastGroup.parseMarkdown === parseMarkdown
    ) {
      lastGroup.rawLines.push(content);
    } else {
      groups.push({
        isBox: false,
        label,
        color,
        isBold,
        dimColor,
        parseMarkdown,
        rawLines: [content],
      });
    }
  }

  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const group = groups[groupIdx];

    if (group.isBox) {
      // For box lines, render directly without any label or border wrapping
      for (const logStr of group.rawLines) {
        const subLines = wrapTextForDisplay(logStr, feedWidth);
        for (let i = 0; i < subLines.length; i++) {
          const lineText = subLines[i];
          wrappedLines.push(
            <Box flexDirection="row" key={`log-line-${groupIdx}-${i}`} width={feedWidth}>
              <Text color={group.color}>{lineText}</Text>
            </Box>
          );
        }
      }
      continue;
    }

    const prefix = groupIdx === 0 ? "┌───" : (groupIdx === groups.length - 1 ? "└───" : "├───");
    const subLinePrefix = groupIdx === groups.length - 1 ? "    " : "│   ";

    // Format header border line
    wrappedLines.push(
      <Box flexDirection="row" key={`log-header-${groupIdx}`} width={feedWidth}>
        <Text color={group.color === "gray" ? "gray" : group.color} bold>
          {prefix} <Text color="white" bold>[ </Text>
          <Text color={group.color === "gray" ? "gray" : group.color} bold>{group.label}</Text>
          <Text color="white" bold> ]</Text>
        </Text>
      </Box>
    );

    // Format content lines of the group
    let inCode = false;
    for (let rawLineIdx = 0; rawLineIdx < group.rawLines.length; rawLineIdx++) {
      const content = group.rawLines[rawLineIdx];
      const subLines = wrapTextForDisplay(content, Math.max(10, feedWidth - 4));

      for (let i = 0; i < subLines.length; i++) {
        const lineText = subLines[i];
        const trimmed = lineText.trim();

        if (group.parseMarkdown) {
          // Code Block detection
          if (trimmed.startsWith("```")) {
            inCode = !inCode;
            const codeLang = trimmed.slice(3).trim() || "TEXT";
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
                <Text color="gray" italic>{inCode ? `┌─── [ CODE: ${codeLang} ]` : "└─── [ END CODE ]"}</Text>
              </Box>
            );
            continue;
          }

          if (inCode) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
                <Text color="green">{lineText}</Text>
              </Box>
            );
            continue;
          }

          // Header lines
          if (trimmed.startsWith("# ")) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
                <Text bold color="yellow">{lineText.slice(2)}</Text>
              </Box>
            );
            continue;
          }
          if (trimmed.startsWith("## ")) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
                <Text bold color="cyan">{lineText.slice(3)}</Text>
              </Box>
            );
            continue;
          }
          if (trimmed.startsWith("### ")) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
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
            <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
              <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
              {listPrefix ? <Text color="magenta" bold>{listPrefix}</Text> : null}
              <Box flexShrink={1}>
                {renderLogInlineStyles(remainingLine, group.color === "gray" ? "gray" : group.color, group.isBold, group.dimColor)}
              </Box>
            </Box>
          );
        } else {
          // Plain text or standard rendering without full markdown parsing
          wrappedLines.push(
            <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
              <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
              <Text color={group.color === "gray" ? "gray" : group.color} bold={group.isBold} dimColor={group.dimColor} wrap={isHistoryTruncated ? "truncate-end" : undefined}>{lineText}</Text>
            </Box>
          );
        }
      }
    }

    // Add empty space/separator line between groups if it's not the last one
    if (groupIdx < groups.length - 1) {
      wrappedLines.push(
        <Box flexDirection="row" key={`log-sep-${groupIdx}`}>
          <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
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
          const workspaceStartRow = 4; // Header banner has fixed height of 3 lines (1-indexed)

          if (x <= leftLimit) {
            if (activeWizard) {
              setFocusArea("input");

              // Handle wizard option clicking
              let options = wizardOptions;
              let maxVisible = 10;
              if (activeWizard.type === "model" && activeWizard.step === 3) {
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

                // Calculate options row positions dynamically based on preceding layouts
                let description = undefined;
                if (activeWizard.type === "plan_approve") {
                  description = `Model AI telah merancang rencana di file: file:///${path.resolve(agent.getPlanFilePath()).replace(/\\/g, "/")}`;
                } else if (activeWizard.type === "question") {
                  description = pendingQuestion?.question || "";
                } else if (activeWizard.type === "login" && activeWizard.step === 10) {
                  description = "Choose a template catalog stack or let AI dynamically design your project details:";
                } else if (activeWizard.type === "login" && activeWizard.step === 11) {
                  description = "Specify the name for this workspace:";
                } else if (activeWizard.type === "login" && activeWizard.step === 12) {
                  description = "Give a one-sentence overview description of this software:";
                } else if (activeWizard.type === "login" && activeWizard.step === 13) {
                  description = "State what you want to build (e.g. 'A command-line text editor in Rust'). AI will construct agents.md specs:";
                }

                let descLines = 0;
                if (description) {
                  const descWidth = Math.max(10, Math.floor(terminalSize.width * 0.40) - 4);
                  descLines = wrapTextForDisplay(description, descWidth).length;
                }

                const isLoading = (activeWizard.type === "model" && activeWizard.step === 3) && wizardIsLoadingModels;

                const y_options_start = workspaceStartRow
                  + leftTopHeight
                  + 1  // registry marginBottom
                  + 1  // wizard top spacer │
                  + 1  // dialog title
                  + (description ? descLines + 1 : 0)  // description + description spacer
                  + (isLoading ? 2 : 0)  // loading indicator + its spacer
                  + (start > 0 ? 1 : 0); // scroll indicator ▲

                const optStartRow = y_options_start;
                const optEndRow = optStartRow + visibleCount - 1;

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
              const promptStartRow = workspaceStartRow + leftTopHeight + 1;
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
    if (agent && agent.isAgentRunning()) {
      try {
        agent.abort();
      } catch {}
      count++;
    }

    if (count > 0) {
      notifySubagentsChanged();
      notifySuperagentsChanged();
      setMasterLogs((prev) => [...prev, `[SYSTEM] 🛑 Interrupted ${count} running agent(s).`].slice(-500));
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

    if (key.ctrl && input === "t") {
      setIsHistoryTruncated((prev) => !prev);
      return;
    }

    const { inserted: currentInserted } = getPasteSplit(query, pastePrefixLength, pasteSuffixLength);
    const isPasteActive = isPasted && (currentInserted.length > 200 || currentInserted.includes("\n"));

    if (
      (key.backspace || key.delete) &&
      isPasteActive
    ) {
      setQuery((prev) => {
        const next = prev.slice(0, -1);
        const { inserted: nextInserted } = getPasteSplit(next, pastePrefixLength, pasteSuffixLength);
        if (next.length <= pastePrefixLength + pasteSuffixLength || (nextInserted.length <= 200 && !nextInserted.includes("\n"))) {
          setIsPasted(false);
        }
        return next;
      });
      return;
    }

    if (key.return) {
      if (isPasteActive) {
        handleQuerySubmit(query);
        return;
      }
    }

    if (key.escape) {
      if (isPasteActive) {
        setQuery("");
        setIsPasted(false);
        setHistoryIndex(-1);
        return;
      }
    }

    if (key.escape) {
      if (!activeWizard && focusArea === "input") {
        if (stopAllRunningAgents() > 0) {
          setCurrentTask("Idle - Interrupted");
          return;
        }
      }
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
        setIsPasted(false);
        return;
      }

      if (key.downArrow) {
        if (historyIndex !== -1) {
          if (historyIndex === history.length - 1) {
            setHistoryIndex(-1);
            setQuery(tempInput);
            setIsPasted(false);
          } else {
            const newIndex = historyIndex + 1;
            setHistoryIndex(newIndex);
            setQuery(history[newIndex]);
            setIsPasted(false);
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
        // For model step 3: navigate within filtered results based on current query
        if (activeWizard.type === "model" && activeWizard.step === 3) {
          const lc = query.trim();
          const len = lc
            ? filterSuggestions(wizardAllOptions, lc).length
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
          setIsPasted(false);
          return;
        }
      }
      
      if (focusArea === "input") {
        setFocusArea("list");
      } else if (focusArea === "list") {
        if (planState === "APPROVED" && checklistTasks.length > 0) {
          setFocusArea("checklist");
        } else if (runningSubagentsCount > 0) {
          setFocusArea("agents");
        } else if (runningTasksCount > 0) {
          setFocusArea("procs");
        } else {
          setFocusArea("logs");
        }
      } else if (focusArea === "checklist") {
        if (runningSubagentsCount > 0) {
          setFocusArea("agents");
        } else if (runningTasksCount > 0) {
          setFocusArea("procs");
        } else {
          setFocusArea("logs");
        }
      } else if (focusArea === "agents") {
        if (runningTasksCount > 0) {
          setFocusArea("procs");
        } else {
          setFocusArea("logs");
        }
      } else if (focusArea === "procs") {
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
      } else if (key.escape) {
        setFocusArea("input");
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
    } else if (focusArea === "checklist") {
      if (key.upArrow) {
        setChecklistScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setChecklistScrollOffset((prev) => {
          const maxScroll = Math.max(0, checklistTasks.length - maxChecklistVisible);
          return Math.min(prev + 1, maxScroll);
        });
      } else if (key.escape) {
        setFocusArea("input");
      }
    } else if (focusArea === "agents") {
      if (key.upArrow) {
        setAgentsScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setAgentsScrollOffset((prev) => {
          const runningAgents = Array.from(subagentInstances.values()).filter((s) => s.status === "running");
          const maxScroll = Math.max(0, runningAgents.length - maxAgentsVisible);
          return Math.min(prev + 1, maxScroll);
        });
      } else if (key.escape) {
        setFocusArea("input");
      }
    } else if (focusArea === "procs") {
      if (key.upArrow) {
        setProcsScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setProcsScrollOffset((prev) => {
          const runningProcs = Array.from(backgroundTasks.entries()).filter(([id, task]) => !task.hasExited);
          const maxScroll = Math.max(0, runningProcs.length - maxProcsVisible);
          return Math.min(prev + 1, maxScroll);
        });
      } else if (key.escape) {
        setFocusArea("input");
      }
    }
  });

  const renderStatusBadge = (status: AgentSession["status"]) => {
    if (status === "WORKING") {
      return activeBlink ? (
        <Text color="black" backgroundColor="yellow" bold>● ACTIVE</Text>
      ) : (
        <Text color="yellow" bold>  ACTIVE</Text>
      );
    }
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

  const maxVisibleSessions = Math.max(3, leftTopHeight - 2);
  let startIdx = 0;
  if (selectedIndex >= maxVisibleSessions) {
    startIdx = selectedIndex - maxVisibleSessions + 1;
  }
  const visibleSessions = sessions.slice(startIdx, startIdx + maxVisibleSessions);

  const activeWTs = [...superagentInstances.values()]
    .filter((i) => i.status === "running")
    .map((i) => i.branch);

  const activeContextUsage = lastMasterPromptTokens;
  const contextPercentage = contextLimit > 0 ? ((activeContextUsage / contextLimit) * 100).toFixed(2) : "0.00";

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0} width={terminalSize.width} height={terminalSize.height}>
      {/* Header Banner - High Tech Cyberpunk Style */}
      <Box flexDirection="row" justifyContent="space-between" paddingX={0} marginBottom={2} alignItems="center">
        <Box flexDirection="row" alignItems="center">
          {/* Info Column */}
          <Box flexDirection="column" justifyContent="center">
            <Box flexDirection="row" alignItems="center">
              <Text color="red" bold>S U P E R</Text>
              <Text color="white" bold>A G E N T</Text>
              <Text color="gray"> │ </Text>
              <Text color="yellow" bold>MULTI-AGENT SYSTEM</Text>
              <Text color="gray"> │ </Text>
              <Text color="magenta" bold>Branch: {gitBranch}</Text>
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
          <Box 
            flexDirection="column" 
            paddingX={1}
            height={leftTopHeight}
            marginBottom={1}
          >
            <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
              <Text bold color={focusArea === "list" ? "green" : "cyan"}>📡 WORKSPACE REGISTRY</Text>
              {focusArea === "list" && (
                <Text color="gray" dimColor> [↑/↓ Navigate • Enter Inspect]</Text>
              )}
            </Box>
            {sessions.length === 0 ? (
              <Box flexDirection="row" marginTop={0}>
                <Text color="gray" dimColor>No active agent threads detected</Text>
              </Box>
            ) : (
              visibleSessions.map((session, index) => {
                const globalIndex = startIdx + index;
                const isSelected = globalIndex === selectedIndex;
                const color = isSelected ? (focusArea === "list" ? "green" : "cyan") : tierColor[session.type];
                
                const isFocused = focusArea === "list";
                const rowBg = isSelected && isFocused ? "green" : undefined;
                const rowTextColor = isSelected && isFocused ? "black" : color;
                const tokenColor = isSelected && isFocused ? "black" : "cyan";
                
                const isSubagent = session.type === "SUBAGENT";
                let label = "";
                
                if (session.type === "MASTER") {
                  label = `[${globalIndex + 1}] master ❯ ${session.task}`;
                } else if (session.type === "SUPERAGENT") {
                  const action = getLatestSuperagentAction(session.logs);
                  const role = session.id.split("-")[1] || "superagent";
                  label = `[${globalIndex + 1}] ${role} ❯ ${action}`;
                } else if (session.type === "SUBAGENT") {
                  const action = getLatestSubagentAction(session.logs);
                  const name = session.id.split("-")[0];
                  label = `[${globalIndex + 1}] ${name} ❯ ${action}`;
                } else {
                  label = `[${globalIndex + 1}] ${session.id.slice(0, 14)}`;
                }
                
                const isActive = session.status === "WORKING";
                const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
                const spinnerChar = spinnerFrames[listSpinnerFrame] || "●";
                const indicatorText = isSelected 
                  ? "▶ " 
                  : (isActive ? `${spinnerChar} ` : "  ");
                const indicatorColor = isSelected
                  ? (focusArea === "list" ? "green" : "cyan")
                  : (isActive ? "yellow" : "gray");

                return (
                  <Box key={session.id} flexDirection="row" justifyContent="space-between" marginTop={0}>
                    <Box flexDirection="row" flexShrink={1}>
                      <Text bold color={indicatorColor}>
                        {indicatorText}
                      </Text>
                      <Text bold={isSelected} color={rowTextColor} backgroundColor={rowBg} wrap="truncate-end">
                        {isSubagent ? "  └─ 🔍 " : `${tierIcon[session.type]} `}
                        {label}
                      </Text>
                    </Box>
                    <Box flexShrink={0}>
                      {renderStatusBadge(session.status)}
                      {session.speed !== undefined && session.speed > 0 && (
                        <Text color={isSelected && isFocused ? "black" : "yellow"} backgroundColor={rowBg} bold> ⚡{session.speed.toFixed(1)}t/s</Text>
                      )}
                      {session.tokens > 0 
                        ? <Text color={tokenColor} backgroundColor={rowBg} dimColor={!isSelected || !isFocused}> {session.tokens.toLocaleString()}t</Text>
                        : <Text color={isSelected && isFocused ? "black" : "gray"} backgroundColor={rowBg} dimColor> --</Text>
                      }
                    </Box>
                  </Box>
                );
              })
            )}
          </Box>


          {/* Left Column Checklist, Active subagents & processes */}
          <Box flexDirection="column" width="100%" marginTop={0}>
            {planState === "PLANNING_PENDING" && activeWizard?.type !== "plan_approve" && (() => {
              const planUrl = "file:///" + path.resolve(agent.getPlanFilePath()).replace(/\\/g, "/");
              return (
                <Box marginBottom={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
                  <Text bold color="yellow">⚠️ PENDING_PLAN: RENCANA IMPLEMENTASI MEMBUTUHKAN PERSETUJUAN</Text>
                  <Text color="yellow">Model AI telah merancang rencana di file: <Text bold color="cyan">{planUrl}</Text></Text>
                  <Text color="yellow">Silakan kirim pesan/masukan apa saja untuk menampilkan kembali dialog persetujuan wizard.</Text>
                </Box>
              );
            })()}

            {planState === "APPROVED" && checklistTasks.length > 0 && (() => {
              const totalTasks = checklistTasks.length;
              const completedTasks = checklistTasks.filter((t) => t.status === "x").length;
              const inProgressTasks = checklistTasks.filter((t) => t.status === "/").length;
              const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
              const hasScroll = totalTasks > maxChecklistVisible;
              const scrollIndicator = hasScroll
                ? ` [Scroll: ${checklistScrollOffset + 1}-${Math.min(totalTasks, checklistScrollOffset + maxChecklistVisible)}/${totalTasks}]`
                : "";
              const helpText = focusArea === "checklist" ? " [↑/▼ Scroll • Esc Exit]" : "";
              const visibleChecklist = checklistTasks.slice(checklistScrollOffset, checklistScrollOffset + maxChecklistVisible);
              return (
                <Box flexDirection="column" borderStyle="round" borderColor={focusArea === "checklist" ? "green" : "cyan"} paddingX={1} marginBottom={1}>
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text bold color={focusArea === "checklist" ? "green" : "cyan"}>
                      📋 ACTIVE TASK CHECKLIST ({completedTasks}/{totalTasks} completed){scrollIndicator}{helpText}
                    </Text>
                  </Box>
                  <Box flexDirection="row" marginBottom={1}>
                    <Text color="cyan">Progress: {pct}% ({completedTasks}/{totalTasks} completed, {inProgressTasks} in progress)</Text>
                  </Box>
                  {visibleChecklist.map((task, index) => {
                    const idx = checklistScrollOffset + index;
                    let status = task.status;
                    let statusChar = "[ ]";
                    let taskColor = "white";
                    let displayStatusText = "";

                    // Dynamic status override in multi-agent mode based on active superagents
                    if (agent && agent.isMultiAgent) {
                      for (const inst of superagentInstances.values()) {
                        const roleLower = inst.role.toLowerCase();
                        if (task.text.toLowerCase().includes(roleLower)) {
                          const isMergeOrCleanup = /merge|cleanup|prune/i.test(task.text);
                          if (!isMergeOrCleanup) {
                            if (inst.status === "running") {
                              status = "/";
                            } else if (inst.status === "completed") {
                              status = "x";
                            } else if (inst.status === "error") {
                              status = "error";
                            }
                          } else {
                            if (inst.status === "completed") {
                              status = "/";
                            }
                          }
                          break;
                        }
                      }
                    }

                    if (status === "x") {
                      statusChar = "[✓]";
                      taskColor = "gray";
                    } else if (status === "/") {
                      statusChar = "[/]";
                      taskColor = "yellow";
                      displayStatusText = " (in progress)";
                    } else if (status === "error") {
                      statusChar = "[✗]";
                      taskColor = "red";
                      displayStatusText = " (failed)";
                    }

                    return (
                      <Box key={idx} flexDirection="row">
                        <Text color={status === "x" ? "green" : status === "/" ? "yellow" : status === "error" ? "red" : "cyan"}>
                          {statusChar}{" "}
                        </Text>
                        <Text color={taskColor} strikethrough={status === "x"}>
                          {task.text}{displayStatusText}
                        </Text>
                      </Box>
                    );
                  })}
                </Box>
              );
            })()}

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
          
          <Text color="white" bold>Task: <Text color="gray" bold={false}>{selectedSession.task}</Text></Text>

          {/* Log Window */}
          <Box flexDirection="column" marginTop={1} height={logBoxHeight} paddingX={1} justifyContent="flex-start">
            {visibleLogs}
            {selectedSession.status === "WORKING" && logScrollOffset === 0 && (selectedSession.type !== "MASTER" || !isExecutingTool) && (() => {
              const isIdleTask = selectedSession.task.startsWith("Idle") || selectedSession.task.startsWith("Error");
              const spinnerType = (selectedSession.type === "MASTER" && !isIdleTask) ? "orchestrating" : "processing";
              return (
                <Box flexDirection="row" marginTop={0}>
                  <ThinkingSpinner type={spinnerType} />
                  <Text color="green" bold>{activeBlink ? "█" : " "}</Text>
                </Box>
              );
            })()}
            {selectedSession.type === "MASTER" && isExecutingTool && (
              <Box flexDirection="column" marginTop={1}>
                <Text color="yellow">
                  ├───[ <Text bold color="yellow">⚙️ SYSTEM_CALL: EXECUTING...{timeLeft !== null ? ` (${timeLeft}s left)` : ""}</Text> ]
                </Text>
                <Box flexDirection="row">
                  <Text color="yellow">│    </Text>
                  <ToolLoadingIndicator />
                </Box>
                {activeToolLines.length > 0 && (
                  <>
                    <Text color="yellow">
                      ├───[ <Text bold color="yellow">⚙️ SYSTEM_CALL_OUTPUT (LIVE)</Text> ]
                    </Text>
                    {activeToolLines.map((line, idx) => (
                      <Box key={idx} flexDirection="row">
                        <Text color="yellow">│    </Text>
                        <Text color="gray">{line}</Text>
                      </Box>
                    ))}
                  </>
                )}
              </Box>
            )}
          </Box>
        </Box>
      </Box>

      {/* Horizontal Divider Line */}
      <Box flexDirection="row" paddingX={1} marginTop={1} marginBottom={0}>
        <Text color="gray" dimColor>{"─".repeat(terminalSize.width - 2)}</Text>
      </Box>

      {/* Wizard Dialog (if active - Full Width) */}
      {activeWizard && (() => {
        const wizardBorderColor = "cyan";
        return (
          <Box flexDirection="column" paddingX={1} marginY={0} width="100%">
            <Box flexDirection="row" marginTop={0}>
              <Text color={wizardBorderColor}>│</Text>
            </Box>
            {/* Model step 3: split out to handle query-based filtering like single agent */}
            {activeWizard.type === "model" && activeWizard.step === 3 && (() => {
              const lc = query.trim();
              const filteredModels = lc
                ? filterSuggestions(wizardAllOptions, lc)
                : wizardAllOptions;
              const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredModels.length - 1));
              const tierStr = activeWizard.data.tier ? ` FOR ${activeWizard.data.tier.toUpperCase()}` : "";
              const provStr = activeWizard.data.provider ? ` VIA ${activeWizard.data.provider.toUpperCase()}` : "";
              const searchTitle = wizardIsLoadingModels
                ? `⚙️ SELECT MODEL${tierStr}${provStr} — ⏳ loading...`
                : lc
                  ? `⚙️ SELECT MODEL${tierStr}${provStr} — 🔍 "${query.trim()}" (${filteredModels.length}/${wizardAllOptions.length} results):`
                  : `⚙️ SELECT MODEL${tierStr}${provStr} (${wizardAllOptions.length} available — type to filter, ↑/↓ navigate, Enter select):`;
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
            {(activeWizard.type !== "model" || activeWizard.step !== 3) && (
              <WizardDialog
                title={
                  activeWizard.type === "model" && activeWizard.step === 1 ? `⚙️ SELECT AGENT TIER TO CONFIGURE:` :
                  activeWizard.type === "model" && activeWizard.step === 2 ? `⚙️ SELECT MODEL PROVIDER FOR ${activeWizard.data.tier?.toUpperCase() || "MODELS"}:` :
                  activeWizard.type === "resume" ? `📁 SELECT SESSION TO RESUME:` :
                  activeWizard.type === "skills" ? `🛠️ SKILLS MANAGER (Step ${activeWizard.step}):` :
                  activeWizard.type === "checkpoint" ? `📋 CHECKPOINT MANAGER (Step ${activeWizard.step}):` :
                  activeWizard.type === "plan_approve" ? `⚠️ PLAN APPROVAL REQUIRED (Use Arrow Keys Up/Down & Enter):` :
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
                  activeWizard.type === "plan_approve" ? `Model AI telah merancang rencana di file: file:///${path.resolve(agent.getPlanFilePath()).replace(/\\/g, "/")}` :
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
                maxVisible={10}
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

      {/* Active Subagents & Tasks Live List (Full Width) */}
      {(runningSubagentsCount > 0 || runningTasksCount > 0) && (
        <Box flexDirection="column" paddingX={1} marginBottom={1} width="100%">
          {runningSubagentsCount > 0 && (() => {
            const runningAgents = Array.from(subagentInstances.values()).filter((s) => s.status === "running");
            const totalAgents = runningAgents.length;
            const hasScroll = totalAgents > maxAgentsVisible;
            const scrollIndicator = hasScroll
              ? ` [Scroll: ${agentsScrollOffset + 1}-${Math.min(totalAgents, agentsScrollOffset + maxAgentsVisible)}/${totalAgents}]`
              : "";
            const helpText = focusArea === "agents" ? " [↑/▼ Scroll • Esc Exit]" : "";
            const visibleAgents = runningAgents.slice(agentsScrollOffset, agentsScrollOffset + maxAgentsVisible);
            return (
              <Box flexDirection="column">
                <Text color={focusArea === "agents" ? "green" : "yellow"} bold>
                  🤖 ACTIVE SUBAGENTS:{scrollIndicator}{helpText}
                </Text>
                {visibleAgents.map((inst) => (
                  <Box key={inst.id} flexDirection="column">
                    <Text color="yellow">
                      ├─ [{inst.id}] Type: {inst.typeName} | Role: {inst.role} ({inst.status})
                    </Text>
                    <Text color="yellow">
                      │  └─ Action: <Text italic color="white">{getLatestSubagentAction(inst.logs)}</Text>
                    </Text>
                  </Box>
                ))}
              </Box>
            );
          })()}
          {runningTasksCount > 0 && (() => {
            const runningProcs = Array.from(backgroundTasks.entries()).filter(([id, task]) => !task.hasExited);
            const totalProcs = runningProcs.length;
            const hasScroll = totalProcs > maxProcsVisible;
            const scrollIndicator = hasScroll
              ? ` [Scroll: ${procsScrollOffset + 1}-${Math.min(totalProcs, procsScrollOffset + maxProcsVisible)}/${totalProcs}]`
              : "";
            const helpText = focusArea === "procs" ? " [↑/▼ Scroll • Esc Exit]" : "";
            const visibleProcs = runningProcs.slice(procsScrollOffset, procsScrollOffset + maxProcsVisible);
            return (
              <Box flexDirection="column" marginTop={runningSubagentsCount > 0 ? 1 : 0}>
                <Text color={focusArea === "procs" ? "green" : "cyan"} bold>
                  ⚙️ ACTIVE PROCESSES:{scrollIndicator}{helpText}
                </Text>
                {visibleProcs.map(([id, task]) => (
                  <Text key={id} color="cyan">
                    ├─ [{id}] Command: {task.command}
                  </Text>
                ))}
              </Box>
            );
          })()}
        </Box>
      )}

      {/* Interactive Full-Width Console Prompt */}
      {focusArea === "input" && query.startsWith("/") && suggestions.length > 0 && (
        <Box flexDirection="row" marginBottom={1} paddingX={1}>
          <Text color="cyan" dimColor>│   </Text>
          <Text color="gray" dimColor>Suggestions: </Text>
          {suggestions.slice(0, 5).map((s, idx) => (
            <Text key={s} color={s === query ? "cyan" : "gray"} bold={s === query} underline={s === query}>
              {s}{idx < Math.min(suggestions.length, 5) - 1 ? "  " : ""}
            </Text>
          ))}
          {suggestions.length > 5 && <Text color="gray" dimColor> (+{suggestions.length - 5} more)</Text>}
        </Box>
      )}
      <Box flexDirection="row" marginTop={0} paddingX={1} width="100%">
        <Box flexShrink={0}>
          <Text bold color={focusArea === "input" ? "green" : "cyan"}>
            {activeWizard?.type === "model" && activeWizard.step === 3
              ? "└──[ MODEL ] ❯ "
              : activeWizard?.type === "model" && activeWizard.step === 2
              ? "└──[ PROVIDER ] ❯ "
              : activeWizard?.type === "model" && activeWizard.step === 1
              ? "└──[ TIER ] ❯ "
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
        <Box flexGrow={1}>
          {(() => {
            const { prefix, inserted, suffix } = getPasteSplit(query, pastePrefixLength, pasteSuffixLength);
            const isPasteActive = isPasted && (inserted.length > 200 || inserted.includes("\n"));
            if (isPasteActive) {
              const lineCount = inserted.split("\n").length;
              return (
                <Box flexDirection="row">
                  {prefix ? <Text>{prefix}</Text> : null}
                  <Text color="yellow" bold>[Pasted Text: {inserted.length} chars, {lineCount} lines] </Text>
                  {suffix ? <Text>{suffix}</Text> : null}
                  <Text dimColor>(Press Enter to send, Esc to clear)</Text>
                </Box>
              );
            }
            return (
              <TextInput
                value={query}
                onChange={handleQueryChange}
                onSubmit={handleQuerySubmit}
                focus={focusArea === "input"}
              />
            );
          })()}
        </Box>
      </Box>

      {/* Footer System statistics & shortcuts */}
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box>
            <Text>
              <Text color="green" bold>🟢 ONLINE</Text>
              <Text color="gray"> │ </Text>
              <Text color="yellow" bold>{activeModel}</Text>
              <Text color="gray"> │ </Text>
              <Text color="green" bold>Ctx: {contextPercentage}% ({formatCompactNumber(activeContextUsage)}/{formatCompactNumber(contextLimit)})</Text>
              {lastSpeed !== null && (
                <>
                  <Text color="gray"> │ </Text>
                  <Text color="cyan" bold>⚡ {lastSpeed.toFixed(1)} t/s</Text>
                </>
              )}
              <Text color="gray"> │ </Text>
              <Text color="magenta" bold>Master: {(masterPromptTokens + masterCompletionTokens).toLocaleString()}t</Text>
              <Text color="gray"> │ </Text>
              <Text color="cyan" bold>Superagents({[...superagentInstances.values()].filter(i => i.status === "running").length} active): {historicalSuperagentTokens.toLocaleString()}t</Text>
              <Text color="gray"> │ </Text>
              <Text color="yellow" bold>Subagents: {[...subagentInstances.values()].reduce((acc, i) => acc + (i.tokenUsage?.prompt ?? 0) + (i.tokenUsage?.completion ?? 0), 0).toLocaleString()}t</Text>
              <Text color="gray"> │ </Text>
              <Text color="blue" bold>Worktrees: {worktreeCount}</Text>
              <Text color="gray"> │ </Text>
              <Text color="yellow" bold>Proc: {runningTasksCount}</Text>
              <Text color="gray"> • </Text>
              <Text color="magenta" bold>Sub: {runningSubagentsCount}</Text>
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
          {activeWizard ? (
            <Text color="yellow">
              <Text bold color="yellow">⚡ [WIZARD] </Text>
              {activeWizard.isMultiSelect ? (
                <Text color="gray" dimColor>[▲/▼] Navigate  [Space] Select/Toggle  [Enter] Confirm  [Esc] Cancel</Text>
              ) : wizardOptions.length > 0 ? (
                <Text color="gray" dimColor>[▲/▼] Navigate  [Enter] Select  [Esc] Cancel</Text>
              ) : (
                <Text color="gray" dimColor>[Type text...]  [Enter] Submit  [Esc] Cancel</Text>
              )}
            </Text>
          ) : (
            <Text color="gray" dimColor>
              <Text bold color="cyan">[{focusArea.toUpperCase()}] </Text>
              {focusArea === "input" && (
                <Text>[Tab] Focus List  [▲/▼] History  [Ctrl+T] Toggle Truncate  [Ctrl+C] Exit/Interrupt</Text>
              )}
              {focusArea === "list" && (
                <Text>[▲/▼] Select Session  [1-9] Quick Select  [Enter] View Logs  [Tab] Cycle Focus  [Esc] Focus Input</Text>
              )}
              {focusArea === "logs" && (
                <Text>[▲/▼] Scroll Logs  [Esc] Focus List  [Tab] Cycle Focus</Text>
              )}
              {focusArea === "checklist" && (
                <Text>[▲/▼] Scroll Checklist  [Esc] Focus Input  [Tab] Cycle Focus</Text>
              )}
              {focusArea === "agents" && (
                <Text>[▲/▼] Scroll Agents  [Esc] Focus Input  [Tab] Cycle Focus</Text>
              )}
              {focusArea === "procs" && (
                <Text>[▲/▼] Scroll Processes  [Esc] Focus Input  [Tab] Cycle Focus</Text>
              )}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function getLatestSubagentAction(logs: string[]): string {
  if (!logs || logs.length === 0) return "Initializing...";
  for (let i = logs.length - 1; i >= 0; i--) {
    const raw = logs[i].trim();
    if (raw) {
      let clean = raw
        .replace(/^.*?───\[\s*/, "")
        .replace(/\s*\]$/, "")
        .replace(/^[│┌├└─\s]+/, "")
        .trim();
      clean = clean.replace(/^Description:\s*/i, "");
      clean = clean.replace(/^Args:\s*/i, "");
      if (clean) {
        return clean.length > 80 ? clean.slice(0, 80) + "..." : clean;
      }
    }
  }
  return "Processing...";
}

function getLatestSuperagentAction(logs: string[]): string {
  if (!logs || logs.length === 0) return "Initializing...";
  for (let i = logs.length - 1; i >= 0; i--) {
    const raw = logs[i].trim();
    if (raw) {
      let clean = raw
        .replace(/^\[THINK\]\s*/i, "")
        .replace(/^\[TOOL:START\]\s*/i, "")
        .replace(/^\[TOOL:SUCCESS\]\s*/i, "")
        .replace(/^\[TOOL:FAILED\]\s*/i, "")
        .replace(/^\[ERROR\]\s*/i, "")
        .replace(/^[│┌├└─\s]+/, "")
        .trim();
      if (clean) {
        return clean.length > 60 ? clean.slice(0, 60) + "..." : clean;
      }
    }
  }
  return "Processing...";
}
