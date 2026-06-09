import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { Agent } from "./core/agent.js";
import type { AgentEvent, PermissionHandler } from "./core/agent.js";
import type { ToolCall } from "./core/conversation.js";
import { Banner } from "./components/banner.js";
import { getContextWindowLimit } from "./core/config.js";
import { getToolDescription } from "./core/permissions.js";

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
  const [showPermission, setShowPermission] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<{
    toolCall: ToolCall;
    description: string;
    resolve: (value: boolean) => void;
  } | null>(null);
  const [lastTabPrefix, setLastTabPrefix] = useState<string | null>(null);
  const [tokensUp, setTokensUp] = useState(0);
  const [tokensDown, setTokensDown] = useState(0);
  const [lastPromptTokens, setLastPromptTokens] = useState(0);
  const [contextLimit, setContextLimit] = useState(128000);
  const streamBufferRef = useRef("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [tempInput, setTempInput] = useState("");
  const agentRef = useRef<Agent | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);

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
        setShowPermission(true);
      });
    },
    []
  );

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case "text":
          streamBufferRef.current += event.content;
          setStreamDisplay(streamBufferRef.current);
          break;
        case "tool_start":
          flushBuffer();
          setIsExecutingTool(true);
          addLine({
            type: "tool_start",
            content: `⚡ ${event.description}\n   Detail: ${event.toolCall.name}(${formatArgs(event.toolCall.args)})`,
            timestamp: Date.now(),
          });
          break;
        case "tool_end":
          setIsExecutingTool(false);
          const r = event.toolResult;
          const statusPrefix = r.isError ? "✗ Failed -" : "✓ Completed -";
          const resultContent = r.isError
            ? `${statusPrefix} ${event.description}\nDetail: ${r.result}`
            : `${statusPrefix} ${event.description}\nOutput: ${r.result.slice(0, 500)}${r.result.length > 500 ? "..." : ""}`;
          addLine({
            type: "tool_end",
            content: resultContent,
            timestamp: Date.now(),
          });
          break;
        case "error":
          setIsExecutingTool(false);
          addLine({
            type: "error",
            content: `Error: ${event.message}`,
            timestamp: Date.now(),
          });
          break;
        case "done":
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
    },
    [flushBuffer, addLine]
  );

  useEffect(() => {
    const agent = new Agent(handleEvent, permissionHandler);
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
  }, [handleEvent, permissionHandler, exit, autoResume]);

  useEffect(() => {
    const hasMessages = agentRef.current ? agentRef.current.getHistory().getMessages().length > 0 : false;
    onHistoryChange?.(hasMessages);
  }, [lines, onHistoryChange]);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || isProcessing) return;

      setInput("");
      setLastTabPrefix(null);
      setHistoryIndex(-1);
      setScrollOffset(0);
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
    },
    [isProcessing, addLine, exit]
  );

  const handleInputChange = useCallback((val: string) => {
    setInput(val);
    if (lastTabPrefix && !val.startsWith(lastTabPrefix)) {
      setLastTabPrefix(null);
    }
  }, [lastTabPrefix]);

  const commands = ["/clear", "/compact", "/help", "/new", "/resume", "/quit", "/exit"];

  useInput((inputChar, key) => {
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
        setShowPermission(false);
        setPendingPermission(null);
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
    { isActive: showPermission }
  );

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

  return (
    <Box flexDirection="column">
      <Banner />

      {/* Messages */}
      <Box flexDirection="column" paddingX={1}>
        {(() => {
          const startIndex = scrollOffset === 0
            ? Math.max(0, lines.length - 15)
            : Math.max(0, lines.length - 15 - scrollOffset);
          const visibleLines = lines.slice(startIndex, scrollOffset === 0 ? undefined : lines.length - scrollOffset);
          return visibleLines.map((line, i) => {
            const originalIndex = startIndex + i;
            return (
              <ChatLineComponent key={originalIndex} line={line} isFirst={originalIndex === 0} />
            );
          });
        })()}

        {scrollOffset === 0 && isProcessing && !showPermission && (
          <Box marginY={0} flexDirection="column">
            <Text color="magenta">
              ├───[ <Text bold color="magenta">✦ SuperAgent</Text> ]
            </Text>
            {streamDisplay ? (
              streamDisplay.split("\n").map((l, idx) => (
                <Box key={idx} flexDirection="row">
                  <Text color="magenta">│ </Text>
                  <Text>{l}</Text>
                </Box>
              ))
            ) : isExecutingTool ? null : (
              <Box flexDirection="row">
                <Text color="magenta">│ </Text>
                <LoadingIndicator />
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* Permission prompt */}
      {showPermission && pendingPermission && (
        <Box
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginY={1}
        >
          <Box flexDirection="column">
            <Text bold color="yellow">
              ⚠ Permission Required
            </Text>
            <Text>{pendingPermission.description}</Text>
            <Box marginTop={1}>
              <Text>
                Approve? (<Text color="green">y</Text>/
                <Text color="red">n</Text>)
              </Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Input */}
      <Box paddingX={1} marginY={1} flexDirection="column">
        <Text dimColor>──────────────────────────────────────────────────────────────</Text>
        
        {/* Render suggestions inline above the input line */}
        {input.startsWith("/") && suggestions.length > 0 && (
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
          <Text color={scrollOffset > 0 ? "yellow" : isProcessing ? "gray" : "green"}>
            └───[ <Text bold color={scrollOffset > 0 ? "yellow" : isProcessing ? "gray" : "green"}>⌨️ Input</Text> ]
            {scrollOffset > 0 && (
              <Text color="yellow" bold> [Scroll: -{scrollOffset} lines/msgs - Press Esc to snap to bottom]</Text>
            )}
          </Text>
          <Box flexDirection="row">
            <Text color={isProcessing ? "gray" : "green"}>│ ❯ </Text>
            {isProcessing ? (
              <Text dimColor>Processing... (Ctrl+C to abort)</Text>
            ) : (input.length > 200 || input.includes("\n")) ? (
              <Box flexDirection="row">
                <Text color="yellow" bold>[Pasted Text: {input.length} chars, {input.split("\n").length} lines] </Text>
                <Text dimColor>(Press Enter to send, Esc to clear)</Text>
              </Box>
            ) : (
              <TextInput
                focus
                value={input}
                onChange={handleInputChange}
                onSubmit={handleSubmit}
                placeholder="Type a message or /help..."
              />
            )}
          </Box>
        </Box>
      </Box>

      {/* Status bar */}
      <Box flexDirection="column" paddingX={1} marginTop={0}>
        <Box justifyContent="space-between">
          <Box>
            <Text backgroundColor="cyan" color="black" bold> SUPERAGENT </Text>
            <Text dimColor>  msgs: {messageCount}  </Text>
            <Text color="yellow" bold>  ↑ Up: {tokensUp.toLocaleString()}  </Text>
            <Text color="green" bold>  ↓ Down: {(tokensDown + liveStreamTokens).toLocaleString()}  </Text>
          </Box>
          <Box>
            <Text color="magenta" bold>
              Ctx: {activeContextUsage.toLocaleString()} / {contextLimit.toLocaleString()} ({contextPercentage}%)
            </Text>
          </Box>
        </Box>
        <Box justifyContent="space-between" marginTop={0}>
          <Box>
            <Text dimColor>Dir: {process.cwd()}</Text>
          </Box>
          <Box>
            <Text backgroundColor="gray" color="white"> {getProviderLabel()} </Text>
            <Text backgroundColor="blue" color="white" bold> {modelName} </Text>
          </Box>
        </Box>
      </Box>
    </Box>
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
    resumeSession?: () => Promise<void>;
  }
) {
  const [name] = cmd.slice(1).split(" ");
  const now = Date.now();

  switch (name.toLowerCase()) {
    case "new":
      ctx.agent?.clearHistory();
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
      ctx.addLine({ type: "system", content: "Conversation cleared.", timestamp: now });
      break;
    case "compact":
      const summary = ctx.agent?.getHistory().getCompactSummary();
      ctx.addLine({ type: "system", content: summary || "No history.", timestamp: now });
      break;
    case "help":
      ctx.addLine({
        type: "system",
        content: [
          "Commands:",
          "  /new      - Start new session (clear history & screen)",
          "  /resume   - Resume last conversation session from history",
          "  /clear    - Clear conversation history",
          "  /compact  - Show conversation summary",
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

const ChatLineComponent = React.memo(function ChatLineComponent({ line, isFirst }: { line: ChatLine; isFirst: boolean }) {
  switch (line.type) {
    case "user": {
      const content = line.content.replace(/^❯ /, "");
      return (
        <Box marginY={0} flexDirection="column">
          <Text color="cyan">
            {isFirst ? "┌" : "├"}───[ <Text bold color="cyan">👤 You</Text> ]
          </Text>
          {content.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="cyan">│ </Text>
              <Text>{l}</Text>
            </Box>
          ))}
        </Box>
      );
    }
    case "assistant":
      return (
        <Box marginY={0} flexDirection="column">
          <Text color="magenta">
            {isFirst ? "┌" : "├"}───[ <Text bold color="magenta">✦ SuperAgent</Text> ]
          </Text>
          {line.content.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="magenta">│ </Text>
              <Text>{l}</Text>
            </Box>
          ))}
        </Box>
      );
    case "tool_start": {
      const content = line.content.replace(/^⚡ /, "");
      return (
        <Box marginY={0} flexDirection="column">
          <Text color="yellow">
            ├───[ <Text bold color="yellow">⚙️ Tool Execute</Text> ]
          </Text>
          {content.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="yellow">│ </Text>
              <Text>{l}</Text>
            </Box>
          ))}
        </Box>
      );
    }
    case "tool_end": {
      const isError = line.content.startsWith("✗");
      const contentText = line.content.substring(2);
      const themeColor = isError ? "red" : "green";
      return (
        <Box marginY={0} flexDirection="column">
          <Text color={themeColor}>
            ├───[ <Text bold color={themeColor}>{isError ? "❌ Tool Failed" : "✅ Tool Success"}</Text> ]
          </Text>
          {contentText.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│ </Text>
              <Text dimColor>{l}</Text>
            </Box>
          ))}
        </Box>
      );
    }
    case "error": {
      const contentText = line.content.replace(/^Error: /, "");
      return (
        <Box marginY={0} flexDirection="column">
          <Text color="red">
            ├───[ <Text bold color="red">🚨 Error</Text> ]
          </Text>
          {contentText.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="red">│ </Text>
              <Text color="red">{l}</Text>
            </Box>
          ))}
        </Box>
      );
    }
    case "system":
      return (
        <Box marginY={0} flexDirection="column">
          <Text color="gray">
            ├───[ <Text bold color="gray">ℹ️ System</Text> ]
          </Text>
          {line.content.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="gray">│ </Text>
              <Text color="gray" italic>{l}</Text>
            </Box>
          ))}
        </Box>
      );
    default:
      return (
        <Box marginY={0} flexDirection="column">
          <Text color="gray">
            ├───[ <Text bold color="gray">Message</Text> ]
          </Text>
          {line.content.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="gray">│ </Text>
              <Text>{l}</Text>
            </Box>
          ))}
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
    }, 80);
    return () => clearInterval(interval);
  }, []);

  return <Text color="yellow">{frames[frame]} Thinking...</Text>;
}
