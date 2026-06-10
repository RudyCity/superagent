import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { Agent } from "./core/agent.js";
import type { AgentEvent, PermissionHandler, QuestionHandler } from "./core/agent.js";
import type { ToolCall } from "./core/conversation.js";
import { Banner } from "./components/banner.js";
import { getContextWindowLimit, updateEnvFile, getInstalledSkills } from "./core/config.js";
import { getToolDescription } from "./core/permissions.js";
import fs from "fs/promises";
import path from "path";
import { registerSubagentType, allTools, backgroundTasks, subagentInstances, subscribeToTasks, subscribeToSubagents } from "./core/tools.js";
import { WizardDialog } from "./components/wizard-dialog.js";
import { execa } from "execa";

interface ChatLine {
  type:
    | "user"
    | "assistant"
    | "tool_start"
    | "tool_end"
    | "error"
    | "system";
  content: string;
  timestamp: number;
}

export function App({
  autoResume = false,
  onHistoryChange,
}: {
  autoResume?: boolean;
  onHistoryChange?: (exists: boolean) => void;
}) {
  const { exit } = useApp();
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
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
  const [contextLimit, setContextLimit] = useState(128000);
  const streamBufferRef = useRef("");
  const lastStreamUpdateRef = useRef<number>(0);
  const streamTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [tempInput, setTempInput] = useState("");
  const agentRef = useRef<Agent | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [runningTasksCount, setRunningTasksCount] = useState(0);
  const [runningSubagentsCount, setRunningSubagentsCount] = useState(0);
  const [activeWizard, setActiveWizard] = useState<{
    type: "login" | "model" | "plan_approve" | "permission" | "question";
    step: number;
    data: Record<string, string>;
  } | null>(null);
  const [wizardSelectedIndex, setWizardSelectedIndex] = useState(0);
  const [wizardOptions, setWizardOptions] = useState<string[]>([]);
  const [planState, setPlanState] = useState<"IDLE" | "PLANNING_PENDING" | "APPROVED">("IDLE");
  const [focusMode, setFocusMode] = useState<"input" | "history">("input");
  const [historySelectedIndex, setHistorySelectedIndex] = useState<number>(0);
  const [terminalHeight, setTerminalHeight] = useState(process.stdout.rows || 30);
  const [terminalWidth, setTerminalWidth] = useState(process.stdout.columns || 80);

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
    const unsubTasks = subscribeToTasks(() => {
      setRunningTasksCount(backgroundTasks.size);
    });
    const unsubSubagents = subscribeToSubagents(() => {
      setRunningSubagentsCount(
        Array.from(subagentInstances.values()).filter((s) => s.status === "running").length
      );
    });
    setRunningTasksCount(backgroundTasks.size);
    setRunningSubagentsCount(
      Array.from(subagentInstances.values()).filter((s) => s.status === "running").length
    );
    return () => {
      unsubTasks();
      unsubSubagents();
    };
  }, []);

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

    const customUrl = process.env.CUSTOM_BASE_URL;
    if (customUrl) {
      const fetchModels = async () => {
        try {
          const res = await fetch(`${customUrl}/models`);
          if (res.ok) {
            const json = await res.json() as any;
            if (json && Array.isArray(json.data)) {
              const currentModelData = json.data.find(
                (m: any) => m.id === modelName
              );
              if (currentModelData) {
                const limit =
                  currentModelData.context_length ||
                  currentModelData.max_model_len ||
                  currentModelData.max_position_embeddings ||
                  (currentModelData.metadata &&
                    (currentModelData.metadata.context_length ||
                      currentModelData.metadata.max_model_len));
                if (limit && typeof limit === "number") {
                  setContextLimit(limit);
                }
              }
            }
          }
        } catch (e) {
          // Silent catch
        }
      };
      fetchModels();
    }
  }, []);

  const addLine = useCallback((line: ChatLine) => {
    setLines((prev) => [...prev, line]);
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
    (question: string, options: string[]) => {
      return new Promise<string>((resolve) => {
        setPendingQuestion({ question, options, resolve });
        setWizardOptions(options);
        setWizardSelectedIndex(0);
        setActiveWizard({
          type: "question",
          step: 1,
          data: { question },
        });
      });
    },
    []
  );

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case "text":
          streamBufferRef.current += event.content;
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
          setIsProcessing(false);
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
    const agent = new Agent(handleEvent, permissionHandler, questionHandler);
    agentRef.current = agent;

    const handleSigint = () => {
      if (agent.isAgentRunning()) {
        agent.abort();
      } else {
        exit();
      }
    };
    process.on("SIGINT", handleSigint);

    agent.loadHistory().then(() => {
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
    });

    return () => {
      process.off("SIGINT", handleSigint);
    };
  }, [handleEvent, permissionHandler, questionHandler, exit, autoResume]);

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
          content: `Selected provider: ${provider}\nStep 2: Please enter your API Key:`,
          timestamp: now,
        });

        setActiveWizard({
          type: "login",
          step: 2,
          data: { provider },
        });
      } else if (activeWizard.step === 2) {
        const provider = activeWizard.data.provider;
        if (provider === "custom") {
          addLine({
            type: "system",
            content: `Entered Base URL: ${value}\nStep 3: Please enter your API Key:`,
            timestamp: now,
          });
          setActiveWizard({
            type: "login",
            step: 3,
            data: { provider, baseUrl: value },
          });
        } else {
          const apiKey = value;
          const updates: Record<string, string> = {};
          if (provider === "openrouter") {
            updates["CUSTOM_BASE_URL"] = "https://openrouter.ai/api/v1";
            updates["CUSTOM_API_KEY"] = apiKey;
            delete process.env.ANTHROPIC_API_KEY;
            delete process.env.OPENAI_API_KEY;
          } else if (provider === "anthropic") {
            updates["ANTHROPIC_API_KEY"] = apiKey;
            updates["CUSTOM_BASE_URL"] = "";
            updates["CUSTOM_API_KEY"] = "";
            delete process.env.CUSTOM_BASE_URL;
            delete process.env.CUSTOM_API_KEY;
            delete process.env.OPENAI_API_KEY;
          } else if (provider === "openai") {
            updates["OPENAI_API_KEY"] = apiKey;
            updates["CUSTOM_BASE_URL"] = "";
            updates["CUSTOM_API_KEY"] = "";
            delete process.env.CUSTOM_BASE_URL;
            delete process.env.CUSTOM_API_KEY;
            delete process.env.ANTHROPIC_API_KEY;
          }

          try {
            const envPath = updateEnvFile(updates);
            addLine({
              type: "system",
              content: `Successfully logged in! Configured provider: ${provider}.\nSaved to: ${envPath}`,
              timestamp: now,
            });
            if (provider === "openrouter" && !process.env.MODEL) {
              updateEnvFile({ MODEL: "google/gemini-2.5-flash" });
            }
          } catch (err: any) {
            addLine({
              type: "error",
              content: `Failed to save credentials: ${err.message}`,
              timestamp: now,
            });
          }
          setActiveWizard(null);
        }
      } else if (activeWizard.step === 3) {
        const provider = activeWizard.data.provider;
        const baseUrl = activeWizard.data.baseUrl;
        const apiKey = value;

        try {
          const envPath = updateEnvFile({
            CUSTOM_BASE_URL: baseUrl,
            CUSTOM_API_KEY: apiKey,
          });
          delete process.env.ANTHROPIC_API_KEY;
          delete process.env.OPENAI_API_KEY;

          addLine({
            type: "system",
            content: `Successfully logged in! Configured custom provider at: ${baseUrl}\nSaved to: ${envPath}`,
            timestamp: now,
          });
        } catch (err: any) {
          addLine({
            type: "error",
            content: `Failed to save credentials: ${err.message}`,
            timestamp: now,
          });
        }
        setActiveWizard(null);
      }
    } else if (activeWizard.type === "model") {
      const modelName = value;
      try {
        const envPath = updateEnvFile({ MODEL: modelName });
        const limit = getContextWindowLimit(modelName);
        setContextLimit(limit);
        addLine({
          type: "system",
          content: `Model successfully changed to: ${modelName}\nContext limit: ${limit.toLocaleString()} tokens\nSaved to: ${envPath}`,
          timestamp: now,
        });
      } catch (err: any) {
        addLine({
          type: "error",
          content: `Failed to set model: ${err.message}`,
          timestamp: now,
        });
      }
      setActiveWizard(null);
    } else if (activeWizard.type === "plan_approve") {
      const approved = value === "approve";
      if (approved) {
        if (agentRef.current) {
          agentRef.current.approvePlan();
          setPlanState("APPROVED");
        }
        addLine({
          type: "system",
          content: "✓ Implementation plan approved! The agent is now allowed to perform code and file modifications.",
          timestamp: now,
        });
      } else {
        addLine({
          type: "system",
          content: "✗ Implementation plan rejected. Please provide your feedback to the agent.",
          timestamp: now,
        });
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    }
  }, [activeWizard, addLine, setContextLimit, setPlanState]);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || isProcessing) return;

      setInput("");
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

      if (trimmed.startsWith("/")) {
        if (trimmed.toLowerCase().startsWith("/clear") || trimmed.toLowerCase().startsWith("/new")) {
          setTokensUp(0);
          setTokensDown(0);
          setLastPromptTokens(0);
        }
        handleSlashCommand(trimmed, {
          addLine,
          exit,
          agent: agentRef.current,
          clearLines: () => setLines([]),
          setContextLimit,
          setActiveWizard,
          setWizardOptions,
          setWizardSelectedIndex,
          setPlanState,
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
          }
        });
        return;
      }

      addLine({
        type: "user",
        content: `❯ ${trimmed}`,
        timestamp: Date.now(),
      });

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
    [isProcessing, addLine, exit]
  );

  const handleInputChange = useCallback((val: string) => {
    setInput(val);
    if (lastTabPrefix && !val.startsWith(lastTabPrefix)) {
      setLastTabPrefix(null);
    }
  }, [lastTabPrefix]);

  const commands = [
    "/clear",
    "/compact",
    "/help",
    "/init",
    "/new",
    "/resume",
    "/quit",
    "/exit",
    "/login",
    "/model",
    "/approve",
    "/agents",
    "/tasks",
    "/install",
    "/skills",
  ];

  useInput((inputChar, key) => {
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
      if (activeWizard.type === "login" && activeWizard.step === 1) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(3, prev + 1));
          return;
        }
        if (key.return) {
          const providers = ["openrouter", "openai", "anthropic", "custom"];
          const provider = providers[wizardSelectedIndex];
          const now = Date.now();
          addLine({
            type: "system",
            content: `Selected provider: ${provider}\nStep 2: Please enter your API Key:`,
            timestamp: now,
          });
          setActiveWizard({
            type: "login",
            step: 2,
            data: { provider },
          });
          setWizardSelectedIndex(0);
          return;
        }
      } else if (activeWizard.type === "model" && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(wizardOptions.length - 1, prev + 1));
          return;
        }
        if (key.return && !input.trim()) {
          const selectedModel = wizardOptions[wizardSelectedIndex];
          const now = Date.now();
          try {
            const envPath = updateEnvFile({ MODEL: selectedModel });
            const limit = getContextWindowLimit(selectedModel);
            setContextLimit(limit);
            addLine({
              type: "system",
              content: `Model successfully changed to: ${selectedModel}\nContext limit: ${limit.toLocaleString()} tokens\nSaved to: ${envPath}`,
              timestamp: now,
            });
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
          if (pendingQuestion) {
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
      }
    }

    if (key.ctrl && inputChar === "c") {
      if (isProcessing) {
        agentRef.current?.abort();
      } else {
        exit();
      }
    }

    if (key.pageUp || (key.ctrl && key.upArrow) || (key.shift && key.upArrow)) {
      setScrollOffset((prev) => {
        const maxScroll = Math.max(0, lines.length - 15);
        return Math.min(prev + 1, maxScroll);
      });
    }

    if (key.pageDown || (key.ctrl && key.downArrow) || (key.shift && key.downArrow)) {
      setScrollOffset((prev) => Math.max(0, prev - 1));
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
        addLine({
          type: "system",
          content: "Wizard cancelled.",
          timestamp: Date.now(),
        });
      } else if (isProcessing) {
        agentRef.current?.abort();
      } else {
        setInput("");
        setHistoryIndex(-1);
      }
    }

    if (key.return && !isProcessing) {
      if (input.length > 200 || input.includes("\n")) {
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
    }

    if (key.downArrow && !isProcessing) {
      if (historyIndex !== -1) {
        if (historyIndex === history.length - 1) {
          setHistoryIndex(-1);
          setInput(tempInput);
        } else {
          const newIndex = historyIndex + 1;
          setHistoryIndex(newIndex);
          setInput(history[newIndex]);
        }
      }
    }

    if (key.tab && !isProcessing) {
      if (input.startsWith("/")) {
        const prefix = lastTabPrefix || input;
        const matches = commands.filter((c) => c.startsWith(prefix));
        if (matches.length > 0) {
          const currentMatchIndex = matches.indexOf(input);
          let nextIndex = 0;
          if (currentMatchIndex !== -1) {
            nextIndex = (currentMatchIndex + 1) % matches.length;
          } else {
            setLastTabPrefix(input);
          }
          setInput(matches[nextIndex]);
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
      if (activeWizard.step === 1) return "Enter provider number (1-4)...";
      if (activeWizard.step === 2) {
        return activeWizard.data.provider === "custom" ? "Enter Custom Base URL..." : "Paste API key...";
      }
      if (activeWizard.step === 3) return "Paste API key...";
    }
    if (activeWizard.type === "model") {
      return "Enter model name (e.g. google/gemini-2.5-flash)...";
    }
    return "Enter value...";
  };

  const getSuggestions = () => {
    if (!input.startsWith("/")) return [];
    const prefix = lastTabPrefix || input;
    return commands.filter((c) => c.startsWith(prefix));
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

  // Dynamic estimate of ChatLine height in terminal rows
  const estimateChatLineHeight = (line: ChatLine, width: number): number => {
    let linesCount = 2; // Border header + spacing lines
    const textLines = line.content.split("\n");
    for (const l of textLines) {
      let rawText = l;
      if (line.type === "user") {
        rawText = l.replace(/^❯ /, "");
      } else if (line.type === "tool_start") {
        rawText = l.replace(/^⚡ /, "");
      }
      linesCount += Math.max(1, Math.ceil(rawText.length / width));
    }
    return linesCount;
  };

  // Calculate dynamic input line height wrapping
  const inputLinesCount = input ? Math.max(1, Math.ceil((input.length + 6) / terminalWidth)) : 1;

  const showBanner = messageCount === 0;
  // Base chrome height: Banner is 7 (if shown), Input wrapper base is 3 (header + margin + prompt border/spacers), Status bar is 3 (3 lines + margin)
  let chromeHeight = (showBanner ? 12 : 5) + inputLinesCount;
  if (planState === "PLANNING_PENDING") {
    if (activeWizard?.type === "plan_approve") {
      chromeHeight += 8;
    } else {
      chromeHeight += 6;
    }
  }
  if (activeWizard) {
    if (activeWizard.type === "login" && activeWizard.step === 1) {
      chromeHeight += 8;
    } else if (activeWizard.type === "model" && wizardOptions.length > 0) {
      chromeHeight += 12;
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
      chromeHeight += 2; // Thinking loading indicator
    }
  }

  let liveListHeight = 0;
  if (runningSubagentsCount > 0 || runningTasksCount > 0) {
    liveListHeight += 1; // padding/margin
    if (runningSubagentsCount > 0) {
      liveListHeight += 1; // header
      liveListHeight += runningSubagentsCount * 2; // Each subagent takes 2 lines
    }
    if (runningTasksCount > 0) {
      liveListHeight += 1; // header
      liveListHeight += runningTasksCount; // Each task is 1 line
      if (runningSubagentsCount > 0) {
        liveListHeight += 1; // marginTop
      }
    }
  }
  chromeHeight += liveListHeight;

  // Calculate available height for messages with a safety buffer to prevent terminal scrolling/duplicated headers
  const chatHeightLimit = Math.max(5, terminalHeight - chromeHeight - 1);

  return (
    <Box flexDirection="column">
      {showBanner && <Banner />}

      <Box flexDirection="row">
        {/* Chat Area */}
        <Box flexDirection="column" width="100%">
          {/* Messages */}
          <Box flexDirection="column" paddingX={1}>
            {(() => {
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
                      <ChatLineComponent key={originalIndex} line={line} isFirst={originalIndex === 0} />
                    );
                  })}

                  {shouldRenderStream && (
                    <Box flexDirection="column">
                      <Text color="magenta">
                        {visibleLines.length === 0 ? "┌" : "├"}───[ <Text bold color="magenta">✦ COGNITIVE_NODE: SUPERAGENT (STREAMING...)</Text> ]
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
              <Box flexDirection="column">
                <Text color="magenta">
                  ├───[ <Text bold color="magenta">✦ COGNITIVE_NODE: SUPERAGENT (THINKING...)</Text> ]
                </Text>
                <Box flexDirection="row">
                  <Text color="magenta">│ </Text>
                  <LoadingIndicator />
                </Box>
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

            {planState === "PLANNING_PENDING" && activeWizard?.type !== "plan_approve" && (
              <Box marginBottom={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
                <Text bold color="yellow">⚠️ PENDING_PLAN: RENCANA IMPLEMENTASI MEMBUTUHKAN PERSETUJUAN</Text>
                <Text color="yellow">Model AI telah merancang rencana di file: <Text bold color="cyan">file:///${process.cwd().replace(/\\/g, "/")}/implementation_plan.md</Text></Text>
                <Text color="yellow">Silakan ketik <Text bold color="green">/approve</Text> untuk menyetujui dan melanjutkan modifikasi kode.</Text>
              </Box>
            )}

            {activeWizard && activeWizard.type === "plan_approve" && wizardOptions.length > 0 && (
              <WizardDialog
                title="⚠️ PLAN APPROVAL REQUIRED (Use Arrow Keys Up/Down & Enter):"
                description={`Model AI telah merancang rencana di file: file:///${process.cwd().replace(/\\/g, "/")}/implementation_plan.md`}
                borderColor="yellow"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
              />
            )}

            {activeWizard && activeWizard.type === "question" && wizardOptions.length > 0 && pendingQuestion && (
              <WizardDialog
                title="❓ QUESTION FROM AGENT (Use Arrow Keys Up/Down & Enter):"
                description={pendingQuestion.question}
                borderColor="cyan"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
              />
            )}

            {activeWizard && activeWizard.type === "login" && activeWizard.step === 1 && (
              <WizardDialog
                title="🔑 SELECT PROVIDER (Use Arrow Keys Up/Down & Enter):"
                borderColor="cyan"
                options={["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint"]}
                selectedIndex={wizardSelectedIndex}
              />
            )}

            {activeWizard && activeWizard.type === "model" && wizardOptions.length > 0 && (
              <WizardDialog
                title="⚙️ SELECT MODEL (Use Arrow Keys Up/Down & Enter, or type custom model):"
                borderColor="cyan"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
                maxVisible={6}
              />
            )}

            {/* Render suggestions inline above the input line */}
            {!activeWizard && input.startsWith("/") && suggestions.length > 0 && (
              <Box marginBottom={1} flexDirection="row">
                <Text dimColor>Suggestions: </Text>
                {suggestions.map((s) => {
                  const isSelected = input === s;
                  return (
                    <Box key={s} marginRight={2}>
                      <Text color={isSelected ? "cyan" : "gray"} bold={isSelected} underline={isSelected}>
                        {s}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            )}

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
                {isProcessing ? (
                  <ProcessingIndicator scrollOffset={scrollOffset} />
                ) : (input.length > 200 || input.includes("\n")) ? (
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

      {/* Active Subagents & Tasks Live List */}
      {(runningSubagentsCount > 0 || runningTasksCount > 0) && (
        <Box flexDirection="column" paddingX={2} marginTop={1}>
          {runningSubagentsCount > 0 && (
            <Box flexDirection="column">
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
            <Box flexDirection="column" marginTop={runningSubagentsCount > 0 ? 1 : 0}>
              <Text color="cyan" bold>⚙️ ACTIVE TASKS:</Text>
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

      {/* Status bar */}
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Box justifyContent="space-between" paddingX={0}>
          <Box>
            <Text color="magenta" bold>ONLINE</Text>
            <Text color="gray"> │ </Text>
            <Text color="white">MSGS: {messageCount}</Text>
            <Text color="gray"> │ </Text>
            <Text color="cyan" bold>TASKS: {runningTasksCount}</Text>
            <Text color="gray"> │ </Text>
            <Text color="yellow" bold>SUBAGENTS: {runningSubagentsCount}</Text>
            <Text color="gray"> │ </Text>
            <Text color="yellow" bold>↑ UP: {formatCompactNumber(tokensUp)}</Text>
            <Text color="gray"> │ </Text>
            <Text color="green" bold>↓ DOWN: {formatCompactNumber(tokensDown + liveStreamTokens)}</Text>
          </Box>
          <Box>
            <Text color="magenta" bold>
              CTX_USAGE: {formatCompactNumber(activeContextUsage)}/{formatCompactNumber(contextLimit)} ({contextPercentage}%)
            </Text>
          </Box>
        </Box>
        <Box justifyContent="space-between" paddingX={0} marginTop={0}>
          <Box>
            <Text dimColor>{process.cwd()}</Text>
          </Box>
          <Box>
            <Text color="blue" bold>{modelName}</Text>
          </Box>
        </Box>
        <Box justifyContent="space-between" paddingX={0} marginTop={0}>
          <Box>
            <Text color="gray">Ctrl+C </Text><Text dimColor>Abort/Exit</Text>
            <Text color="gray"> │ </Text>
            <Text color="gray">Ctrl+↑/↓, PgUp/PgDn </Text><Text dimColor>Scroll</Text>
            <Text color="gray"> │ </Text>
            <Text color="gray">Esc </Text><Text dimColor>Clear/Cancel</Text>
            <Text color="gray"> │ </Text>
            <Text color="gray">↑/↓ </Text><Text dimColor>History</Text>
            <Text color="gray"> │ </Text>
            <Text color="gray">Tab </Text><Text dimColor>Autocomplete</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function renderMarkdown(content: string, themeColor: string = "magenta", showCursor: boolean = false): React.ReactNode {
  const lines = content.split("\n");
  let inCodeBlock = false;
  let codeLanguage = "";

  return (
    <>
      {lines.map((l, idx) => {
        const trimmed = l.trim();
        if (trimmed.startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          codeLanguage = trimmed.slice(3).trim();
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│ </Text>
              <Text color="gray" italic>
                {inCodeBlock ? `┌─── [ CODE: ${codeLanguage || "TEXT"} ]` : "└─── [ END CODE ]"}
              </Text>
              {showCursor && idx === lines.length - 1 && <Text color="gray">█</Text>}
            </Box>
          );
        }

        if (inCodeBlock) {
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│ </Text>
              <Text color="green">{l}</Text>
              {showCursor && idx === lines.length - 1 && <Text color="green">█</Text>}
            </Box>
          );
        }

        if (l.startsWith("# ")) {
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│ </Text>
              <Text bold color="yellow">{l.slice(2)}</Text>
              {showCursor && idx === lines.length - 1 && <Text bold color="yellow">█</Text>}
            </Box>
          );
        }
        if (l.startsWith("## ")) {
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│ </Text>
              <Text bold color="cyan">{l.slice(3)}</Text>
              {showCursor && idx === lines.length - 1 && <Text bold color="cyan">█</Text>}
            </Box>
          );
        }
        if (l.startsWith("### ")) {
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│ </Text>
              <Text bold color="blue">{l.slice(4)}</Text>
              {showCursor && idx === lines.length - 1 && <Text bold color="blue">█</Text>}
            </Box>
          );
        }

        let listPrefix = "";
        let remainingText = l;
        if (l.trim().startsWith("- ")) {
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

          if (boldIdx === -1 && codeIdx === -1) {
            parsedElements.push(<Text key={parsedElements.length}>{currentText}</Text>);
            break;
          }

          if (boldIdx !== -1 && (codeIdx === -1 || boldIdx < codeIdx)) {
            if (boldIdx > 0) {
              parsedElements.push(<Text key={parsedElements.length}>{currentText.slice(0, boldIdx)}</Text>);
            }
            const nextBoldIdx = currentText.indexOf("**", boldIdx + 2);
            if (nextBoldIdx !== -1) {
              const boldText = currentText.slice(boldIdx + 2, nextBoldIdx);
              parsedElements.push(<Text key={parsedElements.length} bold color="yellow">{boldText}</Text>);
              currentText = currentText.slice(nextBoldIdx + 2);
            } else {
              parsedElements.push(<Text key={parsedElements.length}>{currentText.slice(boldIdx)}</Text>);
              break;
            }
          } else {
            if (codeIdx > 0) {
              parsedElements.push(<Text key={parsedElements.length}>{currentText.slice(0, codeIdx)}</Text>);
            }
            const nextCodeIdx = currentText.indexOf("`", codeIdx + 1);
            if (nextCodeIdx !== -1) {
              const codeText = currentText.slice(codeIdx + 1, nextCodeIdx);
              parsedElements.push(<Text key={parsedElements.length} color="cyan" bold>{codeText}</Text>);
              currentText = currentText.slice(nextCodeIdx + 1);
            } else {
              parsedElements.push(<Text key={parsedElements.length}>{currentText.slice(codeIdx)}</Text>);
              break;
            }
          }
        }

        return (
          <Box key={idx} flexDirection="row">
            <Text color={themeColor}>│ </Text>
            {listPrefix ? <Text color="magenta" bold>{listPrefix}</Text> : null}
            <Text>{parsedElements}</Text>
            {showCursor && idx === lines.length - 1 && <Text>█</Text>}
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
                <Text color="yellow">│ </Text>
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
            <Text color="yellow">│ </Text>
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
              <Text color={themeColor}>│ </Text>
              <Text bold color={isError ? "cyan" : "gray"} dimColor={!isError}>{type}</Text>
              <Text dimColor>{rest}</Text>
            </Box>
          );
        }
        return (
          <Box key={idx} flexDirection="row">
            <Text color={themeColor}>│ </Text>
            <Text color={isError ? "white" : "gray"} dimColor={!isError}>{l}</Text>
          </Box>
        );
      })}
    </>
  );
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "{}";
  const parts = entries.map(([k, v]) => {
    const val = typeof v === "string" ? v : JSON.stringify(v);
    const truncated = val.length > 60 ? val.slice(0, 60) + "..." : val;
    return `${k}: ${truncated}`;
  });
  return `{ ${parts.join(", ")} }`;
}

function formatCompactNumber(num: number): string {
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1).replace(/\.?0+$/, "") + "K";
  }
  return num.toString();
}

function getProviderLabel(): string {
  if (process.env.CUSTOM_BASE_URL) {
    const url = new URL(process.env.CUSTOM_BASE_URL);
    return `custom (${url.host})`;
  }
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "openai";
}

function getDefaultModel(): string {
  if (process.env.CUSTOM_BASE_URL) return "custom";
  if (process.env.ANTHROPIC_API_KEY) return "claude-sonnet-4-20250514";
  return "gpt-4o";
}

function handleSlashCommand(
  cmd: string,
  ctx: {
    addLine: (line: ChatLine) => void;
    exit: () => void;
    agent: Agent | null;
    clearLines?: () => void;
    setContextLimit?: (limit: number) => void;
    setActiveWizard?: (val: { type: "login" | "model" | "plan_approve" | "permission" | "question"; step: number; data: Record<string, string> } | null) => void;
    setWizardOptions?: (options: string[]) => void;
    setWizardSelectedIndex?: (index: number) => void;
    resumeSession?: () => Promise<void>;
    setPlanState?: (state: "IDLE" | "PLANNING_PENDING" | "APPROVED") => void;
  }
) {
  const [name] = cmd.slice(1).split(" ");
  const now = Date.now();

  switch (name.toLowerCase()) {
    case "new":
      ctx.agent?.clearHistory();
      if (ctx.agent) {
        ctx.agent.planState = "IDLE";
      }
      ctx.setPlanState?.("IDLE");
      ctx.clearLines?.();
      ctx.addLine({ type: "system", content: "New conversation started. History and terminal cleared.", timestamp: now });
      break;
    case "resume":
      if (ctx.resumeSession) {
        ctx.resumeSession()
          .then(() => {
            ctx.addLine({ type: "system", content: "Conversation session resumed from history.", timestamp: now });
          })
          .catch((err: any) => {
            ctx.addLine({ type: "error", content: `Failed to resume session: ${err.message}`, timestamp: now });
          });
      } else {
        ctx.addLine({ type: "error", content: "Resume command not supported in this context.", timestamp: now });
      }
      break;
    case "clear":
      ctx.agent?.clearHistory();
      if (ctx.agent) {
        ctx.agent.planState = "IDLE";
      }
      ctx.setPlanState?.("IDLE");
      ctx.addLine({ type: "system", content: "Conversation cleared.", timestamp: now });
      break;
    case "approve":
      if (ctx.agent) {
        ctx.agent.approvePlan();
        ctx.setPlanState?.("APPROVED");
        ctx.addLine({
          type: "system",
          content: "✓ Implementation plan approved! The agent is now allowed to perform code and file modifications.",
          timestamp: now,
        });
      } else {
        ctx.addLine({ type: "error", content: "Agent not available in this context.", timestamp: now });
      }
      break;
    case "compact": {
      const currentModel = process.env.MODEL || getDefaultModel();
      const limit = getContextWindowLimit(currentModel);
      const summary = ctx.agent?.getHistory().getCompactSummary(limit);
      ctx.addLine({ type: "system", content: summary || "No history.", timestamp: now });
      break;
    }
    case "init":
      (async () => {
        const agentsPath = path.resolve(process.cwd(), "agents.md");
        let fileStatus = "LOADED";
        try {
          await fs.access(agentsPath);
        } catch {
          // Create agents.md if not exists
          const defaultContent = `# Project Specifications (agents.md)\n\nThis file contains key information about the project for AI agents to study and align with.\n\n## Project Overview\n- **Name**: superagent\n- **Description**: An interactive CLI coding assistant designed for codebase operations.\n- **Technology Stack**: Node.js, TypeScript, Ink (React), Vercel AI SDK\n\n## Coding Guidelines\n- On Windows, statement separator for terminal commands is \';\' instead of \'&&\'.\n- Always write robust TypeScript code and verify compilation with \'npm run build\'.\n`;
          await fs.writeFile(agentsPath, defaultContent, "utf-8");
          fileStatus = "CREATED";
        }

        let projectName = "Unknown";
        let projectTech = "Unknown";
        try {
          const content = await fs.readFile(agentsPath, "utf-8");
          const nameMatch = content.match(/-\s*\*\*Name\*\*:\s*(.*)/i);
          if (nameMatch) projectName = nameMatch[1].trim();
          const techMatch = content.match(/-\s*\*\*Technology Stack\*\*:\s*(.*)/i);
          if (techMatch) projectTech = techMatch[1].trim();
        } catch (err: any) {
          ctx.addLine({ type: "error", content: `Failed to read agents.md: ${err.message}`, timestamp: now });
          return;
        }

        // System information
        const modelName = process.env.MODEL || getDefaultModel();
        let limit = getContextWindowLimit(modelName);
        if (process.env.CONTEXT_WINDOW_LIMIT) {
          const parsed = parseInt(process.env.CONTEXT_WINDOW_LIMIT, 10);
          if (!isNaN(parsed)) limit = parsed;
        }

        const auditLines = [
          "┌───[ ⚙️ SYSTEM AUDIT & AGENT INITIALIZATION ]",
          "│ ",
          "│ [HOST INFO]",
          `│ 🖥️ OS Platform   : ${process.platform}`,
          `│ 📦 Node Version   : ${process.version}`,
          `│ 📂 Workspace      : ${process.cwd()}`,
          "│ ",
          "│ [COGNITIVE CORE]",
          `│ ✦ Provider        : ${process.env.CUSTOM_BASE_URL ? "custom" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai"}`,
          `│ ✦ Active Model    : ${modelName}`,
          `│ ✦ Context Limit   : ${limit.toLocaleString()} tokens`,
          `│ ✦ Streaming       : ${process.env.DISABLE_STREAMING === "true" ? "DISABLED" : "ENABLED"}`,
          "│ ",
          "│ [PROJECT METADATA]",
          `│ 📄 Registry File  : ${fileStatus} (${agentsPath})`,
          `│ 📂 Project Name   : ${projectName}`,
          `│ 🛠️ Tech Stack      : ${projectTech}`,
          "│ ",
          "│ [SYSTEM TOOLS]",
          `│ 🛠️ Loaded Tools (${allTools.length}): ${allTools.map(t => t.name).join(", ")}`,
          "│ ",
          "└──────────────────────────────────────────────"
        ];

        ctx.addLine({
          type: "system",
          content: auditLines.join("\n"),
          timestamp: now,
        });
      })().catch(err => {
        ctx.addLine({ type: "error", content: `Init failed: ${err.message}`, timestamp: now });
      });
      break;
    case "login": {
      const args = cmd.slice(name.length + 2).trim();
      if (!args) {
        if (ctx.setActiveWizard) {
          ctx.setActiveWizard({
            type: "login",
            step: 1,
            data: {},
          });
          ctx.setWizardSelectedIndex?.(0);
        } else {
          ctx.addLine({
            type: "system",
            content: [
              "Usage:",
              "  /login <api_key> (auto-detects OpenRouter, Anthropic, OpenAI)",
              "  /login openrouter <api_key>",
              "  /login anthropic <api_key>",
              "  /login openai <api_key>",
              "  /login custom <base_url> <api_key>",
            ].join("\n"),
            timestamp: now,
          });
        }
        break;
      }

      const parts = args.split(/\s+/);
      let provider = "";
      let apiKey = "";
      let baseUrl = "";

      if (parts[0].toLowerCase() === "custom") {
        if (parts.length < 3) {
          ctx.addLine({
            type: "error",
            content: "Error: /login custom requires <base_url> and <api_key>",
            timestamp: now,
          });
          break;
        }
        provider = "custom";
        baseUrl = parts[1];
        apiKey = parts[2];
      } else if (["openrouter", "anthropic", "openai"].includes(parts[0].toLowerCase())) {
        if (parts.length < 2) {
          ctx.addLine({
            type: "error",
            content: `Error: /login ${parts[0]} requires <api_key>`,
            timestamp: now,
          });
          break;
        }
        provider = parts[0].toLowerCase();
        apiKey = parts[1];
      } else {
        apiKey = parts[0];
        if (apiKey.startsWith("sk-or-")) {
          provider = "openrouter";
        } else if (apiKey.startsWith("sk-ant-")) {
          provider = "anthropic";
        } else {
          provider = "openai";
        }
      }

      const updates: Record<string, string> = {};
      if (provider === "openrouter") {
        updates["CUSTOM_BASE_URL"] = "https://openrouter.ai/api/v1";
        updates["CUSTOM_API_KEY"] = apiKey;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;
      } else if (provider === "anthropic") {
        updates["ANTHROPIC_API_KEY"] = apiKey;
        updates["CUSTOM_BASE_URL"] = "";
        updates["CUSTOM_API_KEY"] = "";
        delete process.env.CUSTOM_BASE_URL;
        delete process.env.CUSTOM_API_KEY;
        delete process.env.OPENAI_API_KEY;
      } else if (provider === "openai") {
        updates["OPENAI_API_KEY"] = apiKey;
        updates["CUSTOM_BASE_URL"] = "";
        updates["CUSTOM_API_KEY"] = "";
        delete process.env.CUSTOM_BASE_URL;
        delete process.env.CUSTOM_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
      } else if (provider === "custom") {
        updates["CUSTOM_BASE_URL"] = baseUrl;
        updates["CUSTOM_API_KEY"] = apiKey;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;
      }

      try {
        const envPath = updateEnvFile(updates);
        ctx.addLine({
          type: "system",
          content: `Successfully logged in. Configured provider: ${provider}.\nSaved to: ${envPath}`,
          timestamp: now,
        });

        if (provider === "openrouter" && !process.env.MODEL) {
          updateEnvFile({ MODEL: "google/gemini-2.5-flash" });
        }
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to save login credentials: ${err.message}`,
          timestamp: now,
        });
      }
      break;
    }
    case "model": {
      const modelName = cmd.slice(name.length + 2).trim();
      if (modelName) {
        try {
          const envPath = updateEnvFile({ MODEL: modelName });
          const limit = getContextWindowLimit(modelName);
          if (ctx.setContextLimit) {
            ctx.setContextLimit(limit);
          }
          ctx.addLine({
            type: "system",
            content: `Model changed to: ${modelName}\nContext limit: ${limit.toLocaleString()} tokens\nSaved to: ${envPath}`,
            timestamp: now,
          });
        } catch (err: any) {
          ctx.addLine({
            type: "error",
            content: `Failed to set model: ${err.message}`,
            timestamp: now,
          });
        }
      } else {
        const currentModel = process.env.MODEL || getDefaultModel();
        ctx.addLine({
          type: "system",
          content: `Current Model: ${currentModel}`,
          timestamp: now,
        });

        const defaults = [
          "google/gemini-2.5-flash",
          "meta-llama/llama-3.3-70b-instruct",
          "deepseek/deepseek-chat",
          "gpt-4o",
          "gpt-4o-mini",
          "claude-3-5-sonnet-20241022",
        ];

        if (ctx.setActiveWizard) {
          ctx.setActiveWizard({
            type: "model",
            step: 1,
            data: {},
          });
          ctx.setWizardOptions?.(defaults);
          ctx.setWizardSelectedIndex?.(0);
        }

        const baseUrl = process.env.CUSTOM_BASE_URL;
        if (baseUrl) {
          fetch(`${baseUrl}/models`)
            .then(async (res) => {
              if (res.ok) {
                const data = (await res.json()) as any;
                if (data && Array.isArray(data.data)) {
                  const modelsList = data.data.map((m: any) => m.id).slice(0, 15);
                  if (ctx.setWizardOptions) {
                    ctx.setWizardOptions(modelsList);
                    ctx.setWizardSelectedIndex?.(0);
                  }
                  ctx.addLine({
                    type: "system",
                    content: `Live models loaded from ${baseUrl}. Selector list updated!`,
                    timestamp: Date.now(),
                  });
                }
              }
            })
            .catch(() => {});
        }
      }
      break;
    }
    case "agents": {
      const activeList = Array.from(subagentInstances.entries());
      const lines = [
        "┌───[ 🤖 ACTIVE SUBAGENTS & TYPES ]",
        "│ ",
        "│ [DEFINED TYPES]",
        "│  ├─ researcher : codebase research & context gathering",
        "│  ├─ explorer   : codebase structure, references, APIs, or resources exploration",
        "│  ├─ coder      : code writing & editing",
        "│  └─ reviewer   : debugging, review & testing",
        "│ ",
        "│ [ACTIVE INSTANCES]",
      ];
      if (activeList.length === 0) {
        lines.push("│  └─ None");
      } else {
        activeList.forEach(([id, inst], index) => {
          const isLast = index === activeList.length - 1;
          const branchChar = isLast ? "└─" : "├─";
          lines.push(`│  ${branchChar} ID: ${id} (${inst.typeName})`);
          const connectChar = isLast ? " " : "│";
          lines.push(`│     ├─ Role: ${inst.role}`);
          if (inst.status === "completed" && (inst as any).result) {
            const snippet = (inst as any).result.length > 60 ? (inst as any).result.slice(0, 57) + "..." : (inst as any).result;
            lines.push(`│     ├─ Status: ${inst.status}`);
            lines.push(`│     └─ Report: ${snippet.replace(/\n/g, " ")}`);
          } else {
            lines.push(`│     └─ Status: ${inst.status}`);
          }
        });
      }
      lines.push("└──────────────────────────────────────────────");
      ctx.addLine({
        type: "system",
        content: lines.join("\n"),
        timestamp: now,
      });
      break;
    }
    case "tasks": {
      const taskList = Array.from(backgroundTasks.entries());
      const lines = [
        "┌───[ ⚙️ RUNNING BACKGROUND TASKS ]",
        "│ ",
      ];
      if (taskList.length === 0) {
        lines.push("│  No active background tasks.");
      } else {
        for (const [id, task] of taskList) {
          lines.push(`│  • ID: ${id} | Command: ${task.command}`);
        }
      }
      lines.push("└──────────────────────────────────────────────");
      ctx.addLine({
        type: "system",
        content: lines.join("\n"),
        timestamp: now,
      });
      break;
    }
    case "install": {
      const args = cmd.slice(name.length + 2).trim();
      if (!args) {
        ctx.addLine({
          type: "error",
          content: "Usage: /install <owner/repo> (e.g. /install vercel-labs/skills/find-skills)",
          timestamp: now,
        });
        break;
      }
      ctx.addLine({
        type: "system",
        content: `Installing skill "${args}" via skills.sh...`,
        timestamp: now,
      });

      (async () => {
        try {
          const isWin = process.platform === "win32";
          const shell = isWin ? "powershell.exe" : true;
          const result = await execa("npx", ["skills", "add", args], {
            shell,
            cwd: process.cwd(),
            reject: false,
          });
          if (result.failed) {
            ctx.addLine({
              type: "error",
              content: `Failed to install skill: ${result.stderr || result.stdout || "Unknown error"}`,
              timestamp: Date.now(),
            });
          } else {
            ctx.addLine({
              type: "system",
              content: `✓ Successfully installed skill: ${args}!\nOutput:\n${result.stdout}`,
              timestamp: Date.now(),
            });
          }
        } catch (err: any) {
          ctx.addLine({
            type: "error",
            content: `Failed to execute install command: ${err.message}`,
            timestamp: Date.now(),
          });
        }
      })();
      break;
    }
    case "skills": {
      const skills = getInstalledSkills();
      const lines = [
        "┌───[ 📂 INSTALLED AGENT SKILLS ]",
        "│ ",
      ];
      if (skills.length === 0) {
        lines.push("│  No skills installed. Use /install <owner/repo> to install skills.");
      } else {
        for (const s of skills) {
          lines.push(`│  • Name        : ${s.name}`);
          lines.push(`│    Description : ${s.description}`);
          lines.push(`│    Path        : ${s.path}`);
          lines.push("│ ");
        }
        lines.pop(); // Remove the last empty spacer line
      }
      lines.push("└──────────────────────────────────────────────");
      ctx.addLine({
        type: "system",
        content: lines.join("\n"),
        timestamp: now,
      });
      break;
    }
    case "help":
      ctx.addLine({
        type: "system",
        content: [
          "Commands:",
          "  /new      - Start new session (clear history & screen)",
          "  /resume   - Resume last conversation session from history",
          "  /clear    - Clear conversation history",
          "  /compact  - Show conversation summary",
          "  /init     - Initialize/audit AI agents and system configuration",
          "  /agents   - List active subagents and defined subagent types",
          "  /tasks    - List running background tasks",
          "  /skills   - List all installed agent skills and templates",
          "  /install  - Install a skill from skills.sh (e.g. /install vercel-labs/skills/find-skills)",
          "  /login    - Login to a provider (e.g. /login openrouter sk-or-...)",
          "  /model    - Set or list active AI models (e.g. /model openai/gpt-4o)",
          "  /approve  - Approve the pending implementation plan",
          "  /help     - Show this help",
          "  /quit     - Exit the app",
          "",
          "Shortcuts:",
          "  Ctrl+C    - Abort / Exit",
        ].join("\n"),
        timestamp: now,
      });
      break;
    case "quit":
    case "exit":
      ctx.exit();
      break;
    default:
      ctx.addLine({
        type: "error",
        content: `Unknown command: /${name}`,
        timestamp: now,
      });
  }
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

const ChatLineComponent = React.memo(function ChatLineComponent({ line, isFirst }: { line: ChatLine; isFirst: boolean }) {
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
              <Text color="cyan">│ </Text>
              <Text>{l}</Text>
            </Box>
          ))}
          <Box flexDirection="row">
            <Text color="cyan">│ </Text>
          </Box>
        </Box>
      );
    }
    case "assistant":
      return (
        <Box flexDirection="column">
          <Text color="magenta">
            {isFirst ? "┌" : "├"}───[ <Text bold color="magenta">✦ COGNITIVE_NODE: SUPERAGENT</Text> ]
          </Text>
          {renderMarkdown(line.content, "magenta")}
          <Box flexDirection="row">
            <Text color="magenta">│ </Text>
          </Box>
        </Box>
      );
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
              <Text color="red">│ </Text>
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
              <Text color="gray">│ </Text>
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
              <Text color="gray">│ </Text>
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
