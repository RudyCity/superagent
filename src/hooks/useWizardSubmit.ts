import { useCallback } from "react";
import fs from "fs";
import path from "path";
import type { ChatLine } from "../core/slash-commands.js";
import type { ToolCall } from "../core/conversation.js";
import { checkPlanStructure, type Agent, type QuestionItem } from "../core/agent.js";
import type { Checkpoint } from "../core/checkpoints.js";

// Import sub-wizards
import { useLoginWizard } from "./wizard/useLoginWizard.js";
import { useModelWizard } from "./wizard/useModelWizard.js";
import { useGoalWizard } from "./wizard/useGoalWizard.js";

export interface WizardSubmitContext {
  activeWizard: {
    type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills" | "exit_confirm" | "workspace";
    step: number;
    data: Record<string, string>;
    isMultiSelect?: boolean;
    questions?: QuestionItem[];
    currentQuestionIndex?: number;
    answers?: string[];
  } | null;
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  wizardOptions: string[];
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  wizardSelectedIndex: number;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setWizardSelectedSet: React.Dispatch<React.SetStateAction<Set<number>>>;
  setCheckpointsList: React.Dispatch<React.SetStateAction<Checkpoint[]>>;
  addLine: (line: ChatLine) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  isProcessing: boolean;
  setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  setContextLimit: React.Dispatch<React.SetStateAction<number>>;
  setActiveModel: React.Dispatch<React.SetStateAction<string>>;
  setPlanState: React.Dispatch<React.SetStateAction<any>>;
  setGoalMode: React.Dispatch<React.SetStateAction<any>>;
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
    resolve: (value: any) => void;
  } | null;
  setPendingQuestion: React.Dispatch<React.SetStateAction<any>>;
  wizardIsLoadingModels: boolean;
  setWizardIsLoadingModels: React.Dispatch<React.SetStateAction<boolean>>;
  planState: string;
  streamBufferRef: React.MutableRefObject<string>;
  setStreamDisplay: React.Dispatch<React.SetStateAction<string>>;
  exit?: () => void;
  setWorkingDirectory?: (path: string) => void;
  clearLines?: () => void;
}

