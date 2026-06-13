import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { Agent } from "./core/agent.js";
import type { AgentEvent, PermissionHandler, QuestionHandler } from "./core/agent.js";
import type { ToolCall } from "./core/conversation.js";
import { Banner } from "./components/banner.js";
import { getContextWindowLimit, updateEnvFile, getInstalledSkills, getConfiguredProviders, switchActiveProvider, listHistorySessions, fetchAndCacheModels } from "./core/config.js";
import { getPresetLabel } from "./core/slash-commands.js";
import { createCheckpoint, listCheckpointsForSession, terminateActiveTasksAndSubagents, restoreCheckpoint, type Checkpoint } from "./core/checkpoints.js";
import { getGlobalConfigDir } from "./core/config.js";
import { getToolDescription } from "./core/permissions.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { registerSubagentType, allTools, backgroundTasks, subagentInstances, superagentInstances, subscribeToTasks, subscribeToSubagents, subscribeToSuperagents, subscribeToSchedules, subscribeToActiveOutput, registerQuestionHandler, notifySubagentsChanged } from "./core/tools.js";
import { WizardDialog } from "./components/wizard-dialog.js";
import { execa } from "execa";
import { resolveCarriageReturns, formatArgs, formatCompactNumber, filterSuggestions } from "./utils/text.js";
import { capDisplayLines, getTruncatedAssistantIndexes, renderScrollBar, wrapTextForDisplay } from "./utils/responseScroll.js";
import { handleSlashCommand, getProviderLabel, getDefaultModel } from "./core/slash-commands.js";
import type { ChatLine } from "./core/slash-commands.js";


export function stripSgrMouseSequences(value: string): string {
  return value.replace(/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/g, "");
}

