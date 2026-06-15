import { useInput } from "ink";
import path from "path";
import { getTruncatedAssistantIndexes, wrapTextForDisplay } from "../utils/responseScroll.js";
import { getPasteSplit, filterSuggestions, getInsertion } from "../utils/text.js";
import { getConfiguredProviders, switchActiveProvider, fetchAndCacheModels, getContextWindowLimit, listHistorySessions, getModelPresets, BUILT_IN_PRESETS, getInstalledSkills } from "../core/config.js";
import { getDefaultModel } from "../core/slash-commands.js";
import { listCheckpointsForSession, terminateActiveTasksAndSubagents, restoreCheckpoint, type Checkpoint } from "../core/checkpoints.js";
import { getToolDescription } from "../core/permissions.js";
import { registerSubagentType, allTools, backgroundTasks, subagentInstances, superagentInstances, subscribeToTasks, subscribeToSubagents, subscribeToSuperagents, subscribeToSchedules, subscribeToActiveOutput, registerQuestionHandler, notifySubagentsChanged } from "../core/tools.js";
import type { ChatLine } from "../core/slash-commands.js";
import type { ToolCall } from "../core/conversation.js";
import type { Agent } from "../core/agent.js";

function formatArgs(args: string | Record<string, any>): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

export interface KeyboardHandlerContext {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  isProcessing: boolean;
  setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  activeWizard: {
    type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills";
    step: number;
    data: Record<string, string>;
    isMultiSelect?: boolean;
  } | null;
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  wizardOptions: string[];
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  wizardSelectedIndex: number;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  wizardSelectedSet: Set<number>;
  setWizardSelectedSet: React.Dispatch<React.SetStateAction<Set<number>>>;
  checkpointsList: Checkpoint[];
  setCheckpointsList: React.Dispatch<React.SetStateAction<Checkpoint[]>>;
  lines: ChatLine[];
  setLines: React.Dispatch<React.SetStateAction<ChatLine[]>>;
  addLine: (line: ChatLine) => void;
  history: string[];
  setHistory: React.Dispatch<React.SetStateAction<string[]>>;
  historyIndex: number;
  setHistoryIndex: React.Dispatch<React.SetStateAction<number>>;
  tempInput: string;
  setTempInput: React.Dispatch<React.SetStateAction<string>>;
  scrollOffset: number;
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  focusedResponseIndex: number | null;
  setFocusedResponseIndex: React.Dispatch<React.SetStateAction<number | null>>;
  focusedResponseOffset: number;
  setFocusedResponseOffset: React.Dispatch<React.SetStateAction<number>>;
  planState: string;
  setPlanState: React.Dispatch<React.SetStateAction<any>>;
  focusMode: "input" | "history" | "checklist" | "superagents" | "subagents" | "procs" | "chat";
  setFocusMode: React.Dispatch<React.SetStateAction<any>>;
  historySelectedIndex: number;
  setHistorySelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  checklistScrollOffset: number;
  setChecklistScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  superagentsScrollOffset: number;
  setSuperagentsScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  subagentsScrollOffset: number;
  setSubagentsScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  procsScrollOffset: number;
  setProcsScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  terminalHeight: number;
  terminalWidth: number;
  checklistTasks: { status: string; text: string }[];
  agentRef: React.MutableRefObject<Agent | null>;
  pendingPermission: {
    toolCall: ToolCall;
    description: string;
    resolve: (value: boolean) => void;
  } | null;
  setPendingPermission: React.Dispatch<React.SetStateAction<any>>;
  pendingQuestion: {
    question: string;
    options: string[];
    resolve: (value: string) => void;
  } | null;
  setPendingQuestion: React.Dispatch<React.SetStateAction<any>>;
  handleWizardSubmit: (value: string) => void;
  handleSubmit: (value: string) => void;
  handlePermissionResponse: (approved: boolean) => void;
  openLatestTruncatedResponse: () => boolean;
  stopRunningSubagents: () => number;
  scrollChat: (direction: "up" | "down", amount?: number) => void;
  setContextLimit: React.Dispatch<React.SetStateAction<number>>;
  setActiveModel: React.Dispatch<React.SetStateAction<string>>;
  exit: () => void;
  isPasted: boolean;
  setIsPasted: React.Dispatch<React.SetStateAction<boolean>>;
  pastePrefixLength: number;
  pasteSuffixLength: number;
  lastTabPrefix: string | null;
  setLastTabPrefix: React.Dispatch<React.SetStateAction<string | null>>;
  commands: string[];
}

