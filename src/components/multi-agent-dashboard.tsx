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
  getRootConfigDir,
  getModelPresets,
  applyModelPreset
} from "../core/config.js";

import { 
  filterSuggestions, 
  formatCompactNumber,
  getInsertion,
  getPasteSplit,
  stripSgrMouseSequences
} from "../utils/text.js";
import { WizardDialog } from "./wizard-dialog.js";
import { handleSlashCommand, getDefaultModel } from "../core/slash-commands.js";
import { listCheckpointsForSession, restoreCheckpoint } from "../core/checkpoints.js";
import { allTools } from "../core/tools.js";
import { readChecklistTasks } from "../core/taskChecklist.js";

// Import extracted subcomponents
import { RegistryPanel } from "./dashboard/registry-panel.js";
import { InspectorPanel, renderLogInlineStyles } from "./dashboard/inspector-panel.js";
import { ChecklistPanel } from "./dashboard/checklist-panel.js";
import { DashboardWizard } from "./dashboard/dashboard-wizard.js";
import { ActiveSubagentsPanel } from "./dashboard/active-subagents-panel.js";
import { ActiveProcessesPanel } from "./dashboard/active-processes-panel.js";
import { DashboardStatusBar } from "./dashboard/dashboard-status-bar.js";

// Import hooks
import { useDashboardWizard } from "../hooks/useDashboardWizard.js";
import { useDashboardMouse } from "../hooks/useDashboardMouse.js";
import { useDashboardKeyboard } from "../hooks/useDashboardKeyboard.js";


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
  parentId?: string;
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

    const { handleWizardSubmit, handleQuerySubmit } = useDashboardWizard({
    agent,
    exit,
    query,
    setQuery,
    activeWizard,
    setActiveWizard,
    wizardOptions,
    setWizardOptions,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    wizardSelectedSet,
    setWizardSelectedSet,
    masterLogs,
    setMasterLogs,
    activeModel,
    setActiveModel,
    currentTask,
    setCurrentTask,
    history,
    setHistory,
    historyIndex,
    setHistoryIndex,
    tempInput,
    setTempInput,
    planState,
    setPlanState,
    pendingQuestion,
    setPendingQuestion,
    wizardAllOptions,
    setWizardAllOptions,
    wizardIsLoadingModels,
    setWizardIsLoadingModels,
    checkpointsList,
    setCheckpointsList,
    contextLimit,
    setContextLimit,
    isPasted,
    setIsPasted,
    pastePrefixLength,
    pasteSuffixLength,
    HISTORY_FILE,
    cachedSessions,
    setCachedSessions,
  });

  // Update sessions list from live state
  useEffect(() => {
    const update = () => {
      const list: AgentSession[] = [];

      // Group subagents by parentId
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
          tokens: (instance.tokenUsage?.prompt || 0) + (instance.tokenUsage?.completion || 0),
          logs: instance.logs && instance.logs.length > 0 ? instance.logs : ["Awaiting output..."],
          branch: "worktree",
          speed: instance.speed,
          parentId,
        });
      }

      // Check for active agents or background tasks
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

      // Push all subagent sessions belonging to "master"
      const masterSubs = subagentSessionsMap.get("master") || [];
      list.push(...masterSubs);

      // Superagent instances
      for (const [id, instance] of superagentInstances.entries()) {
        list.push({
          id: `sa-${instance.role}-${id}`,
          type: "SUPERAGENT",
          task: `[${instance.role}] ${instance.task}`,
          status: instance.status === "running" ? "WORKING"
                : instance.status === "completed" ? "COMPLETED"
                : "ERROR",
          tokens: (instance.tokenUsage?.prompt || 0) + (instance.tokenUsage?.completion || 0),
          logs: instance.logs.length > 0 ? instance.logs : ["Superagent initialising..."],
          branch: instance.branch,
          worktreePath: instance.worktreePath,
          speed: instance.speed,
        });

        // Push all subagent sessions belonging to this superagent
        const saSubs = subagentSessionsMap.get(id) || [];
        list.push(...saSubs);
      }

      // Fallback: Remaining Subagents
      for (const [parentId, subs] of subagentSessionsMap.entries()) {
        if (parentId !== "master" && !superagentInstances.has(parentId)) {
          list.push(...subs);
        }
      }

      // Active background tasks
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
  const feedWidth = Math.max(10, Math.floor(terminalSize.width * 0.58) - 4);
  const taskStr = selectedSession.task || "";
  const normalizedTask = taskStr.replace(/\r\n/g, "\n").replace(/\r/g, "");
  const taskLines = normalizedTask.split("\n").filter(line => line.trim() !== "");
  let renderedTaskLinesCount = 0;
  if (taskLines.length > 0) {
    if (isHistoryTruncated) {
      renderedTaskLinesCount = 1;
    } else {
      renderedTaskLinesCount = 1; // "Task:" label line
      for (const line of taskLines) {
        renderedTaskLinesCount += Math.max(1, Math.ceil(line.length / feedWidth));
      }
    }
  }
  const logBoxHeight = Math.max(5, workspaceHeight - 3 - (renderedTaskLinesCount || 1));
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
      for (const logStr of group.rawLines) {
        const cleanedLogStr = logStr.replace(/\r\n/g, "\n").replace(/\r/g, "");
        const subLines = isHistoryTruncated
          ? cleanedLogStr.split("\n")
          : wrapTextForDisplay(cleanedLogStr, feedWidth);
        for (let i = 0; i < subLines.length; i++) {
          const lineText = subLines[i];
          wrappedLines.push(
            <Box flexDirection="row" key={`log-line-${groupIdx}-${i}`} width={feedWidth}>
              <Text color={group.color} wrap={isHistoryTruncated ? "truncate-end" : undefined}>{lineText}</Text>
            </Box>
          );
        }
      }
      continue;
    }

    const prefix = groupIdx === 0 ? "┌───" : (groupIdx === groups.length - 1 ? "└───" : "├───");
    const subLinePrefix = groupIdx === groups.length - 1 ? "    " : "│   ";

    wrappedLines.push(
      <Box flexDirection="row" key={`log-header-${groupIdx}`} width={feedWidth}>
        <Text color={group.color === "gray" ? "gray" : group.color} bold wrap={isHistoryTruncated ? "truncate-end" : undefined}>
          {prefix} <Text color="white" bold>[ </Text>
          <Text color={group.color === "gray" ? "gray" : group.color} bold>{group.label}</Text>
          <Text color="white" bold> ]</Text>
        </Text>
      </Box>
    );

    let inCode = false;
    for (let rawLineIdx = 0; rawLineIdx < group.rawLines.length; rawLineIdx++) {
      const content = group.rawLines[rawLineIdx];
      const cleanedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
      const subLines = isHistoryTruncated
        ? cleanedContent.split("\n")
        : wrapTextForDisplay(cleanedContent, Math.max(10, feedWidth - 8));

      for (let i = 0; i < subLines.length; i++) {
        const lineText = subLines[i];
        const trimmed = lineText.trim();

        if (group.parseMarkdown) {
          if (trimmed.startsWith("```")) {
            inCode = !inCode;
            const codeLang = trimmed.slice(3).trim() || "TEXT";
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
                <Text color="gray" italic wrap={isHistoryTruncated ? "truncate-end" : undefined}>{inCode ? `┌─── [ CODE: ${codeLang} ]` : "└─── [ END CODE ]"}</Text>
              </Box>
            );
            continue;
          }

          if (inCode) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}│  </Text>
                <Text color="green" wrap={isHistoryTruncated ? "truncate-end" : undefined}>{lineText}</Text>
              </Box>
            );
            continue;
          }

          if (trimmed.startsWith("# ")) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
                <Text bold color="yellow" wrap={isHistoryTruncated ? "truncate-end" : undefined}>{lineText.slice(2)}</Text>
              </Box>
            );
            continue;
          }
          if (trimmed.startsWith("## ")) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
                <Text bold color="cyan" wrap={isHistoryTruncated ? "truncate-end" : undefined}>{lineText.slice(3)}</Text>
              </Box>
            );
            continue;
          }
          if (trimmed.startsWith("### ")) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
                <Text bold color="blue" wrap={isHistoryTruncated ? "truncate-end" : undefined}>{lineText.slice(4)}</Text>
              </Box>
            );
            continue;
          }

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
                <Text wrap={isHistoryTruncated ? "truncate-end" : undefined}>
                  {renderLogInlineStyles(remainingLine, group.color === "gray" ? "gray" : group.color, group.isBold, group.dimColor)}
                </Text>
              </Box>
            </Box>
          );
        } else {
          wrappedLines.push(
            <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
              <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
              <Text color={group.color === "gray" ? "gray" : group.color} bold={group.isBold} dimColor={group.dimColor} wrap={isHistoryTruncated ? "truncate-end" : undefined}>{lineText}</Text>
            </Box>
          );
        }
      }
    }

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

  useDashboardKeyboard({
    exit,
    stopAllRunningAgents,
    setCurrentTask,
    setIsHistoryTruncated,
    query,
    setQuery,
    pastePrefixLength,
    pasteSuffixLength,
    isPasted,
    setIsPasted,
    handleQuerySubmit,
    activeWizard,
    setActiveWizard,
    focusArea,
    setFocusArea,
    setLogScrollOffset,
    history,
    historyIndex,
    setHistoryIndex,
    tempInput,
    setTempInput,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    wizardAllOptions,
    wizardOptions,
    wizardSelectedSet,
    setWizardSelectedSet,
    setWizardOptions,
    setWizardAllOptions,
    setWizardIsLoadingModels,
    pendingQuestion,
    setPendingQuestion,
    suggestions,
    planState,
    checklistTasks,
    runningSubagentsCount,
    runningTasksCount,
    setSelectedIndex,
    sessions,
    selectedIndex,
    wrappedLines,
    logsCount,
    setChecklistScrollOffset,
    maxChecklistVisible,
    setAgentsScrollOffset,
    maxAgentsVisible,
    setProcsScrollOffset,
    maxProcsVisible,
  });

  useDashboardMouse({
    wrappedLines,
    logsCount,
    terminalSize,
    activeWizard,
    setActiveWizard,
    wizardOptions,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    wizardSelectedSet,
    setWizardSelectedSet,
    setWizardOptions,
    pendingQuestion,
    handleWizardSubmit,
    query,
    setQuery,
    wizardAllOptions,
    workspaceHeight,
    leftTopHeight,
    wizardIsLoadingModels,
    agent,
    setFocusArea,
    setLogScrollOffset,
  });

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
        {/* Left Column (Registry + Checklist + Console Input) */}
        <Box flexDirection="column" width="40%" height={workspaceHeight}>
          {/* Top Left: Workspace Registry */}
          <RegistryPanel
            sessions={sessions}
            selectedIndex={selectedIndex}
            focusArea={focusArea}
            startIdx={startIdx}
            visibleSessions={visibleSessions}
            getLatestSuperagentAction={getLatestSuperagentAction}
            getLatestSubagentAction={getLatestSubagentAction}
            leftTopHeight={leftTopHeight}
          />

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

            <ChecklistPanel
              planState={planState}
              checklistTasks={checklistTasks}
              focusArea={focusArea}
              checklistScrollOffset={checklistScrollOffset}
              maxChecklistVisible={maxChecklistVisible}
              agent={agent}
              superagentInstances={superagentInstances}
            />
          </Box>
        </Box>

        {/* Vertical Spacer */}
        <Box width="2%" />

        {/* Right Column: Log Console Inspector (Full Height) */}
        <InspectorPanel
          selectedSession={selectedSession}
          focusArea={focusArea}
          logScrollOffset={logScrollOffset}
          isHistoryTruncated={isHistoryTruncated}
          feedWidth={feedWidth}
          logBoxHeight={logBoxHeight}
          visibleLogs={visibleLogs}
          isExecutingTool={isExecutingTool}
          timeLeft={timeLeft}
          activeToolLines={activeToolLines}
          workspaceHeight={workspaceHeight}
        />
      </Box>

      {/* Horizontal Divider Line */}
      <Box flexDirection="row" paddingX={1} marginTop={1} marginBottom={0}>
        <Text color="gray" dimColor>{"─".repeat(terminalSize.width - 2)}</Text>
      </Box>

      {/* Wizard Dialog (if active - Full Width) */}
      <DashboardWizard
        activeWizard={activeWizard}
        query={query}
        wizardAllOptions={wizardAllOptions}
        wizardSelectedIndex={wizardSelectedIndex}
        wizardIsLoadingModels={wizardIsLoadingModels}
        wizardOptions={wizardOptions}
        wizardSelectedSet={wizardSelectedSet}
        pendingQuestion={pendingQuestion}
        agent={agent}
      />

      {/* Active Subagents & Tasks Live List (Full Width) */}
      {(runningSubagentsCount > 0 || runningTasksCount > 0) && (
        <Box flexDirection="column" paddingX={1} marginBottom={0} width="100%">
          <ActiveSubagentsPanel
            subagentInstances={subagentInstances}
            agentsScrollOffset={agentsScrollOffset}
            maxAgentsVisible={maxAgentsVisible}
            focusArea={focusArea}
            getLatestSubagentAction={getLatestSubagentAction}
          />
          <ActiveProcessesPanel
            backgroundTasks={backgroundTasks}
            procsScrollOffset={procsScrollOffset}
            maxProcsVisible={maxProcsVisible}
            focusArea={focusArea}
            runningSubagentsCount={runningSubagentsCount}
          />
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
      <DashboardStatusBar
        activeModel={activeModel}
        contextPercentage={contextPercentage}
        activeContextUsage={activeContextUsage}
        contextLimit={contextLimit}
        lastSpeed={lastSpeed}
        masterPromptTokens={masterPromptTokens}
        masterCompletionTokens={masterCompletionTokens}
        historicalSuperagentTokens={historicalSuperagentTokens}
        activeSuperagentsCount={[...superagentInstances.values()].filter(i => i.status === "running").length}
        subagentInstances={subagentInstances}
        worktreeCount={worktreeCount}
        runningTasksCount={runningTasksCount}
        runningSubagentsCount={runningSubagentsCount}
        activeWTs={activeWTs}
        activeWizard={activeWizard}
        wizardOptions={wizardOptions}
        focusArea={focusArea}
      />
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