export function App({
  autoResume = false,
  onHistoryChange,
  initialPrompt,
}: {
  autoResume?: boolean;
  onHistoryChange?: (exists: boolean) => void;
  initialPrompt?: string;
}) {
  const { exit } = useApp();
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [isPasted, setIsPasted] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExecutingTool, setIsExecutingTool] = useState(false);
  const [streamDisplay, setStreamDisplay] = useState("");
  const [pendingPermission, setPendingPermission] = useState<{
    toolCall: ToolCall;
    description: string;
    resolve: (value: boolean) => void;
  } | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<{
    question: string;
    options: string[];
    resolve: (value: string) => void;
  } | null>(null);
  const [lastTabPrefix, setLastTabPrefix] = useState<string | null>(null);
  const [tokensUp, setTokensUp] = useState(0);
  const [tokensDown, setTokensDown] = useState(0);
  const [lastPromptTokens, setLastPromptTokens] = useState(0);
  const [contextLimit, setContextLimit] = useState(256000);
  const streamBufferRef = useRef("");
  const lastStreamUpdateRef = useRef<number>(0);
  const streamTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [tempInput, setTempInput] = useState("");
  const agentRef = useRef<Agent | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [focusedResponseIndex, setFocusedResponseIndex] = useState<number | null>(null);
  const [focusedResponseOffset, setFocusedResponseOffset] = useState(0);
  const [runningTasksCount, setRunningTasksCount] = useState(0);
  const [runningSubagentsCount, setRunningSubagentsCount] = useState(0);
  const [runningSuperagentsCount, setRunningSuperagentsCount] = useState(0);
  const [goalMode, setGoalMode] = useState<{ goal: string; startedAt: number } | null>(null);
  const [toolTimeout, setToolTimeout] = useState<number | null>(null);
  const [toolStartTime, setToolStartTime] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [activeWizard, setActiveWizard] = useState<{
    type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills";
    step: number;
    data: Record<string, string>;
    isMultiSelect?: boolean;
  } | null>(null);
  const [wizardSelectedSet, setWizardSelectedSet] = useState<Set<number>>(new Set());
  const [checkpointsList, setCheckpointsList] = useState<Checkpoint[]>([]);
  const [wizardSelectedIndex, setWizardSelectedIndex] = useState(0);
  const [wizardOptions, setWizardOptions] = useState<string[]>([]);
  const [wizardIsLoadingModels, setWizardIsLoadingModels] = useState(false);
  const [planState, setPlanState] = useState<"IDLE" | "PLANNING_PENDING" | "APPROVED">("IDLE");
  const [checklistTasks, setChecklistTasks] = useState<{ status: string; text: string }[]>([]);
  const [focusMode, setFocusMode] = useState<"input" | "history">("input");
  const [historySelectedIndex, setHistorySelectedIndex] = useState<number>(0);
  const [checkpointsListState, setCheckpointsListState] = useState<Checkpoint[]>([]);
  const [terminalPresets, setTerminalPresets] = useState<{ key: string; label: string }[]>([]);
  const [terminalHeight, setTerminalHeight] = useState(process.stdout.rows || 30);
  const [terminalWidth, setTerminalWidth] = useState(process.stdout.columns || 80);
  const [gitBranch, setGitBranch] = useState<string>("");
  const scrollChat = useCallback((direction: "up" | "down", amount = 1) => {
    setScrollOffset((prev) => {
      if (direction === "down") {
        return Math.max(0, prev - amount);
      }
      const maxScroll = Math.max(0, lines.length - 15);
      return Math.min(prev + amount, maxScroll);
    });
  }, [lines.length]);
  const addLine = useCallback((line: ChatLine) => {
    setLines((prev) => [...prev, line]);
  }, []);
  const openLatestTruncatedResponse = useCallback(() => {
    const width = Math.max(20, terminalWidth - 6);
    const maxLines = Math.max(8, Math.min(18, Math.floor(terminalHeight * 0.45)));
    const truncatedIndexes = getTruncatedAssistantIndexes(lines, maxLines, width);
    const latestIndex = truncatedIndexes[truncatedIndexes.length - 1];
    if (latestIndex !== undefined) {
      setFocusedResponseIndex(latestIndex);
      setFocusedResponseOffset(0);
      setScrollOffset(0);
      return true;
    }
    addLine({ type: "system", content: "No long response to open.", timestamp: Date.now() });
    return false;
  }, [addLine, lines, terminalHeight, terminalWidth]);

  const stopRunningSubagents = useCallback(() => {
    const runningSubagents = Array.from(subagentInstances.values()).filter((s) => s.status === "running");
    if (runningSubagents.length === 0) {
      return 0;
    }

    for (const inst of runningSubagents) {
      inst.agent.abort();
      subagentInstances.delete(inst.id);
    }
    notifySubagentsChanged();

    addLine({
      type: "system",
      content: `Interrupted ${runningSubagents.length} running subagent${runningSubagents.length === 1 ? "" : "s"}.`,
      timestamp: Date.now(),
    });
    return runningSubagents.length;
  }, [addLine]);

  useEffect(() => {
    if (!activeWizard) {
      setWizardSelectedSet(new Set());
    }
  }, [activeWizard]);

  useEffect(() => {
    if (input.length === 0) {
      setIsPasted(false);
    }
  }, [input]);

  useEffect(() => {
    if (input.startsWith("/terminal")) {
      const loadPresets = async () => {
        try {
          const cwd = process.cwd();
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
              if (data && data.presets) {
                presets = data.presets;
              } else {
                presets = data;
              }
              break;
            } catch {
              // ignore
            }
          }
          setTerminalPresets(
            Object.keys(presets).map(k => ({ key: k, label: getPresetLabel(k, presets[k]) }))
          );
        } catch {
          // ignore
        }
      };
      loadPresets();
    }
  }, [input]);

  useEffect(() => {
    if (input.startsWith("/checkpoint") && agentRef.current) {
      const sessionPath = agentRef.current.getCurrentHistoryFilePath();
      listCheckpointsForSession(sessionPath)
        .then((list) => {
          setCheckpointsListState(list);
        })
        .catch(() => {});
    }
  }, [input]);

  useEffect(() => {
    const handleResize = () => {
      setTerminalHeight(process.stdout.rows || 30);
      setTerminalWidth(process.stdout.columns || 80);
    };
    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY || !stdout.isTTY) {
      return;
    }

    const enableMouseTracking = "\x1b[?1000h\x1b[?1006h";
    const disableMouseTracking = "\x1b[?1006l\x1b[?1000l";

    const handleMouseInput = (data: Buffer) => {
      const text = data.toString("utf8");
      const wheelEvents = text.matchAll(/\x1b\[<(?<button>64|65);\d+;\d+M/g);

      for (const event of wheelEvents) {
        const button = event.groups?.button;
        if (button === "64") {
          scrollChat("up", 3);
        } else if (button === "65") {
          scrollChat("down", 3);
        }
      }
    };

    stdout.write(enableMouseTracking);
    stdin.on("data", handleMouseInput);

    return () => {
      stdin.off("data", handleMouseInput);
      stdout.write(disableMouseTracking);
    };
  }, [scrollChat]);

  useEffect(() => {
    const fetchBranch = async () => {
      try {
        const { stdout } = await execa("git", ["branch", "--show-current"], { cwd: process.cwd(), reject: false });
        setGitBranch(stdout?.trim() || "");
      } catch {
        // ignore
      }
    };
    fetchBranch();
    const interval = setInterval(fetchBranch, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const unsubTasks = subscribeToTasks(() => {
      const allTasks = Array.from(backgroundTasks.values());
      // Detached windows never set hasExited; count them as always running
      setRunningTasksCount(
        allTasks.filter((t) => t.isDetachedWindow || !t.hasExited).length
      );
      // Push notifications: Log completed background tasks (skip detached windows)
      allTasks.forEach((task) => {
        if (task.isDetachedWindow) return;   // window is alive independently — no completion event
        if (task.hasExited && !(task as any).notified) {
          (task as any).notified = true;
          const msg = `⚙️ [BACKGROUND TASK NOTIFICATION]: Task ${task.id} ("${task.command}") has completed with exit code ${task.exitCode}!`;
          addLine({
            type: "system",
            content: msg,
            timestamp: Date.now()
          });

          // Auto-resume agent with the notification if it's idle!
          if (agentRef.current && !agentRef.current.isAgentRunning()) {
            setIsProcessing(true);
            addLine({
              type: "user",
              content: `❯ [SYSTEM TRIGGER] ${msg}`,
              timestamp: Date.now()
            });
            agentRef.current.sendMessage(msg).then(() => {
              if (agentRef.current) {
                setPlanState(agentRef.current.planState);
              }
            });
          }
        }
      });
    });
    const unsubSubagents = subscribeToSubagents(() => {
      setRunningSubagentsCount(
        Array.from(subagentInstances.values()).filter((s) => s.status === "running").length
      );
      // Push notifications: Log completed subagents directly to context lines
      const activeList = Array.from(subagentInstances.values());
      activeList.forEach((inst) => {
        if (inst.status === "completed" && inst.result && !(inst as any).notified) {
          (inst as any).notified = true;
          const msg = `🤖 [SUBAGENT NOTIFICATION]: Subagent ${inst.id} (${inst.role}) has completed!\nReport Summary:\n${inst.result}`;
          addLine({
            type: "system",
            content: msg,
            timestamp: Date.now()
          });

          // Auto-resume agent with the notification if it's idle!
          if (agentRef.current && !agentRef.current.isAgentRunning()) {
            setIsProcessing(true);
            addLine({
              type: "user",
              content: `❯ [SYSTEM TRIGGER] ${msg}`,
              timestamp: Date.now()
            });
            agentRef.current.sendMessage(msg).then(() => {
              if (agentRef.current) {
                setPlanState(agentRef.current.planState);
              }
            });
          }
        }
      });
    });

    const unsubSuperagents = subscribeToSuperagents(() => {
      setRunningSuperagentsCount(
        Array.from(superagentInstances.values()).filter((s) => s.status === "running").length
      );
      const activeList = Array.from(superagentInstances.values());
      activeList.forEach((inst) => {
        if (inst.status === "completed" && inst.result && !(inst as any).notified) {
          (inst as any).notified = true;
          const msg = `⚡ [SUPERAGENT NOTIFICATION]: Superagent ${inst.id} (${inst.role}) has completed!\nReport Summary:\n${inst.result}`;
          addLine({
            type: "system",
            content: msg,
            timestamp: Date.now()
          });

          if (agentRef.current && !agentRef.current.isAgentRunning()) {
            setIsProcessing(true);
            addLine({
              type: "user",
              content: `❯ [SYSTEM TRIGGER] ${msg}`,
              timestamp: Date.now()
            });
            agentRef.current.sendMessage(msg).then(() => {
              if (agentRef.current) {
                setPlanState(agentRef.current.planState);
              }
            });
          }
        }
      });
    });

    const unsubSchedules = subscribeToSchedules((jobId, prompt) => {
      const msg = `⏳ [SCHEDULE NOTIFICATION]: Schedule job ${jobId} triggered! Prompt: ${prompt}`;
      addLine({
        type: "system",
        content: msg,
        timestamp: Date.now()
      });

      // Auto-resume agent with the notification if it's idle!
      if (agentRef.current && !agentRef.current.isAgentRunning()) {
        setIsProcessing(true);
        addLine({
          type: "user",
          content: `❯ [SYSTEM TRIGGER] ${msg}`,
          timestamp: Date.now()
        });
        agentRef.current.sendMessage(msg).then(() => {
          if (agentRef.current) {
            setPlanState(agentRef.current.planState);
          }
        });
      }
    });

    setRunningTasksCount(
      Array.from(backgroundTasks.values()).filter((t) => !t.hasExited).length
    );
    setRunningSubagentsCount(
      Array.from(subagentInstances.values()).filter((s) => s.status === "running").length
    );

    return () => {
      unsubTasks();
      unsubSubagents();
      unsubSchedules();
    };
  }, [addLine]);

  const [activeToolOutput, setActiveToolOutput] = useState("");
  useEffect(() => {
    return subscribeToActiveOutput((out) => {
      setActiveToolOutput(out);
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

  useEffect(() => {
    let active = true;
    let intervalId: NodeJS.Timeout | null = null;

    const check = async () => {
      const taskPath = agentRef.current ? agentRef.current.getTaskFilePath() : null;
      if (!taskPath) return;
      try {
        const content = await fs.readFile(taskPath, "utf-8");
        if (!active) return;
        const lines = content.split(/\r?\n/);
        const items: { status: string; text: string }[] = [];
        for (const line of lines) {
          const match = line.match(/^\s*-\s*`\[([xX/ ])\]`?\s*(.*)$/) || line.match(/^\s*-\s*\[([xX/ ])\]\s*(.*)$/);
          if (match) {
            items.push({
              status: match[1].toLowerCase(),
              text: match[2].trim(),
            });
          }
        }
        setChecklistTasks(items);
      } catch (err) {
        if (active) setChecklistTasks([]);
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
  }, [planState]);

  useEffect(() => {
    const modelName = process.env.MODEL || getDefaultModel();
    let initialLimit = getContextWindowLimit(modelName);

    if (process.env.CONTEXT_WINDOW_LIMIT) {
      const parsed = parseInt(process.env.CONTEXT_WINDOW_LIMIT, 10);
      if (!isNaN(parsed)) {
        initialLimit = parsed;
      }
    } else if (process.env.MAX_CONTEXT_TOKENS) {
      const parsed = parseInt(process.env.MAX_CONTEXT_TOKENS, 10);
      if (!isNaN(parsed)) {
        initialLimit = parsed;
      }
    }
    setContextLimit(initialLimit);

    fetchAndCacheModels()
      .then(() => {
        const limit = getContextWindowLimit(modelName);
        setContextLimit(limit);
      })
      .catch(() => {});
  }, []);

  const flushBuffer = useCallback(() => {
    if (streamTimeoutRef.current) {
      clearTimeout(streamTimeoutRef.current);
      streamTimeoutRef.current = null;
    }
    const content = streamBufferRef.current.trim();
    if (content) {
      addLine({
        type: "assistant",
        content,
        timestamp: Date.now(),
      });
    }
    streamBufferRef.current = "";
    setStreamDisplay("");
  }, [addLine]);

  const permissionHandler: PermissionHandler = useCallback(
    (toolCall: ToolCall, description: string) => {
      return new Promise<boolean>((resolve) => {
        setPendingPermission({ toolCall, description, resolve });
        setWizardOptions(["Allow Command Execution", "Deny Command Execution"]);
        setWizardSelectedIndex(0);
        setActiveWizard({
          type: "permission",
          step: 1,
          data: {},
        });
      });
    },
    []
  );

  const questionHandler: QuestionHandler = useCallback(
    (question: string, options: string[], isMultiSelect?: boolean) => {
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
    },
    []
  );

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case "text":
          streamBufferRef.current = resolveCarriageReturns(streamBufferRef.current + event.content);
          const now = Date.now();
          if (now - lastStreamUpdateRef.current > 100) {
            setStreamDisplay(streamBufferRef.current);
            lastStreamUpdateRef.current = now;
            if (streamTimeoutRef.current) {
              clearTimeout(streamTimeoutRef.current);
              streamTimeoutRef.current = null;
            }
          } else {
            if (!streamTimeoutRef.current) {
              streamTimeoutRef.current = setTimeout(() => {
                setStreamDisplay(streamBufferRef.current);
                lastStreamUpdateRef.current = Date.now();
                streamTimeoutRef.current = null;
              }, 100);
            }
          }
          break;
        case "tool_start": {
          if (streamTimeoutRef.current) {
            clearTimeout(streamTimeoutRef.current);
            streamTimeoutRef.current = null;
          }
          const content = streamBufferRef.current.trim();
          if (content) {
            flushBuffer();
          } else {
            const fallbackNarrative = `[SYS] Initiating action: ${event.description}...`;
            addLine({
              type: "assistant",
              content: fallbackNarrative,
              timestamp: Date.now(),
            });
            streamBufferRef.current = "";
            setStreamDisplay("");
          }
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
          setIsExecutingTool(true);
          let prefixEmoji = "⚡";
          let customTitle = event.description;
          if (event.toolCall.name === "read" && typeof event.toolCall.args.filePath === "string") {
            const filePath = event.toolCall.args.filePath;
            if (filePath.includes("skills") && filePath.endsWith("SKILL.md")) {
              prefixEmoji = "📖";
              const parts = filePath.replace(/\\/g, "/").split("/");
              const skillName = parts[parts.length - 2] || "unknown";
              customTitle = `[SKILL] Loading instructions for: ${skillName}`;
            }
          }
          addLine({
            type: "tool_start",
            content: `${prefixEmoji} ${customTitle}\n   Detail: ${event.toolCall.name}(${formatArgs(event.toolCall.args)})`,
            timestamp: Date.now(),
          });
          break;
        }
        case "tool_end": {
          setIsExecutingTool(false);
          setToolTimeout(null);
          setToolStartTime(null);
          setTimeLeft(null);
          const r = event.toolResult;
          let prefixEmojiEnd = r.isError ? "✗" : "✓";
          let customTitleEnd = event.description;
          if (r.name === "read" && typeof event.description === "string") {
            const desc = event.description;
            if (desc.includes("skills") && desc.endsWith("SKILL.md")) {
              prefixEmojiEnd = r.isError ? "🚨" : "📖";
              const parts = desc.replace(/\\/g, "/").split("/");
              const skillName = parts[parts.length - 2] || "unknown";
              customTitleEnd = `[SKILL] Loaded instructions for: ${skillName}`;
            }
          }
          const statusPrefix = r.isError ? `${prefixEmojiEnd} Failed -` : `${prefixEmojiEnd} Completed -`;
          const resultContent = r.isError
            ? `${statusPrefix} ${customTitleEnd}\nDetail: ${r.result}`
            : `${statusPrefix} ${customTitleEnd}\nOutput: ${r.result.slice(0, 500)}${r.result.length > 500 ? "..." : ""}`;
          addLine({
            type: "tool_end",
            content: resultContent,
            timestamp: Date.now(),
          });
          break;
        }
        case "error":
          if (streamTimeoutRef.current) {
            clearTimeout(streamTimeoutRef.current);
            streamTimeoutRef.current = null;
          }
          setIsExecutingTool(false);
          setToolTimeout(null);
          setToolStartTime(null);
          setTimeLeft(null);
          addLine({
            type: "error",
            content: `Error: ${event.message}`,
            timestamp: Date.now(),
          });
          break;
        case "done":
          if (streamTimeoutRef.current) {
            clearTimeout(streamTimeoutRef.current);
            streamTimeoutRef.current = null;
          }
          flushBuffer();
          setIsExecutingTool(false);
          setToolTimeout(null);
          setToolStartTime(null);
          setTimeLeft(null);
          setIsProcessing(false);
          break;
        case "goal_done":
          // Goal mode finished - clear goal mode state and notify user
          setGoalMode(null);
          if (agentRef.current) {
            agentRef.current.goalMode = null;
          }
          addLine({
            type: "system",
            content: `🎯 GOAL MODE COMPLETED\n   Goal: "${event.goal}"\n   ${event.summary}`,
            timestamp: Date.now(),
          });
          break;
        case "token_usage":
          setTokensUp((prev) => prev + event.promptTokens);
          setTokensDown((prev) => prev + event.completionTokens);
          setLastPromptTokens(event.promptTokens);
          break;
      }
      if (agentRef.current) {
        const nextState = agentRef.current.planState;
        setPlanState(nextState);
        if (nextState === "PLANNING_PENDING") {
          setActiveWizard((curr) => {
            if (curr && curr.type === "plan_approve") return curr;
            setWizardOptions(["Approve Plan & Proceed", "Reject Plan / Give Feedback"]);
            setWizardSelectedIndex(0);
            return {
              type: "plan_approve",
              step: 1,
              data: {},
            };
          });
        }
      }
    },
    [flushBuffer, addLine]
  );

  useEffect(() => {
    registerQuestionHandler(questionHandler);
    const agent = new Agent(handleEvent, permissionHandler, questionHandler);
    agentRef.current = agent;

    const handleSigint = () => {
      if (stopRunningSubagents() > 0) {
        agent.abort();
        setIsProcessing(false);
        setIsExecutingTool(false);
        setToolTimeout(null);
        setToolStartTime(null);
        setTimeLeft(null);
        return;
      }
      if (agent.isAgentRunning()) {
        agent.abort();
      } else {
        exit();
      }
    };
    process.on("SIGINT", handleSigint);

    agent.loadHistory(autoResume).then(() => {
      const msgs = agent.getHistory().getMessages();
      const userInputs: string[] = [];
      const loadedLines: ChatLine[] = [];
      for (const m of msgs) {
        if (m.role === "user") {
          userInputs.push(m.content);
        }
      }
      if (autoResume) {
        for (const m of msgs) {
          if (m.role === "user") {
            loadedLines.push({
              type: "user",
              content: `❯ ${m.content}`,
              timestamp: m.timestamp,
            });
          } else if (m.role === "assistant") {
            if (m.content) {
              loadedLines.push({
                type: "assistant",
                content: m.content,
                timestamp: m.timestamp,
              });
            }
            if (m.toolCalls && m.toolCalls.length > 0) {
              for (const tc of m.toolCalls) {
                const description = getToolDescription(tc);
                loadedLines.push({
                  type: "tool_start",
                  content: `⚡ ${description}\n   Detail: ${tc.name}(${formatArgs(tc.args)})`,
                  timestamp: m.timestamp,
                });
              }
            }
            if (m.toolResults && m.toolResults.length > 0) {
              for (const tr of m.toolResults) {
                const tc = m.toolCalls?.find((c) => c.id === tr.toolCallId);
                const description = tc ? getToolDescription(tc) : `${tr.name}`;
                const statusPrefix = tr.isError ? "✗ Failed -" : "✓ Completed -";
                const resultContent = tr.isError
                  ? `${statusPrefix} ${description}\nDetail: ${tr.result}`
                  : `${statusPrefix} ${description}\nOutput: ${tr.result.slice(0, 500)}${tr.result.length > 500 ? "..." : ""}`;
                loadedLines.push({
                  type: "tool_end",
                  content: resultContent,
                  timestamp: m.timestamp,
                });
              }
            }
          }
        }
        setLines(loadedLines);
      } else {
        agent.getHistory().clear();
      }
      setHistory(userInputs);

      if (initialPrompt && initialPrompt.trim()) {
        const prompt = initialPrompt.trim();
        setLines((prev) => [
          ...prev,
          {
            type: "user",
            content: `❯ ${prompt}`,
            timestamp: Date.now(),
          },
        ]);
        setIsProcessing(true);
        streamBufferRef.current = "";
        setStreamDisplay("");
        agent.sendMessage(prompt).then(() => {
          const nextState = agent.planState;
          setPlanState(nextState);
          if (nextState === "PLANNING_PENDING") {
            setActiveWizard((curr) => {
              if (curr && curr.type === "plan_approve") return curr;
              setWizardOptions(["Approve Plan & Proceed", "Reject Plan / Give Feedback"]);
              setWizardSelectedIndex(0);
              return {
                type: "plan_approve",
                step: 1,
                data: {},
              };
            });
          }
        });
      }
    });

    return () => {
      process.off("SIGINT", handleSigint);
      registerQuestionHandler(null);
    };
  }, [handleEvent, permissionHandler, questionHandler, exit, autoResume, initialPrompt, stopRunningSubagents]);

  useEffect(() => {
    const hasMessages = agentRef.current ? agentRef.current.getHistory().getMessages().length > 0 : false;
    onHistoryChange?.(hasMessages);
  }, [lines, onHistoryChange]);

  const handleWizardSubmit = useCallback((value: string) => {
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
          addLine({
            type: "system",
            content: `Configured Providers:\n` + list.map(p => `- ${p.name} (${p.type})${p.isActive ? " [Active]" : ""}`).join("\n"),
            timestamp: now,
          });
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
          addLine({
            type: "error",
            content: "Invalid choice. Please select 1, 2, 3, or 4.",
            timestamp: now,
          });
          return;
        }

        addLine({
          type: "system",
          content: `Selected provider type: ${provider}\nStep 3: Enter config profile name (e.g. ${provider}, deepseek, or press Enter for default):`,
          timestamp: now,
        });

        setActiveWizard({
          type: "login",
          step: 3,
          data: { provider },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
      } else if (activeWizard.step === 3) {
        const provider = activeWizard.data.provider;
        const nameInput = value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
        const profileName = nameInput || provider;

        if (provider === "custom") {
          addLine({
            type: "system",
            content: `Config Name: ${profileName}\nStep 4: Please enter your Base URL (e.g. http://localhost:11434/v1):`,
            timestamp: now,
          });
          setActiveWizard({
            type: "login",
            step: 4,
            data: { provider, name: profileName },
          });
          setInput("");
        } else {
          addLine({
            type: "system",
            content: `Config Name: ${profileName}\nStep 6: Please enter your API Key:`,
            timestamp: now,
          });
          setActiveWizard({
            type: "login",
            step: 6,
            data: { provider, name: profileName },
          });
          setInput("");
        }
      } else if (activeWizard.step === 4) {
        const provider = activeWizard.data.provider;
        const profileName = activeWizard.data.name;
        const baseUrl = value.trim();

        addLine({
          type: "system",
          content: `Entered Base URL: ${baseUrl}\nStep 6: Please enter your API Key:`,
          timestamp: now,
        });
        setActiveWizard({
          type: "login",
          step: 6,
          data: { provider, name: profileName, baseUrl },
        });
        setInput("");
      } else if (activeWizard.step === 5) {
        const list = getConfiguredProviders();
        const chosen = list.find(p => p.name.toLowerCase() === value.toLowerCase());
        if (chosen) {
          try {
            const envPath = switchActiveProvider(chosen.name);
            addLine({
              type: "system",
              content: `Switched active provider to: ${chosen.name}\nSaved to: ${envPath}`,
              timestamp: now,
            });
          } catch (err: any) {
            addLine({
              type: "error",
              content: `Failed to switch provider: ${err.message}`,
              timestamp: now,
            });
          }
        } else {
          addLine({
            type: "error",
            content: `Provider "${value}" not found in configured list.`,
            timestamp: now,
          });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 6) {
        const provider = activeWizard.data.provider;
        const profileName = activeWizard.data.name;
        const baseUrl = activeWizard.data.baseUrl;
        const apiKey = value;

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

          addLine({
            type: "system",
            content: `Successfully configured and activated provider profile: ${profileName} (${provider})!\nSaved to: ${envPath}`,
            timestamp: now,
          });

          if (provider === "openrouter" && !process.env.MODEL) {
            updateEnvFile({ MODEL: "google/gemini-2.5-flash" });
          }

          fetchAndCacheModels()
            .then(() => {
              const currentModel = process.env.MODEL || getDefaultModel();
              const limit = getContextWindowLimit(currentModel);
              setContextLimit(limit);
            })
            .catch(() => {});
        } catch (err: any) {
          addLine({
            type: "error",
            content: `Failed to save credentials: ${err.message}`,
            timestamp: now,
          });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 10) {
        const choice = value.toLowerCase();
        if (choice.includes("ask ai") || choice.startsWith("6")) {
          addLine({
            type: "system",
            content: `Selected AI-Assisted Initialization.\nStep 13: Briefly describe what you want to build (e.g. "A simple markdown parser command line tool in TypeScript"):`,
            timestamp: now,
          });
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

          addLine({
            type: "system",
            content: `Selected Stack: ${stack}\nStep 11: Enter Project Name (or press Enter for default "${path.basename(process.cwd())}"):`,
            timestamp: now,
          });
          setActiveWizard({
            type: "login",
            step: 11,
            data: { ...activeWizard.data, stack },
          });
        }
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
      } else if (activeWizard.step === 11) {
        const projectName = value.trim() || path.basename(process.cwd());
        addLine({
          type: "system",
          content: `Project Name: ${projectName}\nStep 12: Enter a short Project Description:`,
          timestamp: now,
        });
        setActiveWizard({
          type: "login",
          step: 12,
          data: { ...activeWizard.data, projectName },
        });
        setInput("");
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
          addLine({ type: "system", content: `📄 Generated agents.md (created: ${projectName}, ${projectTech})`, timestamp: Date.now() });

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
          addLine({ type: "system", content: auditLines.join("\n"), timestamp: Date.now() });
        })().catch(err => {
          addLine({ type: "error", content: `Failed to complete project initialization: ${err.message}`, timestamp: Date.now() });
        });

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 13) {
        const goal = value.trim();
        if (!goal) {
          addLine({ type: "error", content: "AI prompt cannot be empty. Initialization cancelled.", timestamp: now });
          setActiveWizard(null);
          return;
        }

        addLine({ type: "system", content: "🤖 Consulting AI to formulate project structure...", timestamp: now });
        setIsProcessing(true);

        (async () => {
          try {
            if (!agentRef.current) {
              throw new Error("AI Core is not initialized yet.");
            }

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
            const modelConfig = (agentRef.current as any).getModel();
            const response = await generateText({
              model: modelConfig,
              prompt: prompt,
            });

            const content = response.text || "";
            const cwd = process.cwd();
            const agentsPath = path.resolve(cwd, "agents.md");
            await fs.writeFile(agentsPath, content, "utf-8");
            addLine({ type: "system", content: `📄 Generated agents.md successfully!`, timestamp: Date.now() });

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
            addLine({ type: "system", content: auditLines.join("\n"), timestamp: Date.now() });

          } catch (aiErr: any) {
            addLine({ type: "error", content: `AI code completion request failed: ${aiErr.message}. Falling back to default project structure.`, timestamp: Date.now() });
            
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
            setIsProcessing(false);
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
        if (choice.includes("default") || choice.includes("global")) {
          tier = "default";
        } else if (choice.includes("master") || choice.includes("depth 0")) {
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
          const tiers = ["default", "master", "superagent", "subagent", "researcher", "coder", "reviewer", "all"];
          const idx = wizardSelectedIndex >= 0 ? wizardSelectedIndex : 0;
          tier = tiers[idx] || "default";
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
        setInput("");
      } else if (activeWizard.step === 2) {
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
          const list = getConfiguredProviders();
          const cleanName = value.replace(/\s*\[Active\]\s*$/, "").split(" (")[0].trim();
          const found = list.find(p => p.name === cleanName);
          provider = found?.type || "openrouter";
        }

        setActiveWizard({
          type: "model",
          step: 3,
          data: { ...activeWizard.data, provider },
        });

        let initialModels: string[] = [];
        if (provider === "openrouter") {
          initialModels = [
            "google/gemini-2.5-flash",
            "meta-llama/llama-3.3-70b-instruct",
            "deepseek/deepseek-chat",
            "anthropic/claude-3.5-sonnet",
          ];
          setWizardIsLoadingModels(true);
          fetch("https://openrouter.ai/api/v1/models")
            .then(async (res) => {
              if (res.ok) {
                const data = await res.json() as any;
                if (data && Array.isArray(data.data)) {
                  const modelsList = data.data.map((m: any) => m.id);
                  setWizardOptions(modelsList);
                }
              }
            })
            .catch(() => {})
            .finally(() => setWizardIsLoadingModels(false));
        } else if (provider === "openai") {
          initialModels = [
            "gpt-4o",
            "gpt-4o-mini",
            "o1",
            "o1-mini",
            "o1-preview",
            "o3-mini",
            "gpt-4-turbo",
            "gpt-4",
          ];
          const apiKey = process.env.OPENAI_API_KEY || process.env.CUSTOM_API_KEY;
          if (apiKey) {
            setWizardIsLoadingModels(true);
            fetch("https://api.openai.com/v1/models", {
              headers: {
                Authorization: `Bearer ${apiKey}`
              }
            })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList = data.data.map((m: any) => m.id);
                    setWizardOptions(modelsList);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        } else if (provider === "anthropic") {
          initialModels = [
            "claude-opus-4-5",
            "claude-sonnet-4-5",
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
            "claude-3-opus-20240229",
          ];
        } else if (provider === "custom") {
          initialModels = [
            "deepseek-chat",
            "llama-3.3-70b-instruct",
          ];
          const baseUrl = process.env.CUSTOM_BASE_URL;
          const apiKey = process.env.CUSTOM_API_KEY || process.env.OPENAI_API_KEY;
          if (baseUrl) {
            setWizardIsLoadingModels(true);
            const headers: Record<string, string> = {};
            if (apiKey) {
              headers["Authorization"] = `Bearer ${apiKey}`;
            }
            fetch(`${baseUrl}/models`, { headers })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList = data.data.map((m: any) => m.id);
                    setWizardOptions(modelsList);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        }

        setWizardOptions(initialModels);
        setWizardSelectedIndex(0);
        setInput("");
      } else {
        const modelName = value;
        try {
          const profileName = activeWizard.data.provider;
          const tier = activeWizard.data.tier;
          let updates: Record<string, string> = {};

          let envPath = "";
          let targetLabel = "";
          if (tier === "default") {
            envPath = switchActiveProvider(profileName);
            updateEnvFile({ MODEL: modelName });
            targetLabel = "Default Model";
          } else if (tier === "all") {
            const activeProvider = process.env.ACTIVE_PROVIDER || "";
            const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
              ? `${profileName.toLowerCase()}:${modelName}`
              : modelName;
            updates = {
              MODEL: modelName,
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
            envPath = switchActiveProvider(profileName);
            updateEnvFile(updates);
          } else {
            const activeProvider = process.env.ACTIVE_PROVIDER || "";
            const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
              ? `${profileName.toLowerCase()}:${modelName}`
              : modelName;
            
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
            envPath = updateEnvFile(updates);
          }

          const cleanModelName = modelName.includes(":") ? modelName.substring(modelName.indexOf(":") + 1) : modelName;
          const limit = getContextWindowLimit(cleanModelName);
          
          if (tier === "default" || tier === "all") {
            setContextLimit(limit);
          }
          
          addLine({
            type: "system",
            content: `${targetLabel} successfully changed to: ${modelName} (via provider ${profileName})\nContext limit: ${limit.toLocaleString()} tokens\nSaved to: ${envPath}`,
            timestamp: now,
          });
          
          if (tier === "default" || tier === "all") {
            fetchAndCacheModels()
              .then(() => {
                const newLimit = getContextWindowLimit(cleanModelName);
                setContextLimit(newLimit);
              })
              .catch(() => {});
          }
        } catch (err: any) {
          addLine({
            type: "error",
            content: `Failed to set model: ${err.message}`,
            timestamp: now,
          });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardIsLoadingModels(false);
      }
    } else if (activeWizard.type === "plan_approve") {
      const approved = value === "approve";
      if (approved) {
        if (agentRef.current) {
          agentRef.current.approvePlan();
          setPlanState("APPROVED");
          setIsProcessing(true);
          streamBufferRef.current = "";
          setStreamDisplay("");
          agentRef.current.sendMessage("Implementation plan approved via interactive approval wizard. Continue with the approved plan now.").catch((err: any) => {
            setIsProcessing(false);
            addLine({ type: "error", content: `Plan approval resume error: ${err.message}`, timestamp: Date.now() });
          });
        }
        addLine({
          type: "system",
          content: "✓ Implementation plan approved! Continuing with the approved plan now.",
          timestamp: now,
        });
      } else {
        if (agentRef.current) {
          agentRef.current.planState = "IDLE";
          setPlanState("IDLE");
        }
        addLine({
          type: "system",
          content: "✗ Implementation plan rejected. Please type your feedback below and press Enter to send it to the agent.",
          timestamp: now,
        });
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    } else if (activeWizard.type === "question") {
      if (pendingQuestion) {
        pendingQuestion.resolve(value);
        addLine({
          type: "system",
          content: `❓ Answered: "${value}"`,
          timestamp: now,
        });
        setPendingQuestion(null);
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    } else if (activeWizard.type === "goal") {
      // User typed their goal in the wizard dialog
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      if (!value.trim()) return;
      const goalArg = value.trim();
      if (agentRef.current) {
        agentRef.current.goalMode = goalArg;
      }
      setGoalMode({ goal: goalArg, startedAt: now });
      addLine({
        type: "system",
        content: [
          "🎯 GOAL MODE ACTIVATED",
          `   Objective : ${goalArg}`,
          "   Iterations: up to 200 steps (auto-continue enabled)",
          "   The agent will not stop until the goal is achieved.",
          "   Use Ctrl+C to abort at any time.",
        ].join("\n"),
        timestamp: now,
      });
      addLine({
        type: "user",
        content: `❯ /goal ${goalArg}`,
        timestamp: now,
      });
      setIsProcessing(true);
      agentRef.current?.sendMessage(
        `GOAL MODE: Your primary objective is to achieve the following goal completely and verifiably:\n\n"${goalArg}"\n\nBegin immediately. Plan thoroughly, execute step by step, verify completion, and report back with GOAL_COMPLETE or GOAL_PARTIAL.`
      ).catch((err: any) => {
        addLine({ type: "error", content: `Goal mode error: ${err.message}`, timestamp: Date.now() });
      });
    }
  }, [activeWizard, addLine, setContextLimit, setPlanState, setGoalMode, setIsProcessing]);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      if (isProcessing && !activeWizard) return;

      setInput("");
      setIsPasted(false);
      setLastTabPrefix(null);
      setHistoryIndex(-1);
      setScrollOffset(0);

      if (activeWizard) {
        handleWizardSubmit(trimmed);
        return;
      }
      setHistory((prev) => {
        if (prev.length > 0 && prev[prev.length - 1] === trimmed) {
          return prev;
        }
        return [...prev, trimmed];
      });

      const commandInput = trimmed.startsWith("!") ? `/terminal ${trimmed.slice(1).trim()}` : trimmed;

      if (commandInput.startsWith("/")) {
        if (commandInput.toLowerCase().startsWith("/clear") || commandInput.toLowerCase().startsWith("/new")) {
          setTokensUp(0);
          setTokensDown(0);
          setLastPromptTokens(0);
        }
        handleSlashCommand(commandInput, {
          addLine,
          exit,
          agent: agentRef.current,
          clearLines: () => setLines([]),
          setContextLimit,
          setActiveWizard,
          setWizardOptions,
          setWizardSelectedIndex,
          setPlanState,
          setGoalMode: (val: { goal: string; startedAt: number } | null) => setGoalMode(val),
          setIsProcessing,
          resumeSession: async () => {
            if (!agentRef.current) return;
            await agentRef.current.loadHistory();
            const msgs = agentRef.current.getHistory().getMessages();
            const loadedLines: ChatLine[] = [];
            const userInputs: string[] = [];
            for (const m of msgs) {
              if (m.role === "user") {
                loadedLines.push({
                  type: "user",
                  content: `❯ ${m.content}`,
                  timestamp: m.timestamp,
                });
                userInputs.push(m.content);
              } else if (m.role === "assistant") {
                if (m.content) {
                  loadedLines.push({
                    type: "assistant",
                    content: m.content,
                    timestamp: m.timestamp,
                  });
                }
                if (m.toolCalls && m.toolCalls.length > 0) {
                  for (const tc of m.toolCalls) {
                    const description = getToolDescription(tc);
                    loadedLines.push({
                      type: "tool_start",
                      content: `⚡ ${description}\n   Detail: ${tc.name}(${formatArgs(tc.args)})`,
                      timestamp: m.timestamp,
                    });
                  }
                }
                if (m.toolResults && m.toolResults.length > 0) {
                  for (const tr of m.toolResults) {
                    const tc = m.toolCalls?.find((c) => c.id === tr.toolCallId);
                    const description = tc ? getToolDescription(tc) : `${tr.name}`;
                    const statusPrefix = tr.isError ? "✗ Failed -" : "✓ Completed -";
                    const resultContent = tr.isError
                      ? `${statusPrefix} ${description}\nDetail: ${tr.result}`
                      : `${statusPrefix} ${description}\nOutput: ${tr.result.slice(0, 500)}${tr.result.length > 500 ? "..." : ""}`;
                    loadedLines.push({
                      type: "tool_end",
                      content: resultContent,
                      timestamp: m.timestamp,
                    });
                  }
                }
              }
            }
            setLines(loadedLines);
            setHistory(userInputs);
            if (agentRef.current) {
              setPlanState(agentRef.current.planState);
            }
          },
          resumeFromPath: async (filePath: string) => {
            if (!agentRef.current) return;
            await agentRef.current.loadHistoryFromPath(filePath);
            const msgs = agentRef.current.getHistory().getMessages();
            const loadedLines: ChatLine[] = [];
            const userInputs: string[] = [];
            for (const m of msgs) {
              if (m.role === "user") {
                loadedLines.push({
                  type: "user",
                  content: `❯ ${m.content}`,
                  timestamp: m.timestamp,
                });
                userInputs.push(m.content);
              } else if (m.role === "assistant") {
                if (m.content) {
                  loadedLines.push({
                    type: "assistant",
                    content: m.content,
                    timestamp: m.timestamp,
                  });
                }
                if (m.toolCalls && m.toolCalls.length > 0) {
                  for (const tc of m.toolCalls) {
                    const description = getToolDescription(tc);
                    loadedLines.push({
                      type: "tool_start",
                      content: `⚡ ${description}\n   Detail: ${tc.name}(${formatArgs(tc.args)})`,
                      timestamp: m.timestamp,
                    });
                  }
                }
                if (m.toolResults && m.toolResults.length > 0) {
                  for (const tr of m.toolResults) {
                    const tc = m.toolCalls?.find((c) => c.id === tr.toolCallId);
                    const description = tc ? getToolDescription(tc) : `${tr.name}`;
                    const statusPrefix = tr.isError ? "✗ Failed -" : "✓ Completed -";
                    const resultContent = tr.isError
                      ? `${statusPrefix} ${description}\nDetail: ${tr.result}`
                      : `${statusPrefix} ${description}\nOutput: ${tr.result.slice(0, 500)}${tr.result.length > 500 ? "..." : ""}`;
                    loadedLines.push({
                      type: "tool_end",
                      content: resultContent,
                      timestamp: m.timestamp,
                    });
                  }
                }
              }
            }
            setLines(loadedLines);
            setHistory(userInputs);
            if (agentRef.current) {
              setPlanState(agentRef.current.planState);
            }
          },
        });
        return;
      }

      addLine({
        type: "user",
        content: `❯ ${trimmed}`,
        timestamp: Date.now(),
      });

      // Auto-checkpoint before sending message
      if (agentRef.current) {
        const sessionPath = agentRef.current.getCurrentHistoryFilePath();
        const msgs = agentRef.current.getHistory().getMessages();
        if (msgs.length > 0) {
          const preview = trimmed.slice(0, 40) + (trimmed.length > 40 ? "…" : "");
          createCheckpoint(sessionPath, `Auto: ${preview}`, msgs, agentRef.current.planState, agentRef.current.workingDirectory).catch(() => {});
        }
      }

      setIsProcessing(true);
      streamBufferRef.current = "";
      setStreamDisplay("");
      await agentRef.current?.sendMessage(trimmed);
      if (agentRef.current) {
        const nextState = agentRef.current.planState;
        setPlanState(nextState);
        if (nextState === "PLANNING_PENDING") {
          setActiveWizard((curr) => {
            if (curr && curr.type === "plan_approve") return curr;
            setWizardOptions(["Approve Plan & Proceed", "Reject Plan / Give Feedback"]);
            setWizardSelectedIndex(0);
            return {
              type: "plan_approve",
              step: 1,
              data: {},
            };
          });
        }
      }
    },
    [isProcessing, activeWizard, handleWizardSubmit, addLine, exit]
  );

  const handleInputChange = useCallback((val: string) => {
    const sanitizedVal = stripSgrMouseSequences(val);

    setInput(sanitizedVal);
    const lengthDiff = sanitizedVal.length - input.length;
    const containsNewline = sanitizedVal.includes("\n");
    if (lengthDiff < 0) {
      // User is deleting characters — never treat as paste
      setIsPasted(false);
    } else if (lengthDiff > 15 || containsNewline) {
      setIsPasted(true);
    } else if (sanitizedVal.length === 0 || (sanitizedVal.length <= 200 && !containsNewline)) {
      setIsPasted(false);
    }
    if (lastTabPrefix && !sanitizedVal.startsWith(lastTabPrefix)) {
      setLastTabPrefix(null);
    }
    // Reset selection to top when search query changes in model wizard
    if (activeWizard?.type === "model" && wizardOptions.length > 0) {
      setWizardSelectedIndex(0);
    }
  }, [input, lastTabPrefix, activeWizard, wizardOptions]);

  const installedSkills = getInstalledSkills();
  const skillCommands = installedSkills.map(s => {
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    return `/skill-${slug}`;
  });

  const commands = [
    "/checkpoint",
    "/clear",
    "/compact",
    "/goal",
    "/help",
    "/init",
    "/new",
    "/resume",
    "/search-history",
    "/quit",
    "/exit",
    "/login",
    "/model",
    "/agents",
    "/worktree",
    "/worktrees",
    "/tasks",
    "/processes",
    "/procs",
    "/install",
    "/skills",
    "/terminal",
    ...skillCommands
  ];

  useInput((inputChar, key) => {
    if (focusedResponseIndex !== null) {
      const width = Math.max(20, terminalWidth - 6);
      const maxLines = Math.max(8, Math.min(18, Math.floor(terminalHeight * 0.45)));
      const truncatedIndexes = getTruncatedAssistantIndexes(lines, maxLines, width);
      const currentPosition = truncatedIndexes.indexOf(focusedResponseIndex);
      const focusedLine = lines[focusedResponseIndex];
      const responseLines = focusedLine?.type === "assistant" ? wrapTextForDisplay(focusedLine.content, Math.max(20, width - 6)) : [];
      const focusWindowHeight = Math.max(5, terminalHeight - 13);
      const maxOffset = Math.max(0, responseLines.length - focusWindowHeight);

      if (key.escape) {
        setFocusedResponseIndex(null);
        setFocusedResponseOffset(0);
        return;
      }
      if (inputChar === "n" && currentPosition >= 0 && currentPosition < truncatedIndexes.length - 1) {
        setFocusedResponseIndex(truncatedIndexes[currentPosition + 1]);
        setFocusedResponseOffset(0);
        return;
      }
      if (inputChar === "p" && currentPosition > 0) {
        setFocusedResponseIndex(truncatedIndexes[currentPosition - 1]);
        setFocusedResponseOffset(0);
        return;
      }
      if (key.pageUp || (key.ctrl && key.upArrow)) {
        setFocusedResponseOffset((prev) => Math.max(0, prev - focusWindowHeight));
        return;
      }
      if (key.pageDown || (key.ctrl && key.downArrow)) {
        setFocusedResponseOffset((prev) => Math.min(maxOffset, prev + focusWindowHeight));
        return;
      }
      if (key.upArrow) {
        setFocusedResponseOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setFocusedResponseOffset((prev) => Math.min(maxOffset, prev + 1));
        return;
      }
      return;
    }

    if (key.ctrl && inputChar === "o") {
      if (!activeWizard) openLatestTruncatedResponse();
      return;
    }

    if (key.ctrl && inputChar === "h") {
      setFocusMode((prev) => {
        const next = prev === "input" ? "history" : "input";
        if (next === "history") {
          const uniqueHistory = Array.from(new Set(history));
          setHistorySelectedIndex(uniqueHistory.length > 0 ? uniqueHistory.length - 1 : 0);
        }
        return next;
      });
      return;
    }

    // Ctrl+P: Open checkpoint wizard
    if (key.ctrl && inputChar === "p") {
      if (isProcessing || activeWizard) return;
      if (!agentRef.current) return;
      const sessionPath = agentRef.current.getCurrentHistoryFilePath();
      listCheckpointsForSession(sessionPath)
        .then((checkpoints) => {
          if (checkpoints.length === 0) {
            addLine({ type: "system", content: "No checkpoints found. Use /checkpoint <name> to create one.", timestamp: Date.now() });
            return;
          }
          setCheckpointsList(checkpoints);
          const relTime = (ts: number) => {
            const diff = Math.floor((Date.now() - ts) / 1000);
            if (diff < 60) return `${diff}s ago`;
            if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
            if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
            return `${Math.floor(diff / 86400)}d ago`;
          };
          const options = checkpoints.map((c) => {
            const gitTag = c.gitSha ? ` [${c.gitSha}]` : "";
            return `📌 ${c.name}  |  ${c.messages.length} msgs  |  ${relTime(c.timestamp)}${gitTag}`;
          });
          setActiveWizard({ type: "checkpoint", step: 1, data: {} });
          setWizardOptions(options);
          setWizardSelectedIndex(0);
        })
        .catch(() => {
          addLine({ type: "error", content: "Failed to list checkpoints.", timestamp: Date.now() });
        });
      return;
    }

    if (focusMode === "history") {
      const uniqueHistory = Array.from(new Set(history));
      if (key.upArrow) {
        setHistorySelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setHistorySelectedIndex((prev) => Math.min(uniqueHistory.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        if (uniqueHistory.length > 0 && uniqueHistory[historySelectedIndex]) {
          setInput(uniqueHistory[historySelectedIndex]);
        }
        setFocusMode("input");
        return;
      }
      if (key.escape) {
        setFocusMode("input");
        return;
      }
      return;
    }

    if (activeWizard) {
      if (activeWizard.type === "login" && (activeWizard.step === 1 || activeWizard.step === 2 || activeWizard.step === 5 || activeWizard.step === 10)) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(wizardOptions.length - 1, prev + 1));
          return;
        }
        if (key.return) {
          const selectedOption = wizardOptions[wizardSelectedIndex];
          if (!selectedOption) return;
          const now = Date.now();

          if (activeWizard.step === 1) {
            if (selectedOption.includes("Add / Log in")) {
              setActiveWizard({
                type: "login",
                step: 2,
                data: {},
              });
              setWizardOptions(["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint"]);
              setWizardSelectedIndex(0);
            } else if (selectedOption.includes("Switch Active")) {
              const list = getConfiguredProviders();
              const options = list.map(p => `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${p.isActive ? " [Active]" : ""}`);
              setActiveWizard({
                type: "login",
                step: 5,
                data: {},
              });
              setWizardOptions(options);
              setWizardSelectedIndex(0);
            } else {
              const list = getConfiguredProviders();
              addLine({
                type: "system",
                content: `Configured Providers:\n` + list.map(p => `- ${p.name} (${p.type})${p.isActive ? " [Active]" : ""}`).join("\n"),
                timestamp: now,
              });
              setActiveWizard(null);
              setWizardOptions([]);
              setWizardSelectedIndex(0);
            }
          } else if (activeWizard.step === 10) {
            handleWizardSubmit(selectedOption);
            return;
          } else if (activeWizard.step === 2) {
            const choice = selectedOption.toLowerCase();
            let provider = "";
            if (choice.includes("openrouter")) provider = "openrouter";
            else if (choice.includes("openai")) provider = "openai";
            else if (choice.includes("anthropic")) provider = "anthropic";
            else if (choice.includes("custom")) provider = "custom";

            addLine({
              type: "system",
              content: `Selected provider type: ${provider}\nStep 3: Enter config profile name (e.g. ${provider}, deepseek, or press Enter for default):`,
              timestamp: now,
            });

            setActiveWizard({
              type: "login",
              step: 3,
              data: { provider },
            });
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setInput("");
          } else if (activeWizard.step === 5) {
            const list = getConfiguredProviders();
            const chosen = list[wizardSelectedIndex];
            if (chosen) {
              try {
                const envPath = switchActiveProvider(chosen.name);
                addLine({
                  type: "system",
                  content: `Switched active provider to: ${chosen.name}\nSaved to: ${envPath}`,
                  timestamp: now,
                });
                fetchAndCacheModels()
                  .then(() => {
                    const currentModel = process.env.MODEL || getDefaultModel();
                    const limit = getContextWindowLimit(currentModel);
                    setContextLimit(limit);
                  })
                  .catch(() => {});
              } catch (err: any) {
                addLine({
                  type: "error",
                  content: `Failed to switch provider: ${err.message}`,
                  timestamp: now,
                });
              }
            }
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
          }
          return;
        }
      } else if (activeWizard.type === "model" && activeWizard.step === 1 && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const tiers = ["default", "master", "superagent", "subagent", "researcher", "coder", "reviewer", "all"];
          const tier = tiers[wizardSelectedIndex];
          if (!tier) return;

          setActiveWizard({
            type: "model",
            step: 2,
            data: { tier },
          });

          const list = getConfiguredProviders();
          const options = list.map(p => `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${p.isActive ? " [Active]" : ""}`);
          setWizardOptions(options.length > 0 ? options : ["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint"]);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }
      } else if (activeWizard.type === "model" && activeWizard.step === 2 && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const list = getConfiguredProviders();
          const chosen = list[wizardSelectedIndex];
          if (!chosen) return;
          
          setActiveWizard({
            type: "model",
            step: 3,
            data: { ...activeWizard.data, provider: chosen.name },
          });

          // Fetch models from this chosen profile
          const prefix = `PROVIDER_${chosen.name.toUpperCase()}`;
          const type = chosen.type;
          const baseUrl = chosen.baseUrl || (type === "openrouter" ? "https://openrouter.ai/api/v1" : type === "openai" ? "https://api.openai.com/v1" : "");
          const apiKey = process.env[`${prefix}_API_KEY`] || (type === "openai" ? process.env.OPENAI_API_KEY : type === "anthropic" ? process.env.ANTHROPIC_API_KEY : "");

          let initialModels: string[] = [];
          if (type === "openrouter" || chosen.name === "openrouter") {
            initialModels = [
              "google/gemini-2.5-flash",
              "meta-llama/llama-3.3-70b-instruct",
              "deepseek/deepseek-chat",
              "anthropic/claude-3.5-sonnet",
            ];
            setWizardIsLoadingModels(true);
            fetch("https://openrouter.ai/api/v1/models")
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList = data.data.map((m: any) => m.id);
                    setWizardOptions(modelsList);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          } else if (type === "openai" || chosen.name === "openai") {
            initialModels = [
              "gpt-4o",
              "gpt-4o-mini",
              "o1",
              "o1-mini",
              "o1-preview",
              "o3-mini",
              "gpt-4-turbo",
              "gpt-4",
            ];
            if (apiKey) {
              setWizardIsLoadingModels(true);
              fetch("https://api.openai.com/v1/models", {
                headers: {
                  Authorization: `Bearer ${apiKey}`
                }
              })
                .then(async (res) => {
                  if (res.ok) {
                    const data = await res.json() as any;
                    if (data && Array.isArray(data.data)) {
                      const modelsList = data.data.map((m: any) => m.id);
                      setWizardOptions(modelsList);
                    }
                  }
                })
                .catch(() => {})
                .finally(() => setWizardIsLoadingModels(false));
            }
          } else if (type === "anthropic" || chosen.name === "anthropic") {
            initialModels = [
              "claude-3-5-sonnet-20241022",
              "claude-3-5-haiku-20241022",
              "claude-3-opus-20240229",
              "claude-3-sonnet-20240229",
              "claude-3-haiku-20240307",
            ];
          } else {
            initialModels = [
              "deepseek-chat",
              "llama-3.3-70b-instruct",
            ];
            if (baseUrl) {
              const headers: Record<string, string> = {};
              if (apiKey) {
                headers["Authorization"] = `Bearer ${apiKey}`;
              }
              setWizardIsLoadingModels(true);
              fetch(`${baseUrl}/models`, { headers })
                .then(async (res) => {
                  if (res.ok) {
                    const data = await res.json() as any;
                    if (data && Array.isArray(data.data)) {
                      const modelsList = data.data.map((m: any) => m.id);
                      setWizardOptions(modelsList);
                    }
                  }
                })
                .catch(() => {})
                .finally(() => setWizardIsLoadingModels(false));
            }
          }

          setWizardOptions(initialModels);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }
      } else if (activeWizard.type === "model" && activeWizard.step === 3 && wizardOptions.length > 0) {
        const modelSearchQuery = input.trim().toLowerCase();
        const filteredModels = modelSearchQuery
          ? wizardOptions.filter((m) => m.toLowerCase().includes(modelSearchQuery))
          : wizardOptions;
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, filteredModels.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const selectedModel = filteredModels[wizardSelectedIndex] ?? filteredModels[0];
          if (!selectedModel) return;
          const now = Date.now();
          try {
            const profileName = activeWizard.data.provider;
            const tier = activeWizard.data.tier;
            let updates: Record<string, string> = {};

            let envPath = "";
            let targetLabel = "";
            if (tier === "default") {
              envPath = switchActiveProvider(profileName);
              updateEnvFile({ MODEL: selectedModel });
              targetLabel = "Default Model";
            } else if (tier === "all") {
              const activeProvider = process.env.ACTIVE_PROVIDER || "";
              const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
                ? `${profileName.toLowerCase()}:${selectedModel}`
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
              envPath = switchActiveProvider(profileName);
              updateEnvFile(updates);
            } else {
              const activeProvider = process.env.ACTIVE_PROVIDER || "";
              const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
                ? `${profileName.toLowerCase()}:${selectedModel}`
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
              envPath = updateEnvFile(updates);
            }

            const cleanModelName = selectedModel.includes(":") ? selectedModel.substring(selectedModel.indexOf(":") + 1) : selectedModel;
            const limit = getContextWindowLimit(cleanModelName);
            
            if (tier === "default" || tier === "all") {
              setContextLimit(limit);
            }
            
            addLine({
              type: "system",
              content: `${targetLabel} successfully changed to: ${selectedModel} (via provider ${profileName})\nContext limit: ${limit.toLocaleString()} tokens\nSaved to: ${envPath}`,
              timestamp: now,
            });
            
            if (tier === "default" || tier === "all") {
              fetchAndCacheModels()
                .then(() => {
                  const newLimit = getContextWindowLimit(cleanModelName);
                  setContextLimit(newLimit);
                })
                .catch(() => {});
            }
          } catch (err: any) {
            addLine({
              type: "error",
              content: `Failed to set model: ${err.message}`,
              timestamp: now,
            });
          }
          setInput("");
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardIsLoadingModels(false);
          setWizardSelectedIndex(0);
          return;
        }
      } else if (activeWizard.type === "plan_approve" && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(wizardOptions.length - 1, prev + 1));
          return;
        }
        if (key.return) {
          const isApprove = wizardSelectedIndex === 0;
          handleWizardSubmit(isApprove ? "approve" : "reject");
          return;
        }
      } else if (activeWizard.type === "permission" && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(wizardOptions.length - 1, prev + 1));
          return;
        }
        if (key.return) {
          const approved = wizardSelectedIndex === 0;
          handlePermissionResponse(approved);
          return;
        }
      } else if (activeWizard.type === "question" && wizardOptions.length > 0) {
        if (activeWizard.isMultiSelect && inputChar === " ") {
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
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(wizardOptions.length - 1, prev + 1));
          return;
        }
        if (key.return) {
          if (activeWizard.isMultiSelect) {
            const selectedList = Array.from(wizardSelectedSet).map(idx => wizardOptions[idx]).filter(Boolean);
            const answer = selectedList.join(", ");
            if (pendingQuestion) {
              pendingQuestion.resolve(answer);
              addLine({
                type: "system",
                content: `❓ Answered: "${answer}"`,
                timestamp: Date.now(),
              });
              setPendingQuestion(null);
              setActiveWizard(null);
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              setWizardSelectedSet(new Set());
            }
            return;
          }
          const selectedOption = wizardOptions[wizardSelectedIndex];
          if (pendingQuestion) {
            if (selectedOption === "Custom...") {
              setActiveWizard({
                type: "question",
                step: 2,
                data: { question: pendingQuestion.question },
              });
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              setInput("");
              return;
            }
            pendingQuestion.resolve(selectedOption);
            addLine({
              type: "system",
              content: `❓ Answered: "${selectedOption}"`,
              timestamp: Date.now(),
            });
            setPendingQuestion(null);
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
          }
          return;
        }
      } else if (activeWizard.type === "resume" && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(wizardOptions.length - 1, prev + 1));
          return;
        }
        if (key.return) {
          const sessions = listHistorySessions();
          const chosen = sessions[wizardSelectedIndex];
          if (!chosen) return;
          const now = Date.now();
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          if (agentRef.current) {
            agentRef.current.loadHistoryFromPath(chosen.filePath)
              .then(() => {
                const msgs = agentRef.current!.getHistory().getMessages();
                const loadedLines: ChatLine[] = [];
                const userInputs: string[] = [];
                for (const m of msgs) {
                  if (m.role === "user") {
                    loadedLines.push({ type: "user", content: `❯ ${m.content}`, timestamp: m.timestamp });
                    userInputs.push(m.content);
                  } else if (m.role === "assistant") {
                    if (m.content) {
                      loadedLines.push({ type: "assistant", content: m.content, timestamp: m.timestamp });
                    }
                    if (m.toolCalls && m.toolCalls.length > 0) {
                      for (const tc of m.toolCalls) {
                        const description = getToolDescription(tc);
                        loadedLines.push({ type: "tool_start", content: `⚡ ${description}\n   Detail: ${tc.name}(${formatArgs(tc.args)})`, timestamp: m.timestamp });
                      }
                    }
                  }
                }
                setLines(loadedLines);
                setHistory(userInputs);
                if (agentRef.current) setPlanState(agentRef.current.planState);
                addLine({ type: "system", content: `✓ Session resumed: ${chosen.displayName} (${msgs.length} messages)`, timestamp: now });
              })
              .catch((err: any) => {
                addLine({ type: "error", content: `Failed to resume session: ${err.message}`, timestamp: now });
              });
          }
          return;
        }
      } else if (activeWizard.type === "checkpoint" && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(wizardOptions.length - 1, prev + 1));
          return;
        }
        if (key.return) {
          const chosen = checkpointsList[wizardSelectedIndex];
          if (!chosen) return;
          const now = Date.now();

          // Step 1: If checkpoint has gitSha, show git restore confirmation
          if (activeWizard.step === 1 && chosen.gitSha) {
            setActiveWizard({ type: "checkpoint", step: 2, data: { checkpointIndex: String(wizardSelectedIndex) } });
            setWizardOptions(["✓ Ya, pulihkan workspace ke commit ini (git stash & checkout)", "✗ Tidak, hanya pulihkan riwayat percakapan saja"]);
            setWizardSelectedIndex(0);
            return;
          }

          // Perform restore (no git)
          const sessionPath = agentRef.current?.getCurrentHistoryFilePath();
          if (!sessionPath) return;
          const checkpointsDir = path.join(path.dirname(sessionPath), "checkpoints");
          const chkPath = path.join(checkpointsDir, `checkpoint_${chosen.timestamp}.json`);

          terminateActiveTasksAndSubagents();

          restoreCheckpoint(chkPath, sessionPath)
            .then(async () => {
              if (agentRef.current) {
                await agentRef.current.loadHistoryFromPath(sessionPath);
                const msgs = agentRef.current.getHistory().getMessages();
                const loadedLines: ChatLine[] = [];
                const userInputs: string[] = [];
                for (const m of msgs) {
                  if (m.role === "user") {
                    loadedLines.push({ type: "user", content: `❯ ${m.content}`, timestamp: m.timestamp });
                    userInputs.push(m.content);
                  } else if (m.role === "assistant") {
                    if (m.content) loadedLines.push({ type: "assistant", content: m.content, timestamp: m.timestamp });
                  }
                }
                setLines(loadedLines);
                setHistory(userInputs);
                setPlanState(agentRef.current.planState);
              }
              addLine({ type: "system", content: `✓ Checkpoint "${chosen.name}" berhasil dipulihkan! (${chosen.messages.length} messages)`, timestamp: now });
            })
            .catch((err: any) => {
              addLine({ type: "error", content: `Gagal memulihkan checkpoint: ${err.message}`, timestamp: now });
            });

          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setCheckpointsList([]);
          return;
        }
      } else if (activeWizard.type === "checkpoint" && activeWizard.step === 2) {
        // Git restore confirmation step
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(wizardOptions.length - 1, prev + 1));
          return;
        }
        if (key.return) {
          const chkIndex = parseInt(activeWizard.data.checkpointIndex || "0", 10);
          const chosen = checkpointsList[chkIndex];
          if (!chosen) return;
          const now = Date.now();
          const doGitRestore = wizardSelectedIndex === 0;
          const sessionPath = agentRef.current?.getCurrentHistoryFilePath();
          if (!sessionPath) return;

          const checkpointsDir = path.join(path.dirname(sessionPath), "checkpoints");
          const chkPath = path.join(checkpointsDir, `checkpoint_${chosen.timestamp}.json`);

          terminateActiveTasksAndSubagents();

          (async () => {
            try {
              // Git stash & checkout if user chose yes
              if (doGitRestore && chosen.gitSha) {
                try {
                  const { execa: execaFn } = await import("execa");
                  const targetCwd = agentRef.current?.workingDirectory || process.cwd();
                  await execaFn("git", ["stash", "--include-untracked"], { cwd: targetCwd, reject: false });
                  const checkoutRes = await execaFn("git", ["checkout", chosen.gitSha], { cwd: targetCwd, reject: false });
                  if (checkoutRes.failed) {
                    addLine({ type: "error", content: `Git restore gagal: ${checkoutRes.stderr || checkoutRes.message}. Riwayat percakapan tetap dipulihkan.`, timestamp: now });
                  } else {
                    addLine({ type: "system", content: `✓ Workspace dipulihkan ke Git commit: ${chosen.gitSha} (uncommitted changes di-stash)`, timestamp: now });
                  }
                } catch (gitErr: any) {
                  addLine({ type: "error", content: `Git restore gagal: ${gitErr.message}. Riwayat percakapan tetap dipulihkan.`, timestamp: now });
                }
              }

              // Restore conversation
              await restoreCheckpoint(chkPath, sessionPath);
              if (agentRef.current) {
                await agentRef.current.loadHistoryFromPath(sessionPath);
                const msgs = agentRef.current.getHistory().getMessages();
                const loadedLines: ChatLine[] = [];
                const userInputs: string[] = [];
                for (const m of msgs) {
                  if (m.role === "user") {
                    loadedLines.push({ type: "user", content: `❯ ${m.content}`, timestamp: m.timestamp });
                    userInputs.push(m.content);
                  } else if (m.role === "assistant") {
                    if (m.content) loadedLines.push({ type: "assistant", content: m.content, timestamp: m.timestamp });
                  }
                }
                setLines(loadedLines);
                setHistory(userInputs);
                setPlanState(agentRef.current.planState);
              }
              addLine({ type: "system", content: `✓ Checkpoint "${chosen.name}" berhasil dipulihkan! (${chosen.messages.length} messages)`, timestamp: now });
            } catch (err: any) {
              addLine({ type: "error", content: `Gagal memulihkan checkpoint: ${err.message}`, timestamp: now });
            }
          })();

          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setCheckpointsList([]);
          return;
        }
      } else if (activeWizard.type === "skills" && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(wizardOptions.length - 1, prev + 1));
          return;
        }
        if (key.return) {
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
            return;
          }

          const skillIndex = parseInt(activeWizard.data.skillIndex || "0", 10);
          const skillsList = getInstalledSkills();
          const chosen = skillsList[skillIndex];
          if (!chosen) return;

          if (wizardSelectedIndex === 0) {
            // Use / Activate Skill
            const now = Date.now();
            const slug = chosen.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
            addLine({
              type: "user",
              content: `❯ /skill-${slug}`,
              timestamp: now,
            });
            addLine({
              type: "system",
              content: `Activating skill "${chosen.name}"...\nInstruction path: ${chosen.path}`,
              timestamp: now,
            });
            setIsProcessing(true);
            agentRef.current?.sendMessage(
              `I would like you to use the following skill: "${chosen.name}".\nPlease read its instruction file at "${chosen.path}" using a file read tool first, and then help me with my request based on its instructions.`
            ).catch((err: any) => {
              addLine({ type: "error", content: `Skill activation error: ${err.message}`, timestamp: Date.now() });
            });

            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
          } else if (wizardSelectedIndex === 1) {
            // View Details
            const now = Date.now();
            const detailLines = [
              "┌───[ 📂 INSTALLED AGENT SKILLS ]",
              `│  • Name        : ${chosen.name}`,
              `│    Description : ${chosen.description}`,
              `│    Path        : ${chosen.path}`,
              "└──────────────────────────────────────────────",
            ];
            addLine({
              type: "system",
              content: detailLines.join("\n"),
              timestamp: now,
            });
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
          return;
        }
      }
    }

    if (key.ctrl && inputChar === "c") {
      if (stopRunningSubagents() > 0) {
        agentRef.current?.abort();
        setIsProcessing(false);
        setIsExecutingTool(false);
        setToolTimeout(null);
        setToolStartTime(null);
        setTimeLeft(null);
        return;
      }
      if (isProcessing) {
        agentRef.current?.abort();
      } else {
        exit();
      }
    }

    if (key.pageUp || (key.ctrl && key.upArrow) || (key.shift && key.upArrow)) {
      scrollChat("up");
    }

    if (key.pageDown || (key.ctrl && key.downArrow) || (key.shift && key.downArrow)) {
      scrollChat("down");
    }

    if (key.escape) {
      if (scrollOffset > 0) {
        setScrollOffset(0);
      } else if (activeWizard) {
        if (pendingPermission) {
          pendingPermission.resolve(false);
          setPendingPermission(null);
        }
        if (pendingQuestion) {
          pendingQuestion.resolve("");
          setPendingQuestion(null);
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setCheckpointsList([]);
        addLine({
          type: "system",
          content: "Wizard cancelled.",
          timestamp: Date.now(),
        });
      } else if (isProcessing) {
        if (stopRunningSubagents() > 0) {
          agentRef.current?.abort();
          setIsProcessing(false);
          setIsExecutingTool(false);
          setToolTimeout(null);
          setToolStartTime(null);
          setTimeLeft(null);
          return;
        }
        agentRef.current?.abort();
      } else {
        setInput("");
        setIsPasted(false);
        setHistoryIndex(-1);
      }
    }

    if (
      (key.backspace || key.delete) &&
      isPasted &&
      (input.length > 200 || input.includes("\n")) &&
      !isProcessing
    ) {
      setInput((prev) => {
        const next = prev.slice(0, -1);
        const hasNewline = next.includes("\n");
        if (next.length <= 200 && !hasNewline) {
          setIsPasted(false);
        }
        return next;
      });
    }

    if (key.return && !isProcessing) {
      if (isPasted && (input.length > 200 || input.includes("\n"))) {
        handleSubmit(input);
      }
    }

    if (key.upArrow && !isProcessing && history.length > 0) {
      let newIndex = historyIndex;
      if (historyIndex === -1) {
        setTempInput(input);
        newIndex = history.length - 1;
      } else if (historyIndex > 0) {
        newIndex = historyIndex - 1;
      }
      setHistoryIndex(newIndex);
      setInput(history[newIndex]);
      setIsPasted(false);
    }

    if (key.downArrow && !isProcessing) {
      if (historyIndex !== -1) {
        if (historyIndex === history.length - 1) {
          setHistoryIndex(-1);
          setInput(tempInput);
          setIsPasted(false);
        } else {
          const newIndex = historyIndex + 1;
          setHistoryIndex(newIndex);
          setInput(history[newIndex]);
          setIsPasted(false);
        }
      }
    }

    if (key.tab && !isProcessing) {
      if (input.startsWith("/")) {
        const prefix = lastTabPrefix || input;
        const matches = getSuggestions(prefix);
        if (matches.length > 0) {
          const currentMatchIndex = matches.indexOf(input);
          let nextIndex = 0;
          if (currentMatchIndex !== -1) {
            nextIndex = (currentMatchIndex + 1) % matches.length;
          } else {
            setLastTabPrefix(input);
          }
          setInput(matches[nextIndex]);
          setIsPasted(false);
        }
      }
    }
  });

  const handlePermissionResponse = useCallback(
    (approved: boolean) => {
      if (pendingPermission) {
        pendingPermission.resolve(approved);
        addLine({
          type: "system",
          content: approved ? "✓ Permission granted" : "✗ Permission denied",
          timestamp: Date.now(),
        });
        setPendingPermission(null);
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      }
    },
    [pendingPermission, addLine]
  );

  useInput(
    (inputChar) => {
      if (inputChar === "y" || inputChar === "Y") {
        handlePermissionResponse(true);
      } else if (inputChar === "n" || inputChar === "N") {
        handlePermissionResponse(false);
      }
    },
    { isActive: activeWizard?.type === "permission" }
  );

  const getWizardPlaceholder = () => {
    if (!activeWizard) return "Type a message or /help...";
    if (activeWizard.type === "login") {
      if (activeWizard.step === 1) return "Select option using arrows and Enter...";
      if (activeWizard.step === 2) return "Select provider template using arrows and Enter...";
      if (activeWizard.step === 3) return "Enter config profile name (or press Enter for default)...";
      if (activeWizard.step === 4) return "Enter Custom Base URL...";
      if (activeWizard.step === 5) return "Select provider to switch to using arrows and Enter...";
      if (activeWizard.step === 6) return "Paste API key...";
      if (activeWizard.step === 10) return "Select option using arrows and Enter...";
      if (activeWizard.step === 11) return "Enter project name (press Enter for folder default)...";
      if (activeWizard.step === 12) return "Enter project description (press Enter for default)...";
      if (activeWizard.step === 13) return "Describe the project (e.g. CLI tool in Rust)...";
    }
    if (activeWizard.type === "model") {
      if (activeWizard.step === 1) return "Select agent tier (Use Arrow Keys Up/Down & Enter)...";
      if (activeWizard.step === 2) return "Enter provider number or select using arrows...";
      return wizardOptions.length > 0
        ? "🔍 Search models (type to filter, arrows to navigate, Enter to select)..."
        : "Enter model name (e.g. google/gemini-2.5-flash)...";
    }
    if (activeWizard.type === "question") {
      if (activeWizard.step === 2) return "Type custom answer and press Enter...";
      return "Select option using arrows and Enter, or choose Custom...";
    }
    return "Enter value...";
  };

  const getSuggestions = (currentInput = input) => {
    if (!currentInput.startsWith("/")) return [];

    // Split by spaces, but keep the space formatting
    const trimmed = currentInput.trim();
    const parts = trimmed.split(/\s+/);
    const mainCommand = parts[0];

    // If typing the main command itself (e.g. "/" or "/t" or "/terminal" without space)
    if (!currentInput.includes(" ")) {
      return filterSuggestions(commands, currentInput);
    }

    // If there is a space, we are offering suggestions for subcommands / arguments
    if (mainCommand === "/processes" || mainCommand === "/procs") {
      if (currentInput.startsWith(`${mainCommand} stop`)) {
        const stopSuggestions = [`${mainCommand} stop all`];
        for (const [id] of backgroundTasks.entries()) {
          stopSuggestions.push(`${mainCommand} stop ${id}`);
        }
        return stopSuggestions.filter(p => p.startsWith(currentInput));
      }
      return [`${mainCommand} stop`, `${mainCommand} stop all`].filter(p => p.startsWith(currentInput));
    }

    if (mainCommand === "/terminal") {
      const presetEntries = terminalPresets;
      const presetLabels = presetEntries.map(p => p.label);

      if (currentInput.startsWith("/terminal preset ") || currentInput === "/terminal preset") {
        return presetLabels.map(lbl => `/terminal preset ${lbl}`).filter(p => p.startsWith(currentInput));
      }

      if (currentInput.startsWith("/terminal bg preset ") || currentInput === "/terminal bg preset") {
        return presetLabels.map(lbl => `/terminal bg preset ${lbl}`).filter(p => p.startsWith(currentInput));
      }

      if (currentInput.startsWith("/terminal bg ") || currentInput === "/terminal bg") {
        // Offer both `/terminal bg preset <name>` and `/terminal bg <preset_name>`
        const bgPossibilities = [
          "/terminal bg preset",
          ...presetLabels.map(lbl => `/terminal bg preset ${lbl}`),
          ...presetLabels.map(lbl => `/terminal bg ${lbl}`)
        ];
        return bgPossibilities.filter(p => p.startsWith(currentInput));
      }

      if (currentInput.startsWith("/terminal stop")) {
        const stopSuggestions = ["/terminal stop all"];
        for (const [id] of backgroundTasks.entries()) {
          if (id.startsWith("term-")) {
            stopSuggestions.push(`/terminal stop ${id}`);
          }
        }
        return stopSuggestions.filter(p => p.startsWith(currentInput));
      }

      const subCommands = ["init", "all", "preset", "bg", "stop"];
      let possibilities: string[] = [];
      possibilities.push(...subCommands.map(sub => `/terminal ${sub}`));
      possibilities.push(...presetLabels.map(lbl => `/terminal ${lbl}`));

      const uniquePossibilities = Array.from(new Set(possibilities));
      const query = currentInput.replace("/terminal", "").trim();
      return query ? filterSuggestions(uniquePossibilities, query) : filterSuggestions(uniquePossibilities, currentInput);
    }

    if (mainCommand === "/checkpoint") {
      if (currentInput.startsWith("/checkpoint restore")) {
        const checkpointIds = checkpointsListState.map(c => c.id);
        const possibilities = checkpointIds.map(id => `/checkpoint restore ${id}`);
        const query = currentInput.replace("/checkpoint restore", "").trim();
        return query ? filterSuggestions(possibilities, query) : possibilities;
      }

      const subCommands = ["list", "restore"];
      const possibilities = subCommands.map(sub => `/checkpoint ${sub}`);
      const query = currentInput.replace("/checkpoint", "").trim();
      return query ? filterSuggestions(possibilities, query) : possibilities;
    }

    if (mainCommand === "/login") {
      const providers = ["openrouter", "anthropic", "openai", "custom"];
      const possibilities = providers.map(p => `/login ${p}`);
      const query = currentInput.replace("/login", "").trim();
      return query ? filterSuggestions(possibilities, query) : possibilities;
    }

    if (mainCommand === "/model") {
      const commonModels = [
        "google/gemini-2.5-flash",
        "google/gemini-2.5-pro",
        "anthropic/claude-3-5-sonnet",
        "openai/gpt-4o",
        "openai/gpt-4o-mini"
      ];
      const possibilities = commonModels.map(m => `/model ${m}`);
      const query = currentInput.replace("/model", "").trim();
      return query ? filterSuggestions(possibilities, query) : possibilities;
    }

    if (mainCommand === "/install") {
      const commonSkills = [
        "obra/superpowers-skills/find-skills",
        "obra/superpowers-skills/agent-browser",
        "obra/superpowers-skills/systematic-debugging"
      ];
      const possibilities = commonSkills.map(s => `/install ${s}`);
      const query = currentInput.replace("/install", "").trim();
      return query ? filterSuggestions(possibilities, query) : possibilities;
    }

    return [];
  };


  const suggestions = getSuggestions();
  const messageCount = lines.filter(
    (l) => l.type === "user" || l.type === "assistant"
  ).length;
  const modelName = process.env.MODEL || getDefaultModel();
  const liveStreamTokens = Math.ceil(streamDisplay.length / 4);
  const activeContextUsage = lastPromptTokens > 0 ? (lastPromptTokens + liveStreamTokens) : 0;
  const contextPercentage = contextLimit > 0 ? ((activeContextUsage / contextLimit) * 100).toFixed(2) : "0.00";
  const lastUserLine = [...lines].reverse().find((l) => l.type === "user");
  const lastUserPrompt = lastUserLine ? lastUserLine.content.replace(/^❯ /, "").replace(/\n/g, " ") : "";
  const displayPrompt = lastUserPrompt.length > 50 ? lastUserPrompt.slice(0, 47) + "..." : lastUserPrompt;

  const planPath = agentRef.current ? agentRef.current.getPlanFilePath() : path.join(process.cwd(), "implementation_plan.md");
  const planUrl = `file:///${planPath.replace(/\\/g, "/")}`;

  // Calculate layout dimensions dynamically
  const chatWidth = Math.max(20, terminalWidth - 6);

  // Dynamic estimate of markdown line rendering count
  const estimateMarkdownLines = (text: string, width: number): number => {
    let count = 0;
    const rawLines = text.split("\n");
    for (const l of rawLines) {
      count += Math.max(1, Math.ceil(l.length / width));
    }
    return count;
  };

  const maxAssistantResponseLines = Math.max(8, Math.min(18, Math.floor(terminalHeight * 0.45)));

  // Dynamic estimate of ChatLine height in terminal rows
  const estimateChatLineHeight = (line: ChatLine, width: number): number => {
    let linesCount = 2; // Border header + spacing lines
    const textLines = line.content.split("\n");
    const maxContentLines = line.type === "assistant" ? maxAssistantResponseLines + 1 : Number.POSITIVE_INFINITY;
    for (const l of textLines) {
      let rawText = l;
      if (line.type === "user") {
        rawText = l.replace(/^❯ /, "");
      } else if (line.type === "tool_start") {
        rawText = l.replace(/^⚡ /, "");
      }
      linesCount += Math.max(1, Math.ceil(rawText.length / width));
      if (linesCount >= maxContentLines + 2) {
        return maxContentLines + 2;
      }
    }
    return linesCount;
  };

  // Calculate dynamic input line height wrapping
  const inputLinesCount = input ? Math.max(1, Math.ceil((input.length + 6) / terminalWidth)) : 1;

  const activeToolLines = activeToolOutput ? activeToolOutput.trim().split("\n").slice(-8) : [];
  const activeToolLinesCount = activeToolLines.length;

  const showBanner = messageCount === 0;
  // Base chrome height: Banner is 6 (if shown), Input wrapper base is 2 (header + margin + prompt border/spacers), Status bar is 5 (5 lines + margin)
  let chromeHeight = (showBanner ? 14 : 7) + inputLinesCount;
  if (isExecutingTool) {
    chromeHeight += 3; // Loader header + loader line + top margin
    if (activeToolLinesCount > 0) {
      chromeHeight += activeToolLinesCount + 1; // Live output header + lines
    }
  }
  if (planState === "PLANNING_PENDING") {
    if (activeWizard?.type === "plan_approve") {
      chromeHeight += 8;
    } else {
      chromeHeight += 6;
    }
  }
  if (activeWizard) {
    chromeHeight += 3;
    if (activeWizard.type === "login") {
      if (activeWizard.step === 1 || activeWizard.step === 2) {
        chromeHeight += 8;
      } else if (activeWizard.step === 5 || activeWizard.step === 10) {
        chromeHeight += 8 + Math.min(6, wizardOptions.length);
      } else if (activeWizard.step === 11 || activeWizard.step === 12 || activeWizard.step === 13) {
        chromeHeight += 6;
      }
    } else if (activeWizard.type === "model" && wizardOptions.length > 0) {
      chromeHeight += 13; // +1 for search result count line
    } else if (activeWizard.type === "permission") {
      chromeHeight += 9;
    } else if (activeWizard.type === "question") {
      chromeHeight += 8 + Math.min(6, wizardOptions.length);
    }
  } else if (input.startsWith("/") && suggestions.length > 0) {
    chromeHeight += 2;
  }
  if (isProcessing) {
    if (streamDisplay && streamDisplay.trim().length > 0) {
      chromeHeight += 2; // Stream header and spacing
    } else if (activeWizard?.type !== "permission" && !isExecutingTool) {
      chromeHeight += 3; // Thinking loading indicator + top margin
    }
  }

  if (planState === "APPROVED" && checklistTasks.length > 0) {
    chromeHeight += 3 + checklistTasks.length;
  }

  let liveListHeight = 0;
  if (runningSuperagentsCount > 0 || runningSubagentsCount > 0 || runningTasksCount > 0) {
    liveListHeight += 1; // padding/margin
    if (runningSuperagentsCount > 0) {
      liveListHeight += 1; // header
      liveListHeight += runningSuperagentsCount * 3; // Each superagent takes 3 lines
    }
    if (runningSubagentsCount > 0) {
      liveListHeight += 1; // header
      if (runningSuperagentsCount > 0) {
        liveListHeight += 1; // marginTop
      }
      liveListHeight += runningSubagentsCount * 2; // Each subagent takes 2 lines
    }
    if (runningTasksCount > 0) {
      liveListHeight += 1; // header
      liveListHeight += runningTasksCount; // Each task is 1 line
      if (runningSuperagentsCount > 0 || runningSubagentsCount > 0) {
        liveListHeight += 1; // marginTop
      }
    }
  }
  chromeHeight += liveListHeight;

  // Calculate available height for messages with a safety buffer to prevent terminal scrolling/duplicated headers
  const chatHeightLimit = Math.max(5, terminalHeight - chromeHeight - 1);

  return (
    <Box flexDirection="column" height={terminalHeight}>
      {showBanner && <Banner />}

      <Box flexDirection="row" flexGrow={1}>
        {/* Chat Area */}
        <Box flexDirection="column" width="100%" flexGrow={1}>
          {/* Messages */}
          <Box flexDirection="column" paddingX={1} flexGrow={1}>
            {focusedResponseIndex !== null ? (() => {
              const width = Math.max(20, chatWidth - 6);
              const maxLines = Math.max(8, Math.min(18, Math.floor(terminalHeight * 0.45)));
              const truncatedIndexes = getTruncatedAssistantIndexes(lines, maxLines, chatWidth);
              const currentPosition = Math.max(0, truncatedIndexes.indexOf(focusedResponseIndex));
              const focusedLine = lines[focusedResponseIndex];
              if (!focusedLine || focusedLine.type !== "assistant") return null;
              const focusWindowHeight = Math.max(5, chatHeightLimit - 3);
              const responseLines = wrapTextForDisplay(focusedLine.content, width);
              const maxOffset = Math.max(0, responseLines.length - focusWindowHeight);
              const safeOffset = Math.min(focusedResponseOffset, maxOffset);
              const visibleText = responseLines.slice(safeOffset, safeOffset + focusWindowHeight).join("\n");
              const visibleEnd = Math.min(responseLines.length, safeOffset + focusWindowHeight);
              return (
                <Box flexDirection="column">
                  <Text color="yellow">
                    ┌───[ <Text bold color="yellow">RESPONSE_SCROLL</Text><Text dimColor> {currentPosition + 1}/{Math.max(1, truncatedIndexes.length)} line {safeOffset + 1}-{visibleEnd} / {responseLines.length} {renderScrollBar(safeOffset, focusWindowHeight, responseLines.length)} | n/p switch | Esc close</Text> ]
                  </Text>
                  {renderMarkdown(visibleText, "magenta")}
                  <Text color="yellow">└───[ focused assistant response #{focusedResponseIndex + 1} ]</Text>
                </Box>
              );
            })() : (() => {
              let startIndex = lines.length;
              let accumulatedHeight = 0;
              const endIndex = scrollOffset === 0 ? lines.length : Math.max(0, lines.length - scrollOffset);

              let effectiveChatHeightLimit = chatHeightLimit;
              let streamVisibleLinesCount = 0;
              const shouldRenderStream = scrollOffset === 0 && isProcessing && streamDisplay && streamDisplay.trim().length > 0;

              if (shouldRenderStream) {
                const totalStreamLines = estimateMarkdownLines(streamDisplay, chatWidth);
                const maxStreamHeight = Math.max(3, chatHeightLimit - 2); // Keep at least 2 lines for history/headers
                if (totalStreamLines > maxStreamHeight) {
                  streamVisibleLinesCount = maxStreamHeight;
                  effectiveChatHeightLimit = Math.max(0, chatHeightLimit - streamVisibleLinesCount);
                } else {
                  streamVisibleLinesCount = totalStreamLines;
                  effectiveChatHeightLimit = chatHeightLimit - totalStreamLines;
                }
              }

              for (let i = endIndex - 1; i >= 0; i--) {
                const h = estimateChatLineHeight(lines[i], chatWidth);
                if (accumulatedHeight + h > effectiveChatHeightLimit) {
                  if (i === endIndex - 1 && effectiveChatHeightLimit > 0) {
                    startIndex = i; // Show at least the latest line if there is any history space
                  }
                  break;
                }
                accumulatedHeight += h;
                startIndex = i;
              }

              const visibleLines = lines.slice(startIndex, endIndex);
              return (
                <>
                  {visibleLines.map((line, i) => {
                    const originalIndex = startIndex + i;
                    return (
                      <ChatLineComponent
                        key={originalIndex}
                        line={line}
                        isFirst={originalIndex === 0}
                        tokensUp={tokensUp}
                        tokensDown={tokensDown}
                        modelName={modelName}
                        maxResponseLines={maxAssistantResponseLines}
                        chatWidth={chatWidth}
                      />
                    );
                  })}

                  {shouldRenderStream && (
                    <Box flexDirection="column">
                      <Text color="magenta">
                        {visibleLines.length === 0 ? "┌" : "├"}───[ <Text bold color="magenta">✦ COGNITIVE_NODE: SUPERAGENT (STREAMING...)</Text><Text dimColor> (▲{formatCompactNumber(tokensUp)} | ▼{formatCompactNumber(tokensDown + liveStreamTokens)})</Text> ]
                      </Text>
                      {renderMarkdown(
                        truncateStreamDisplay(streamDisplay, streamVisibleLinesCount, chatWidth),
                        "magenta",
                        true
                      )}
                    </Box>
                  )}
                </>
              );
            })()}

            {scrollOffset === 0 && isProcessing && (!streamDisplay || streamDisplay.trim().length === 0) && activeWizard?.type !== "permission" && !isExecutingTool && (
              <Box flexDirection="column" marginTop={2}>
                <Text color="magenta">
                  ├───[ <Text bold color="magenta">✦ COGNITIVE_NODE: SUPERAGENT (THINKING...)</Text><Text dimColor> (▲{formatCompactNumber(tokensUp)} | ▼{formatCompactNumber(tokensDown)})</Text> ]
                </Text>
                <Box flexDirection="row">
                  <Text color="magenta">│    </Text>
                  <LoadingIndicator />
                </Box>
              </Box>
            )}

            {scrollOffset === 0 && isExecutingTool && (
              <Box flexDirection="column" marginTop={2}>
                <Text color="yellow">
                  ├───[ <Text bold color="yellow">⚙️ SYSTEM_CALL: EXECUTING...{timeLeft !== null ? ` (${timeLeft}s left)` : ""}</Text> ]
                </Text>
                <Box flexDirection="row">
                  <Text color="yellow">│    </Text>
                  <ToolLoadingIndicator />
                </Box>
                {activeToolLinesCount > 0 && (
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

          {/* Permission prompt */}
          {activeWizard && activeWizard.type === "permission" && pendingPermission && (
            <WizardDialog
              title="⚠️ PERMISSION REQUIRED (Use Arrow Keys Up/Down & Enter, or press Y/N):"
              description={pendingPermission.description}
              borderColor="yellow"
              options={wizardOptions}
              selectedIndex={wizardSelectedIndex}
            />
          )}

          {/* Input */}
          <Box flexDirection="column" paddingX={1} marginTop={1}>
            {/* Active Superagents, Subagents & Tasks Live List */}
            {(runningSuperagentsCount > 0 || runningSubagentsCount > 0 || runningTasksCount > 0) && (
              <Box flexDirection="column" marginBottom={1}>
                {runningSuperagentsCount > 0 && (
                  <Box flexDirection="column">
                    <Text color="cyan" bold>⚡ ACTIVE SUPERAGENTS:</Text>
                    {Array.from(superagentInstances.values())
                      .filter((s) => s.status === "running")
                      .map((inst) => (
                        <Box key={inst.id} flexDirection="column">
                          <Text color="cyan">
                            ├─ [{inst.id}] Role: {inst.role} ({inst.status})
                          </Text>
                          <Text color="cyan">
                            │  ├─ Task: <Text color="white">{inst.task}</Text>
                          </Text>
                          <Text color="cyan">
                            │  └─ Action: <Text italic color="white">{getLatestSuperagentAction(inst.logs)}</Text>
                          </Text>
                        </Box>
                      ))}
                  </Box>
                )}
                {runningSubagentsCount > 0 && (
                  <Box flexDirection="column" marginTop={runningSuperagentsCount > 0 ? 1 : 0}>
                    <Text color="yellow" bold>🤖 ACTIVE SUBAGENTS:</Text>
                    {Array.from(subagentInstances.values())
                      .filter((s) => s.status === "running")
                      .map((inst) => (
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
                )}
                {runningTasksCount > 0 && (
                  <Box flexDirection="column" marginTop={(runningSuperagentsCount > 0 || runningSubagentsCount > 0) ? 1 : 0}>
                    <Text color="cyan" bold>⚙️ ACTIVE PROCESSES:</Text>
                    {Array.from(backgroundTasks.entries())
                      .map(([id, task]) => (
                        <Text key={id} color="cyan">
                          ├─ [{id}] Command: {task.command}
                        </Text>
                      ))}
                  </Box>
                )}
              </Box>
            )}

            {planState === "APPROVED" && checklistTasks.length > 0 && (() => {
              const totalTasks = checklistTasks.length;
              const completedTasks = checklistTasks.filter((t) => t.status === "x").length;
              const inProgressTasks = checklistTasks.filter((t) => t.status === "/").length;
              const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
              const barLength = Math.max(10, Math.min(25, terminalWidth - 30));
              const filled = Math.round((pct / 100) * barLength);
              const bar = "█".repeat(filled) + "░".repeat(barLength - filled);
              return (
                <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text bold color="cyan">📋 ACTIVE TASK CHECKLIST ({completedTasks}/{totalTasks} completed)</Text>
                  </Box>
                  <Box flexDirection="row" marginBottom={1}>
                    <Text color="cyan">Progress: [ </Text>
                    <Text color="green" bold>{bar}</Text>
                    <Text color="cyan"> ] {pct}% ({completedTasks}/{totalTasks} completed, {inProgressTasks} in progress)</Text>
                  </Box>
                  {checklistTasks.map((task, idx) => {
                    let statusChar = "[ ]";
                    let taskColor = "white";
                    let statusText = "";
                    if (task.status === "x") {
                      statusChar = "[✓]";
                      taskColor = "gray";
                    } else if (task.status === "/") {
                      statusChar = "[/]";
                      taskColor = "yellow";
                      statusText = " (in progress)";
                    }
                    return (
                      <Box key={idx} flexDirection="row">
                        <Text color={task.status === "x" ? "green" : task.status === "/" ? "yellow" : "cyan"}>
                          {statusChar}{" "}
                        </Text>
                        <Text color={taskColor} strikethrough={task.status === "x"}>
                          {task.text}{statusText}
                        </Text>
                      </Box>
                    );
                  })}
                </Box>
              );
            })()}

            {planState === "PLANNING_PENDING" && activeWizard?.type !== "plan_approve" && (
              <Box marginBottom={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
                <Text bold color="yellow">⚠️ PENDING_PLAN: RENCANA IMPLEMENTASI MEMBUTUHKAN PERSETUJUAN</Text>
                <Text color="yellow">Model AI telah merancang rencana di file: <Text bold color="cyan">{planUrl}</Text></Text>
                <Text color="yellow">Silakan kirim pesan/masukan apa saja untuk menampilkan kembali dialog persetujuan wizard.</Text>
              </Box>
            )}

            {activeWizard && activeWizard.type === "plan_approve" && wizardOptions.length > 0 && (
              <WizardDialog
                title="⚠️ PLAN APPROVAL REQUIRED (Use Arrow Keys Up/Down & Enter):"
                description={`Model AI telah merancang rencana di file: ${planUrl}`}
                borderColor="yellow"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
              />
            )}

            {activeWizard && activeWizard.type === "question" && pendingQuestion && (
              <WizardDialog
                title={activeWizard.step === 2 ? "❓ ENTER CUSTOM ANSWER (Type and press Enter):" : (activeWizard.isMultiSelect ? "❓ QUESTION FROM AGENT (Arrows: navigate, Space: select, Enter: submit):" : "❓ QUESTION FROM AGENT (Use Arrow Keys Up/Down & Enter):")}
                description={pendingQuestion.question}
                borderColor="cyan"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
                isMultiSelect={activeWizard.isMultiSelect}
                selectedSet={wizardSelectedSet}
              />
            )}

            {activeWizard && activeWizard.type === "login" && activeWizard.step === 1 && wizardOptions.length > 0 && (
              <WizardDialog
                title="🔑 PROVIDER MANAGER (Use Arrow Keys Up/Down & Enter):"
                borderColor="cyan"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
              />
            )}

            {activeWizard && activeWizard.type === "login" && activeWizard.step === 2 && wizardOptions.length > 0 && (
              <WizardDialog
                title="🔑 SELECT PROVIDER TEMPLATE (Use Arrow Keys Up/Down & Enter):"
                borderColor="cyan"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
              />
            )}

            {activeWizard && activeWizard.type === "login" && activeWizard.step === 5 && wizardOptions.length > 0 && (
              <WizardDialog
                title="🔑 SWITCH ACTIVE PROVIDER (Use Arrow Keys Up/Down & Enter):"
                borderColor="cyan"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
              />
            )}

            {activeWizard && activeWizard.type === "login" && activeWizard.step === 10 && wizardOptions.length > 0 && (
              <WizardDialog
                title="🛠️ PROJECT INITIALIZATION — Select Technology Stack (Arrows & Enter):"
                description="Choose a template catalog stack or let AI dynamically design your project details:"
                borderColor="cyan"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
              />
            )}

            {activeWizard && activeWizard.type === "login" && activeWizard.step === 11 && (
              <WizardDialog
                title="🛠️ PROJECT INITIALIZATION — Enter Project Name (Type & Enter):"
                description="Specify the catalog name for this workspace:"
                borderColor="cyan"
                options={[]}
                selectedIndex={0}
              />
            )}

            {activeWizard && activeWizard.type === "login" && activeWizard.step === 12 && (
              <WizardDialog
                title="🛠️ PROJECT INITIALIZATION — Enter Project Description (Type & Enter):"
                description="Give a one-sentence overview description of this software:"
                borderColor="cyan"
                options={[]}
                selectedIndex={0}
              />
            )}

            {activeWizard && activeWizard.type === "login" && activeWizard.step === 13 && (
              <WizardDialog
                title="🤖 AI PROJECT INITIALIZATION — Describe Project Goal (Type & Enter):"
                description="State what you want to build (e.g. 'A command-line text editor in Rust'). AI will construct agents.md specs:"
                borderColor="magenta"
                options={[]}
                selectedIndex={0}
              />
            )}

            {activeWizard && activeWizard.type === "model" && activeWizard.step === 1 && wizardOptions.length > 0 && (
              <WizardDialog
                title="⚙️ SELECT AGENT TIER TO CONFIGURE (Use Arrow Keys Up/Down & Enter):"
                borderColor="cyan"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
              />
            )}

            {activeWizard && activeWizard.type === "model" && activeWizard.step === 2 && wizardOptions.length > 0 && (
              <WizardDialog
                title="⚙️ SELECT PROVIDER FOR MODELS (Use Arrow Keys Up/Down & Enter):"
                borderColor="cyan"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
              />
            )}

            {activeWizard && activeWizard.type === "model" && activeWizard.step === 3 && wizardOptions.length > 0 && (() => {
              const modelSearchQuery = input.trim().toLowerCase();
              const filteredModels = modelSearchQuery
                ? wizardOptions.filter((m) => m.toLowerCase().includes(modelSearchQuery))
                : wizardOptions;
              const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredModels.length - 1));
              const searchTitle = modelSearchQuery
                ? `⚙️ SELECT MODEL — 🔍 "${input.trim()}" (${filteredModels.length}/${wizardOptions.length} results):`
                : `⚙️ SELECT MODEL (${wizardOptions.length} available — type to filter, ↑/↓ navigate, Enter select):`;
              return (
                <WizardDialog
                  title={searchTitle}
                  borderColor="cyan"
                  options={filteredModels.length > 0 ? filteredModels : ["(no results)"]}
                  selectedIndex={clampedIndex}
                  maxVisible={6}
                  isLoading={wizardIsLoadingModels}
                />
              );
            })()}

            {activeWizard && activeWizard.type === "resume" && wizardOptions.length > 0 && (
              <WizardDialog
                title="📚 RESUME SESSION — Pilih sesi untuk dilanjutkan (↑/↓ Navigate, Enter: Load, Esc: Cancel):"
                description="Sesi diurutkan dari yang paling baru:"
                borderColor="magenta"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
                maxVisible={8}
              />
            )}

            {activeWizard && activeWizard.type === "skills" && wizardOptions.length > 0 && (() => {
              const skillTitle = activeWizard.step === 2
                ? `📂 SKILL ACTION — Pilih tindakan untuk skill: "${getInstalledSkills()[parseInt(activeWizard.data.skillIndex || "0", 10)]?.name || ""}" (↑/↓ Navigate, Enter: Select):`
                : "📂 INSTALLED AGENT SKILLS — Pilih skill (↑/↓ Navigate, Enter: Choose, Esc: Cancel):";
              const skillDesc = activeWizard.step === 2
                ? "Silakan pilih apakah ingin mengaktifkan skill ini untuk agen atau melihat detail lokasinya:"
                : "Daftar kemampuan khusus agen yang terpasang:";
              return (
                <WizardDialog
                  title={skillTitle}
                  description={skillDesc}
                  borderColor="cyan"
                  options={wizardOptions}
                  selectedIndex={wizardSelectedIndex}
                  maxVisible={8}
                />
              );
            })()}

            {activeWizard && activeWizard.type === "checkpoint" && activeWizard.step === 1 && wizardOptions.length > 0 && (
              <WizardDialog
                title="📌 CHECKPOINT — Pilih checkpoint untuk dipulihkan (↑/↓ Navigate, Enter: Restore, Esc: Cancel):"
                description="Checkpoints diurutkan dari yang paling baru:"
                borderColor="green"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
                maxVisible={8}
              />
            )}

            {activeWizard && activeWizard.type === "checkpoint" && activeWizard.step === 2 && wizardOptions.length > 0 && (
              <WizardDialog
                title="📌 RESTORE WORKSPACE — Pulihkan kode workspace ke Git commit checkpoint? (↑/↓ Navigate, Enter: Select):"
                description={`Git commit: ${checkpointsList[parseInt(activeWizard.data.checkpointIndex || "0", 10)]?.gitSha || "unknown"}`}
                borderColor="yellow"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
              />
            )}

            {activeWizard && activeWizard.type === "goal" && activeWizard.step === 1 && (
              <WizardDialog
                title="🎯 GOAL MODE — Deskripsikan tujuan yang ingin dicapai (Type & Enter):"
                description="Agent akan bekerja tanpa henti sampai goal tercapai. Gunakan Ctrl+C untuk membatalkan."
                borderColor="yellow"
                options={[]}
                selectedIndex={0}
              />
            )}

            {/* Goal Mode Banner */}
            {goalMode && !activeWizard && (
              <Box marginBottom={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
                <Text bold color="yellow">🎯 GOAL MODE ACTIVE ─────────────────────────────────────</Text>
                <Text color="yellow">  Target: <Text bold color="white">{goalMode.goal.length > 80 ? goalMode.goal.slice(0, 77) + "..." : goalMode.goal}</Text></Text>
                <Text color="yellow" dimColor>  Running... (Ctrl+C to abort)</Text>
              </Box>
            )}

            {/* Render suggestions inline above the input line */}
            {!activeWizard && input.startsWith("/") && suggestions.length > 0 && (() => {
              const MAX_VISIBLE_SUGGESTIONS = 5;
              let visibleSuggestions: string[] = [];
              let hasMoreSuffix = false;
              let hasMorePrefix = false;
              let remainingCount = 0;

              if (suggestions.length <= MAX_VISIBLE_SUGGESTIONS) {
                visibleSuggestions = suggestions;
              } else {
                const selectedIndex = suggestions.indexOf(input);
                if (selectedIndex === -1 || selectedIndex < MAX_VISIBLE_SUGGESTIONS - 1) {
                  visibleSuggestions = suggestions.slice(0, MAX_VISIBLE_SUGGESTIONS - 1);
                  hasMoreSuffix = true;
                  remainingCount = suggestions.length - visibleSuggestions.length;
                } else {
                  visibleSuggestions = [
                    suggestions[0],
                    suggestions[selectedIndex - 1],
                    suggestions[selectedIndex],
                  ];
                  if (selectedIndex + 1 < suggestions.length) {
                    visibleSuggestions.push(suggestions[selectedIndex + 1]);
                  }
                  hasMorePrefix = true;
                  hasMoreSuffix = selectedIndex + 2 < suggestions.length;
                  remainingCount = suggestions.length - visibleSuggestions.length;
                }
              }

              return (
                <Box marginBottom={1} flexDirection="row">
                  <Text dimColor>Suggestions: </Text>
                  {hasMorePrefix && (
                    <>
                      <Box marginRight={2}>
                        <Text color={input === suggestions[0] ? "cyan" : "gray"} bold={input === suggestions[0]} underline={input === suggestions[0]}>
                          {suggestions[0]}
                        </Text>
                      </Box>
                      <Box marginRight={2}>
                        <Text dimColor>...</Text>
                      </Box>
                    </>
                  )}
                  {visibleSuggestions.map((s, idx) => {
                    if (hasMorePrefix && idx === 0) return null;
                    const isSelected = input === s;
                    return (
                      <Box key={s} marginRight={2}>
                        <Text color={isSelected ? "cyan" : "gray"} bold={isSelected} underline={isSelected}>
                          {s}
                        </Text>
                      </Box>
                    );
                  })}
                  {hasMoreSuffix && (
                    <Box marginRight={2}>
                      <Text dimColor>... (+{remainingCount} more)</Text>
                    </Box>
                  )}
                </Box>
              );
            })()}



            <Box flexDirection="column">
              <Text color={scrollOffset > 0 ? "yellow" : activeWizard ? "magenta" : isProcessing ? "gray" : "green"}>
                └───[ <Text bold color={scrollOffset > 0 ? "yellow" : activeWizard ? "magenta" : isProcessing ? "gray" : "green"}>
                  {activeWizard ? `⚙️ WIZARD: ${activeWizard.type.toUpperCase()} (Step ${activeWizard.step})` : "⌨️ COMM_LINK: ACTIVE"}
                </Text> ]
                {isProcessing && displayPrompt && (
                  <Text color="cyan" bold> ─── [ PROMPT: "{displayPrompt}" ]</Text>
                )}
                {scrollOffset > 0 && (
                  <Text color="yellow" bold> [Scroll: -{scrollOffset} lines/msgs - Press Esc to snap to bottom]</Text>
                )}
              </Text>
              <Box flexDirection="row">
                <Text color={activeWizard ? "magenta" : isProcessing ? "gray" : "green"}>│ ❯ </Text>
                {isProcessing && !activeWizard ? (
                  <ProcessingIndicator scrollOffset={scrollOffset} />
                ) : (isPasted && (input.length > 200 || input.includes("\n"))) ? (
                  <Box flexDirection="row">
                    <Text color="yellow" bold>[Pasted Text: {input.length} chars, {input.split("\n").length} lines] </Text>
                    <Text dimColor>(Press Enter to send, Esc to clear)</Text>
                  </Box>
                ) : (
                  <TextInput
                    focus={focusMode === "input"}
                    value={input}
                    onChange={handleInputChange}
                    onSubmit={handleSubmit}
                    placeholder={getWizardPlaceholder()}
                  />
                )}
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>

      {/* Status bar */}
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Box justifyContent="space-between" paddingX={0}>
          <Box>
            <Text>
              <Text color="green" bold>🟢 ONLINE</Text>
              <Text color="gray"> │ </Text>
              <Text color="cyan" bold>{modelName}</Text>
              <Text color="gray"> │ </Text>
              <Text color="white">Msg: {messageCount}</Text>
              <Text color="gray"> • </Text>
              <Text color="yellow">Proc: {runningTasksCount}</Text>
              <Text color="gray"> • </Text>
              <Text color="magenta">Sub: {runningSubagentsCount}</Text>
            </Text>
          </Box>
          <Box>
            <Text color="magenta" bold>
              Ctx: {contextPercentage}% ({formatCompactNumber(activeContextUsage)}/{formatCompactNumber(contextLimit)})
            </Text>
          </Box>
        </Box>
        <Box justifyContent="space-between" paddingX={0} marginTop={0}>
          <Box>
            <Text>
              <Text color="gray">Workspace: </Text>
              <Text dimColor>{process.cwd()}</Text>
              {gitBranch && (
                <>
                  <Text color="gray"> │ </Text>
                  <Text color="gray">Branch: </Text>
                  <Text color="green" bold>🌿 {gitBranch}</Text>
                </>
              )}
            </Text>
          </Box>
          <Box>
            <Text>
              <Text color="yellow">▲ {formatCompactNumber(tokensUp)}</Text>
              <Text color="gray"> │ </Text>
              <Text color="green">▼ {formatCompactNumber(tokensDown + liveStreamTokens)}</Text>
            </Text>
          </Box>
        </Box>
        <Box justifyContent="space-between" paddingX={0} marginTop={0}>
          <Box>
            <Text>
              <Text color="gray">Shortcuts: </Text>
              <Text color="cyan">Ctrl+C</Text><Text dimColor> Exit</Text>
              <Text color="gray"> │ </Text>
              <Text color="cyan">Ctrl+P</Text><Text dimColor> Checkpoint</Text>
              <Text color="gray"> │ </Text>
              <Text color="cyan">Esc</Text><Text dimColor> Clear</Text>
              <Text color="gray"> │ </Text>
              <Text color="cyan">↑/↓</Text><Text dimColor> History</Text>
              <Text color="gray"> │ </Text>
              <Text color="cyan">Tab</Text><Text dimColor> Autocomplete</Text>
              <Text color="gray"> │ </Text>
              <Text color="cyan">Ctrl+↑/↓</Text><Text dimColor> Scroll</Text>
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function renderMarkdown(content: string, themeColor: string = "magenta", showCursor: boolean = false): React.ReactNode {
  const rawLines = content.split("\n");

  // Format markdown tables helper
  function formatMarkdownTable(tableLines: string[]): string[] {
    const rows = tableLines.map(line => {
      const parts = line.split("|");
      if (parts.length >= 2) {
        return parts.slice(1, parts.length - 1).map(cell => cell.trim());
      }
      return [];
    });

    const isSeparatorRow = (row: string[]) => {
      return row.length > 0 && row.every(cell => cell.length > 0 && /^[:-]+$/.test(cell));
    };

    const numCols = Math.max(...rows.map(r => r.length));
    const colWidths = Array(numCols).fill(0);

    rows.forEach((row) => {
      if (isSeparatorRow(row)) return;
      for (let i = 0; i < numCols; i++) {
        const cellText = row[i] || "";
        const cleanText = cellText.replace(/\*\*|`/g, "");
        if (cleanText.length > colWidths[i]) {
          colWidths[i] = cleanText.length;
        }
      }
    });

    return rows.map((row) => {
      if (isSeparatorRow(row)) {
        const separatorCells = colWidths.map(width => "-".repeat(width + 2));
        return "| " + separatorCells.join(" | ") + " |";
      }

      const formattedCells = colWidths.map((width, colIdx) => {
        const cellText = row[colIdx] || "";
        const cleanText = cellText.replace(/\*\*|`/g, "");
        const paddingLength = Math.max(0, width - cleanText.length);
        return cellText + " ".repeat(paddingLength);
      });

      return "| " + formattedCells.join(" | ") + " |";
    });
  }

  const processedLines: { text: string; inCodeBlock: boolean; codeLanguage?: string }[] = [];
  let inCodeBlock = false;
  let codeLanguage = "";

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      codeLanguage = trimmed.slice(3).trim();
      processedLines.push({ text: line, inCodeBlock: true, codeLanguage });
      i++;
      continue;
    }

    if (inCodeBlock) {
      processedLines.push({ text: line, inCodeBlock: true });
      i++;
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableLines: string[] = [];
      while (i < rawLines.length && rawLines[i].trim().startsWith("|") && rawLines[i].trim().endsWith("|")) {
        tableLines.push(rawLines[i]);
        i++;
      }
      const formatted = formatMarkdownTable(tableLines);
      formatted.forEach(fLine => {
        processedLines.push({ text: fLine, inCodeBlock: false });
      });
      continue;
    }

    processedLines.push({ text: line, inCodeBlock: false });
    i++;
  }

  let inCode = false;
  return (
    <>
      {processedLines.map((item, idx) => {
        const l = item.text;
        const trimmed = l.trim();

        if (trimmed.startsWith("```")) {
          inCode = !inCode;
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│    </Text>
              <Text color="gray" italic>
                {inCode ? `┌─── [ CODE: ${item.codeLanguage || "TEXT"} ]` : "└─── [ END CODE ]"}
              </Text>
              {showCursor && idx === processedLines.length - 1 && <Text color="gray">█</Text>}
            </Box>
          );
        }

        if (inCode) {
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│    </Text>
              <Text color="green">{l}</Text>
              {showCursor && idx === processedLines.length - 1 && <Text color="green">█</Text>}
            </Box>
          );
        }

        if (l.startsWith("# ")) {
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│    </Text>
              <Text bold color="yellow">{l.slice(2)}</Text>
              {showCursor && idx === processedLines.length - 1 && <Text bold color="yellow">█</Text>}
            </Box>
          );
        }
        if (l.startsWith("## ")) {
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│    </Text>
              <Text bold color="cyan">{l.slice(3)}</Text>
              {showCursor && idx === processedLines.length - 1 && <Text bold color="cyan">█</Text>}
            </Box>
          );
        }
        if (l.startsWith("### ")) {
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│    </Text>
              <Text bold color="blue">{l.slice(4)}</Text>
              {showCursor && idx === processedLines.length - 1 && <Text bold color="blue">█</Text>}
            </Box>
          );
        }

        let listPrefix = "";
        let isSysLine = false;
        let remainingText = l;
        if (l.trim().startsWith("[SYS]")) {
          isSysLine = true;
          const sysIndex = l.indexOf("[SYS]");
          listPrefix = l.slice(0, sysIndex);
          remainingText = l.slice(sysIndex + 5);
        } else if (l.trim().startsWith("- ")) {
          const indent = l.indexOf("- ");
          listPrefix = " ".repeat(indent) + "• ";
          remainingText = l.slice(indent + 2);
        } else if (l.trim().startsWith("* ")) {
          const indent = l.indexOf("* ");
          listPrefix = " ".repeat(indent) + "• ";
          remainingText = l.slice(indent + 2);
        } else if (/^\d+\.\s/.test(l.trim())) {
          const match = l.match(/^(\s*)(\d+\.\s)(.*)/);
          if (match) {
            listPrefix = match[1] + match[2];
            remainingText = match[3];
          }
        }

        const parsedElements: React.ReactNode[] = [];
        let currentText = remainingText;

        while (currentText.length > 0) {
          const boldIdx = currentText.indexOf("**");
          const codeIdx = currentText.indexOf("`");
          const linkIdx = currentText.indexOf("[");
          
          // Check for raw URLs (file:///, http://, https://)
          const fileUrlIdx = currentText.indexOf("file://");
          const httpUrlIdx = currentText.indexOf("http://");
          const httpsUrlIdx = currentText.indexOf("https://");
          
          let rawUrlIdx = -1;
          if (fileUrlIdx !== -1) {
            rawUrlIdx = fileUrlIdx;
          }
          if (httpUrlIdx !== -1 && (rawUrlIdx === -1 || httpUrlIdx < rawUrlIdx)) {
            rawUrlIdx = httpUrlIdx;
          }
          if (httpsUrlIdx !== -1 && (rawUrlIdx === -1 || httpsUrlIdx < rawUrlIdx)) {
            rawUrlIdx = httpsUrlIdx;
          }

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
            parsedElements.push(<Text key={parsedElements.length}>{currentText}</Text>);
            break;
          }

          if (minIdx > 0) {
            parsedElements.push(<Text key={parsedElements.length}>{currentText.slice(0, minIdx)}</Text>);
          }

          currentText = currentText.slice(minIdx);

          if (tokenType === "bold") {
            const nextBoldIdx = currentText.indexOf("**", 2);
            if (nextBoldIdx !== -1) {
              const boldContent = currentText.slice(2, nextBoldIdx);
              parsedElements.push(<Text key={parsedElements.length} bold color="yellow">{boldContent}</Text>);
              currentText = currentText.slice(nextBoldIdx + 2);
            } else {
              parsedElements.push(<Text key={parsedElements.length}>{currentText.slice(0, 2)}</Text>);
              currentText = currentText.slice(2);
            }
          } else if (tokenType === "code") {
            const nextCodeIdx = currentText.indexOf("`", 1);
            if (nextCodeIdx !== -1) {
              const codeContent = currentText.slice(1, nextCodeIdx);
              parsedElements.push(<Text key={parsedElements.length} color="cyan" bold>{codeContent}</Text>);
              currentText = currentText.slice(nextCodeIdx + 1);
            } else {
              parsedElements.push(<Text key={parsedElements.length}>{currentText.slice(0, 1)}</Text>);
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
              // Strip trailing punctuation if it was just sentence punctuation
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
              parsedElements.push(<Text key={parsedElements.length}>{currentText[0]}</Text>);
              currentText = currentText.slice(1);
            }
          }
        }

        return (
          <Box key={idx} flexDirection="row">
            <Text color={themeColor}>│    </Text>
            {isSysLine ? (
              <Text>
                {listPrefix}
                <Text bold color="yellow">[SYS]</Text>
              </Text>
            ) : listPrefix ? (
              <Text color="magenta" bold>{listPrefix}</Text>
            ) : null}
            <Box flexShrink={1}>
              <Text>
                {parsedElements}
                {showCursor && idx === processedLines.length - 1 && "█"}
              </Text>
            </Box>
          </Box>
        );
      })}
    </>
  );
}

