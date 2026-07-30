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

async function getSortedChainOptions(currentWorkspace: string): Promise<{ options: string[], chainIds: string[] }> {
  const { getWorkspaceChains, getActiveChainId } = await import("../core/workspace/WorkspaceChainConfig.js");
  const { workspaceMode } = await import("../core/ssh/workspaceMode.js");
  
  const chains = getWorkspaceChains();
  const activeId = getActiveChainId();
  const isSsh = workspaceMode.isSsh();
  
  // Sort chains so that current workspace chains are first
  const sortedChains = [...chains].sort((a, b) => {
    let aCurrent = 0;
    let bCurrent = 0;
    const aPrimary = a.nodes.find(n => n.id === a.primaryNodeId);
    const bPrimary = b.nodes.find(n => n.id === b.primaryNodeId);
    
    if (aPrimary) {
      if (aPrimary.type === "local" && !isSsh) {
        if (path.resolve(aPrimary.path || "") === path.resolve(currentWorkspace)) aCurrent = 1;
      } else if (aPrimary.type === "ssh" && isSsh) {
        const sshCfg = workspaceMode.getConfig();
        if (sshCfg && aPrimary.sshConfig &&
            aPrimary.sshConfig.host === sshCfg.host &&
            aPrimary.sshConfig.port === sshCfg.port &&
            aPrimary.sshConfig.username === sshCfg.username &&
            aPrimary.sshConfig.remoteCwd === sshCfg.remoteCwd) aCurrent = 1;
      }
    }
    if (bPrimary) {
      if (bPrimary.type === "local" && !isSsh) {
        if (path.resolve(bPrimary.path || "") === path.resolve(currentWorkspace)) bCurrent = 1;
      } else if (bPrimary.type === "ssh" && isSsh) {
        const sshCfg = workspaceMode.getConfig();
        if (sshCfg && bPrimary.sshConfig &&
            bPrimary.sshConfig.host === sshCfg.host &&
            bPrimary.sshConfig.port === sshCfg.port &&
            bPrimary.sshConfig.username === sshCfg.username &&
            bPrimary.sshConfig.remoteCwd === sshCfg.remoteCwd) bCurrent = 1;
      }
    }
    return bCurrent - aCurrent;
  });

  const options = sortedChains.map(c => {
    const isActive = c.id === activeId ? " [ACTIVE]" : "";
    
    // Check if current
    let isCurrentWs = false;
    const primaryNode = c.nodes.find(n => n.id === c.primaryNodeId);
    if (primaryNode) {
      if (primaryNode.type === "local" && !isSsh) {
        isCurrentWs = path.resolve(primaryNode.path || "") === path.resolve(currentWorkspace);
      } else if (primaryNode.type === "ssh" && isSsh) {
        const sshCfg = workspaceMode.getConfig();
        if (sshCfg && primaryNode.sshConfig) {
          isCurrentWs = 
            primaryNode.sshConfig.host === sshCfg.host &&
            primaryNode.sshConfig.port === sshCfg.port &&
            primaryNode.sshConfig.username === sshCfg.username &&
            primaryNode.sshConfig.remoteCwd === sshCfg.remoteCwd;
        }
      }
    }
    const currentBadge = isCurrentWs ? " [CURRENT]" : "";
    return `🔗 ${c.name} (${c.id})${isActive}${currentBadge} — ${c.nodes.length} nodes`;
  });

  options.push("➕ Create new workspace chain...");
  options.push("❌ Back");

  return {
    options,
    chainIds: sortedChains.map(c => c.id)
  };
}

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
    inputType?: "select" | "text" | "password";
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
          const workspacesMap = new Map(dbWorkspaces.map(w => [w.path.startsWith("ssh:") ? w.path : path.resolve(w.path), w]));
          const currentCwd = agentRef.current?.workingDirectory?.startsWith("ssh:")
            ? agentRef.current.workingDirectory
            : path.resolve(agentRef.current?.workingDirectory || process.cwd());

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

          const removePaths = trustedDirs.map(d => d.startsWith("ssh:") ? d : path.resolve(d));
          setActiveWizard({
            type: "workspace",
            step: 4,
            data: { removePaths },
          });
          setWizardOptions(removeOptions);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        if (value === "🔗 Manage workspace chains...") {
          const { workspaceMode } = await import("../core/ssh/workspaceMode.js");
          const sshCfg = workspaceMode.getConfig();
          const currentWorkspace = workspaceMode.isSsh() && sshCfg
            ? `${sshCfg.username}@${sshCfg.host}:${sshCfg.port}${sshCfg.remoteCwd}`
            : path.resolve(agentRef.current?.workingDirectory || process.cwd());

          const { options, chainIds } = await getSortedChainOptions(currentWorkspace);
          setActiveWizard({
            type: "workspace",
            step: 7,
            data: { chainIds },
          });
          setWizardOptions(options);
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
        const currentCwd = agentRef.current?.workingDirectory || process.cwd();
        const resolvedPath = isSsh ? cleanVal : path.resolve(currentCwd, cleanVal);

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
              try {
                await sshProxy.connect(sshConfig);
              } catch (connErr: any) {
                workspaceMode.setLocalMode();
                addLine({ type: "error", content: `SSH connect failed: ${connErr?.message || connErr}`, timestamp: Date.now() });
                return;
              }
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

          let chainNotice = "";
          try {
            const { getWorkspaceChains, getWorkspaceChain, setActiveChainId } = await import("../core/workspace/WorkspaceChainConfig.js");
            const chains = getWorkspaceChains();
            let matchedChainId: string | null = null;
            
            for (const chain of chains) {
              const primaryNode = chain.nodes.find(n => n.id === chain.primaryNodeId);
              if (primaryNode) {
                let matches = false;
                if (primaryNode.type === "local" && !isSsh) {
                  matches = path.resolve(primaryNode.path || "") === path.resolve(resolvedPath);
                } else if (primaryNode.type === "ssh" && isSsh) {
                  const sshCfg = workspaceMode.getConfig();
                  if (sshCfg && primaryNode.sshConfig) {
                    matches = 
                      primaryNode.sshConfig.host === sshCfg.host &&
                      primaryNode.sshConfig.port === sshCfg.port &&
                      primaryNode.sshConfig.username === sshCfg.username &&
                      primaryNode.sshConfig.remoteCwd === sshCfg.remoteCwd;
                  }
                }
                if (matches) {
                  matchedChainId = chain.id;
                  break;
                }
              }
            }
            
            if (matchedChainId) {
              setActiveChainId(matchedChainId);
              const activeChainName = getWorkspaceChain(matchedChainId)?.name || matchedChainId;
              chainNotice = `\n🔗 Active Workspace Chain auto-switched to: ${activeChainName} (${matchedChainId})`;
            } else {
              setActiveChainId(null);
            }
          } catch (chainErr: any) {
            // ignore
          }

          addLine({
            type: "system",
            content: `Switched workspace to: ${resolvedPath}${chainNotice}\nStarted a new chat session.`,
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
          // Validate SSH URI before proceeding to name step
          if (isSsh) {
            const { workspaceMode: wmProbe } = await import("../core/ssh/workspaceMode.js");
            const probe = wmProbe.parseSshTarget(resolvedPath);
            if (!probe) {
              addLine({
                type: "error",
                content: `Error: Invalid SSH target: ${pathInput}`,
                timestamp: now,
              });
              setInput("");
              setActiveWizard(null);
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              return;
            }
          }

          // Move to name prompt step; finalize add in step 6 handler.
          setActiveWizard({
            type: "workspace",
            step: 6,
            data: { ...(activeWizard.data ?? {}), pendingPath: resolvedPath, pendingIsSsh: isSsh },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        addLine({
          type: "error",
          content: `Error: Path does not exist or is not a directory: ${resolvedPath}`,
          timestamp: now,
        });
        setInput("");
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        return;
      }

      if (activeWizard.step === 6) {
        const nameInput = value.trim();
        const pendingPath = (activeWizard.data as any)?.pendingPath as string | undefined;
        const pendingIsSsh = !!(activeWizard.data as any)?.pendingIsSsh;

        if (!pendingPath) {
          addLine({
            type: "error",
            content: "Error: lost pending workspace path. Please retry /workspace.",
            timestamp: now,
          });
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          return;
        }

        // Empty name is allowed (falls back to default basename in DB).
        const wsName = nameInput;

        try {
          const { addTrustedDirectory } = await import("../core/config/jsonConfig.js");
          const { workspaceMode } = await import("../core/ssh/workspaceMode.js");
          const { sshProxy } = await import("../core/ssh/sshProxy.js");
          addTrustedDirectory(pendingPath, wsName || undefined);

          if (pendingIsSsh) {
            const sshConfig = workspaceMode.parseSshTarget(pendingPath);
            if (sshConfig) {
              await sshProxy.disconnect();
              workspaceMode.setSshMode(sshConfig);
              try {
                await sshProxy.connect(sshConfig);
              } catch (connErr: any) {
                workspaceMode.setLocalMode();
                addLine({ type: "error", content: `SSH connect failed: ${connErr?.message || connErr}`, timestamp: Date.now() });
                return;
              }
            }
          } else {
            await sshProxy.disconnect();
            workspaceMode.setLocalMode();
          }

          if (setWorkingDirectory) {
            setWorkingDirectory(pendingPath);
          } else {
            if (!pendingIsSsh) process.chdir(pendingPath);
            if (agentRef.current) agentRef.current.workingDirectory = pendingPath;
          }

          if (agentRef.current) {
            agentRef.current.resetInternalState();
            try {
              await agentRef.current.clearHistory();
            } catch (err: any) {
              addLine({
                type: "error",
                content: `Warning: failed to clear history (${err?.message ?? err}); continuing with workspace switch.`,
                timestamp: now,
              });
            }
            agentRef.current.planState = "IDLE";
            agentRef.current.goalMode = null;
          }
          if (setPlanState) setPlanState("IDLE");
          if (clearLines) clearLines();

          const displayName = wsName || pendingPath;
          const kindLabel = pendingIsSsh ? "🔌 SSH workspace" : "📁 Workspace";
          addLine({
            type: "system",
            content: `${kindLabel} added: ${displayName}\nPath: ${pendingPath}\nStarted a new chat session.`,
            timestamp: now,
          });
        } catch (err: any) {
          addLine({
            type: "error",
            content: `Failed to add workspace: ${err?.message ?? err}`,
            timestamp: now,
          });
        }

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (activeWizard.step === 4) {
        let targetWs = "";
        const removePaths: string[] = Array.isArray(activeWizard.data?.removePaths) ? activeWizard.data.removePaths : [];
        const match = removePaths.find(p => value.includes(p));
        if (match) {
          targetWs = match;
        } else {
          targetWs = value.replace(/^📁\s*/, "").replace(/\s*\(active\)$/i, "").trim();
          if (targetWs.startsWith("[")) {
            const bracketEnd = targetWs.indexOf("]");
            if (bracketEnd !== -1) {
              targetWs = targetWs.substring(bracketEnd + 1).trim();
            }
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

      if (activeWizard.step === 7) {
        if (value === "❌ Back" || value.endsWith("Back")) {
          setActiveWizard({ type: "workspace", step: 1, data: {} });
          setWizardOptions([
            "📁 Select & Switch Workspace...",
            "➕ Add a new workspace...",
            "🗑️ Remove a workspace...",
            "📊 View workspace status",
            "🔗 Manage workspace chains...",
            "❌ Exit Wizard",
          ]);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }
        if (value === "➕ Create new workspace chain...") {
          setActiveWizard({
            type: "workspace",
            step: 9,
            data: {},
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }
        const chainIds: string[] = Array.isArray(activeWizard.data?.chainIds) ? activeWizard.data.chainIds : [];
        const selectedChainId = chainIds.find(id => value.includes(id));
        if (selectedChainId) {
          const { getWorkspaceChain } = await import("../core/workspace/WorkspaceChainConfig.js");
          const chain = getWorkspaceChain(selectedChainId);
          if (chain) {
            setActiveWizard({
              type: "workspace",
              step: 8,
              data: { chainId: chain.id, chainName: chain.name },
            });
            setWizardOptions([
              "⚡ Activate Chain",
              "📊 View Topology",
              "✏️ Edit Chain Name",
              "➕ Add Node to Chain...",
              "🗑️ Remove Node from Chain...",
              "🗑️ Delete Chain",
              "❌ Back",
            ]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (activeWizard.step === 8) {
        const chainId = activeWizard.data?.chainId;
        const chainName = activeWizard.data?.chainName || chainId;
        const openChainsList = async () => {
          const { workspaceMode } = await import("../core/ssh/workspaceMode.js");
          const sshCfg = workspaceMode.getConfig();
          const currentWorkspace = workspaceMode.isSsh() && sshCfg
            ? `${sshCfg.username}@${sshCfg.host}:${sshCfg.port}${sshCfg.remoteCwd}`
            : path.resolve(agentRef.current?.workingDirectory || process.cwd());

          const { options, chainIds } = await getSortedChainOptions(currentWorkspace);
          setActiveWizard({
            type: "workspace",
            step: 7,
            data: { chainIds },
          });
          setWizardOptions(options);
          setWizardSelectedIndex(0);
          setInput("");
        };

        const openSelectedMenu = (cId: string, cName: string) => {
          setActiveWizard({
            type: "workspace",
            step: 8,
            data: { chainId: cId, chainName: cName },
          });
          setWizardOptions([
            "⚡ Activate Chain",
            "📊 View Topology",
            "✏️ Edit Chain Name",
            "➕ Add Node to Chain...",
            "🗑️ Remove Node from Chain...",
            "🗑️ Delete Chain",
            "❌ Back",
          ]);
          setWizardSelectedIndex(0);
          setInput("");
        };

        if (!chainId || value === "❌ Back" || value.endsWith("Back")) {
          await openChainsList();
          return;
        }

        if (value === "⚡ Activate Chain") {
          const { workspaceChainManager } = await import("../core/workspace/WorkspaceChainManager.js");
          const { formatChainTopology } = await import("../core/workspace/WorkspaceChainTypes.js");
          try {
            const chain = await workspaceChainManager.activateChain(chainId);
            const topology = formatChainTopology(chain);
            addLine({
              type: "system",
              content: `🔗 Workspace Chain Activated: ${chain.name} (${chain.id})\n\n${topology}`,
              timestamp: now,
            });
          } catch (err: any) {
            addLine({
              type: "error",
              content: `Failed to activate workspace chain: ${err?.message ?? err}`,
              timestamp: now,
            });
          }
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        if (value === "📊 View Topology") {
          const { getWorkspaceChain } = await import("../core/workspace/WorkspaceChainConfig.js");
          const { formatChainTopology } = await import("../core/workspace/WorkspaceChainTypes.js");
          const chain = getWorkspaceChain(chainId);
          if (chain) {
            const topology = formatChainTopology(chain);
            addLine({
              type: "system",
              content: `🔗 Workspace Chain Topology (${chain.name} / ${chain.id}):\n\n${topology}`,
              timestamp: now,
            });
          }
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        if (value === "✏️ Edit Chain Name") {
          setActiveWizard({
            type: "workspace",
            step: 10,
            data: { chainId, chainName },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setInput(chainName);
          return;
        }

        if (value === "➕ Add Node to Chain...") {
          const { getTrustedDirectories } = await import("../core/config/jsonConfig.js");
          const { getWorkspacesFromDb } = await import("../core/storage/historyDb.js");
          const trustedDirs = getTrustedDirectories();
          const dbWorkspaces = getWorkspacesFromDb();
          const currentCwd = agentRef.current?.workingDirectory || process.cwd();
          
          const options = trustedDirs.map(dir => {
            const dbWs = dbWorkspaces.find(ws => ws.path === dir);
            const namePart = dbWs?.name ? ` [${dbWs.name}]` : "";
            const isCurrent = dir === currentCwd;
            const currentBadge = isCurrent ? " (Current)" : "";
            const cleanDir = dir.startsWith("ssh:") ? dir : path.basename(dir) || dir;
            return `📁${namePart} ${cleanDir}${currentBadge}`;
          });
          options.push("➕ Type a custom path or SSH target...");
          options.push("❌ Back");

          setActiveWizard({
            type: "workspace",
            step: 11,
            data: { 
              chainId, 
              chainName,
              trustedPaths: JSON.stringify(trustedDirs)
            },
          });
          setWizardOptions(options);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        if (value === "🗑️ Remove Node from Chain...") {
          const { getWorkspaceChain } = await import("../core/workspace/WorkspaceChainConfig.js");
          const chain = getWorkspaceChain(chainId);
          if (!chain || chain.nodes.length === 0) {
            addLine({ type: "system", content: "No nodes in chain to remove.", timestamp: now });
            openSelectedMenu(chainId, chainName);
            return;
          }
          const nodeOptions = chain.nodes.map(n => {
            const badge = n.id === chain.primaryNodeId ? " [PRIMARY]" : "";
            return `🖥️ ${n.label} (${n.id}) [${n.type}/${n.role}]${badge}`;
          });
          nodeOptions.push("❌ Back");
          setActiveWizard({
            type: "workspace",
            step: 13,
            data: { chainId, chainName, nodeIds: chain.nodes.map(n => n.id) },
          });
          setWizardOptions(nodeOptions);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        if (value === "🗑️ Delete Chain") {
          setActiveWizard({
            type: "workspace",
            step: 14,
            data: { chainId, chainName },
          });
          setWizardOptions(["Yes, delete chain", "No, cancel"]);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }
      }

      if (activeWizard.step === 9) {
        const nameInput = value.trim();
        const openChainsList = async () => {
          const { workspaceMode } = await import("../core/ssh/workspaceMode.js");
          const sshCfg = workspaceMode.getConfig();
          const currentWorkspace = workspaceMode.isSsh() && sshCfg
            ? `${sshCfg.username}@${sshCfg.host}:${sshCfg.port}${sshCfg.remoteCwd}`
            : path.resolve(agentRef.current?.workingDirectory || process.cwd());

          const { options, chainIds } = await getSortedChainOptions(currentWorkspace);
          setActiveWizard({
            type: "workspace",
            step: 7,
            data: { chainIds },
          });
          setWizardOptions(options);
          setWizardSelectedIndex(0);
          setInput("");
        };

        if (!nameInput) {
          addLine({ type: "system", content: "Workspace chain creation cancelled.", timestamp: now });
          await openChainsList();
          return;
        }
        const { createWorkspaceChain } = await import("../core/workspace/WorkspaceChainConfig.js");
        const { generateNodeId } = await import("../core/workspace/WorkspaceChainTypes.js");
        const { workspaceMode } = await import("../core/ssh/workspaceMode.js");
        const sshCfg = workspaceMode.getConfig();
        const isSsh = workspaceMode.isSsh() && !!sshCfg;
        const currentCwd = agentRef.current?.workingDirectory || process.cwd();
        const primaryLabel = path.basename(currentCwd) || "main";
        const primaryNodeId = generateNodeId(primaryLabel);

        const primaryNode = isSsh
          ? {
              id: primaryNodeId,
              label: primaryLabel,
              type: "ssh" as const,
              role: "main" as const,
              sshConfig: {
                host: sshCfg.host,
                port: sshCfg.port,
                username: sshCfg.username,
                remoteCwd: sshCfg.remoteCwd,
              },
            }
          : {
              id: primaryNodeId,
              label: primaryLabel,
              type: "local" as const,
              role: "main" as const,
              path: currentCwd,
            };

        const openSelectedMenu = (cId: string, cName: string) => {
          setActiveWizard({
            type: "workspace",
            step: 8,
            data: { chainId: cId, chainName: cName },
          });
          setWizardOptions([
            "⚡ Activate Chain",
            "📊 View Topology",
            "✏️ Edit Chain Name",
            "➕ Add Node to Chain...",
            "🗑️ Remove Node from Chain...",
            "🗑️ Delete Chain",
            "❌ Back",
          ]);
          setWizardSelectedIndex(0);
          setInput("");
        };

        try {
          const chain = createWorkspaceChain(nameInput, "Created via workspace wizard", [primaryNode], primaryNodeId);
          addLine({
            type: "system",
            content: `✅ Workspace chain created: ${chain.name} (${chain.id})\nPrimary Node: ${primaryLabel}`,
            timestamp: now,
          });
          openSelectedMenu(chain.id, chain.name);
          return;
        } catch (err: any) {
          addLine({
            type: "error",
            content: `Failed to create workspace chain: ${err?.message ?? err}`,
            timestamp: now,
          });
          await openChainsList();
        }
        return;
      }

      if (activeWizard.step === 10) {
        const chainId = activeWizard.data?.chainId;
        const newName = value.trim();
        const openSelectedMenu = (cId: string, cName: string) => {
          setActiveWizard({
            type: "workspace",
            step: 8,
            data: { chainId: cId, chainName: cName },
          });
          setWizardOptions([
            "⚡ Activate Chain",
            "📊 View Topology",
            "✏️ Edit Chain Name",
            "➕ Add Node to Chain...",
            "🗑️ Remove Node from Chain...",
            "🗑️ Delete Chain",
            "❌ Back",
          ]);
          setWizardSelectedIndex(0);
          setInput("");
        };

        if (chainId && newName) {
          const { updateWorkspaceChain } = await import("../core/workspace/WorkspaceChainConfig.js");
          try {
            updateWorkspaceChain(chainId, { name: newName });
            addLine({ type: "system", content: `✏️ Updated workspace chain name to: ${newName}`, timestamp: now });
            openSelectedMenu(chainId, newName);
            return;
          } catch (err: any) {
            addLine({ type: "error", content: `Failed to rename chain: ${err?.message ?? err}`, timestamp: now });
          }
        }
        openSelectedMenu(chainId, activeWizard.data?.chainName || chainId);
        return;
      }

      if (activeWizard.step === 11) {
        const chainId = activeWizard.data?.chainId;
        const chainName = activeWizard.data?.chainName;
        const openSelectedMenu = (cId: string, cName: string) => {
          setActiveWizard({
            type: "workspace",
            step: 8,
            data: { chainId: cId, chainName: cName },
          });
          setWizardOptions([
            "⚡ Activate Chain",
            "📊 View Topology",
            "✏️ Edit Chain Name",
            "➕ Add Node to Chain...",
            "🗑️ Remove Node from Chain...",
            "🗑️ Delete Chain",
            "❌ Back",
          ]);
          setWizardSelectedIndex(0);
          setInput("");
        };

        if (value === "❌ Back" || value.endsWith("Back")) {
          openSelectedMenu(chainId, chainName);
          return;
        }

        if (value === "➕ Type a custom path or SSH target...") {
          setActiveWizard({
            type: "workspace",
            step: 15,
            data: { ...activeWizard.data },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        const trustedPaths: string[] = JSON.parse(activeWizard.data?.trustedPaths || "[]");
        const idx = wizardOptions.indexOf(value);
        const selectedPath = trustedPaths[idx];

        if (!chainId || !selectedPath) {
          addLine({ type: "system", content: "Add node cancelled.", timestamp: now });
          openSelectedMenu(chainId, chainName);
          return;
        }

        setActiveWizard({
          type: "workspace",
          step: 12,
          data: { ...activeWizard.data, pendingTarget: selectedPath },
        });
        setWizardOptions(["main", "backend", "frontend", "worker", "service", "module"]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (activeWizard.step === 15) {
        const chainId = activeWizard.data?.chainId;
        const chainName = activeWizard.data?.chainName;
        const openSelectedMenu = (cId: string, cName: string) => {
          setActiveWizard({
            type: "workspace",
            step: 8,
            data: { chainId: cId, chainName: cName },
          });
          setWizardOptions([
            "⚡ Activate Chain",
            "📊 View Topology",
            "✏️ Edit Chain Name",
            "➕ Add Node to Chain...",
            "🗑️ Remove Node from Chain...",
            "🗑️ Delete Chain",
            "❌ Back",
          ]);
          setWizardSelectedIndex(0);
          setInput("");
        };

        const targetInput = value.trim();
        if (value === "❌ Back" || value.endsWith("Back") || !targetInput) {
          const { getTrustedDirectories } = await import("../core/config/jsonConfig.js");
          const { getWorkspacesFromDb } = await import("../core/storage/historyDb.js");
          const trustedDirs = getTrustedDirectories();
          const dbWorkspaces = getWorkspacesFromDb();
          const currentCwd = agentRef.current?.workingDirectory || process.cwd();
          
          const options = trustedDirs.map(dir => {
            const dbWs = dbWorkspaces.find(ws => ws.path === dir);
            const namePart = dbWs?.name ? ` [${dbWs.name}]` : "";
            const isCurrent = dir === currentCwd;
            const currentBadge = isCurrent ? " (Current)" : "";
            const cleanDir = dir.startsWith("ssh:") ? dir : path.basename(dir) || dir;
            return `📁${namePart} ${cleanDir}${currentBadge}`;
          });
          options.push("➕ Type a custom path or SSH target...");
          options.push("❌ Back");

          setActiveWizard({
            type: "workspace",
            step: 11,
            data: { ...activeWizard.data },
          });
          setWizardOptions(options);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        setActiveWizard({
          type: "workspace",
          step: 12,
          data: { ...activeWizard.data, pendingTarget: targetInput },
        });
        setWizardOptions(["main", "backend", "frontend", "worker", "service", "module"]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (activeWizard.step === 12) {
        const chainId = activeWizard.data?.chainId;
        const pendingTarget = activeWizard.data?.pendingTarget;
        const role = (value.trim() as any) || "module";
        const openSelectedMenu = (cId: string, cName: string) => {
          setActiveWizard({
            type: "workspace",
            step: 8,
            data: { chainId: cId, chainName: cName },
          });
          setWizardOptions([
            "⚡ Activate Chain",
            "📊 View Topology",
            "✏️ Edit Chain Name",
            "➕ Add Node to Chain...",
            "🗑️ Remove Node from Chain...",
            "🗑️ Delete Chain",
            "❌ Back",
          ]);
          setWizardSelectedIndex(0);
          setInput("");
        };

        if (value === "❌ Back" || value.endsWith("Back")) {
          const { getTrustedDirectories } = await import("../core/config/jsonConfig.js");
          const { getWorkspacesFromDb } = await import("../core/storage/historyDb.js");
          const trustedDirs = getTrustedDirectories();
          const dbWorkspaces = getWorkspacesFromDb();
          const currentCwd = agentRef.current?.workingDirectory || process.cwd();
          
          const options = trustedDirs.map(dir => {
            const dbWs = dbWorkspaces.find(ws => ws.path === dir);
            const namePart = dbWs?.name ? ` [${dbWs.name}]` : "";
            const isCurrent = dir === currentCwd;
            const currentBadge = isCurrent ? " (Current)" : "";
            const cleanDir = dir.startsWith("ssh:") ? dir : path.basename(dir) || dir;
            return `📁${namePart} ${cleanDir}${currentBadge}`;
          });
          options.push("➕ Type a custom path or SSH target...");
          options.push("❌ Back");

          setActiveWizard({
            type: "workspace",
            step: 11,
            data: { ...activeWizard.data },
          });
          setWizardOptions(options);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        if (!chainId || !pendingTarget) {
          openSelectedMenu(chainId, activeWizard.data?.chainName || chainId);
          return;
        }

        setActiveWizard({
          type: "workspace",
          step: 16,
          data: { ...activeWizard.data, pendingRole: role },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (activeWizard.step === 16) {
        const chainId = activeWizard.data?.chainId;
        const pendingTarget = activeWizard.data?.pendingTarget;
        const role = activeWizard.data?.pendingRole || "module";
        const description = value.trim();

        const openSelectedMenu = (cId: string, cName: string) => {
          setActiveWizard({
            type: "workspace",
            step: 8,
            data: { chainId: cId, chainName: cName },
          });
          setWizardOptions([
            "⚡ Activate Chain",
            "📊 View Topology",
            "✏️ Edit Chain Name",
            "➕ Add Node to Chain...",
            "🗑️ Remove Node from Chain...",
            "🗑️ Delete Chain",
            "❌ Back",
          ]);
          setWizardSelectedIndex(0);
          setInput("");
        };

        if (value === "❌ Back" || value.endsWith("Back")) {
          setActiveWizard({
            type: "workspace",
            step: 12,
            data: { ...activeWizard.data },
          });
          setWizardOptions(["main", "backend", "frontend", "worker", "service", "module"]);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }

        if (!chainId || !pendingTarget) {
          openSelectedMenu(chainId, activeWizard.data?.chainName || chainId);
          return;
        }

        const { addNodeToChain } = await import("../core/workspace/WorkspaceChainConfig.js");
        const { generateNodeId } = await import("../core/workspace/WorkspaceChainTypes.js");
        const { workspaceMode } = await import("../core/ssh/workspaceMode.js");

        const isSsh = pendingTarget.startsWith("ssh:") || (pendingTarget.includes("@") && (pendingTarget.includes(":/") || pendingTarget.includes(":")));
        const label = path.basename(pendingTarget) || "node";
        const nodeId = generateNodeId(label);

        let node: any;
        if (isSsh) {
          const parsed = workspaceMode.parseSshTarget(pendingTarget);
          if (!parsed) {
            addLine({ type: "error", content: `Invalid SSH target: ${pendingTarget}`, timestamp: now });
            openSelectedMenu(chainId, activeWizard.data?.chainName || chainId);
            return;
          }
          node = {
            id: nodeId,
            label,
            type: "ssh",
            role,
            sshConfig: {
              host: parsed.host,
              port: parsed.port,
              username: parsed.username,
              remoteCwd: parsed.remoteCwd,
            },
            description: description || undefined,
          };
        } else {
          const resolvedPath = path.resolve(agentRef.current?.workingDirectory || process.cwd(), pendingTarget);
          node = {
            id: nodeId,
            label,
            type: "local",
            role,
            path: resolvedPath,
            description: description || undefined,
          };
        }

        try {
          addNodeToChain(chainId, node);
          addLine({ type: "system", content: `➕ Added node "${label}" (${role}) to chain.`, timestamp: now });
        } catch (err: any) {
          addLine({ type: "error", content: `Failed to add node: ${err?.message ?? err}`, timestamp: now });
        }
        openSelectedMenu(chainId, activeWizard.data?.chainName || chainId);
        return;
      }

      if (activeWizard.step === 13) {
        const chainId = activeWizard.data?.chainId;
        const openSelectedMenu = (cId: string, cName: string) => {
          setActiveWizard({
            type: "workspace",
            step: 8,
            data: { chainId: cId, chainName: cName },
          });
          setWizardOptions([
            "⚡ Activate Chain",
            "📊 View Topology",
            "✏️ Edit Chain Name",
            "➕ Add Node to Chain...",
            "🗑️ Remove Node from Chain...",
            "🗑️ Delete Chain",
            "❌ Back",
          ]);
          setWizardSelectedIndex(0);
          setInput("");
        };

        if (value === "❌ Back" || value.endsWith("Back") || !chainId) {
          openSelectedMenu(chainId, activeWizard.data?.chainName || chainId);
          return;
        }
        const nodeIds: string[] = Array.isArray(activeWizard.data?.nodeIds) ? activeWizard.data.nodeIds : [];
        const selectedNodeId = nodeIds.find(id => value.includes(id));
        if (selectedNodeId) {
          const { removeNodeFromChain } = await import("../core/workspace/WorkspaceChainConfig.js");
          try {
            removeNodeFromChain(chainId, selectedNodeId);
            addLine({ type: "system", content: `🗑️ Removed node "${selectedNodeId}" from workspace chain.`, timestamp: now });
          } catch (err: any) {
            addLine({ type: "error", content: `Failed to remove node: ${err?.message ?? err}`, timestamp: now });
          }
        }
        openSelectedMenu(chainId, activeWizard.data?.chainName || chainId);
        return;
      }

      if (activeWizard.step === 14) {
        const chainId = activeWizard.data?.chainId;
        const openChainsList = async () => {
          const { workspaceMode } = await import("../core/ssh/workspaceMode.js");
          const sshCfg = workspaceMode.getConfig();
          const currentWorkspace = workspaceMode.isSsh() && sshCfg
            ? `${sshCfg.username}@${sshCfg.host}:${sshCfg.port}${sshCfg.remoteCwd}`
            : path.resolve(agentRef.current?.workingDirectory || process.cwd());

          const { options, chainIds } = await getSortedChainOptions(currentWorkspace);
          setActiveWizard({
            type: "workspace",
            step: 7,
            data: { chainIds },
          });
          setWizardOptions(options);
          setWizardSelectedIndex(0);
          setInput("");
        };

        const openSelectedMenu = (cId: string, cName: string) => {
          setActiveWizard({
            type: "workspace",
            step: 8,
            data: { chainId: cId, chainName: cName },
          });
          setWizardOptions([
            "⚡ Activate Chain",
            "📊 View Topology",
            "✏️ Edit Chain Name",
            "➕ Add Node to Chain...",
            "🗑️ Remove Node from Chain...",
            "🗑️ Delete Chain",
            "❌ Back",
          ]);
          setWizardSelectedIndex(0);
          setInput("");
        };

        if (value === "Yes, delete chain" && chainId) {
          const { deleteWorkspaceChain } = await import("../core/workspace/WorkspaceChainConfig.js");
          const { workspaceChainManager } = await import("../core/workspace/WorkspaceChainManager.js");
          try {
            if (workspaceChainManager.getActiveChain()?.id === chainId) {
              await workspaceChainManager.deactivateChain();
            }
            deleteWorkspaceChain(chainId);
            addLine({ type: "system", content: `🗑️ Deleted workspace chain: ${chainId}`, timestamp: now });
          } catch (err: any) {
            addLine({ type: "error", content: `Failed to delete chain: ${err?.message ?? err}`, timestamp: now });
          }
          await openChainsList();
          return;
        }
        addLine({ type: "system", content: "Cancelled chain deletion.", timestamp: now });
        openSelectedMenu(chainId, activeWizard.data?.chainName || chainId);
        return;
      }

      if (activeWizard.step === 5) {
        if (value === "Yes, remove this workspace" && activeWizard.data.targetWorkspace) {
          const targetWs = activeWizard.data.targetWorkspace;
          const { removeTrustedDirectory } = await import("../core/config/jsonConfig.js");
          try {
            removeTrustedDirectory(targetWs);
            addLine({
              type: "system",
              content: `🗑️ Successfully removed workspace from trusted list: ${targetWs}`,
              timestamp: now,
            });
          } catch (err) {
            addLine({
              type: "error",
              content: `🗑️ Failed to remove workspace: ${err instanceof Error ? err.message : String(err)}`,
              timestamp: now,
            });
          }
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
        const isPassword = pendingQuestion?.inputType === "password";
        const displayValue = isPassword ? "•".repeat(String(value).length) : value;
        addLine({
          type: "system",
          content: `❓ Answered: "${displayValue}"`,
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
        const isPassword2 = pendingQuestion?.inputType === "password";
        const displayValue2 = isPassword2 ? "•".repeat(String(value).length) : value;
        addLine({
          type: "system",
          content: `❓ Answered: "${displayValue2}"`,
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
