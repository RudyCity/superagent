import fs from "fs";
import path from "path";
import { type CoreMessage } from "ai";
import { getSettings, getContextWindowLimit, getModelConnectionDetailsForTier, loadAgentSkills, getConfig } from "../config.js";
import { getCurrentSkillQuery, getModeGuidance, getToolDiscoveryGuidance, getExecutionGuidance, shouldIncludePlanningContext } from "./SystemPromptPolicy.js";
// NOTE: `backgroundTasks` and `isTaskInWorkspace` are imported
// DYNAMICALLY inside `buildContext` to break the circular dependency cycle:
//   tools/index.ts → subagentTools.ts → agent.ts → ContextBuilder.ts → tools.js
// A static import here would cause `toolsets.ts` to receive a partial module
// snapshot during evaluation, leaving `manageSubagentsTool` / `defineSubagentTool`
// in TDZ and crashing the `masterToolset.map((t) => t.name)` runtime allowlist.
import { isRmemoryActive } from "../rmemoryUtil.js";
import { redactMemorySecrets } from "../memoryLifecycle.js";
import { HistoryCompactor } from "./HistoryCompactor.js";
import { buildBudgetedPromptContext } from "./PromptContextBudget.js";
import { getAgentActiveModelName } from "./AgentUtils.js";
import type { Agent } from "../agent.js";