function renderToolStart(content: string): React.ReactNode {
  const lines = content.split("\n");
  return (
    <>
      {lines.map((l, idx) => {
        if (l.includes("Detail:")) {
          const parts = l.split("Detail:");
          const prefix = parts[0] + "Detail: ";
          const rest = parts[1];
          const openParenIdx = rest.indexOf("(");
          if (openParenIdx !== -1) {
            const toolName = rest.slice(0, openParenIdx).trim();
            let remaining = rest.slice(openParenIdx + 1);
            let hasClose = false;
            if (remaining.endsWith(")")) {
              remaining = remaining.slice(0, -1);
              hasClose = true;
            }
            return (
              <Box key={idx} flexDirection="row">
                <Text color="yellow">│    </Text>
                <Text dimColor>{prefix}</Text>
                <Text bold color="green">{toolName}</Text>
                <Text color="cyan">(</Text>
                <Text color="yellow">{remaining}</Text>
                {hasClose && <Text color="cyan">)</Text>}
              </Box>
            );
          }
        }
        return (
          <Box key={idx} flexDirection="row">
            <Text color="yellow">│    </Text>
            <Text bold color="white">{l}</Text>
          </Box>
        );
      })}
    </>
  );
}

function renderToolEnd(content: string, isError: boolean): React.ReactNode {
  const lines = content.split("\n");
  const themeColor = isError ? "red" : "green";
  return (
    <>
      {lines.map((l, idx) => {
        if (l.startsWith("Output:") || l.startsWith("Detail:")) {
          const type = l.startsWith("Output:") ? "Output: " : "Detail: ";
          const rest = l.substring(type.length);
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│    </Text>
              <Text bold color={isError ? "cyan" : "gray"} dimColor={!isError}>{type}</Text>
              <Text dimColor>{rest}</Text>
            </Box>
          );
        }
        return (
          <Box key={idx} flexDirection="row">
            <Text color={themeColor}>│    </Text>
            <Text color={isError ? "white" : "gray"} dimColor={!isError}>{l}</Text>
          </Box>
        );
      })}
    </>
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
        return clean.length > 80 ? clean.slice(0, 80) + "..." : clean;
      }
    }
  }
  return "Processing...";
}

