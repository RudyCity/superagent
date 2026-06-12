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
  notifySubagentsChanged,
  notifySuperagentsChanged
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
  getGlobalConfigDir
} from "../core/config.js";
import { filterSuggestions } from "../utils/text.js";
import { WizardDialog } from "./wizard-dialog.js";
import { handleSlashCommand } from "../core/slash-commands.js";
import { listCheckpointsForSession, restoreCheckpoint } from "../core/checkpoints.js";

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
  const [pendingQuestion, setPendingQuestion] = useState<{
    question: string;
    options: string[];
    resolve: (value: string) => void;
  } | null>(null);
  const [checkpointsList, setCheckpointsList] = useState<any[]>([]);

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

  const getSuggestions = () => {
    if (!query.startsWith("/")) return [];
    const commands = [
      "/model", "/login", "/resume", "/clear", "/new", "/exit", 
      "/quit", "/checkpoint", "/install", "/skills", "/procs", 
      "/processes", "/agents", "/search-history", "/compact", 
      "/init", "/terminal", "/help"
    ];
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

  const handleWizardSubmit = async (value: string) => {
    if (!activeWizard) return;

    if (activeWizard.type === "login") {
      if (activeWizard.step === 1) {
        const choice = value.toLowerCase();
        let provider = "";
        if (choice.includes("openrouter") || choice.includes("1")) {
          provider = "openrouter";
        } else if (choice.includes("openai") || choice.includes("2")) {
          provider = "openai";
        } else if (choice.includes("anthropic") || choice.includes("3")) {
          provider = "anthropic";
        } else if (choice.includes("custom") || choice.includes("4")) {
          provider = "custom";
        } else {
          setMasterLogs((prev) => [...prev, `[ERROR] Invalid provider choice.`].slice(-50));
          return;
        }

        if (provider === "custom") {
          setActiveWizard({
            type: "login",
            step: 3,
            data: { provider },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setMasterLogs((prev) => [...prev, `[MASTER] Custom provider selected. Enter Custom Base URL:`].slice(-50));
        } else {
          setActiveWizard({
            type: "login",
            step: 4,
            data: { provider },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setMasterLogs((prev) => [...prev, `[MASTER] Enter API key for ${provider}:`].slice(-50));
        }
      } else if (activeWizard.step === 3) {
        const baseUrl = value.trim();
        if (!baseUrl) return;
        setActiveWizard({
          type: "login",
          step: 4,
          data: { ...activeWizard.data, baseUrl },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setMasterLogs((prev) => [...prev, `[MASTER] Base URL set to: ${baseUrl}. Enter API Key:`].slice(-50));
      } else if (activeWizard.step === 4) {
        const apiKey = value.trim();
        if (!apiKey) return;
        const provider = activeWizard.data.provider;
        const baseUrl = activeWizard.data.baseUrl;
        try {
          const prefix = `PROVIDER_${provider.toUpperCase()}`;
          const updates: Record<string, string> = {
            ACTIVE_PROVIDER: provider,
            [`${prefix}_TYPE`]: provider,
            [`${prefix}_API_KEY`]: apiKey,
          };
          if (baseUrl) {
            updates[`${prefix}_BASE_URL`] = baseUrl;
          } else if (provider === "openrouter") {
            updates[`${prefix}_BASE_URL`] = "https://openrouter.ai/api/v1";
          }
          updateEnvFile(updates);
          switchActiveProvider(provider);
          setMasterLogs((prev) => [...prev, `[MASTER] Successfully logged in to provider: ${provider}`].slice(-50));
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to save credentials: ${err.message}`].slice(-50));
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      }
    } else if (activeWizard.type === "model") {
      if (activeWizard.step === 1) {
        const choice = value.toLowerCase();
        let provider = "";
        if (choice.includes("openrouter") || choice.includes("1")) {
          provider = "openrouter";
        } else if (choice.includes("openai") || choice.includes("2")) {
          provider = "openai";
        } else if (choice.includes("anthropic") || choice.includes("3")) {
          provider = "anthropic";
        } else if (choice.includes("custom") || choice.includes("4")) {
          provider = "custom";
        } else {
          setMasterLogs((prev) => [...prev, `[ERROR] Invalid provider choice.`].slice(-50));
          return;
        }

        setActiveWizard({
          type: "model",
          step: 2,
          data: { provider },
        });

        let initialModels: string[] = [];
        if (provider === "openrouter") {
          initialModels = [
            "google/gemini-2.5-flash",
            "meta-llama/llama-3.3-70b-instruct",
            "deepseek/deepseek-chat",
            "anthropic/claude-3.5-sonnet",
          ];
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
            .catch(() => {});
        } else if (provider === "openai") {
          initialModels = [
            "gpt-4o",
            "gpt-4o-mini",
            "o1",
            "o1-mini",
            "o1-preview",
            "o3-mini",
          ];
          const apiKey = process.env.OPENAI_API_KEY || process.env.CUSTOM_API_KEY;
          if (apiKey) {
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
              .catch(() => {});
          }
        } else if (provider === "anthropic") {
          initialModels = [
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
              .catch(() => {});
          }
        }

        setWizardOptions(initialModels);
        setWizardSelectedIndex(0);
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
        const checkpointsDir = path.join(getGlobalConfigDir(), "checkpoints");
        const sessionBase = path.basename(sessionPath, ".json");
        const chkPath = path.join(checkpointsDir, `${sessionBase}_checkpoint_${chosen.timestamp}.json`);

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

        const checkpointsDir = path.join(getGlobalConfigDir(), "checkpoints");
        const sessionBase = path.basename(sessionPath, ".json");
        const chkPath = path.join(checkpointsDir, `${sessionBase}_checkpoint_${chosen.timestamp}.json`);

        (async () => {
          try {
            if (doGitRestore && chosen.gitSha) {
              try {
                const { execa: execaFn } = await import("execa");
                await execaFn("git", ["stash", "--include-untracked"], { cwd: process.cwd(), reject: false });
                await execaFn("git", ["checkout", chosen.gitSha], { cwd: process.cwd(), reject: false });
                setMasterLogs((prev) => [...prev, `[MASTER] Workspace restored to Git commit: ${chosen.gitSha}`].slice(-50));
              } catch (gitErr: any) {
                setMasterLogs((prev) => [...prev, `[ERROR] Git restore failed: ${gitErr.message}. Conversation history restored anyway.`].slice(-50));
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

      const hasOptions = wizardOptions.length > 0;
      const finalValue = hasOptions && wizardSelectedIndex >= 0 && wizardSelectedIndex < wizardOptions.length
        ? wizardOptions[wizardSelectedIndex]
        : cleanVal;

      handleWizardSubmit(finalValue);
      setQuery("");
      return;
    }

    if (!cleanVal) return;

    // Save to history
    setHistory((prev) => {
      if (prev.length > 0 && prev[prev.length - 1] === cleanVal) {
        return prev;
      }
      return [...prev, cleanVal];
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
        setWizardSelectedIndex((prev) => Math.min(wizardOptions.length - 1, prev + 1));
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
        if (pendingQuestion) {
          pendingQuestion.resolve("");
          setPendingQuestion(null);
        }
        return;
      }
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
          {activeWizard && (
            <Box flexDirection="column" marginY={0}>
              <Box flexDirection="row" marginTop={0}>
                <Text color="magenta">│</Text>
              </Box>
              <WizardDialog
                title={
                  activeWizard.type === "model" ? `⚙️ SELECT MODEL PROVIDER (Step ${activeWizard.step}):` :
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
                  `🔑 PROVIDER CREDENTIALS (Step ${activeWizard.step}):`
                }
                description={activeWizard.type === "question" ? (pendingQuestion?.question || "") : undefined}
                borderColor="magenta"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
                maxVisible={5}
                isMultiSelect={activeWizard.isMultiSelect}
                selectedSet={wizardSelectedSet}
                marginY={0}
              />
              <Box flexDirection="row" marginTop={0}>
                <Text color="magenta">│</Text>
              </Box>
            </Box>
          )}

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
              <Text bold color={focusArea === "input" ? "green" : "cyan"}>└───[ ⚡ PROMPT ] ❯ </Text>
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
              <Text color="cyan" bold>Superagents({[...superagentInstances.values()].length}): {[...superagentInstances.values()].reduce((acc, i) => acc + (i.tokenUsage?.prompt ?? 0) + (i.tokenUsage?.completion ?? 0), 0).toLocaleString()}t</Text>
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
        <Box flexDirection="row" marginTop={0}>
          <Text color="gray" dimColor>[Tab] Cycle Focus  [▲/▼] Navigate/Scroll  [Esc] Snap Bottom  [Ctrl+C] Exit</Text>
        </Box>
      </Box>
    </Box>
  );
}
