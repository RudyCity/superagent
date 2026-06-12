import React, { useState, useEffect } from "react";
import { execSync } from "child_process";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { 
  subagentInstances, 
  subscribeToSubagents, 
  superagentInstances,
  subscribeToSuperagents,
  backgroundTasks, 
  subscribeToTasks,
  subscribeToActiveOutput,
  notifySubagentsChanged
} from "../core/tools/state.js";
import { Agent } from "../core/agent.js";
import { wrapTextForDisplay } from "../utils/responseScroll.js";
import { 
  updateEnvFile, 
  switchActiveProvider, 
  listHistorySessions, 
  fetchAndCacheModels 
} from "../core/config.js";
import { filterSuggestions } from "../utils/text.js";

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
  registerQuestionHandlerRef?: (setter: (q: string, opts: string[]) => Promise<string>) => void;
}) {
  const { exit } = useApp();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [focusArea, setFocusArea] = useState<"list" | "logs" | "input">("input");
  const [query, setQuery] = useState("");
  const [masterLogs, setMasterLogs] = useState<string[]>(["[MASTER] System initialised. Ready for tasks."]);

  const [currentTask, setCurrentTask] = useState("Idle - Ready for input");
  const [gitBranch, setGitBranch] = useState("main");
  const [cachedSessions, setCachedSessions] = useState<any[]>([]);

  const getSuggestions = () => {
    if (!query.startsWith("/")) return [];
    const commands = ["/model", "/login", "/resume"];
    const parts = query.split(/\s+/);
    const mainCommand = parts[0].toLowerCase();
    
    if (parts.length === 1) {
      return filterSuggestions(commands, query);
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
      return filterSuggestions(possibilities, query);
    }
    
    if (mainCommand === "/login") {
      const providers = ["openrouter", "openai", "anthropic"];
      const possibilities = providers.map(p => `/login ${p}`);
      return filterSuggestions(possibilities, query);
    }
    
    if (mainCommand === "/resume") {
      const sessionsList = listHistorySessions();
      const possibilities = sessionsList.map((s, idx) => `/resume ${idx + 1}`);
      return filterSuggestions(possibilities, query);
    }
    
    return [];
  };

  const suggestions = getSuggestions();

  useEffect(() => {
    try {
      const branch = execSync("git branch --show-current", { encoding: "utf-8" }).trim();
      if (branch) setGitBranch(branch);
    } catch {}
  }, []);

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
      if (output.trim()) {
        const newLogs = output.split("\n").filter(Boolean);
        setMasterLogs((prev) => [...prev, ...newLogs].slice(-50));
      }
    });
  }, []);

  // Register the agent event log handler on mount
  useEffect(() => {
    registerLogHandler((msg) => {
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
          const cleanMsg = msg.replace(/^\[AGENT\]\s?/, "");
          updated[lastIdx] = last + cleanMsg;
          return updated.slice(-50);
        }

        if (!isTag(msg) && !isTag(last)) {
          const updated = [...prev];
          updated[lastIdx] = last + msg;
          return updated.slice(-50);
        }
        
        return [...prev, msg].slice(-50);
      });
    });
  }, [registerLogHandler]);

  const handleQuerySubmit = (val: string) => {
    if (!val.trim()) return;
    const cleanVal = val.trim();

    if (cleanVal.startsWith("/")) {
      const parts = cleanVal.split(/\s+/);
      const commandName = parts[0].toLowerCase();

      if (commandName === "/model") {
        const modelName = parts[1];
        if (modelName) {
          try {
            updateEnvFile({ MODEL: modelName });
            fetchAndCacheModels().catch(() => {});
            setMasterLogs((prev) => [...prev, `[USER] ${cleanVal}`, `[MASTER] Model switched to: ${modelName}`].slice(-50));
          } catch (err: any) {
            setMasterLogs((prev) => [...prev, `[USER] ${cleanVal}`, `[ERROR] Failed to switch model: ${err.message}`].slice(-50));
          }
        } else {
          setMasterLogs((prev) => [
            ...prev,
            `[USER] ${cleanVal}`,
            `[MASTER] Active Model: ${process.env.MODEL || "google/gemini-2.5-flash"}`,
            `[MASTER] Common models: google/gemini-2.5-flash, google/gemini-2.5-pro, anthropic/claude-3-5-sonnet, openai/gpt-4o`,
            `[MASTER] Usage: /model <model_name>`
          ].slice(-50));
        }
        setQuery("");
        return;
      }

      if (commandName === "/login") {
        const providerName = parts[1];
        const apiKey = parts[2];
        if (providerName && apiKey) {
          try {
            const profileName = providerName.toLowerCase();
            const prefix = `PROVIDER_${profileName.toUpperCase()}`;
            const updates: Record<string, string> = {
              ACTIVE_PROVIDER: profileName,
              [`${prefix}_TYPE`]: profileName,
              [`${prefix}_API_KEY`]: apiKey,
            };
            if (profileName === "openrouter") {
              updates[`${prefix}_BASE_URL`] = "https://openrouter.ai/api/v1";
            }
            updateEnvFile(updates);
            switchActiveProvider(profileName);
            setMasterLogs((prev) => [...prev, `[USER] ${cleanVal}`, `[MASTER] Switched provider profile to: ${profileName}`].slice(-50));
          } catch (err: any) {
            setMasterLogs((prev) => [...prev, `[USER] ${cleanVal}`, `[ERROR] Login switch failed: ${err.message}`].slice(-50));
          }
        } else {
          setMasterLogs((prev) => [
            ...prev,
            `[USER] ${cleanVal}`,
            `[MASTER] Usage: /login <provider_name> <api_key>`,
            `[MASTER] E.g. /login openrouter sk-or-v1-xxxxxxxx`
          ].slice(-50));
        }
        setQuery("");
        return;
      }

      if (commandName === "/resume") {
        const targetArg = parts[1];
        const sessionsList = listHistorySessions();
        if (sessionsList.length === 0) {
          setMasterLogs((prev) => [...prev, `[USER] ${cleanVal}`, `[MASTER] No active sessions found in workspace.`].slice(-50));
          setQuery("");
          return;
        }

        if (!targetArg) {
          const logLines = [`[USER] ${cleanVal}`, `[MASTER] Select session to resume:`];
          sessionsList.forEach((s, idx) => {
            logLines.push(`[MASTER]   [${idx + 1}] ${s.displayName} (${s.messageCount} msgs)`);
          });
          logLines.push(`[MASTER] Usage: /resume <session_number>`);
          setMasterLogs((prev) => [...prev, ...logLines].slice(-50));
          setCachedSessions(sessionsList);
        } else {
          const index = parseInt(targetArg, 10);
          const selected = (index > 0 && index <= sessionsList.length) 
            ? sessionsList[index - 1]
            : sessionsList.find(s => s.displayName.toLowerCase().includes(targetArg.toLowerCase()));

          if (selected) {
            agent.loadHistoryFromPath(selected.filePath)
              .then(() => {
                setMasterLogs((prev) => [...prev, `[USER] ${cleanVal}`, `[MASTER] Session loaded successfully: ${selected.displayName}`].slice(-50));
              })
              .catch((err: any) => {
                setMasterLogs((prev) => [...prev, `[USER] ${cleanVal}`, `[ERROR] Session load failed: ${err.message}`].slice(-50));
              });
          } else {
            setMasterLogs((prev) => [...prev, `[USER] ${cleanVal}`, `[ERROR] Session index/name "${targetArg}" not found.`].slice(-50));
          }
        }
        setQuery("");
        return;
      }
    }

    setMasterLogs((prev) => [...prev, `[USER] ${cleanVal}`].slice(-50));
    setQuery("");
    setCurrentTask(cleanVal);

    // Spawn subtask logs and actual agents
    agent.sendMessage(cleanVal)
      .then(() => {
        setCurrentTask(`Idle - Completed: ${cleanVal}`);
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

  const workspaceHeight = Math.max(10, terminalSize.height - 9);
  const leftTopHeight = Math.max(5, workspaceHeight - 7);
  const logBoxHeight = Math.max(5, workspaceHeight - 3);
  const showCursor = selectedSession.status === "WORKING" && logScrollOffset === 0;
  const logsCount = showCursor ? Math.max(1, logBoxHeight - 1) : logBoxHeight;

  const feedWidth = Math.max(10, Math.floor(terminalSize.width * 0.58) - 4);
  const wrappedLines: React.ReactNode[] = [];
  
  for (const log of selectedSession.logs) {
    const logStr = log.trim();
    if (!logStr) continue;

    let tag = "";
    let content = logStr;
    let color = "green";
    let isBold = false;
    let dimColor = false;

    if (logStr.startsWith("[USER]")) {
      tag = "[USER]   ❯ ";
      content = logStr.replace("[USER]", "").trim();
      color = "cyan";
      isBold = true;
    } else if (logStr.startsWith("[MASTER]")) {
      tag = "[SYSTEM] ❯ ";
      content = logStr.replace("[MASTER]", "").trim();
      color = "yellow";
      dimColor = true;
    } else if (logStr.startsWith("[AGENT]")) {
      tag = "[AGENT]  ❯ ";
      content = logStr.replace("[AGENT]", "").trim();
      color = "white";
      isBold = true;
    } else if (logStr.startsWith("[TOOL START]")) {
      tag = "[START]  ❯ ";
      content = logStr.replace("[TOOL START]", "").trim();
      color = "magenta";
    } else if (logStr.startsWith("[TOOL END]")) {
      tag = "[DONE]   ❯ ";
      content = logStr.replace("[TOOL END]", "").trim();
      color = "gray";
    } else if (logStr.startsWith("[ERROR]")) {
      tag = "[ERROR]  ❯ ";
      content = logStr.replace("[ERROR]", "").trim();
      color = "red";
      isBold = true;
    } else if (logStr.startsWith("[AUTO-APPROVE]")) {
      tag = "[OK]     ❯ ";
      content = logStr.replace("[AUTO-APPROVE]", "").trim();
      color = "blue";
      dimColor = true;
    } else if (logStr.startsWith("[QUESTION]")) {
      tag = "[QUEST]  ❯ ";
      content = logStr.replace("[QUESTION]", "").trim();
      color = "magenta";
    }

    const tagWidth = tag.length;
    const contentWidth = Math.max(10, feedWidth - tagWidth);
    const subLines = wrapTextForDisplay(content, contentWidth);

    for (let i = 0; i < subLines.length; i++) {
      const lineText = subLines[i];
      if (i === 0) {
        wrappedLines.push(
          <Box flexDirection="row" key={`${log}-${i}`}>
            {tag ? <Text color={color === "gray" ? "gray" : color} bold={isBold}>{tag}</Text> : null}
            <Text color={color} bold={isBold} dimColor={dimColor}>{lineText}</Text>
          </Box>
        );
      } else {
        wrappedLines.push(
          <Box flexDirection="row" key={`${log}-${i}`}>
            {tag ? <Text>{" ".repeat(tagWidth)}</Text> : null}
            <Text color={color} bold={isBold} dimColor={dimColor}>{lineText}</Text>
          </Box>
        );
      }
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
            const promptStartRow = 3 + workspaceHeight - 2;
            if (y >= promptStartRow) {
              setFocusArea("input");
            } else {
              setFocusArea("list");
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
  }, [wrappedLines.length, logsCount, terminalSize.width, terminalSize.height]);

  // Handle user inputs
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

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

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0} width={terminalSize.width}>
      {/* Header Banner - High Tech Cyberpunk Style */}
      <Box flexDirection="column" marginBottom={1} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Text color="cyan" bold>◣ M U L T I - A G E N T ◢</Text>
            <Text color="gray">   </Text>
            <Text color="yellow" bold>COGNITIVE CONTROL STATION</Text>
          </Box>
          <Text color="magenta" bold>ACTIVE_SYSTEM: ONLINE</Text>
        </Box>
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
              <Box justifyContent="center" marginTop={1}>
                <Text color="gray" dimColor>No active agent threads detected</Text>
              </Box>
            ) : (
              visibleSessions.map((session, index) => {
                const globalIndex = startIdx + index;
                const isSelected = globalIndex === selectedIndex;
                const color = isSelected ? "cyan" : tierColor[session.type];
                return (
                  <Box key={session.id} flexDirection="row" justifyContent="space-between" marginTop={0}>
                    <Text bold={isSelected} color={color} wrap="truncate-end">
                      {isSelected ? "▶ " : "  "}
                      {tierIcon[session.type]} [{globalIndex + 1}] {session.id.slice(0, 14)}
                    </Text>
                    <Box>
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
          </Box>

          {/* Bottom Left: Interactive Console Prompt */}
          <Box flexDirection="column" width="100%" marginTop={1}>

            {focusArea === "input" && query.startsWith("/") && suggestions.length > 0 && (
              <Box flexDirection="row" marginBottom={1} paddingLeft={2}>
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
              <Text bold color={focusArea === "input" ? "green" : "cyan"}>⚡ PROMPT ❯ </Text>
              <Box width={Math.max(10, Math.floor(terminalSize.width * 0.40) - 12)}>
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

      {/* Footer System statistics */}
      <Box marginTop={1} paddingX={1} flexDirection="row">
        <Text color="gray">SYS_STATUS: </Text>
        <Text color="green" bold>● ONLINE</Text>
        <Text color="gray">  MODEL: </Text>
        <Text color="yellow" bold>{process.env.MODEL || "google/gemini-2.5-flash"}</Text>
        <Text color="gray">  MASTER: </Text>
        <Text color="magenta" bold>{sessions.find(s => s.type === "MASTER")?.tokens.toLocaleString() ?? 0}t</Text>
        <Text color="gray">  SUPERAGENTS({[...superagentInstances.values()].length}): </Text>
        <Text color="cyan" bold>
          {[...superagentInstances.values()]
            .reduce((acc, i) => acc + (i.tokenUsage?.prompt ?? 0) + (i.tokenUsage?.completion ?? 0), 0)
            .toLocaleString()}t
        </Text>
      </Box>

      {/* System Legend Shortcuts */}
      <Box paddingX={1} flexDirection="row" marginTop={0}>
        <Text bold color={focusArea === "input" ? "green" : "cyan"}>⌨️  </Text>
        <Text color="gray" dimColor>[Tab] Cycle Focus  [▲/▼] Navigate/Scroll  [Esc] Snap Bottom  [Ctrl+C] Exit</Text>
      </Box>
    </Box>
  );
}
