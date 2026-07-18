import fs from "fs";
import path from "path";
import { type CoreMessage } from "ai";
import { getSettings, getContextWindowLimit, getModelConnectionDetailsForTier, getDynamicVisionThreshold, loadAgentSkills, getConfig } from "../config.js";
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
    const isGoalMode = !!agent.goalMode;
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
    try {
      const scratchpadPath = path.resolve(agent.workingDirectory, "scratch", "scratchpad.md");
      if (fs.existsSync(scratchpadPath)) {
        scratchpadText = fs.readFileSync(scratchpadPath, "utf-8");
      }
    } catch {}

    const goalModeAddendum = isGoalMode
      ? `\n\n🎯 GOAL MODE ACTIVE:\nYour PRIMARY OBJECTIVE is: "${agent.goalMode}"\n\nCRITICAL GOAL MODE RULES:\n- You MUST NOT stop until this goal is FULLY and VERIFIABLY achieved.\n- After every action, ask yourself: "Is the goal complete?" — if not, keep going.\n- Self-verify completion: run tests, check outputs, read files to confirm correctness.\n- If you hit an error, diagnose and fix it. Never give up on the goal.\n- Only declare completion when you have concrete evidence the goal is done.\n- Use subagents aggressively to parallelize work and meet the goal faster.\n- At the end of your work, produce a concise GOAL COMPLETION REPORT starting with "GOAL_COMPLETE:" or "GOAL_PARTIAL:" followed by a brief summary of what was achieved.\n`
      : "";

    const classifierSkipWsDiscovery = agent.currentClassification
      ? (await import("../requestClassifier.js")).shouldSkipWorkspaceDiscovery(agent.currentClassification.category)
      : false;
    if (!agent.disableWorkspaceDiscovery && agent.tier !== "subagent" && !classifierSkipWsDiscovery) {
      const shouldScan = !agent.workspaceCache || (agent as any).workspaceCacheNeedsUpdate;
      if (shouldScan) {
        try {
          const { discoverWorkspace } = await import("../workspaceDiscovery.js");
          const { isIdentical, cache } = await discoverWorkspace(agent.workingDirectory);
          const wasFirstRun = !agent.workspaceCache;
          agent.workspaceCache = cache;
          (agent as any).workspaceCacheNeedsUpdate = false;
          if (wasFirstRun) {
            if (isIdentical) {
              agent.onEvent({
                type: "text",
                content: `\n[SYS] Workspace identical to previous session. Using cached context.\n`,
              });
            } else {
              agent.onEvent({
                type: "text",
                content: `\n[SYS] Workspace scanned and cached.\n`,
              });
            }
          } else if (!isIdentical) {
            agent.onEvent({
              type: "text",
              content: `\n[SYS] Workspace changes detected. Updated cache.\n`,
            });
          }
        } catch (err: any) {
          agent.writeToLogFile("WARN", `Workspace discovery failed: ${err.message}`);
        }
      }
    }

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
        const { getToolsetForCategory } = await import("../requestClassifier.js");
        const filteredTools = getToolsetForCategory(agent.currentClassification.category, toolsToUse || []);
        if (filteredTools.length !== (toolsToUse?.length ?? toolDefs.length)) {
          filteredToolDefs = filteredTools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          }));
        }
      } catch {}
    }

    const fileStatus = (filePath: string): string =>
      fs.existsSync(filePath) ? "[EXISTS]" : "[NOT YET CREATED]";

    let planStateNotice = "";
    if (agent.tier === "master" || agent.tier === "single") {
      const planPath = agent.getPlanFilePath();
      const taskPath = agent.getTaskFilePath();
      const taskHistoryPath = agent.getTaskHistoryFilePath();
      const walkthroughPath = agent.getWalkthroughFilePath();
      planStateNotice = `\n\nPLANNING, TASKS & VERIFICATION FILES FOR THIS SESSION:\n- Implementation Plan File: ${planPath} ${fileStatus(planPath)}\n- Task Tracking File: ${taskPath} ${fileStatus(taskPath)}\n- Task History File: ${taskHistoryPath} ${fileStatus(taskHistoryPath)}\n- Verification/Walkthrough File: ${walkthroughPath} ${fileStatus(walkthroughPath)}\n\nCRITICAL RULES FOR PLANNING:\n1. You MUST use the 'manage_plan' tool (action: 'create', 'edit', or 'sync') to create, edit, update, or synchronize the Implementation Plan and tasks.\n2. You MUST use the 'manage_tasks' tool to manage checklist tasks:\n   - 'add' (single task) or 'add_bulk' with 'texts' array (multiple tasks at once).\n   - 'update' (single) or 'update_bulk' with 'indices' array (multiple tasks at once) to change task status.\n   - 'remove' (single) or 'remove_bulk' with 'indices' array to delete tasks.\n   - 'list' to inspect current tasks.\n3. DO NOT use 'write_to_file', 'replace_file_content', 'multi_replace_file_content', or 'edit' to create, modify, or update the Implementation Plan File or the Task Tracking File directly. Doing so is strictly forbidden.\n4. For the Verification/Walkthrough File, you may use 'write_to_file' directly.\n5. Do NOT write or create plan or task files in the local workspace directory.\n6. Whenever you reference these files, always use their absolute paths or format them as absolute file:/// links.`;
    } else if (agent.tier === "superagent") {
      const planPath = agent.getPlanFilePath();
      const taskPath = agent.getTaskFilePath();
      const taskHistoryPath = agent.getTaskHistoryFilePath();
      const walkthroughPath = agent.getWalkthroughFilePath();
      planStateNotice = `\n\nPLANNING, TASKS & VERIFICATION FILES FOR THIS SESSION:\n- Implementation Plan File: ${planPath} ${fileStatus(planPath)}\n- Task Tracking File: ${taskPath} ${fileStatus(taskPath)}\n- Task History File: ${taskHistoryPath} ${fileStatus(taskHistoryPath)}\n- Verification/Walkthrough File: ${walkthroughPath} ${fileStatus(walkthroughPath)}\n\nCRITICAL RULES FOR PLANNING:\n1. You MUST use the 'manage_tasks' tool to manage checklist tasks:\n   - 'add' (single task) or 'add_bulk' with 'texts' array (multiple tasks at once).\n   - 'update' (single) or 'update_bulk' with 'indices' array (multiple tasks at once) to change task status.\n   - 'remove' (single) or 'remove_bulk' with 'indices' array to delete tasks.\n   - 'list' to inspect current tasks.\n2. DO NOT attempt to directly modify the Implementation Plan File or Task Tracking File using 'write_to_file', 'replace_file_content', or other file writing tools. Direct modification of these files is strictly blocked by the system's security boundaries.\n3. For the Verification/Walkthrough File, you may use 'write_to_file' directly.\n4. Do NOT write or create plan or task files in the local workspace directory.\n5. Whenever you reference these files, always use their absolute paths or format them as absolute file:/// links.`;
    }

    let planStateAddendum = "";
    if (agent.planState === "PLANNING_PENDING") {
      planStateAddendum = `\n\n⚠️ IMPORTANT PLAN STATE NOTICE:\nAn implementation plan has been written to '${agent.getPlanFilePath()}' and is currently pending user approval.\nYou are temporarily in a READ-ONLY mode.\n- DO NOT attempt to write/edit/modify any codebase files.\n- DO NOT run terminal commands that modify files, add packages, or check out git branches.\n- Focus on explaining your proposed plan to the user, answering any questions, or waiting for them to approve via the interactive approval wizard.`;
    } else if (agent.planState === "APPROVED") {
      planStateAddendum = `\n\n✓ PLAN STATE NOTICE:\nThe user has APPROVED your implementation plan. You are now fully authorized to modify codebase files and run commands to execute the plan.`;
    }

    let followUpTaskAddendum = "";
    if ((agent as any).tasksJustArchived) {
      followUpTaskAddendum = `\n\n🔄 TASK CHECKLIST RESET NOTICE:\nAll ${(agent as any).archivedTaskCount} previous tasks were completed and have been archived to the task history file.\nThe active task list has been cleared and is ready for new tasks.\nYou SHOULD use the 'manage_tasks' tool (action: 'add' or 'add_bulk') or 'manage_plan' tool (action: 'create') to create fresh tasks for the user's new request.\nUse 'add_bulk' with a 'texts' array to add multiple tasks in a single call (more efficient than repeated 'add' calls).\nThis ensures the ACTIVE TASK CHECKLIST stays up-to-date with the current work.`;
      (agent as any).tasksJustArchived = false;
    }

    const workspacePath = agent.workingDirectory || process.cwd();
    const runningProcesses = Array.from(backgroundTasks.entries())
      .filter(([_, t]) => !t.hasExited && isTaskInWorkspace(t.cwd, workspacePath))
      .map(([id, t]) => `- Process ID: ${id}, Command: "${t.command}"`)
      .join("\n");
    const processNotice = runningProcesses
      ? `\n\n⚙️ RUNNING BACKGROUND/TERMINAL PROCESSES:\nYou are aware that the following background/terminal processes are currently running in the environment:\n${runningProcesses}`
      : "";

    let pinnedKnowledgeNotice = "";
    try {
      const { getAllKnowledge, formatKnowledgeForPrompt } = await import("../pinnedKnowledge.js");
      const knowledgeEntries = getAllKnowledge({ limit: 10 });
      if (knowledgeEntries.length > 0) {
        pinnedKnowledgeNotice = "\n\n" + formatKnowledgeForPrompt(knowledgeEntries, 8, 1500);
      }
    } catch {}

    const singleModeSubagentDirective = agent.tier === "single" ? `\n\nSUBAGENT WORKFLOW — GUIDELINES FOR SINGLE MODE:\nYou operate in single-agent mode. You should leverage subagents when tasks are complex, independent, or can be run in parallel.\nFor small, simple, or direct operations (e.g. reading a single file, running a quick build or test command, or editing a specific code block), you should perform them directly rather than spawning subagents. This minimizes process spawning and context-swapping overhead.\n\nSUBAGENT RULES:\n1. RESEARCH tasks (exploring codebase, reading docs, searching web) → Spawn a 'researcher' subagent for broad context gathering or when reading multiple files. You may perform quick direct lookups.\n2. IMPLEMENTATION tasks (writing code, editing files) → Spawn a 'coder' subagent for multi-file changes or larger features. You may perform small or simple inline modifications.\n3. REVIEW tasks (checking correctness, testing, validating) → Spawn a 'reviewer' subagent for verifying large features. For simple verification, run commands directly.\n4. COMPLEX requests → Break into parallel subtasks and spawn multiple subagents concurrently.\n\nSUBAGENT DISPATCH PATTERN (follow this when delegating):\n  Step 1 — Analyze: understand what the user wants.\n  Step 2 — Plan: identify independent subtasks (and which skills are relevant).\n  Step 3 — Spawn: invoke subagents for each subtask (parallel if independent).\n  Step 4 — Integrate: collect results, synthesize, respond to user.\n\nWHEN YOU SHOULD DELEGATE TO A SUBAGENT (non-exhaustive):\n- Any codebase investigation spanning multiple folders or components\n- Multi-file editing or complex feature implementation\n- Large-scale refactoring or major architectural changes\n- Web search or documentation lookup that requires extensive research\n\nSKILL USAGE — MANDATORY:\nYou have access to INSTALLED AGENT SKILLS listed above. You MUST use them.\nBEFORE starting any task, identify which skill(s) are relevant and load them using the use_skill tool.\nSkill categories to always check:\n- Debugging/investigation → 'systematic-debugging', 'root-cause-tracing', 'diagnosing-bugs'\n- New feature/development → 'writing-plans', 'subagent-driven-development', 'test-driven-development-tdd'\n- Code review → 'requesting-code-review', 'code-review-reception'\n- Finishing work → 'finishing-a-development-branch', 'verification-before-completion'\n- Research/exploration → 'dispatching-parallel-agents'\nDO NOT skip skill reading. Instruct your subagents to also read and follow the relevant SKILL.md.\n\nBULK READ — MANDATORY:\nWhen you need to read or analyze multiple files, ALWAYS batch them into a single tool call using the 'filePaths' array — NEVER read files one at a time in sequential calls.\n- Identify ALL files needed upfront, then read them all in one call before processing.\n- If reading related files (e.g. types, imports, tests, configs), include them all in the same batch.\n- This applies to you and all subagents you spawn.\n\nFAST ANALYSIS — MANDATORY:\nTo reduce latency, prevent timeout issues, and save tokens:\n1. PINPOINT FIRST: ALWAYS use 'grep' or 'ripgrep' search tools to locate exact files/lines containing target symbols (e.g. methods, classes, variables) before reading files. Do NOT use recursive directory listings or read large files blindly.\n2. TARGETED READING: If a file is large (>200 lines), only view/read the specific line range (using StartLine/EndLine parameters) containing the code you actually need to examine.\n3. EXCLUDE GENERIC DIRECTORIES: Filter out dependency/build folders ('node_modules', 'dist', 'build', '.git', etc.) in glob/search path arguments.\n\n\nCONTEXT_ANCHOR — ANTI-DRIFT PROTOCOL:\nBefore each action, verify:\n1. Am I still working toward the PRIMARY OBJECTIVE?\n2. Am I within declared boundaries / workspace limits?\n3. Will this action move closer to success/acceptance criteria?\n\nPOST-CHANGE VERIFICATION — MANDATORY AFTER ANY CODE MODIFICATION:\nWhenever you (or any subagent) modify source files, you MUST run verification before responding to the user:\n1. BUILD: Run the project's build command (e.g. 'npm run build', 'cargo build', 'go build', 'mvn compile'). If it fails, fix all compile errors before proceeding.\n2. TEST: Run the project's test suite (e.g. 'npm test', 'cargo test', 'pytest', 'go test ./...'). If tests fail, diagnose and fix them. Do NOT skip this step.\n3. CONCERN_TRACKS: Evaluate changes against all 5 tracks: Correctness (logic/tests), Resilience (failure modes), Consistency (patterns/naming), Impact-Radius (trace consumers), Reversibility.\n4. if verification_failed: fix errors → re-run build + test → repeat until both pass.\n5. ONLY respond to the user AFTER build and test both pass.\n\nSELF-VERIFICATION & CRITIC — MANDATORY BEFORE RESPONDING TO USER:\nAfter all subagents finish, you MUST perform this verification loop before considering the task done:\n1. VALIDATE OUTPUTS: Review each subagent's report. Check that build passed, tests passed, and all task requirements are met.\n2. CRITIC: Actively challenge the results. Ask yourself:\n   - Did the coder subagent actually run the build and tests? If not, spawn a reviewer to verify.\n   - Are there edge cases that were not addressed?\n   - Does the implementation actually solve the user's original request (not just a surface interpretation)?\n   - Are there any TODOs, placeholders, or incomplete parts?\n3. SELF-INTERROGATION: Ask yourself: "What am I assuming that might be wrong?", "What is the simplest thing that could break this?", "If reviewing this from someone else, what would I flag?", "What did I NOT check?", and "Is there a simpler approach?".\n4. IF GAPS FOUND → spawn a fix subagent (coder or reviewer) to address them. Do NOT report completion with known gaps.\n5. ONLY report completion when you have concrete evidence (build pass, test pass, acceptance criteria met).` : "";

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

    let devHookNotice = "";
    try {
      const { getActiveDevHookGlobal } = await import("../tools/state.js");
      const activeDevHook = getActiveDevHookGlobal();
      if (activeDevHook) {
        devHookNotice = `\n\n🛠️ ACTIVE INTERNAL HOOK DEVELOPMENT FOCUS:\n- You are currently focusing on developing the "${activeDevHook}" internal hook.\n- CRITICAL: Your active working directory (CWD) is ALREADY set to the hook's folder: "internal-hooks/${activeDevHook}/".\n- All files in the WORKSPACE FILES LIST (like hook.json, index.js, package.json, README.md, CHANGELOG.md) are located directly inside this hook folder.\n- You MUST access, read, and modify these files using their direct relative names (e.g., "index.js", "hook.json", "package.json") WITHOUT any "internal-hooks/${activeDevHook}/" prefix.\n- DO NOT prefix paths with "internal-hooks/${activeDevHook}/" because doing so will resolve to incorrect nested paths.\n- Your primary objective is to implement, refine, or test this specific hook.\n- If you need to access files in the parent project, prefix them with "../../" to reference them relative to the project root.\n- You can test this hook's execution and verify its behavior locally by calling appropriate terminal commands or using "/ih dev ${activeDevHook}" as reference.`;
      }
    } catch {}

    let sharedMemoryNotice = "";
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

    const workspaceDir = agent.worktreePath || agent.workingDirectory;
    const workspaceBoundaryNotice = workspaceDir
      ? `\n\n# CURRENT ENVIRONMENT & ACTIVE WORKSPACE\n- Active Workspace Directory: "${workspaceDir}"\n- Shell Execution CWD: "${workspaceDir}"\n\n# WORKSPACE BOUNDARY — CRITICAL\n- Workspace root: "${workspaceDir}"\n- ALL file read/write operations MUST target paths inside this directory.\n- NEVER write files to any path outside the workspace root.\n- Do NOT use absolute paths discovered from bash command output (e.g., ls, find, pwd) as file write targets — always derive paths relative to the workspace root.\n- If a shell command reveals a path on a different drive or directory than the workspace, DO NOT write files there.`
      : "";

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

    const runtimeCapabilitiesText = `\n# RUNTIME CAPABILITIES (do NOT assume or hardcode, reference these exactly)\n- Shell: ${hasShell ? "enabled" : "disabled"}\n- Write: ${hasWrite ? "enabled" : "disabled"}\n- Network: ${hasNetwork ? "enabled" : "disabled"}\n- Subagents: ${hasSubagents ? "enabled" : "disabled"}\n- Verification: ${verificationStatus}\n- Windows Shell Platform: ${activeShellType}\n- Command Separator Syntax: ${shellSep}\n`;

    const category = agent.currentClassification?.category || "complex_task";
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

    const activeModeNotice = `\n# CURRENT ACTIVE INTENT MODE: '${activeMode}'\nFollow these instructions for '${activeMode}' mode:\n${activeMode === "ask" ? `- You are in lightweight Q&A/concept explanation mode. Do NOT create any plan file or task list file. Do NOT spawn subagents. Do NOT call get_skills() or use_skill(). Do NOT run build, test, lint, or typecheck commands. Respond immediately and concisely.` : ""}\n${activeMode === "research" ? `- You are in read-only research/exploration mode. Do NOT modify any files. Do NOT run build, test, lint, or typecheck commands. Set final status to static-only.` : ""}\n${activeMode === "plan" ? `- Propose an implementation plan using 'manage_plan'. Do NOT edit source files before user approval. Minta approval secara eksplisit.` : ""}\n${activeMode === "implement" ? `- Implement code changes. Proposing a plan is mandatory only for multi-file/complex/risky changes. Small direct edits are allowed. Run build and tests if shell is available; if shell is disabled, report Build/Test as 'not-run' with reason 'shell disabled', and set status to 'static-only'.` : ""}\n${activeMode === "debug" ? `- Investigate and fix bugs. Trace root cause first before editing. Run build and tests if shell is available; if shell is disabled, report Build/Test as 'not-run' with reason 'shell disabled', and set status to 'static-only'.` : ""}\n${activeMode === "review" ? `- Perform code quality or security review. Do NOT make file edits unless requested. Output issues with severity ([CRITICAL], [IMPORTANT], [MINOR]), file/line references, and proposed fixes.` : ""}\n`;

    let toolRestrictionNotice = "";
    if (!hasShell) {
      toolRestrictionNotice = `\n\n⚠️ CRITICAL RESTRICTION: Terminal/shell command execution is currently DISABLED for this request. Do NOT attempt to use 'run_command', 'run_background_process', 'bash', or any terminal/shell execution tools, as they are not available in your tool schema.`;
    }

    const systemPrompt = `${activeSystemPrompt}${toolRestrictionNotice}${runtimeCapabilitiesText}${activeModeNotice}\n\nCRITICAL TASK EXECUTION CONTEXT:\n- Do NOT repeat, echo, or quote any content wrapped in <system_context_do_not_echo_or_repeat> tags. Treat them as background instruction states only.\n- You are running with a strict step limit of ${agent.goalMode ? agent.goalMaxIterations : (getSettings().maxIterations || 50)} agent iterations per request.\n- Be highly efficient. DO NOT try to do everything in a single sequential thread.\n- Spawn subagents in parallel ONLY when the task meets subagent threshold rules (spans >3 files, >2 domains, major refactor/architecture, broad audit/research, or independent parallel work).\n- Spawn subagents in parallel whenever tasks are independent.\n- After spawning, wait for results, integrate them, and report back to the user.\n${singleModeSubagentDirective}${goalModeAddendum}${guidelinesText}${processNotice}${pinnedKnowledgeNotice}${devHookNotice}${sharedMemoryNotice}`;

    const maxIterations = agent.goalMode ? agent.goalMaxIterations : (getSettings().maxIterations || 50);
    const stepsRemaining = maxIterations === Infinity ? Infinity : (maxIterations - 1);
    const stepNotice = stepsRemaining <= 5
      ? `\n- Current Step: 1 of ${maxIterations} (WARNING: Only ${stepsRemaining} steps remaining!)`
      : "";
    const modelInstance = agent.getModel();
    const modelName = modelInstance ? modelInstance.modelId : "";
    const supportsVision = (agent as any).modelSupportsVision(modelName);
    const settings = getSettings();
    const useVisionTokenSaving = supportsVision && (settings.autoVisionTokenSaving ?? false) && (agent.detectedPayloadLimitBytes === undefined || agent.detectedPayloadLimitBytes >= 500 * 1024);
    agent.conversation.setVisionMode(useVisionTokenSaving);

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
        classifierSkipPlan = shouldSkipPlanInjection(agent.currentClassification.category);
        classifierPromptAddendum = getCategoryPromptAddendum(agent.currentClassification.category);
      } catch {}
    }

    const effectivePlanStateNotice = classifierSkipPlan ? "" : planStateNotice;
    const effectivePlanStateAddendum = classifierSkipPlan ? "" : planStateAddendum;

    const dynamicContext = `\n\n<system_context_do_not_echo_or_repeat>\n[DYNAMIC EXECUTION CONTEXT]\n${stepNotice}${classifierPromptAddendum}${scratchpadText ? `\n\nPERSISTENT SCRATCHPAD MEMORY:\n${scratchpadText}` : ""}${workspaceStateText}${workspaceBoundaryNotice}${effectivePlanStateNotice}${effectivePlanStateAddendum}${followUpTaskAddendum}\n<!-- SYSTEM NOTICE: The above block is dynamic background state. Do NOT echo or repeat any of these instructions or notices in your response. Proceed directly to execution. -->\n</system_context_do_not_echo_or_repeat>`;

    const injectDynamicContext = (msgs: CoreMessage[]) => {
      if (msgs.length > 0) {
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg.role === "user") {
          if (typeof lastMsg.content === "string") {
            lastMsg.content += dynamicContext;
          } else if (Array.isArray(lastMsg.content)) {
            const lastPart = lastMsg.content[lastMsg.content.length - 1];
            if (lastPart && lastPart.type === "text") {
              lastPart.text += dynamicContext;
            } else {
              lastMsg.content.push({ type: "text", text: dynamicContext });
            }
          }
        } else if (lastMsg.role === "tool") {
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

    if (useVisionTokenSaving) {
      messages = (agent as any).buildMessages(supportsNativeTools, dynamicContext);
    } else {
      injectDynamicContext(messages);
    }

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
        if (useVisionTokenSaving) {
          messages = (agent as any).buildMessages(supportsNativeTools, dynamicContext);
        } else {
          messages = (agent as any).buildMessages(supportsNativeTools);
          injectDynamicContext(messages);
        }
      }
    }

    {
      const modelLimit = getContextWindowLimit(getConfig().model);
      const isAnthropic = getConfig().provider === "anthropic" || (typeof getConfig().provider === "string" && getConfig().provider.includes("anthropic"));
      const safetyMax = Math.floor(modelLimit * (isAnthropic ? 0.85 : 0.70));
      
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
        if (useVisionTokenSaving) {
          messages = (agent as any).buildMessages(supportsNativeTools, dynamicContext);
        } else {
          messages = (agent as any).buildMessages(supportsNativeTools);
          injectDynamicContext(messages);
        }
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