function truncateStreamDisplay(text: string, maxLines: number, width: number): string {
  const rawLines = text.split("\n");
  let accumulated = 0;
  const resultLines: string[] = [];

  for (let i = rawLines.length - 1; i >= 0; i--) {
    const wrappedCount = Math.max(1, Math.ceil(rawLines[i].length / width));
    if (accumulated + wrappedCount > maxLines) {
      if (resultLines.length === 0) {
        resultLines.unshift(rawLines[i]);
      } else {
        resultLines.unshift("... [older output hidden to fit screen] ...");
      }
      break;
    }
    accumulated += wrappedCount;
    resultLines.unshift(rawLines[i]);
  }
  return resultLines.join("\n");
}

const ChatLineComponent = React.memo(function ChatLineComponent({
  line,
  isFirst,
  tokensUp,
  tokensDown,
  modelName,
  maxResponseLines,
  chatWidth,
}: {
  line: ChatLine;
  isFirst: boolean;
  tokensUp?: number;
  tokensDown?: number;
  modelName?: string;
  maxResponseLines?: number;
  chatWidth?: number;
}) {
  switch (line.type) {
    case "user": {
      const content = line.content.replace(/^❯ /, "");
      return (
        <Box flexDirection="column">
          <Text color="cyan">
            {isFirst ? "┌" : "├"}───[ <Text bold color="cyan">👤 ACCESS_POINT: USER</Text> ]
          </Text>
          {content.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="cyan">│    </Text>
              <Text>{l}</Text>
            </Box>
          ))}
          <Box flexDirection="row">
            <Text color="cyan">│ </Text>
          </Box>
        </Box>
      );
    }
    case "assistant": {
      const capped = capDisplayLines(line.content, maxResponseLines || 12, chatWidth || 80);
      return (
        <Box flexDirection="column">
          <Text color="magenta">
            {isFirst ? "┌" : "├"}───[ <Text bold color="magenta">✦ COGNITIVE_NODE: SUPERAGENT{modelName ? ` (${modelName})` : ""}</Text><Text dimColor> (▲{formatCompactNumber(tokensUp || 0)} | ▼{formatCompactNumber(tokensDown || 0)})</Text> ]
          </Text>
          {renderMarkdown(capped.text, "magenta")}
          {capped.truncated && (
            <Box flexDirection="row">
              <Text color="magenta">│    </Text>
              <Text color="yellow">... [response panjang dipotong; Ctrl+O buka response scroll, PageUp/Ctrl+Up scroll history] ...</Text>
            </Box>
          )}
          <Box flexDirection="row">
            <Text color="magenta">│ </Text>
          </Box>
        </Box>
      );
    }
    case "tool_start": {
      const content = line.content.replace(/^⚡ /, "");
      return (
        <Box flexDirection="column">
          <Text color="yellow">
            ├───[ <Text bold color="yellow">⚙️ SYSTEM_INVOKING_MODULE</Text> ]
          </Text>
          {renderToolStart(content)}
          <Box flexDirection="row">
            <Text color="yellow">│ </Text>
          </Box>
        </Box>
      );
    }
    case "tool_end": {
      const isError = line.content.startsWith("✗");
      const contentText = line.content.substring(2);
      const themeColor = isError ? "red" : "green";
      return (
        <Box flexDirection="column">
          <Text color={themeColor}>
            ├───[ <Text bold color={themeColor}>{isError ? "🔴 SYSTEM_CALL_FAILED" : "🟢 SYSTEM_CALL_SUCCESS"}</Text> ]
          </Text>
          {renderToolEnd(contentText, isError)}
          <Box flexDirection="row">
            <Text color={themeColor}>│ </Text>
          </Box>
        </Box>
      );
    }
    case "error": {
      const contentText = line.content.replace(/^Error: /, "");
      return (
        <Box flexDirection="column">
          <Text color="red">
            ├───[ <Text bold color="red">🚨 ERROR_REPORT</Text> ]
          </Text>
          {contentText.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="red">│    </Text>
              <Text color="red">{l}</Text>
            </Box>
          ))}
          <Box flexDirection="row">
            <Text color="red">│ </Text>
          </Box>
        </Box>
      );
    }
    case "system":
      return (
        <Box flexDirection="column">
          <Text color="gray">
            ├───[ <Text bold color="gray">ℹ️ SYSTEM_INFO</Text> ]
          </Text>
          {line.content.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="gray">│    </Text>
              <Text color="gray" italic>{l}</Text>
            </Box>
          ))}
          <Box flexDirection="row">
            <Text color="gray">│ </Text>
          </Box>
        </Box>
      );
    default:
      return (
        <Box flexDirection="column">
          <Text color="gray">
            ├───[ <Text bold color="gray">COMM_PACKET</Text> ]
          </Text>
          {line.content.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="gray">│    </Text>
              <Text>{l}</Text>
            </Box>
          ))}
          <Box flexDirection="row">
            <Text color="gray">│ </Text>
          </Box>
        </Box>
      );
  }
});