export class ContextBuilder {
  public static async buildContext(
    agent: Agent,
    signal?: AbortSignal
  ): Promise<{
    finalSystemPrompt: string;
    messages: CoreMessage[];
    toolDefs: any[];
    filteredToolDefs: any[];
    supportsNativeTools: boolean;
    dynamicContext: string;
  }> {
    // Dynamic import to break circular dep (see import note above). Loading
    // `../tools.js` synchronously here would deadlock during module init.
    const { backgroundTasks, isTaskInWorkspace } = await import("../tools.js");

    const isGoalMode = !!agent.goalMode;
    const category = agent.currentClassification?.category || "complex_task";
    let baseSystemPrompt = (agent as any).customSystemPrompt || (agent as any).config.systemPrompt || "";

    const allMessages = agent.conversation.getMessages();
    const queryStr = getCurrentSkillQuery(allMessages);

    const guidelinesText = (agent as any).buildGuidelinesText(queryStr);

    if (!baseSystemPrompt.includes("INSTALLED AGENT SKILLS:")) {
      const skillsPrompt = loadAgentSkills(agent.subagentType, agent.tier, queryStr, agent.isMultiAgent);
      if (skillsPrompt) {
        baseSystemPrompt += "\n\n" + skillsPrompt;
      }
    }

    if (baseSystemPrompt.includes("INSTALLED AGENT SKILLS:")) {
      baseSystemPrompt = (agent as any).markPreloadedSkillsInList(baseSystemPrompt);
    }

    let scratchpadText = "";
    if (category !== "conversation") {
      try {
        const scratchpadPath = path.resolve(agent.workingDirectory, "scratch", "scratchpad.md");
        if (fs.existsSync(scratchpadPath)) {
          scratchpadText = fs.readFileSync(scratchpadPath, "utf-8");
        }
      } catch {}
    }

    const goalModeAddendum = isGoalMode ? String.fromCharCode(10) + 'GOAL: ' + agent.goalMode : "";

    try {
      await (agent as any).prepopulateRmemoryContext();
    } catch (err: any) {
      agent.writeToLogFile("WARN", `Failed to prepopulate RMemory Memory context: ${err.message}`);
    }


    await agent.compactHistoryIfNeeded(signal);

    let supportsNativeTools = true;
    const details = getModelConnectionDetailsForTier(agent.tier, agent.delegationDepth, agent.subagentType, !agent.isMultiAgent);
    if (getSettings().forcePromptBasedToolCalling) {
      supportsNativeTools = false;
    } else {
      const isTest = !!process.env.VITEST;
      if (!isTest && details.provider === "custom" && details.baseUrl) {
        try {
          const { probeToolCallSupport } = await import("../../utils/promptBasedToolCalling.js");
          supportsNativeTools = await probeToolCallSupport(details.baseUrl, details.apiKey, details.modelName);
        } catch (err: any) {
          agent.writeToLogFile("WARN", `Failed to probe tool call support: ${err.message}. Defaulting to native tools.`);
        }
      }
    }

    let messages = (agent as any).buildMessages(supportsNativeTools);
    const authorizedTools = await agent.getActiveTools();
    const toolsToUse = await agent.getModelVisibleTools(authorizedTools);
    const authorizedToolDefs = authorizedTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    const toolDefs = toolsToUse.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    let filteredToolDefs = toolDefs;
    if (agent.currentClassification) {
      try {
        const isUnlockedMode = agent.activeModeOverride === "implement" || agent.activeModeOverride === "debug";
        const shouldBypassFilter = isUnlockedMode || agent.planState !== "IDLE" || agent.tier === "subagent" || agent.tier === "superagent" || agent.tier === "master";
        if (!shouldBypassFilter) {
          const { getToolsetForCategory } = await import("../requestClassifier.js");
          const filteredTools = getToolsetForCategory(agent.currentClassification.category, toolsToUse);
          const discoveryNames = new Set(["list_tools", "describe_tool"]);
          const discoveryTools = toolsToUse.filter((tool) => discoveryNames.has(tool.name));
          const modelVisibleFilteredTools = [
            ...discoveryTools,
            ...toolsToUse.filter((tool) =>
              !discoveryNames.has(tool.name) &&
              (filteredTools.some((ft: any) => ft.name === tool.name) ||
               (typeof agent.isToolDiscovered === "function" && agent.isToolDiscovered(tool.name)))
            ),
          ];
          if (modelVisibleFilteredTools.length !== toolsToUse.length || filteredTools.length !== toolsToUse.length) {
            filteredToolDefs = modelVisibleFilteredTools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            }));
          }
        }
      } catch {}
    }

    const fileStatus = (filePath: string): string =>
      fs.existsSync(filePath) ? "[EXISTS]" : "[NOT YET CREATED]";

    let planStateNotice = "";
    if (agent.tier === "master" || agent.tier === "single" || agent.tier === "superagent") {
      const planPath = agent.getPlanFilePath();
      const taskPath = agent.getTaskFilePath();
      const taskHistoryPath = agent.getTaskHistoryFilePath();
      const walkthroughPath = agent.getWalkthroughFilePath();
      const isMasterOrSingle = agent.tier === "master" || agent.tier === "single";
      const planToolRule = isMasterOrSingle
        ? `- PLAN_MANAGEMENT: Use manage_plan (create|edit|sync) for Implementation Plan; manage_tasks for checklist. ALWAYS mark active tasks in-progress ('/') and completed ('x') via manage_tasks(action:'update') in real-time as work proceeds.`
        : `- TASK_MANAGEMENT: Use manage_tasks for checklist. ALWAYS mark active tasks in-progress ('/') and completed ('x') via manage_tasks(action:'update') in real-time as work proceeds.`;
      planStateNotice = `\n\n# PLANNING & VERIFICATION FILES\n- Plan: ${planPath} ${fileStatus(planPath)}\n- Tasks: ${taskPath} ${fileStatus(taskPath)}\n- History: ${taskHistoryPath} ${fileStatus(taskHistoryPath)}\n- Walkthrough: ${walkthroughPath} ${fileStatus(walkthroughPath)}\n\n# RULES\n${planToolRule}\n- Direct file write edits to Plan/Task files BLOCKED.\n- Walkthrough: use write_to_file.\n- Always use absolute paths.`;
    }

    let planStateAddendum = "";
    if (agent.planState === "PLANNING_PENDING") {
      planStateAddendum = `\n\n# PLAN STATE: PENDING_APPROVAL\nPlan written to '${agent.getPlanFilePath()}'. Status: READ-ONLY.\n- Code/file modifications BLOCKED.\n- Mutating terminal commands BLOCKED.\n- Explain proposed plan and await user approval.`;
    } else if (agent.planState === "APPROVED" && typeof (agent as any).hasRealPlanContent === "function" && (agent as any).hasRealPlanContent()) {
      planStateAddendum = `\n\n# PLAN STATE: APPROVED\nPlan APPROVED by user. File modification and command execution AUTHORIZED.`;
    }

    let followUpTaskAddendum = "";
    if ((agent as any).tasksJustArchived) {
      followUpTaskAddendum = `\n\n# TASK RESET: ${(agent as any).archivedTaskCount} tasks archived. Use 'manage_tasks' (add/add_bulk) or 'manage_plan' (create) for new tasks.`;
      (agent as any).tasksJustArchived = false;
    }

    const workspacePath = agent.workingDirectory || process.cwd();
    const runningProcesses = Array.from(backgroundTasks.entries())
      .filter(([_, t]) => !t.hasExited && isTaskInWorkspace(t.cwd, workspacePath))
      .map(([id, t]) => `- Process ID: ${id}, Command: "${t.command}"`)
      .join("\n");
    const processNotice = runningProcesses
      ? `\n\n# RUNNING PROCESSES\n${runningProcesses}`
      : "";

    let pinnedKnowledgeNotice = "";
    try {
      const { getAllKnowledge, formatKnowledgeForPrompt } = await import("../pinnedKnowledge.js");
      const knowledgeEntries = getAllKnowledge({ limit: 10 });
      if (knowledgeEntries.length > 0) {
        pinnedKnowledgeNotice = "\n\n" + formatKnowledgeForPrompt(knowledgeEntries, 8, 1500);
      }
    } catch {}

    let activeSystemPrompt = baseSystemPrompt;
    if (agent.workspaceCache) {
      try {
        const { injectWorkspaceOverview } = await import("../workspaceDiscovery.js");
        activeSystemPrompt = injectWorkspaceOverview(baseSystemPrompt, agent.workspaceCache);
      } catch {}
    }

    if (!(await isRmemoryActive())) {
      activeSystemPrompt = activeSystemPrompt
        .replace(/'save_shared_memory' or 'rmemory_memory_save'/g, "'save_shared_memory'")
        .replace(/or 'rmemory_memory_save'/g, "")
        .replace(/, 'rmemory_memory_save'/g, "")
        .replace(/rmemory_[a-zA-Z0-9_]+/g, "");
    }

    try {
      const { workspaceChainManager } = await import("../workspace/WorkspaceChainManager.js");
      const workspaceDir = agent.worktreePath || agent.workingDirectory;
      if (!workspaceChainManager.isChainActive(workspaceDir)) {
        activeSystemPrompt = activeSystemPrompt
          .split("\n")
          .filter((line: string) => {
            const trimmed = line.trim();
            if (trimmed.startsWith("- WORKSPACE_CHAINS:") || trimmed.includes("manage_workspace_chain") || trimmed.includes("cross_workspace_exec")) {
              return false;
            }
            return true;
          })
          .join("\n");
      }
    } catch {}

    let devHookNotice = "";
    try {
      const { getActiveDevHookGlobal } = await import("../tools/state.js");
      const activeDevHook = getActiveDevHookGlobal();
      if (activeDevHook) {
        devHookNotice = `\n\n🛠️ HOOK FOCUS: "${activeDevHook}" — CWD is internal-hooks/${activeDevHook}/. Access files by name (e.g. "index.js"), NOT with "internal-hooks/${activeDevHook}/" prefix. Use "../../" for parent project files.`;
      }
    } catch {}

    let sharedMemoryNotice = "";
    if (category !== "conversation") {
      try {
        const { getRootConfigDir } = await import("../config/paths.js");
        const sharedMemPath = path.join(getRootConfigDir(), "shared-memory.json");
        if (fs.existsSync(sharedMemPath)) {
          const raw = fs.readFileSync(sharedMemPath, "utf-8");
          const memories = JSON.parse(raw);
          if (Array.isArray(memories) && memories.length > 0) {
            const currentWorkspace = path.resolve(agent.worktreePath || agent.workingDirectory || process.cwd());
            
            const globalMemories = memories
              .filter((m: any) => m.scope === "global")
              .slice(-10);

            const projectMemories = memories
              .filter((m: any) => {
                if (m.scope === "global") return false;
                if (!m.projectPath) return true;
                return path.resolve(m.projectPath) === currentWorkspace;
              })
              .slice(-15);

            const sections: string[] = [];
            if (globalMemories.length > 0) {
              const lines = globalMemories.map((m: any) => `- [${m.source}] ${m.key}: ${m.value}`).join("\n");
              sections.push(`### GLOBAL AGENT MEMORIES:\n${lines}`);
            }
            if (projectMemories.length > 0) {
              const lines = projectMemories.map((m: any) => `- [${m.source}] ${m.key}: ${m.value}`).join("\n");
              sections.push(`### PROJECT AGENT MEMORIES (this workspace):\n${lines}`);
            }

            if (sections.length > 0) {
              sharedMemoryNotice = `\n\n${sections.join("\n\n")}`;
            }
          }
        }
      } catch {}
    }

    const workspaceDir = agent.worktreePath || agent.workingDirectory;
    const workspaceBoundaryNotice = workspaceDir
      ? `\n\n# ACTIVE WORKSPACE: "${workspaceDir}"\n- ALL file operations MUST target paths inside this directory. NEVER write outside workspace root.`
      : "";

    // Workspace chain topology injection — lets AI understand cross-workspace relationships
    let workspaceChainNotice = "";
    const skipHeavyContext = category === "conversation" || category === "question";
    if (!skipHeavyContext) {
      try {
        const { workspaceChainManager } = await import("../workspace/WorkspaceChainManager.js");
        const chain = workspaceChainManager.getActiveChain(workspaceDir);
        if (chain) {
          const topology = workspaceChainManager.getTopologyString();
          const activeNode = workspaceChainManager.getActiveNode();
          const activeNodeInfo = activeNode
            ? `\n- ACTIVE NODE: ${activeNode.label} (${activeNode.id}) — type=${activeNode.type}, role=${activeNode.role}`
            : "";
          workspaceChainNotice = `\n\n# WORKSPACE CHAIN ACTIVE\n${topology}${activeNodeInfo}\n- **Execution**: If targeting the ACTIVE node (local or SSH), run standard tools (run_command, view_file, write_to_file, glob, grep, etc.) DIRECTLY. Standard tools automatically execute on the active node. Use 'cross_workspace_exec' (operation='exec') ONLY for executing on non-active/inactive nodes in the topology.\n- **Health & Metrics**: Use 'cross_workspace_exec' (operation='health') or 'manage_workspace_chain' (action='health') for real-time node latency, RAM, Disk, Uptime metrics.\n- **Cross-Node Diff**: Use 'cross_workspace_exec' (operation='diff', sourceNodeId, targetNodeId, filePath) to compare code/config across nodes.\n- **Cross-Node Sync**: Use 'cross_workspace_exec' (operation='sync', sourceNodeId, targetNodeId, filePath, targetPath?) to deploy/transfer files between nodes.\n- **Topology**: Use 'manage_workspace_chain' to manage graph nodes or switch active chain.`;
        }
      } catch {}
    }

    // Runtime capabilities come from the full authorized catalog, not from which
    // schemas have been discovered for the current model request.
    const hasShell = authorizedToolDefs.some((t: any) => t.name === "run_command" || t.name === "bash" || t.name === "run_background_process");
    const hasWrite = authorizedToolDefs.some((t: any) => t.name === "write_to_file" || t.name === "edit" || t.name === "replace_file_content" || t.name === "multi_replace_file_content" || t.name === "write" || t.name === "apply_patch");
    const hasNetwork = authorizedToolDefs.some((t: any) => t.name === "web_search" || t.name === "fetch_url");
    const hasSubagents = authorizedToolDefs.some((t: any) => t.name === "invoke_subagent" || t.name === "invoke_superagent");

    let verificationStatus = "blocked";
    if (hasShell) {
      verificationStatus = "runtime";
    } else if (hasWrite) {
      verificationStatus = "static-only";
    }

    let activeShellType = "unix-default";
    let shellSep = "&&";
    if (process.platform === "win32") {
      try {
        const { resolveWindowsShell } = await import("../tools/helpers.js");
        const shellInfo = resolveWindowsShell();
        activeShellType = shellInfo.isBash ? "git-bash" : "powershell";
        shellSep = shellInfo.isBash ? "&&" : ";";
      } catch {
        activeShellType = "powershell";
        shellSep = ";";
      }
    }

    const runtimeCapabilitiesText = `\n# RUNTIME\n- Workspace: ${workspaceDir || process.cwd()}\n- Shell: ${hasShell ? "enabled" : "disabled"} | Write: ${hasWrite ? "enabled" : "disabled"} | Network: ${hasNetwork ? "enabled" : "disabled"} | Subagents: ${hasSubagents ? "enabled" : "disabled"}\n- Verification: ${verificationStatus} | Platform: ${activeShellType} | Separator: ${shellSep}\n`;

    const lastUserMessage = messages.slice().reverse().find((m: any) => m.role === "user");
    const userInputText = lastUserMessage ? (typeof lastUserMessage.content === "string" ? lastUserMessage.content : "") : "";
    const lowerInput = userInputText.toLowerCase();

    let activeMode = "implement";
    if (agent.activeModeOverride) {
      activeMode = agent.activeModeOverride;
    } else {
      if (category === "conversation" || category === "question") {
        activeMode = "ask";
      } else if (category === "research") {
        activeMode = "research";
      } else if (category === "debug") {
        activeMode = "debug";
      } else if (category === "complex_task") {
        if (/plan|design|architecture/i.test(lowerInput)) {
          activeMode = "plan";
        } else {
          activeMode = "implement";
        }
      } else if (category === "simple_edit" || category === "command") {
        activeMode = "implement";
      }

      if (/review|audit|diff\b/i.test(lowerInput)) {
        activeMode = "review";
      }
    }

    const activeModeNotice = getModeGuidance(activeMode, authorizedToolDefs.some((t: any) => t.name === "switch_mode"));

    let toolRestrictionNotice = "";
    if (!hasShell) {
      toolRestrictionNotice = `\n\n⚠️ Terminal/shell execution DISABLED for this request. Do NOT use run_command or similar tools.`;
    }

    const defaultMax = getSettings().maxIterations === 0 ? Infinity : (getSettings().maxIterations || 500);
    const maxIterations = agent.goalMode ? agent.goalMaxIterations : defaultMax;
    const maxIterationsStr = maxIterations === Infinity ? "unlimited" : maxIterations.toString();
    const promptContextBudget = Math.max(1_000, getSettings().promptContextBudget ?? 8_000);
    const systemContextBudget = Math.round(promptContextBudget * 0.65);
    const dynamicContextBudget = promptContextBudget - systemContextBudget;

    // Load selfdev operational lessons for prompt injection (best-effort).
    let selfdevLessonsText = "";
    try {
      const { buildSelfDevInjectionBlock } = await import("../selfdev/selfdevAgent.js");
      selfdevLessonsText = await buildSelfDevInjectionBlock(agent.workingDirectory || process.cwd(), agent.sessionId);
    } catch {}

    // Check live status of remote services (/muse tunnel, MCP servers, Telegram)
    let remoteServicesNotice = "";
    try {
      const { getRemoteServiceStatus, formatDynamicRemoteNotice } = await import("../remoteAgent/remoteStatusService.js");
      const remoteStatus = await getRemoteServiceStatus();
      if (remoteStatus.anyActive) {
        const notice = formatDynamicRemoteNotice(remoteStatus);
        if (notice) {
          remoteServicesNotice = `\n\n${notice}`;
        }
      }
    } catch {}

    // Keep all recalled-memory tiers under one 2,500-character allowance,
    // accounting for the RMemory block already added to the conversation. Redact
    // each assembled tier at the final prompt boundary as well as at storage.
    const totalMemoryCharBudget = 2500;
    let remainingMemoryChars = Math.max(
      0,
      totalMemoryCharBudget - Math.min(
        totalMemoryCharBudget,
        Math.max(0, Math.trunc(Number((agent as any)._bootstrapRMemoryContextChars || 0))),
      ),
    );
    const capMemoryTier = (value: string, tierCap: number): string => {
      const redacted = redactMemorySecrets(String(value || ""));
      const limit = Math.max(0, Math.min(remainingMemoryChars, tierCap));
      if (!redacted || limit === 0) return "";
      const marker = "… [truncated]";
      let bounded = redacted;
      if (redacted.length > limit) {
        bounded = limit > marker.length
          ? redacted.slice(0, limit - marker.length) + marker
          : redacted.slice(0, limit);
      }
      remainingMemoryChars = Math.max(0, remainingMemoryChars - bounded.length);
      return bounded;
    };
    pinnedKnowledgeNotice = capMemoryTier(pinnedKnowledgeNotice, 900);
    sharedMemoryNotice = capMemoryTier(sharedMemoryNotice, 800);
    selfdevLessonsText = capMemoryTier(selfdevLessonsText, remainingMemoryChars);

    const budgetedSystemContext = buildBudgetedPromptContext([
      { id: "guidelines", content: guidelinesText, maxTokens: 3_200 },
      { id: "workspace-chain", content: workspaceChainNotice, maxTokens: 900 },
      { id: "pinned-knowledge", content: pinnedKnowledgeNotice, maxTokens: 700 },
      { id: "shared-memory", content: sharedMemoryNotice, maxTokens: 500 },
      { id: "running-processes", content: processNotice, maxTokens: 300 },
      { id: "remote-services", content: remoteServicesNotice, maxTokens: 400 },
      { id: "developer-hook", content: devHookNotice, maxTokens: 150 },
      { id: "selfdev-lessons", content: selfdevLessonsText, maxTokens: 400 },
    ], systemContextBudget);
    const toolDiscoveryInstruction = getToolDiscoveryGuidance(agent.tier, authorizedToolDefs.map((t: any) => t.name), activeMode);
    const executionDirective = getExecutionGuidance(maxIterationsStr, hasSubagents && !skipHeavyContext, isGoalMode);
    const systemPrompt = [activeSystemPrompt, toolRestrictionNotice, runtimeCapabilitiesText, activeModeNotice,
      toolDiscoveryInstruction, executionDirective, goalModeAddendum, budgetedSystemContext.text]
      .filter(Boolean).join("\n");
    const stepsRemaining = maxIterations === Infinity ? Infinity : (maxIterations - 1);
    const stepNotice = stepsRemaining <= 5
      ? `\n- Current Step: 1 of ${maxIterations} (WARNING: Only ${stepsRemaining} steps remaining!)`
      : "";

    let workspaceStateText = "";
    if (agent.tier !== "subagent") {
      try {
        const { buildWorkspaceStateBlock } = await import("../context/WorkspaceStateTracker.js");
        const { subagentInstances: saInstances } = await import("../tools/state.js");
        const subagentSummary = Array.from(saInstances.entries()).map(([id, inst]) => ({
          id,
          role: inst.role,
          typeName: inst.typeName,
          status: inst.status,
        }));
        const wsBlock = buildWorkspaceStateBlock({
          taskFilePath: agent.getTaskFilePath(),
          planFilePath: agent.getPlanFilePath(),
          cwd: agent.workingDirectory,
          tier: agent.tier as "master" | "single" | "superagent",
          subagentSummary,
        });
        workspaceStateText = wsBlock.text;
      } catch {}
    }

    let classifierSkipPlan = false;
    let classifierPromptAddendum = "";
    if (agent.currentClassification) {
      try {
        const { shouldSkipPlanInjection, getClassificationPromptAddendum, getCategoryPromptAddendum } = await import("../requestClassifier.js");
        const category = agent.currentClassification.category;
        const isDestructive = !!agent.currentClassification.isDestructive;
        const shouldBypassFilter = agent.planState !== "IDLE" || agent.tier === "subagent" || agent.tier === "superagent" || agent.tier === "master";
        // Never skip plan injection if destructive safety guardrail is active
        classifierSkipPlan = !isDestructive && shouldSkipPlanInjection(category) && !shouldBypassFilter;
        classifierPromptAddendum = typeof getClassificationPromptAddendum === "function"
          ? getClassificationPromptAddendum(agent.currentClassification)
          : getCategoryPromptAddendum(category);
      } catch {}
    }

    const hasPlanningContext = shouldIncludePlanningContext(category, agent.planState, !!agent.currentClassification?.isDestructive, isGoalMode);
    const effectivePlanStateNotice = classifierSkipPlan || !hasPlanningContext ? "" : planStateNotice;
    const effectivePlanStateAddendum = classifierSkipPlan || !hasPlanningContext ? "" : planStateAddendum;

    const budgetedDynamicContext = buildBudgetedPromptContext([
      { id: "workspace-boundary", content: workspaceBoundaryNotice, maxTokens: 250 },
      { id: "plan-state", content: effectivePlanStateAddendum, maxTokens: 900 },
      { id: "plan-files", content: effectivePlanStateNotice, maxTokens: 500 },
      { id: "workspace-state", content: workspaceStateText, maxTokens: 500 },
      { id: "classifier", content: `${stepNotice}${classifierPromptAddendum}`, maxTokens: 250 },
      { id: "scratchpad", content: scratchpadText ? `SCRATCHPAD:\n${scratchpadText}` : "", maxTokens: 300 },
      { id: "task-reset", content: followUpTaskAddendum, maxTokens: 100 },
    ], Math.max(0, dynamicContextBudget - 20));
    const dynamicContext = budgetedDynamicContext.text
      ? `

<system_context_do_not_echo_or_repeat>
${budgetedDynamicContext.text}
</system_context_do_not_echo_or_repeat>`
      : "";

    const injectDynamicContext = (msgs: CoreMessage[]) => {
      if (!dynamicContext) return;
      if (msgs.length > 0) {
        // Find the actual last user message (skip any non-user or system context blocks)
        let targetMsg: CoreMessage | undefined;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "user") {
            const raw = typeof msgs[i].content === "string" ? (msgs[i].content as string) : "";
            if (!raw.startsWith("[RMemory Agent Memory Context]:")) {
              targetMsg = msgs[i];
              break;
            }
          }
        }

        if (targetMsg) {
          if (typeof targetMsg.content === "string") {
            targetMsg.content += dynamicContext;
          } else if (Array.isArray(targetMsg.content)) {
            const arr = targetMsg.content as any[];
            const lastPart = arr[arr.length - 1];
            if (lastPart && lastPart.type === "text") {
              lastPart.text += dynamicContext;
            } else {
              arr.push({ type: "text", text: dynamicContext });
            }
          }
        } else {
          // Fallback: append dynamic context as a standard user message
          msgs.push({
            role: "user",
            content: dynamicContext,
          });
        }
      } else {
        msgs.push({
          role: "user",
          content: dynamicContext,
        });
      }
    };

    messages = (agent as any).buildMessages(supportsNativeTools);
    injectDynamicContext(messages);

    {
      const systemSize = systemPrompt ? Buffer.byteLength(systemPrompt, "utf-8") : 0;
      const toolsSize = supportsNativeTools ? Buffer.byteLength(JSON.stringify(filteredToolDefs), "utf-8") : 0;
      const payloadJson = JSON.stringify(messages);
      const payloadBytes = Buffer.byteLength(payloadJson, "utf-8") + systemSize + toolsSize + 5000;
      const maxPayloadBytes = agent.detectedPayloadLimitBytes
        ? Math.floor(agent.detectedPayloadLimitBytes * 0.9)
        : 4 * 1024 * 1024;

      if (payloadBytes > maxPayloadBytes) {
        agent.writeToLogFile(
          "WARN",
          `Pre-flight payload check: estimated payload size (${(payloadBytes / 1024 / 1024).toFixed(2)} MB) exceeds safety threshold (${(maxPayloadBytes / 1024 / 1024).toFixed(2)} MB). Triggering emergency compaction.`
        );
        const targetBudget = Math.max(20 * 1024, maxPayloadBytes - systemSize - toolsSize - 5000);
        await agent.compactHistoryIfNeeded(signal, true, undefined, targetBudget);
        messages = (agent as any).buildMessages(supportsNativeTools);
        injectDynamicContext(messages);
      }
    }

    {
      const activeModelName = getAgentActiveModelName(agent);
      const modelLimit = getContextWindowLimit(activeModelName);
      const details = getModelConnectionDetailsForTier(agent.tier, agent.delegationDepth, agent.subagentType, !agent.isMultiAgent);
      const provider = details?.provider || getConfig().provider;
      const isAnthropic = provider === "anthropic" ||
                          (typeof provider === "string" && provider.includes("anthropic")) ||
                          activeModelName.toLowerCase().includes("antigravity") ||
                          activeModelName.toLowerCase().includes("claude");
      const safetyMax = Math.floor(modelLimit * (isAnthropic || modelLimit >= 100000 ? 0.80 : 0.70));
      
      let estSysTokens = 0;
      let estMsgTokens = 0;
      let estToolTokens = 0;
      let estTotal = 0;

      const ctxMgr = agent.conversation.getContextManager();
      const toolsJson = JSON.stringify(filteredToolDefs);

      if (ctxMgr) {
        const tracker = ctxMgr.getTokenTracker();
        await tracker.ensureEncoder();
        const breakdown = tracker.getBreakdown(allMessages, systemPrompt);
        const dynamicContextTokens = tracker.estimateTokens({
          role: "user",
          content: dynamicContext,
          timestamp: Date.now(),
        });
        estToolTokens = tracker.estimateText(toolsJson);
        estSysTokens = breakdown.systemPrompt;
        estMsgTokens = breakdown.messages + breakdown.toolCalls + breakdown.toolResults + dynamicContextTokens;
        estTotal = breakdown.total + dynamicContextTokens + estToolTokens;
      } else {
        estSysTokens = Math.ceil(systemPrompt.length / 3);
        estToolTokens = Math.ceil(toolsJson.length / 3);
        estMsgTokens = agent.conversation.getTokenEstimate() + Math.ceil(dynamicContext.length / 3);
        estTotal = estMsgTokens + estSysTokens + estToolTokens;
      }

      if (estTotal > safetyMax && allMessages.length >= 8) {
        const overshootPct = Math.round((estTotal / modelLimit) * 100);
        agent.writeToLogFile(
          "WARN",
          `Pre-flight context check (${activeModelName}): estimated ~${estTotal.toLocaleString()} total tokens (${overshootPct}% of ${modelLimit.toLocaleString()} limit). Compact threshold: ${safetyMax.toLocaleString()}. Triggering emergency compaction.`
        );
        const dynamicContextTokens = ctxMgr ? ctxMgr.getTokenTracker().estimateTokens({
          role: "user",
          content: dynamicContext,
          timestamp: Date.now(),
        }) : Math.ceil(dynamicContext.length / 3);
        const targetHistoryBudget = Math.max(1000, safetyMax - estSysTokens - estToolTokens - dynamicContextTokens);
        await agent.compactHistoryIfNeeded(signal, false, targetHistoryBudget);
        messages = (agent as any).buildMessages(supportsNativeTools);
        injectDynamicContext(messages);
        let afterEstMsgTokens = agent.conversation.getTokenEstimate() + Math.ceil(dynamicContext.length / 3);
        let afterEstTotal = afterEstMsgTokens + estSysTokens + estToolTokens;

        if (afterEstTotal > safetyMax && allMessages.length >= 8) {
          agent.writeToLogFile(
            "WARN",
            `Post-compaction estimated total (~${afterEstTotal.toLocaleString()}) still exceeds safety threshold (${safetyMax.toLocaleString()}). Applying hard pruning.`
          );
          agent.conversation.pruneToTokenLimit(targetHistoryBudget);
          messages = (agent as any).buildMessages(supportsNativeTools);
          injectDynamicContext(messages);
          afterEstMsgTokens = agent.conversation.getTokenEstimate() + Math.ceil(dynamicContext.length / 3);
          afterEstTotal = afterEstMsgTokens + estSysTokens + estToolTokens;
        }

        agent.writeToLogFile("INFO", `Post-compaction estimated total: ~${afterEstTotal.toLocaleString()} tokens.`);
      } else if (estTotal > safetyMax && allMessages.length < 8) {
        agent.writeToLogFile(
          "INFO",
          `Pre-flight context check (${activeModelName}): estimated ~${estTotal.toLocaleString()} tokens exceeds threshold (${safetyMax.toLocaleString()}), but conversation is short (${allMessages.length} msgs). Preserving recent turns and skipping premature compaction.`
        );
      }
    }

    let finalSystemPrompt = systemPrompt;
    if (!supportsNativeTools) {
      try {
        const { buildToolsSystemPromptBlock } = await import("../../utils/promptBasedToolCalling.js");
        const toolDefsForPrompt = filteredToolDefs.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as any,
        }));
        finalSystemPrompt += buildToolsSystemPromptBlock(toolDefsForPrompt);
      } catch {}
    }

    return {
      finalSystemPrompt,
      messages,
      // XML/prompt-based parsing must accept only schemas actually exposed to the model.
      toolDefs: filteredToolDefs,
      filteredToolDefs,
      supportsNativeTools,
      dynamicContext,
    };
  }
}