export function useWizardSubmit(ctx: WizardSubmitContext) {
  const {
    activeWizard,
    setActiveWizard,
    wizardOptions,
    setWizardOptions,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    setWizardSelectedSet,
    addLine,
    setInput,
    setIsProcessing,
    setPlanState,
    agentRef,
    pendingQuestion,
    setPendingQuestion,
    planState,
    streamBufferRef,
    setStreamDisplay,
    exit,
    setWorkingDirectory,
    clearLines,
  } = ctx;

  const handleLoginWizard = useLoginWizard(ctx);
  const handleModelWizard = useModelWizard(ctx);
  const handleGoalWizard = useGoalWizard(ctx);

  const handleWizardSubmit = useCallback(async (value: string) => {
    if (!activeWizard) return;
    const now = Date.now();

    if (activeWizard.type === "exit_confirm") {
      if (value === "Yes, exit") {
        exit?.();
      } else {
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        addLine({
          type: "system",
          content: "Exit cancelled. Retaining session.",
          timestamp: now,
        });
      }
      return;
    }

    if (activeWizard.type === "login") {
      handleLoginWizard(value, activeWizard.step, activeWizard.data);
      return;
    }

    if (activeWizard.type === "model") {
      handleModelWizard(value, activeWizard.step, activeWizard.data);
      return;
    }

    if (activeWizard.type === "goal") {
      handleGoalWizard(value, activeWizard.step, activeWizard.data);
      return;
    }

    if (activeWizard.type === "plan_approve") {
      // Step 2: custom feedback — send feedback to agent for revision
      if (activeWizard.step === 2) {
        const feedback = (typeof value === "string" ? value : "").trim();
        if (!feedback) return;
        if (agentRef.current) {
          agentRef.current.planState = "IDLE";
          setPlanState("IDLE");
          setIsProcessing(true);
          streamBufferRef.current = "";
          setStreamDisplay("");
          agentRef.current.sendMessage(`Plan revision feedback: ${feedback}`).catch((err: any) => {
            setIsProcessing(false);
            addLine({ type: "error", content: `Plan feedback error: ${err.message}`, timestamp: Date.now() });
          });
        }
        addLine({
          type: "system",
          content: `💬 Plan feedback sent: "${feedback.slice(0, 100)}${feedback.length > 100 ? "..." : ""}"`,
          timestamp: now,
        });
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        return;
      }

      // Step 1: approve / reject
      const approved = value === "approve";
      if (approved && planState === "APPROVED") return;
      if (approved) {
        let isPlanValid = true;
        if (agentRef.current) {
          const planFilePath = agentRef.current.getPlanFilePath();
          try {
            if (fs.existsSync(planFilePath)) {
              const content = fs.readFileSync(planFilePath, "utf8");
              isPlanValid = checkPlanStructure(content);
            } else {
              isPlanValid = false;
            }
          } catch {
            isPlanValid = false;
          }
        }

        if (!isPlanValid) {
          addLine({
            type: "error",
            content: "⚠️ The implementation plan is invalid or lacks structure. A plan must match one of the template structures (full, quick, or refactor). Redirecting to request revision...",
            timestamp: now,
          });
          setActiveWizard({
            type: "plan_approve",
            step: 2,
            data: activeWizard.data,
          });
          return;
        }

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
          content: "✅ Implementation plan approved! Continuing with the approved plan now.",
          timestamp: now,
        });
      } else {
        // Reject — stop the agent process
        if (agentRef.current) {
          agentRef.current.planState = "IDLE";
          setPlanState("IDLE");
          agentRef.current.abort();
        }
        setIsProcessing(false);
        addLine({
          type: "system",
          content: "❌ Implementation plan rejected. Agent process stopped.",
          timestamp: now,
        });
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      return;
    }

    if (activeWizard.type === "workspace") {
      if (activeWizard.step === 1) {
        if (value === "❌ Exit Wizard") {
          addLine({
            type: "system",
            content: "Workspace wizard closed.",
            timestamp: now,
          });
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        if (value === "📁 Select & Switch Workspace...") {
          const { getTrustedDirectories } = await import("../core/config/jsonConfig.js");
          const { getWorkspacesFromDb } = await import("../core/storage/historyDb.js");
          const { workspaceMode } = await import("../core/ssh/workspaceMode.js");
          const sshCfg = workspaceMode.getConfig();
          const currentWorkspace = workspaceMode.isSsh() && sshCfg
            ? `${sshCfg.username}@${sshCfg.host}:${sshCfg.port}${sshCfg.remoteCwd}`
            : path.resolve(agentRef.current?.workingDirectory || process.cwd());

          const trustedDirs = getTrustedDirectories().map(d => d.startsWith("ssh:") ? d : path.resolve(d));
          const allDirs = [...new Set([currentWorkspace, ...trustedDirs])];
          const dbWorkspaces = getWorkspacesFromDb();
          const workspacesMap = new Map(dbWorkspaces.map(w => [path.resolve(w.path), w]));

          const switchOptions = allDirs.map((dir) => {
            let isActive = dir === currentWorkspace;
            if (!isActive && workspaceMode.isSsh() && sshCfg && (dir.startsWith("ssh:") || (dir.includes("@") && (dir.includes(":/") || dir.includes(":"))))) {
              const parsedDir = workspaceMode.parseSshTarget(dir);
              if (parsedDir) {
                isActive =
                  parsedDir.host === sshCfg.host &&
                  parsedDir.port === sshCfg.port &&
                  parsedDir.username === sshCfg.username &&
                  parsedDir.remoteCwd === sshCfg.remoteCwd;
              }
            }
            const prefix = isActive ? "* [active] " : "📁 ";
            const wsRecord = workspacesMap.get(dir);
            const wsName = wsRecord?.name || "";
            const namePart = wsName ? ` [${wsName}]` : "";
            return `${prefix}${namePart} ${dir}`;
          });

          setActiveWizard({
            type: "workspace",
            step: 2,
            data: {},
          });
          setWizardOptions(switchOptions);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        if (value === "➕ Add a new workspace...") {
          setActiveWizard({
            type: "workspace",
            step: 3,
            data: {},
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        if (value === "🗑️ Remove a workspace...") {
          const { getTrustedDirectories } = await import("../core/config/jsonConfig.js");
          const { getWorkspacesFromDb } = await import("../core/storage/historyDb.js");
          const trustedDirs = getTrustedDirectories();
          const dbWorkspaces = getWorkspacesFromDb();
          const workspacesMap = new Map(dbWorkspaces.map(w => [path.resolve(w.path), w]));
          const currentCwd = path.resolve(agentRef.current?.workingDirectory || process.cwd());

          const removeOptions = trustedDirs.map((dir) => {
            const cleanDir = dir.startsWith("ssh:") ? dir : path.resolve(dir);
            const wsRecord = workspacesMap.get(cleanDir);
            const wsName = wsRecord?.name || "";
            const namePart = wsName ? ` [${wsName}]` : "";
            const isCurrent = cleanDir === currentCwd;
            const currentBadge = isCurrent ? " (active)" : "";
            return `📁${namePart} ${cleanDir}${currentBadge}`;
          });

          if (removeOptions.length === 0) {
            addLine({
              type: "system",
              content: "No stored workspaces to remove.",
              timestamp: now,
            });
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            return;
          }

          setActiveWizard({
            type: "workspace",
            step: 4,
            data: {},
          });
          setWizardOptions(removeOptions);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        if (value === "📊 View workspace status") {
          const { workspaceMode } = await import("../core/ssh/workspaceMode.js");
          const { sshProxy } = await import("../core/ssh/sshProxy.js");
          if (!workspaceMode.isSsh()) {
            const localPath = agentRef.current?.workingDirectory || process.cwd();
            addLine({
              type: "system",
              content: `📁 Local Workspace Status:\n- Mode: Local Disk\n- Active Path: ${localPath}`,
              timestamp: now,
            });
          } else {
            try {
              const metrics = await sshProxy.getSystemMetrics();
              addLine({
                type: "system",
                content: `🌐 SSH Remote Workspace Status:\n- Target Host: ${metrics.user}@${metrics.host}\n- Remote OS: ${metrics.osName}\n- System Uptime: ${metrics.uptime}\n- RAM Usage: ${metrics.ramUsage}\n- Disk Usage: ${metrics.diskUsage}\n- SSH Latency: ${metrics.pingMs}ms\n- Active Remote Directory: ${workspaceMode.getConfig()?.remoteCwd}`,
                timestamp: now,
              });
            } catch (err: any) {
              addLine({
                type: "system",
                content: `Error fetching SSH remote metrics: ${err.message}`,
                timestamp: now,
              });
            }
          }
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          return;
        }
      }

      if (activeWizard.step === 2) {
        let cleanVal = value.replace(/^\*\s*\[active\]\s*/i, "").replace(/^📁\s*/, "").replace(/\s*\(active\)$/i, "").trim();
        if (cleanVal.startsWith("[")) {
          const bracketEnd = cleanVal.indexOf("]");
          if (bracketEnd !== -1) {
            cleanVal = cleanVal.substring(bracketEnd + 1).trim();
          }
        }
        const isSsh = cleanVal.startsWith("ssh:") || (cleanVal.includes("@") && (cleanVal.includes(":/") || cleanVal.includes(":")));
        const resolvedPath = isSsh ? cleanVal : path.resolve(cleanVal);

        if (isSsh || fs.existsSync(resolvedPath)) {
          const { addTrustedDirectory } = await import("../core/config/jsonConfig.js");
          const { workspaceMode } = await import("../core/ssh/workspaceMode.js");
          const { sshProxy } = await import("../core/ssh/sshProxy.js");
          addTrustedDirectory(resolvedPath);

          if (isSsh) {
            const sshConfig = workspaceMode.parseSshTarget(resolvedPath);
            if (sshConfig) {
              await sshProxy.disconnect();
              workspaceMode.setSshMode(sshConfig);
            }
          } else {
            await sshProxy.disconnect();
            workspaceMode.setLocalMode();
          }

          if (setWorkingDirectory) {
            setWorkingDirectory(resolvedPath);
          } else {
            if (!isSsh) process.chdir(resolvedPath);
            if (agentRef.current) agentRef.current.workingDirectory = resolvedPath;
          }

          if (agentRef.current) {
            agentRef.current.resetInternalState();
            await agentRef.current.clearHistory();
            agentRef.current.planState = "IDLE";
            agentRef.current.goalMode = null;
          }
          if (setPlanState) setPlanState("IDLE");
          if (clearLines) clearLines();

          addLine({
            type: "system",
            content: `Switched workspace to: ${resolvedPath}\nStarted a new chat session.`,
            timestamp: now,
          });
        } else {
          addLine({
            type: "error",
            content: `Error: Workspace path does not exist: ${resolvedPath}`,
            timestamp: now,
          });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        return;
      }

      if (activeWizard.step === 3) {
        const pathInput = value.trim();
        if (!pathInput) {
          addLine({
            type: "system",
            content: "Workspace addition cancelled.",
            timestamp: now,
          });
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          return;
        }

        const currentCwd = agentRef.current?.workingDirectory || process.cwd();
        const isSsh = pathInput.startsWith("ssh:") || (pathInput.includes("@") && (pathInput.includes(":/") || pathInput.includes(":")));
        const resolvedPath = isSsh ? pathInput : path.resolve(currentCwd, pathInput);

        if (isSsh || (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory())) {
          const { addTrustedDirectory } = await import("../core/config/jsonConfig.js");
          const { workspaceMode } = await import("../core/ssh/workspaceMode.js");
          const { sshProxy } = await import("../core/ssh/sshProxy.js");
          addTrustedDirectory(resolvedPath);

          if (isSsh) {
            const sshConfig = workspaceMode.parseSshTarget(resolvedPath);
            if (sshConfig) {
              await sshProxy.disconnect();
              workspaceMode.setSshMode(sshConfig);
            }
          } else {
            await sshProxy.disconnect();
            workspaceMode.setLocalMode();
          }

          if (setWorkingDirectory) {
            setWorkingDirectory(resolvedPath);
          } else {
            if (!isSsh) process.chdir(resolvedPath);
            if (agentRef.current) agentRef.current.workingDirectory = resolvedPath;
          }

          if (agentRef.current) {
            agentRef.current.resetInternalState();
            await agentRef.current.clearHistory();
            agentRef.current.planState = "IDLE";
            agentRef.current.goalMode = null;
          }
          if (setPlanState) setPlanState("IDLE");
          if (clearLines) clearLines();

          addLine({
            type: "system",
            content: `Added and switched to workspace: ${resolvedPath}\nStarted a new chat session.`,
            timestamp: now,
          });
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        } else {
          addLine({
            type: "error",
            content: `Error: Path does not exist or is not a directory: ${resolvedPath}`,
            timestamp: now,
          });
          setInput("");
        }
        return;
      }

      if (activeWizard.step === 4) {
        let targetWs = value.replace(/^📁\s*/, "").replace(/\s*\(active\)$/i, "").trim();
        if (targetWs.startsWith("[")) {
          const bracketEnd = targetWs.indexOf("]");
          if (bracketEnd !== -1) {
            targetWs = targetWs.substring(bracketEnd + 1).trim();
          }
        }

        if (!targetWs) {
          addLine({
            type: "system",
            content: "Workspace removal cancelled.",
            timestamp: now,
          });
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          return;
        }

        setActiveWizard({
          type: "workspace",
          step: 5,
          data: { targetWorkspace: targetWs },
        });
        setWizardOptions(["Yes, remove this workspace", "No, cancel"]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (activeWizard.step === 5) {
        if (value === "Yes, remove this workspace" && activeWizard.data.targetWorkspace) {
          const targetWs = activeWizard.data.targetWorkspace;
          const { removeTrustedDirectory } = await import("../core/config/jsonConfig.js");
          removeTrustedDirectory(targetWs);
          addLine({
            type: "system",
            content: `🗑️ Successfully removed workspace from trusted list: ${targetWs}`,
            timestamp: now,
          });
        } else {
          addLine({
            type: "system",
            content: "Cancelled workspace removal.",
            timestamp: now,
          });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        return;
      }
    }

    if (activeWizard.type === "question") {
      const qList = activeWizard.questions;
      const currIdx = activeWizard.currentQuestionIndex;
      if (qList && currIdx !== undefined) {
        const updatedAnswers = [...(activeWizard.answers || [])];
        updatedAnswers[currIdx] = value;
        
        addLine({
          type: "system",
          content: `❓ Answered: "${value}"`,
          timestamp: now,
        });
        
        const nextIdx = currIdx + 1;
        if (nextIdx < qList.length) {
          const nextQ = qList[nextIdx];
          const hasOptions = Array.isArray(nextQ.options) && nextQ.options.length > 0;
          const allOptions = hasOptions ? [...nextQ.options, "Custom..."] : [];
          if (pendingQuestion) {
            setPendingQuestion({
              question: nextQ.question,
              options: allOptions,
              resolve: pendingQuestion.resolve,
            });
          }
          setWizardOptions(allOptions);
          
          const nextSavedAns = updatedAnswers[nextIdx] || "";
          if (nextQ.isMultiSelect) {
            const nextAnsList = nextSavedAns.split(", ").map(x => x.trim());
            const newSet = new Set<number>();
            allOptions.forEach((opt, idx) => {
              if (nextAnsList.includes(opt)) {
                newSet.add(idx);
              }
            });
            setWizardSelectedSet(newSet);
            setWizardSelectedIndex(0);
          } else {
            const optionIdx = nextQ.options.indexOf(nextSavedAns);
            if (optionIdx >= 0) {
              setWizardSelectedIndex(optionIdx);
            } else {
              setWizardSelectedIndex(0);
            }
            setWizardSelectedSet(new Set());
          }
          
          setInput("");
          
          const optionIdx = nextQ.options.indexOf(nextSavedAns);
          const isCustomAnswer = nextSavedAns !== "" && optionIdx < 0;
          
          if (isCustomAnswer && !nextQ.isMultiSelect) {
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setInput(nextSavedAns);
            setActiveWizard({
              ...activeWizard,
              step: 2,
              currentQuestionIndex: nextIdx,
              answers: updatedAnswers,
              isMultiSelect: nextQ.isMultiSelect,
            });
          } else {
            setActiveWizard({
              ...activeWizard,
              step: hasOptions ? 1 : 2,
              currentQuestionIndex: nextIdx,
              answers: updatedAnswers,
              isMultiSelect: nextQ.isMultiSelect,
            });
          }
        } else {
          if (pendingQuestion) {
            pendingQuestion.resolve(updatedAnswers);
            setPendingQuestion(null);
          }
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setWizardSelectedSet(new Set());
        }
        return;
      }

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
      return;
    }
  }, [
    activeWizard,
    handleLoginWizard,
    handleModelWizard,
    handleGoalWizard,
    planState,
    agentRef,
    setPlanState,
    setIsProcessing,
    streamBufferRef,
    setStreamDisplay,
    addLine,
    setActiveWizard,
    setWizardOptions,
    setWizardSelectedIndex,
    setWizardSelectedSet,
    setInput,
    pendingQuestion,
    setPendingQuestion,
    exit,
    setWorkingDirectory,
  ]);

  return handleWizardSubmit;
}