function LoadingIndicator() {
  const [frame, setFrame] = useState(0);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % frames.length);
    }, 250);
    return () => clearInterval(interval);
  }, []);

  return <Text color="yellow">{frames[frame]} Thinking...</Text>;
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

function ProcessingIndicator({ scrollOffset }: { scrollOffset: number }) {
  const [frame, setFrame] = useState(0);
  const progressFrames = [
    "[■□□□□□□□□□]",
    "[■■□□□□□□□□]",
    "[■■■□□□□□□□]",
    "[■■■■□□□□□□]",
    "[■■■■■□□□□□]",
    "[■■■■■■□□□□]",
    "[■■■■■■■□□□]",
    "[■■■■■■■■□□]",
    "[■■■■■■■■■□]",
    "[■■■■■■■■■■]",
  ];
  const pulseFrames = ["   ", ".  ", ".. ", "..."];

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % 40);
    }, 150);
    return () => clearInterval(interval);
  }, []);

  const pulse = pulseFrames[frame % pulseFrames.length];
  const barIndex = Math.floor(frame / 4) % progressFrames.length;
  const bar = progressFrames[barIndex];

  return (
    <Box flexDirection="row">
      <Text dimColor>Processing{pulse} (Ctrl+C to abort) </Text>
      {scrollOffset > 0 && (
        <Text color="yellow" bold>
          [New outputs streaming at bottom - {bar}]
        </Text>
      )}
    </Box>
  );
}
