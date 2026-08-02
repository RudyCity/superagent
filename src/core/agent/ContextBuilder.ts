import fs from "fs";
import path from "path";
import { type CoreMessage } from "ai";
import { getSettings, getContextWindowLimit, getModelConnectionDetailsForTier, loadAgentSkills, getConfig } from "../config.js";
import { contentToString, type Message } from "../conversation.js";
import { getToolDefinitions, backgroundTasks, isTaskInWorkspace } from "../tools.js";
import { isRmemoryActive } from "../rmemoryUtil.js";
import { HistoryCompactor } from "./HistoryCompactor.js";
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
    // Reset stale APPROVED planState if no real plan content exists on disk,
    // but only when there is existing conversation history (indicating a resumed session).
    // A fresh agent with planState set programmatically (e.g., in tests) should not be reset.
    const hasConversationHistory = agent.conversation.getMessages().length > 0;
    if (hasConversationHistory && agent.planState === "APPROVED" && typeof (agent as any).hasRealPlanContent === "function" && !(agent as any).hasRealPlanContent()) {
      agent.planState = "IDLE";
    }
    const isGoalMode = !!agent.goalMode;
    const category = agent.currentClassification?.category || "complex_task";
    let baseSystemPrompt = (agent as any).customSystemPrompt || (agent as any).config.systemPrompt || "";

    const allMessages = agent.conversation.getMessages();
    const recentUserMessages: Message[] = [];
    for (let i = allMessages.length - 1; i >= 0 && recentUserMessages.length < 3; i--) {
      if (allMessages[i].role === "user") recentUserMessages.unshift(allMessages[i]);
    }
    const queryStr = recentUserMessages.map(m => contentToString(m.content)).join(" ");

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

    const goalModeAddendum = isGoalMode
      ? `\n\n🎯 GOAL MODE: "${agent.goalMode}"\nDo NOT stop until goal is FULLY achieved. Self-verify (build+test), fix errors, use subagents aggressively. End with "GOAL_COMPLETE:" or "GOAL_PARTIAL:" summary.\n`
      : "";



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
    let toolsToUse = await agent.getActiveTools();

    const toolDefs = toolsToUse
      ? toolsToUse.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }))
      : getToolDefinitions();

    let filteredToolDefs = toolDefs;
    if (agent.currentClassification) {
      try {
        const shouldBypassFilter = agent.planState !== "IDLE" || agent.tier === "subagent";
        if (!shouldBypassFilter) {
          const { getToolsetForCategory } = await import("../requestClassifier.js");
          const filteredTools = getToolsetForCategory(agent.currentClassification.category, toolsToUse || []);
          if (filteredTools.length !== (toolsToUse?.length ?? toolDefs.length)) {
            filteredToolDefs = filteredTools.map((t) => ({
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
        ? `1. Use 'manage_plan' tool (action: 'create', 'edit', or 'sync') to manage the Implementation Plan.\n2. Use 'manage_tasks' tool to manage checklist tasks ('add', 'add_bulk', 'update', 'update_bulk', 'remove', 'remove_bulk', 'list').`
        : `1. Use 'manage_tasks' tool to manage checklist tasks ('add', 'add_bulk', 'update', 'update_bulk', 'remove', 'remove_bulk', 'list').`;
      planStateNotice = `\n\nPLANNING, TASKS & VERIFICATION FILES:\n- Plan: ${planPath} ${fileStatus(planPath)}\n- Tasks: ${taskPath} ${fileStatus(taskPath)}\n- History: ${taskHistoryPath} ${fileStatus(taskHistoryPath)}\n- Walkthrough: ${walkthroughPath} ${fileStatus(walkthroughPath)}\n\nPLANNING RULES:\n${planToolRule}\n- DO NOT use file write tools to modify Plan or Task files directly.\n- Walkthrough File: use 'write_to_file' directly.\n- Always use absolute paths when referencing these files.`;
    }

    let planStateAddendum = "";
    if (agent.planState === "PLANNING_PENDING") {
      planStateAddendum = `\n\n⚠️ IMPORTANT PLAN STATE NOTICE:\nAn implementation plan has been written to '${agent.getPlanFilePath()}' and is currently pending user approval.\nYou are temporarily in a READ-ONLY mode.\n- DO NOT attempt to write/edit/modify any codebase files.\n- DO NOT run terminal commands that modify files, add packages, or check out git branches.\n- Focus on explaining your proposed plan to the user, answering any questions, or waiting for them to approve via the interactive approval wizard.`;
    } else if (agent.planState === "APPROVED" && typeof (agent as any).hasRealPlanContent === "function" && (agent as any).hasRealPlanContent()) {
      planStateAddendum = `\n\n✓ PLAN STATE NOTICE:\nThe user has APPROVED your implementation plan. You are now fully authorized to modify codebase files and run commands to execute the plan.`;
    }

    let followUpTaskAddendum = "";
    if ((agent as any).tasksJustArchived) {
      followUpTaskAddendum = `\n\n🔄 TASK RESET: ${(agent as any).archivedTaskCount} tasks archived. Use 'manage_tasks' (add/add_bulk) or 'manage_plan' (create) for new tasks.`;
      (agent as any).tasksJustArchived = false;
    }

    const workspacePath = agent.workingDirectory || process.cwd();
    const runningProcesses = Array.from(backgroundTasks.entries())
      .filter(([_, t]) => !t.hasExited && isTaskInWorkspace(t.cwd, workspacePath))
      .map(([id, t]) => `- Process ID: ${id}, Command: "${t.command}"`)
      .join("\n");
    const processNotice = runningProcesses
      ? `\n\n⚙️ RUNNING PROCESSES:\n${runningProcesses}`
      : "";

    let pinnedKnowledgeNotice = "";
    try {
      const { getAllKnowledge, formatKnowledgeForPrompt } = await import("../pinnedKnowledge.js");
      const knowledgeEntries = getAllKnowledge({ limit: 10 });
      if (knowledgeEntries.length > 0) {
        pinnedKnowledgeNotice = "\n\n" + formatKnowledgeForPrompt(knowledgeEntries, 8, 1500);
      }
    } catch {}

    const singleModeSubagentDirective = agent.tier === "single" ? `\n\nSINGLE MODE SUBAGENT DISPATCH:\n- Perform small/simple operations directly. Spawn subagents for: broad research (researcher), multi-file changes (coder), large feature review (reviewer), security audits (security-engineer), browser automation (chrome-agent), or parallel independent subtasks.\n- Run build + test after code changes. Only report completion when both pass.` : "";

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
            const currentWorkspace = path.resolve(process.cwd());
            
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
          workspaceChainNotice = `\n\n# WORKSPACE CHAIN ACTIVE\n${topology}${activeNodeInfo}\n- **Execution**: Use 'cross_workspace_exec' (operation='exec') to run commands on any chain node.\n- **Health & Metrics**: Use 'cross_workspace_exec' (operation='health') or 'manage_workspace_chain' (action='health') for real-time node latency, RAM, Disk, Uptime metrics.\n- **Cross-Node Diff**: Use 'cross_workspace_exec' (operation='diff', sourceNodeId, targetNodeId, filePath) to compare code/config across nodes.\n- **Cross-Node Sync**: Use 'cross_workspace_exec' (operation='sync', sourceNodeId, targetNodeId, filePath, targetPath?) to deploy/transfer files between nodes.\n- **Topology**: Use 'manage_workspace_chain' to manage graph nodes or switch active chain.`;
        }
      } catch {}
    }

    const hasShell = filteredToolDefs.some((t: any) => t.name === "run_command" || t.name === "bash" || t.name === "run_background_process");
    const hasWrite = filteredToolDefs.some((t: any) => t.name === "write_to_file" || t.name === "edit" || t.name === "replace_file_content" || t.name === "multi_replace_file_content" || t.name === "write" || t.name === "apply_patch");
    const hasNetwork = filteredToolDefs.some((t: any) => t.name === "web_search" || t.name === "fetch_url");
    const hasSubagents = filteredToolDefs.some((t: any) => t.name === "invoke_subagent" || t.name === "invoke_superagent");

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

    const runtimeCapabilitiesText = `\n# RUNTIME\n- Shell: ${hasShell ? "enabled" : "disabled"} | Write: ${hasWrite ? "enabled" : "disabled"} | Network: ${hasNetwork ? "enabled" : "disabled"} | Subagents: ${hasSubagents ? "enabled" : "disabled"}\n- Verification: ${verificationStatus} | Platform: ${activeShellType} | Separator: ${shellSep}\n`;

    const lastUserMessage = messages.slice().reverse().find((m: any) => m.role === "user");
    const userInputText = lastUserMessage ? (typeof lastUserMessage.content === "string" ? lastUserMessage.content : "") : "";
    const lowerInput = userInputText.toLowerCase();

    let activeMode = "implement";
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

    const MODE_INSTRUCTIONS: Record<string, string> = {
      ask: `- Lightweight Q&A mode. Respond concisely. No plan/task files, no subagents, no build/test commands.`,
      research: `- Read-only research mode. Do NOT modify files or run build/test commands.`,
      plan: `- Propose implementation plan via 'manage_plan'. Do NOT edit source files before user approval.`,
      implement: `- Implement code changes. Plan mandatory only for complex/risky changes. Run build+test if shell available.`,
      debug: `- Investigate and fix bugs. Debug via terminal execution first. Trace root cause. Run build or test on new/updated files at END of repair process.`,
      review: `- Code quality/security review. No file edits unless requested. Output issues with severity and file/line refs.`,
    };
    const activeModeNotice = `\n# ACTIVE MODE: '${activeMode}'\n${MODE_INSTRUCTIONS[activeMode] || ""}\n`;

    let toolRestrictionNotice = "";
    if (!hasShell) {
      toolRestrictionNotice = `\n\n⚠️ Terminal/shell execution DISABLED for this request. Do NOT use run_command or similar tools.`;
    }

    const defaultMax = getSettings().maxIterations === 0 ? Infinity : (getSettings().maxIterations || 500);
    const maxIterations = agent.goalMode ? agent.goalMaxIterations : defaultMax;
    const maxIterationsStr = maxIterations === Infinity ? "unlimited" : maxIterations.toString();
    const systemPrompt = `${activeSystemPrompt}${toolRestrictionNotice}${runtimeCapabilitiesText}${activeModeNotice}\n\nEXECUTION CONTEXT:\n- Step limit: ${maxIterationsStr} iterations. Be efficient.\n- Spawn subagents in parallel for independent tasks (>3 files, >2 domains, broad research).\n${singleModeSubagentDirective}${goalModeAddendum}${guidelinesText}${processNotice}${pinnedKnowledgeNotice}${devHookNotice}${sharedMemoryNotice}${workspaceChainNotice}`;

    const stepsRemaining = maxIterations === Infinity ? Infinity : (maxIterations - 1);
    const stepNotice = stepsRemaining <= 5
      ? `\n- Current Step: 1 of ${maxIterations} (WARNING: Only ${stepsRemaining} steps remaining!)`
      : "";
    const modelInstance = agent.getModel();
    const modelName = modelInstance ? modelInstance.modelId : "";


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
        const { shouldSkipPlanInjection, getCategoryPromptAddendum } = await import("../requestClassifier.js");
        const category = agent.currentClassification.category;
        const shouldBypassFilter = agent.planState !== "IDLE" || agent.tier === "subagent";
        classifierSkipPlan = shouldSkipPlanInjection(category) && !shouldBypassFilter;
        classifierPromptAddendum = getCategoryPromptAddendum(category);
      } catch {}
    }

    const effectivePlanStateNotice = classifierSkipPlan ? "" : planStateNotice;
    const effectivePlanStateAddendum = classifierSkipPlan ? "" : planStateAddendum;

    const dynamicContext = `\n\n<system_context_do_not_echo_or_repeat>\n${stepNotice}${classifierPromptAddendum}${scratchpadText ? `\nSCRATCHPAD:\n${scratchpadText}` : ""}${workspaceStateText}${workspaceBoundaryNotice}${effectivePlanStateNotice}${effectivePlanStateAddendum}${followUpTaskAddendum}\n</system_context_do_not_echo_or_repeat>`;

    const injectDynamicContext = (msgs: CoreMessage[]) => {
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
      const modelLimit = getContextWindowLimit(getConfig().model);
      const isAnthropic = getConfig().provider === "anthropic" || (typeof getConfig().provider === "string" && getConfig().provider.includes("anthropic"));
      const safetyMax = Math.floor(modelLimit * (isAnthropic || modelLimit >= 100000 ? 0.80 : 0.70));
      
      let estSysTokens = 0;
      let estMsgTokens = 0;
      let estTotal = 0;

      const ctxMgr = agent.conversation.getContextManager();
      if (ctxMgr) {
        const tracker = ctxMgr.getTokenTracker();
        const breakdown = tracker.getBreakdown(allMessages, systemPrompt);
        const dynamicContextTokens = tracker.estimateTokens({
          role: "user",
          content: dynamicContext,
          timestamp: Date.now(),
        });
        estTotal = breakdown.total + dynamicContextTokens;
        estSysTokens = breakdown.systemPrompt;
        estMsgTokens = estTotal - estSysTokens;
      } else {
        estSysTokens = Math.ceil(systemPrompt.length / 3);
        estMsgTokens = agent.conversation.getTokenEstimate() + Math.ceil(dynamicContext.length / 3);
        estTotal = estMsgTokens + estSysTokens;
      }

      if (estTotal > safetyMax) {
        const overshootPct = Math.round((estTotal / modelLimit) * 100);
        agent.writeToLogFile("WARN", `Pre-flight context check: estimated ~${estTotal.toLocaleString()} total tokens (${overshootPct}% of ${modelLimit.toLocaleString()} limit). Compact threshold: ${safetyMax.toLocaleString()}. Triggering emergency compaction.`);
        const dynamicContextTokens = ctxMgr ? ctxMgr.getTokenTracker().estimateTokens({
          role: "user",
          content: dynamicContext,
          timestamp: Date.now(),
        }) : Math.ceil(dynamicContext.length / 3);
        const targetHistoryBudget = Math.max(1000, safetyMax - estSysTokens - dynamicContextTokens);
        await agent.compactHistoryIfNeeded(signal, false, targetHistoryBudget);
        messages = (agent as any).buildMessages(supportsNativeTools);
        injectDynamicContext(messages);
        const afterEstMsgTokens = agent.conversation.getTokenEstimate() + Math.ceil(dynamicContext.length / 3);
        const afterEstTotal = afterEstMsgTokens + estSysTokens;
        agent.writeToLogFile("INFO", `Post-compaction estimated total: ~${afterEstTotal.toLocaleString()} tokens.`);
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
      toolDefs,
      filteredToolDefs,
      supportsNativeTools,
      dynamicContext,
    };
  }
}