export function useKeyboardHandler(ctx: KeyboardHandlerContext) {
  const {
    input,
    setInput,
    isProcessing,
    setIsProcessing,
    activeWizard,
    setActiveWizard,
    wizardOptions,
    setWizardOptions,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    wizardSelectedSet,
    setWizardSelectedSet,
    checkpointsList,
    setCheckpointsList,
    lines,
    setLines,
    addLine,
    history,
    setHistory,
    historyIndex,
    setHistoryIndex,
    tempInput,
    setTempInput,
    scrollOffset,
    setScrollOffset,
    focusedResponseIndex,
    setFocusedResponseIndex,
    focusedResponseOffset,
    setFocusedResponseOffset,
    planState,
    setPlanState,
    focusMode,
    setFocusMode,
    historySelectedIndex,
    setHistorySelectedIndex,
    checklistScrollOffset,
    setChecklistScrollOffset,
    superagentsScrollOffset,
    setSuperagentsScrollOffset,
    subagentsScrollOffset,
    setSubagentsScrollOffset,
    procsScrollOffset,
    setProcsScrollOffset,
    terminalHeight,
    terminalWidth,
    checklistTasks,
    agentRef,
    pendingPermission,
    setPendingPermission,
    pendingQuestion,
    setPendingQuestion,
    handleWizardSubmit,
    handleSubmit,
    handlePermissionResponse,
    openLatestTruncatedResponse,
    stopRunningSubagents,
    scrollChat,
    setContextLimit,
    setActiveModel,
    exit,
    isPasted,
    setIsPasted,
    pastePrefixLength,
    pasteSuffixLength,
    lastTabPrefix,
    setLastTabPrefix,
    commands,
  } = ctx;

  const maxChecklistVisible = 5;
  const maxSuperagentsVisible = 2;
  const maxSubagentsVisible = 3;
  const maxProcsVisible = 5;

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

    if (focusMode === "checklist") {
      if (key.upArrow) {
        setChecklistScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setChecklistScrollOffset((prev) => {
          const maxScroll = Math.max(0, checklistTasks.length - maxChecklistVisible);
          return Math.min(prev + 1, maxScroll);
        });
        return;
      }
      if (key.escape) {
        setFocusMode("input");
        return;
      }
      return;
    }

    if (focusMode === "superagents") {
      if (key.upArrow) {
        setSuperagentsScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSuperagentsScrollOffset((prev) => {
          const runningSuperagentsCount = [...superagentInstances.values()].filter((s) => s.status === "running").length;
          const maxScroll = Math.max(0, runningSuperagentsCount - maxSuperagentsVisible);
          return Math.min(prev + 1, maxScroll);
        });
        return;
      }
      if (key.escape) {
        setFocusMode("input");
        return;
      }
      return;
    }

    if (focusMode === "subagents") {
      if (key.upArrow) {
        setSubagentsScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSubagentsScrollOffset((prev) => {
          const runningSubagentsCount = [...subagentInstances.values()].filter((s) => s.status === "running").length;
          const maxScroll = Math.max(0, runningSubagentsCount - maxSubagentsVisible);
          return Math.min(prev + 1, maxScroll);
        });
        return;
      }
      if (key.escape) {
        setFocusMode("input");
        return;
      }
      return;
    }

    if (focusMode === "procs") {
      if (key.upArrow) {
        setProcsScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setProcsScrollOffset((prev) => {
          const runningTasksCount = [...backgroundTasks.values()].filter((t) => t.isDetachedWindow || !t.hasExited).length;
          const maxScroll = Math.max(0, runningTasksCount - maxProcsVisible);
          return Math.min(prev + 1, maxScroll);
        });
        return;
      }
      if (key.escape) {
        setFocusMode("input");
        return;
      }
      return;
    }

    if (focusMode === "chat") {
      if (key.upArrow) {
        scrollChat("up");
        return;
      }
      if (key.downArrow) {
        scrollChat("down");
        return;
      }
      if (key.escape) {
        setScrollOffset(0);
        setFocusMode("input");
        return;
      }
      return;
    }

    if (key.ctrl && inputChar === "o") {
      if (!activeWizard) openLatestTruncatedResponse();
      return;
    }

    if (key.ctrl && inputChar === "h") {
      setFocusMode((prev: any) => {
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
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
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
                    setActiveModel(currentModel);
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
          const choices = [
            "preset_load",    // 0
            "preset_list",    // 1
            "preset_create",  // 2
            "preset_edit",    // 3
            "preset_delete",  // 4
            "configure_tiers", // 5
            "back"            // 6
          ];
          const choice = choices[wizardSelectedIndex];
          if (!choice) return;

          if (choice === "back") {
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }

          if (choice === "preset_load") {
            setActiveWizard({
              type: "model",
              step: 4,
              data: { tier: choice },
            });
            const presets = getModelPresets();
            const options = presets.map(p => `${p.name} - ${p.description}`);
            setWizardOptions([...options, "< Back"]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }

          if (choice === "preset_list") {
            const presets = getModelPresets();
            const listStr = presets.map(p => {
              const modelsStr = Object.entries(p.models).map(([k, v]) => `    - ${k}: ${v}`).join("\n");
              return `- **${p.name}**: ${p.description}\n${modelsStr}`;
            }).join("\n");
            addLine({
              type: "system",
              content: `Available Model Presets:\n${listStr}`,
              timestamp: Date.now(),
            });
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            return;
          }

          if (choice === "preset_create") {
            setActiveWizard({
              type: "model",
              step: 20,
              data: { tier: choice },
            });
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }

          if (choice === "preset_edit") {
            const presets = getModelPresets();
            const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
            if (customPresets.length === 0) {
              addLine({
                type: "error",
                content: "No custom presets available to edit.",
                timestamp: Date.now(),
              });
              setActiveWizard(null);
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              return;
            }
            setActiveWizard({
              type: "model",
              step: 30,
              data: { tier: choice },
            });
            setWizardOptions([...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }

          if (choice === "preset_delete") {
            const presets = getModelPresets();
            const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
            if (customPresets.length === 0) {
              addLine({
                type: "error",
                content: "No custom presets available to delete.",
                timestamp: Date.now(),
              });
              setActiveWizard(null);
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              return;
            }
            setActiveWizard({
              type: "model",
              step: 40,
              data: { tier: choice },
            });
            setWizardOptions([...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }

          if (choice === "configure_tiers") {
            const getResolvedModelWithProvider = (rawVal: string, isDefault: boolean): string => {
              const mStr = (rawVal || (isDefault ? (process.env.MODEL || getDefaultModel()) : "")).trim();
              if (!mStr) return "(not set)";
              if (mStr.includes(":")) return mStr;
              const activeProvider = (process.env.ACTIVE_PROVIDER || (process.env.CUSTOM_BASE_URL ? "custom" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai")).trim();
              return `${activeProvider}:${mStr}`;
            };
            const defaultResolved = getResolvedModelWithProvider("", true);
            const rawMaster = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "";
            const masterModelFormatted = rawMaster ? getResolvedModelWithProvider(rawMaster, false) : `(use default: ${defaultResolved})`;
            const rawSuperagent = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "";
            const superagentModelFormatted = rawSuperagent ? getResolvedModelWithProvider(rawSuperagent, false) : `(use default: ${defaultResolved})`;
            const rawSubagent = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "";
            const subagentModelFormatted = rawSubagent ? getResolvedModelWithProvider(rawSubagent, false) : `(use default: ${defaultResolved})`;
            const rawResearcher = process.env.MODEL_SUBAGENT_RESEARCHER || process.env.MODEL_RESEARCHER || "";
            const researcherModelFormatted = rawResearcher ? getResolvedModelWithProvider(rawResearcher, false) : `(use default: ${subagentModelFormatted})`;
            const rawCoder = process.env.MODEL_SUBAGENT_CODER || process.env.MODEL_CODER || "";
            const coderModelFormatted = rawCoder ? getResolvedModelWithProvider(rawCoder, false) : `(use default: ${subagentModelFormatted})`;
            const rawReviewer = process.env.MODEL_SUBAGENT_REVIEWER || process.env.MODEL_REVIEWER || "";
            const reviewerModelFormatted = rawReviewer ? getResolvedModelWithProvider(rawReviewer, false) : `(use default: ${subagentModelFormatted})`;

            setActiveWizard({
              type: "model",
              step: 50,
              data: { ...activeWizard.data },
            });
            setWizardOptions([
              `1. Master Agent (depth 0) (${masterModelFormatted})`,
              `2. Superagent (depth 1) (${superagentModelFormatted})`,
              `3. Subagent (depth 2) (${subagentModelFormatted})`,
              `4. Subagent: researcher (${researcherModelFormatted})`,
              `5. Subagent: coder (${coderModelFormatted})`,
              `6. Subagent: reviewer (${reviewerModelFormatted})`,
              `7. Default Model (Only set default fallback)`,
              `8. All Tiers (Overwrite All)`,
              `< Back`
            ]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }
        }
      } else if (activeWizard.type === "model" && activeWizard.step === 50 && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const tiers = ["master", "superagent", "subagent", "researcher", "coder", "reviewer", "default", "all", "back"];
          const tier = tiers[wizardSelectedIndex];
          if (!tier) return;

          if (tier === "back") {
            setActiveWizard({
              type: "model",
              step: 1,
              data: {},
            });
            setWizardOptions([
              "1. Load/Apply Model Preset",
              "2. List Model Presets",
              "3. Create Model Preset",
              "4. Edit Model Preset",
              "5. Delete Model Preset",
              "6. Configure Agent Tier Models"
            ]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }

          setActiveWizard({
            type: "model",
            step: 2,
            data: { ...activeWizard.data, tier },
          });

          const list = getConfiguredProviders();
          const options = list.map(p => `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${p.isActive ? " [Active]" : ""}`);
          const providerOptions = options.length > 0 ? [...options, "< Back"] : ["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint", "< Back"];
          setWizardOptions(providerOptions);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }
      } else if (
        activeWizard.type === "model" && 
        (activeWizard.step === 2 || activeWizard.step === 4 || activeWizard.step === 22 || activeWizard.step === 23 || activeWizard.step === 30 || activeWizard.step === 32 || activeWizard.step === 33 || activeWizard.step === 40 || activeWizard.step === 41) && 
        wizardOptions.length > 0
      ) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const selectedVal = wizardOptions[wizardSelectedIndex];
          if (selectedVal) {
            handleWizardSubmit(selectedVal);
          }
          return;
        }
      } else if (activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 24 || activeWizard.step === 34) && wizardOptions.length > 0) {
        const modelSearchQuery = input.trim();
        const filteredModels = modelSearchQuery
          ? filterSuggestions(wizardOptions, modelSearchQuery)
          : wizardOptions;
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => {
            const currentMax = Math.max(0, filteredModels.length - 1);
            const clampedPrev = Math.min(prev, currentMax);
            return Math.max(0, clampedPrev - 1);
          });
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => {
            const currentMax = Math.max(0, filteredModels.length - 1);
            const clampedPrev = Math.min(prev, currentMax);
            return Math.min(currentMax, clampedPrev + 1);
          });
          return;
        }
        if (key.return) {
          const selectedModel = filteredModels[wizardSelectedIndex] ?? filteredModels[0];
          if (selectedModel) {
            handleWizardSubmit(selectedModel);
          }
          return;
        }
      } else if (activeWizard.type === "plan_approve" && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          return;
        }
      } else if (activeWizard.type === "permission" && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const approved = wizardSelectedIndex === 0;
          handlePermissionResponse(approved);
          return;
        }
      } else if (activeWizard.type === "question" && wizardOptions.length > 0) {
        if (activeWizard.isMultiSelect && inputChar === " ") {
          setWizardSelectedSet((prev: Set<number>) => {
            const next = new Set<number>(prev);
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
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
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
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
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
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
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
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
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
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
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
      if (activeWizard) {
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
        return;
      }
      if (stopRunningSubagents() > 0) {
        agentRef.current?.abort();
        setIsProcessing(false);
        return;
      }
      if (isProcessing) {
        agentRef.current?.abort();
        setIsProcessing(false);
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
        if (activeWizard.type === "model" && activeWizard.step !== 1) {
          if (activeWizard.step === 50) {
            handleWizardSubmit("back");
          } else {
            handleWizardSubmit("< Back");
          }
          return;
        } else if (activeWizard.type === "checkpoint" && activeWizard.step === 2) {
          setActiveWizard({ type: "checkpoint", step: 1, data: {} });
          const listOptions = checkpointsList.map((c: any) => `${c.name} (${new Date(c.timestamp).toLocaleString()}) - ${c.messages.length} messages`);
          setWizardOptions(listOptions);
          setWizardSelectedIndex(0);
          return;
        } else if (activeWizard.type === "skills" && activeWizard.step === 2) {
          const skillsList = getInstalledSkills();
          const options = skillsList.map((s) => `• ${s.name} - ${s.description.slice(0, 50)}${s.description.length > 50 ? "..." : ""}`);
          const skillIndex = parseInt(activeWizard.data.skillIndex || "0", 10);
          setActiveWizard({
            type: "skills",
            step: 1,
            data: {},
          });
          setWizardOptions(options);
          setWizardSelectedIndex(skillIndex);
          return;
        }

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
          return;
        }
        agentRef.current?.abort();
        setIsProcessing(false);
      } else {
        setInput("");
        setIsPasted(false);
        setHistoryIndex(-1);
      }
    }

    const { inserted: currentInserted } = getPasteSplit(input, pastePrefixLength, pasteSuffixLength);
    const isPasteActive = isPasted && (currentInserted.length > 200 || currentInserted.includes("\n"));

    if (
      (key.backspace || key.delete) &&
      isPasteActive &&
      !isProcessing
    ) {
      setInput((prev) => {
        const next = prev.slice(0, -1);
        const { inserted: nextInserted } = getPasteSplit(next, pastePrefixLength, pasteSuffixLength);
        if (next.length <= pastePrefixLength + pasteSuffixLength || (nextInserted.length <= 200 && !nextInserted.includes("\n"))) {
          setIsPasted(false);
        }
        return next;
      });
      return;
    }

    if (key.return && !isProcessing) {
      if (isPasteActive) {
        handleSubmit(input);
        return;
      }
    }

    if (key.escape) {
      if (isPasteActive) {
        setInput("");
        setIsPasted(false);
        setHistoryIndex(-1);
        return;
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
        const query = input;
        const matching = commands.filter((c) => c.startsWith(query));
        if (matching.length === 1 && matching[0]) {
          setInput(matching[0] + " ");
          setLastTabPrefix(null);
        } else if (matching.length > 1) {
          let commonPrefix = query;
          let possible = true;
          while (possible) {
            const nextChar = matching[0]?.[commonPrefix.length];
            if (!nextChar) break;
            for (let i = 1; i < matching.length; i++) {
              if (matching[i]?.[commonPrefix.length] !== nextChar) {
                possible = false;
                break;
              }
            }
            if (possible) {
              commonPrefix += nextChar;
            }
          }
          if (commonPrefix !== query) {
            setInput(commonPrefix);
            setLastTabPrefix(commonPrefix);
          } else {
            const list = matching.join("  ");
            addLine({
              type: "system",
              content: list,
              timestamp: Date.now(),
            });
            setLastTabPrefix(query);
          }
        }
      }
    }
  });

  // Small y/n listener for permission wizard
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
}
