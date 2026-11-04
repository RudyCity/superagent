# COMPLETE REVISED FILES - SuperAgent Delegate

Workspace branch main. Observed package version 1.14.62.
All listed files are written in the real workspace, and the full source of each follows.

## REVISED - src/core/tools/toolsets.ts

~~~~typescript
/**

 * toolsets.ts — Per-tier tool definitions for the 3-tier multi-agent system.

 *

 * Master Agent  (depth 0): orchestration only — no direct coding

 * Superagent    (depth 1): full dev toolset, scoped to own worktree

 * Subagent      (depth 2): restricted toolset per specialization type

 */



import { Tool } from "./types.js";
import {
  delegateCreateChatTool,
  delegateReadChatTool,
  delegateSendMessageTool,
  delegateStopGenerationTool,
} from "./delegateTools.js";
import {
  studioGenerateTool,
  studioReviseTool,
  studioStatusTool,
  studioUpscaleTool,
  studioListProjectsTool,
  studioInspectProjectTool,
  studioEditProjectTool,
  studioClipEditTool,
  studioDesktopFocusTool,
  motionGenerateTool,
  motionReviseTool,
  motionStatusTool,
  motionUpscaleTool,
} from "./motionAgentTools.js";
import {

  readTool,



  globTool,

  grepTool,

  ripgrepSearchTool,

  writeToFileTool,

  replaceFileContentTool,

  multiReplaceFileContentTool,

  applyPatchTool,

} from "./systemTools.js";

import {

  bashTool,

  runCommandTool,

  runBackgroundProcessTool,

  manageBackgroundProcessTool,

  inspectBackgroundLogTool,

} from "./shellTools.js";

import { webSearchTool, fetchUrlTool } from "./networkTools.js";

import { searchJournalTool } from "./academicSearchTools.js";

import { readDocumentTool } from "./documentReadTools.js";

import { officeCliTool } from "./officeCliTools.js";

import {

  defineSubagentTool,

  invokeSubagentTool,

  sendMessageTool,

  manageSubagentsTool,

} from "./subagentTools.js";

import {

  askQuestionTool,

  scheduleTool,

  gitActionTool,

  screenshotTool,

  playwrightScreenshotTool,

  androidCliTool,

  searchHistoryTool,

  loadPinnedSessionTool,

  searchPinnedKnowledgeTool,

  gitWorktreeTool,

  manageTasksTool,

  listPeerSuperagentsTool,

  managePlanTool,

  getSkillsTool,

  useSkillTool,

  controlBrowserTabTool,

  controlBrowserMacroSaveTool,

  controlBrowserMacroRunTool,

} from "./otherTools.js";

import { listChromeProfilesTool } from "./chromeProfileTools.js";

import {

  launchChromeProfileTool,

  getActiveBrowserTabsTool,

  chromeExtensionStatusTool,

  manageChromeBookmarksTool,

  extractPageContentMarkdownTool,

  captureTabFullpagePdfTool,

} from "./chromeBrowserTools.js";

import {

  manageChromeHistoryTool,

  listChromeExtensionsTool,

  getBrowserConsoleLogsTool,

  getBrowserNetworkLogsTool,

  manageChromeDownloadsTool,

} from "./chromeAdvancedTools.js";

import {

  manageBrowserCookiesStorageTool,

  setBrowserEmulationTool,

  setNetworkConditionsTool,

} from "./chromeExtraTools.js";

import {

  listRunningChromeTool,

  closeChromeProfileTool,

} from "./chromeProcessTools.js";

import {

  runHeadlessBrowserTool,

  simulateVirtualCursorTool,

  controlIsolatedCdpTool,

} from "./advancedAutomationTools.js";

import { controlChromeCdpTool } from "./chromeCdpTools.js";

import { controlChromeVisionTool } from "./chromeVisionTools.js";

import { runListTools, runDescribeTool } from "./toolDiscoveryTools.js";



import {

  invokeSuperagentTool,

  awaitSuperagentsTool,

  mergeSuperagentsTool,

  manageSuperagentsTool,

  defineSuperagentTool,

  sendMessageToSuperagentTool,

  readPeerSuperagentFileTool,

} from "./superagentTools.js";



import {

  rmemoryStatusTool,

  rmemorySearchTool,

  rmemoryConversationSearchTool,

  rmemoryReadCosTool,

  rmemorySaveTool,

  rmemoryConversationAddTool,

  rmemoryInspectTool,

  rmemoryExportTool,

  rmemoryDeleteTool,

  rmemoryMigrateLegacyTool,

  rmemoryReviseTool,

  rmemoryMemoryReviewTool,

  rmemoryRetentionReviewTool,

  rmemoryTaskSummaryTool,

  rmemoryArchiveRecoveryTool,
  rmemorySuggestTool,
} from "./rmemoryTools.js";



import { manageMcpTool } from "./mcpTools.js";

import { saveSharedMemoryTool, readSharedMemoryTool } from "./sharedMemoryTools.js";

import { manageWorkspaceChainTool, crossWorkspaceExecTool } from "../workspace/workspaceChainTools.js";

import { unlockFileTool, getLockStatsTool, resolveConflictTool, generateLockReportTool } from "./lockTools.js";

import { transferSshFileTool } from "./sshTransferTools.js";

import { cliBridgeTool } from "./cliBridgeTool.js";

import { inspectSessionTool } from "./sessionTools.js";

import { synthesizeSkillTool } from "./synthesizeSkillTool.js";

import { listToolsTool, describeToolTool } from "./toolDiscoveryTools.js";

import {

  inspectPortTool,

  freePortTool,

  findProcessTool,

  killProcessTool,

} from "./processInspectionTools.js";

import { switchModeTool } from "./modeTools.js";

import { getRemoteServiceStatusTool } from "./remoteServiceTools.js";

import { getMuseDirectChatReadinessTool } from "./remoteChatTools.js";



// ─── Master Agent Toolset (depth 0) ─────────────────────────────────────────

// Orchestration only. The Master Agent MUST NOT directly modify code or

// Arbitrary shell execution and direct code editing belong to Superagent.

// The Master retains guarded file-write tools only for its own plan/task/

// walkthrough artifacts under ~/.superagent-r; enforceMasterWriteAllowlist()

// blocks codebase paths at execution time. See AGENTS.md §"Master Agent Planning".

export const masterToolset: Tool[] = [

  // ── Superagent orchestration (the core job of the Master) ──

  switchModeTool,

  askQuestionTool,

  invokeSuperagentTool,

  awaitSuperagentsTool,

  mergeSuperagentsTool,

  manageSuperagentsTool,

  defineSuperagentTool,

  sendMessageToSuperagentTool,

  manageSubagentsTool,

  // ── Read-only inspection ──

  readTool,

  readDocumentTool,

  globTool,

  grepTool,

  ripgrepSearchTool,

  webSearchTool,

  searchJournalTool,

  fetchUrlTool,

  searchHistoryTool,

  loadPinnedSessionTool,

  searchPinnedKnowledgeTool,

  inspectSessionTool,

  listToolsTool,

  describeToolTool,

  inspectPortTool,

  findProcessTool,

  getRemoteServiceStatusTool,

  getMuseDirectChatReadinessTool,

  inspectBackgroundLogTool,

  officeCliTool,

  // ── Planning & session management (writes only to ~/.superagent-r/) ──

  scheduleTool,

  manageTasksTool,

  managePlanTool,

  getSkillsTool,

  useSkillTool,

  synthesizeSkillTool,

  // The three write tools below ARE allowed in the master toolset because

  // the Master owns its own plan/task/walkthrough artifacts. The runtime

  // path-allowlist in the write tools' .execute() blocks writes to the

  // codebase for tier==="master" callers, so the Master cannot directly

  // edit source files. Codebase edits MUST be delegated to Superagents.

  writeToFileTool,

  replaceFileContentTool,

  multiReplaceFileContentTool,

  // ── Long-term memory & shared state (read+write, scoped to memory store) ──

  rmemoryStatusTool,

  rmemorySearchTool,

  rmemoryConversationSearchTool,

  rmemoryReadCosTool,

  rmemorySaveTool,

  rmemoryConversationAddTool,

  rmemoryInspectTool,

  rmemoryExportTool,

  rmemoryDeleteTool,

  rmemoryMigrateLegacyTool,

  rmemoryReviseTool,

  rmemoryMemoryReviewTool,

  rmemoryRetentionReviewTool,

  rmemoryTaskSummaryTool,

  rmemoryArchiveRecoveryTool,
  rmemorySuggestTool,
  saveSharedMemoryTool,

  readSharedMemoryTool,

  // ── Lock visibility (read-only stats; unlock/cross-workspace tools

  //    are intentionally NOT here — the Master delegates file edits to

  //    Superagents, which own their worktree's locks). ──

  getLockStatsTool,

  generateLockReportTool,

  // ── Worktree topology (read+add, NOT cross-workspace exec) ──

  gitWorktreeTool,

  // ── MCP is a master-tier concern (cross-tool integration setup) ──

  manageMcpTool,

];



// Defense-in-depth runtime allowlist. The MasterAgent runner consults

// this set before executing any tool call. If a tool name is not in

// ORCHESTRATION_TOOL_NAMES, the call is rejected with a clear error —

// even if the model is prompt-injected into trying to call it. This

// closes the gap between the static masterToolset (which may drift) and

// the intent in AGENTS.md.

export const ORCHESTRATION_TOOL_NAMES: ReadonlySet<string> = new Set(

  masterToolset.map((t) => t.name)

);



// ─── Superagent Toolset (depth 1) ────────────────────────────────────────────

// Full development toolset. Scoped to own worktree at runtime via permission layer.

export const superagentToolset: Tool[] = [

  studioGenerateTool,
  studioReviseTool,
  studioStatusTool,
  studioUpscaleTool,
  studioListProjectsTool,
  studioInspectProjectTool,
  studioEditProjectTool,
  studioClipEditTool,
  studioDesktopFocusTool,
  motionGenerateTool,
  motionReviseTool,
  motionStatusTool,
  motionUpscaleTool,
  switchModeTool,

  transferSshFileTool,

  readTool,

  readDocumentTool,

  officeCliTool,

  writeToFileTool,

  replaceFileContentTool,

  multiReplaceFileContentTool,

  applyPatchTool,

  globTool,

  grepTool,

  ripgrepSearchTool,

  bashTool,

  runCommandTool,

  runBackgroundProcessTool,

  manageBackgroundProcessTool,

  inspectPortTool,

  freePortTool,

  findProcessTool,

  killProcessTool,

  getRemoteServiceStatusTool,

  getMuseDirectChatReadinessTool,

  inspectBackgroundLogTool,

  webSearchTool,

  fetchUrlTool,

  searchJournalTool,

  gitActionTool,         // commit to own branch

  gitWorktreeTool,

  manageTasksTool,

  managePlanTool,

  getSkillsTool,

  useSkillTool,

  synthesizeSkillTool,

  manageMcpTool,

  listPeerSuperagentsTool,

  defineSubagentTool,    // define specialized subagents

  invokeSubagentTool,    // spawn subagents (depth 2)

  sendMessageTool,

  manageSubagentsTool,

  askQuestionTool,

  scheduleTool,

  searchHistoryTool,

  loadPinnedSessionTool,

  searchPinnedKnowledgeTool,

  inspectSessionTool,

  androidCliTool,

  playwrightScreenshotTool,

  readPeerSuperagentFileTool, // read files from peer Superagent worktrees

  rmemoryStatusTool,

  rmemorySearchTool,

  rmemoryConversationSearchTool,

  rmemoryReadCosTool,

  rmemorySaveTool,

  rmemoryConversationAddTool,

  rmemoryInspectTool,

  rmemoryExportTool,

  rmemoryDeleteTool,

  rmemoryMigrateLegacyTool,

  rmemoryReviseTool,

  rmemoryMemoryReviewTool,

  rmemoryRetentionReviewTool,

  rmemoryTaskSummaryTool,

  rmemoryArchiveRecoveryTool,
  rmemorySuggestTool,
  saveSharedMemoryTool,

  readSharedMemoryTool,

  getLockStatsTool,

  generateLockReportTool,

  manageWorkspaceChainTool,

  crossWorkspaceExecTool,

  cliBridgeTool,           // delegate tasks to external AI CLIs (codex/claude/agy)

  // ─── Chrome Automation & Browser Control (Extension-Free) ───

  controlChromeCdpTool,    // extension-free native Chrome DevTools Protocol automation (port 9222)

  controlChromeVisionTool, // local UI-DETR-1 vision AI automation (port 8095)

  listRunningChromeTool,   // inspect running Chrome windows, tabs, and profiles

  closeChromeProfileTool,  // close target Chrome profile window

  listChromeProfilesTool,  // list available Chrome user profiles

  launchChromeProfileTool, // launch Chrome with profile, optional URL, and remoteDebuggingPort

  listToolsTool,

  describeToolTool,

];



// ─── Chrome Extension Toolset (depth 1) ──────────────────────────────────────

// --- Visible ONLY in chrome-extension chat mode --------------------------------

// The 12 browser tools below require the Superagent Chrome Extension on the

// TARGET Chrome. They are registered ONLY when this server serves the extension

// sidepanel chat (clientMode "chrome-extension") -- the one mode where the

// extension is guaranteed present. In every other mode, filterExtensionChatTools()

// excludes them from the registered tool list (and therefore from the model

// prompt). control_chrome_cdp is the extension-free path and is never filtered.

export const EXTENSION_CHAT_HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set([

  "get_active_browser_tabs",

  "control_isolated_cdp",

  "extract_page_content_markdown",

  "capture_tab_fullpage_pdf",

  "manage_chrome_history",

  "get_browser_console_logs",

  "get_browser_network_logs",

  "manage_browser_cookies_storage",

  "set_browser_emulation",

  "set_network_conditions",

  "run_headless_browser",

  "simulate_virtual_cursor",

]);



export function filterExtensionChatTools(tools: Tool[]): Tool[] {

  return tools.filter((t) => !EXTENSION_CHAT_HIDDEN_TOOL_NAMES.has(t.name));

}



/**

 * Replace list_tools / describe_tool with mode-aware versions bound to the

 * given visible toolset. In non-extension modes the 12 extension-dependent

 * browser tools (EXTENSION_CHAT_HIDDEN_TOOL_NAMES) are absent from listings,

 * and describe_tool reports them as unavailable-in-this-mode instead of

 * returning their schema. control_chrome_cdp is never hidden.

 * In chrome-extension chat mode (isExtensionChatMode=true) listings cover

 * the full toolset.

 */

export function withModeAwareDiscoveryTools(tools: Tool[], isExtensionChatMode: boolean): Tool[] {

  const base = tools.filter((t) => t.name !== "list_tools" && t.name !== "describe_tool");

  const visible: Tool[] = [...base];



  const listTools: Tool = {

    ...listToolsTool,

    execute: async (args: Record<string, unknown>) =>

      runListTools(

        visible.map((t) => ({ name: t.name, description: t.description })),

        args

      ),

  };



  const matchVisible = (name: string) => {

    const clean = name.trim().replace(/^['"`]+|['"`]+$/g, "");

    if (!clean) return undefined;

    return (

      visible.find((t) => t.name === clean) ??

      visible.find((t) => t.name.toLowerCase() === clean.toLowerCase()) ??

      visible.find(

        (t) => t.name.toLowerCase().replace(/[-_]/g, "_") === clean.toLowerCase().replace(/[-_]/g, "_")

      )

    );

  };



  const describeTool: Tool = {

    ...describeToolTool,

    execute: async (args: Record<string, unknown>) =>

      runDescribeTool(visible, args, {

        findTool: matchVisible,

        unavailableMessage: (name: string) =>

          !isExtensionChatMode && EXTENSION_CHAT_HIDDEN_TOOL_NAMES.has(name)

            ? `"${name}" is not available in this mode. It requires the Superagent Chrome Extension and is only active in chrome-extension chat mode. For extension-free Chrome automation, use control_chrome_cdp.`

            : undefined,

      }),

  };



  visible.push(listTools, describeTool);

  return visible;

}



// Dedicated delegate extension RPC tools. Not part of Master or its allowlist.
export const delegateToolset: Tool[] = [
  delegateCreateChatTool,
  delegateReadChatTool,
  delegateSendMessageTool,
  delegateStopGenerationTool,
];

export const chromeExtensionToolset: Tool[] = [

  switchModeTool,

  readTool,

  writeToFileTool,

  replaceFileContentTool,

  multiReplaceFileContentTool,

  applyPatchTool,

  globTool,

  grepTool,

  ripgrepSearchTool,

  bashTool,

  runCommandTool,

  runBackgroundProcessTool,

  manageBackgroundProcessTool,

  inspectPortTool,

  freePortTool,

  findProcessTool,

  killProcessTool,

  inspectBackgroundLogTool,

  webSearchTool,

  fetchUrlTool,

  gitActionTool,

  gitWorktreeTool,

  manageTasksTool,

  managePlanTool,

  getSkillsTool,

  useSkillTool,

  manageMcpTool,

  defineSubagentTool,

  invokeSubagentTool,

  sendMessageTool,

  manageSubagentsTool,

  askQuestionTool,

  scheduleTool,

  searchHistoryTool,

  loadPinnedSessionTool,

  searchPinnedKnowledgeTool,

  inspectSessionTool,

  listToolsTool,

  describeToolTool,

  androidCliTool,

  rmemoryStatusTool,

  rmemorySearchTool,

  rmemoryConversationSearchTool,

  rmemoryReadCosTool,

  rmemorySaveTool,

  rmemoryConversationAddTool,

  saveSharedMemoryTool,

  readSharedMemoryTool,

  getLockStatsTool,

  generateLockReportTool,

  // ─── Chrome & Browser Control Tools ───

  controlBrowserTabTool,

  controlBrowserMacroSaveTool,

  controlBrowserMacroRunTool,

  listChromeProfilesTool,

  launchChromeProfileTool,

  getActiveBrowserTabsTool,

  chromeExtensionStatusTool,

  manageChromeBookmarksTool,

  extractPageContentMarkdownTool,

  captureTabFullpagePdfTool,

  manageChromeHistoryTool,

  listChromeExtensionsTool,

  getBrowserConsoleLogsTool,

  getBrowserNetworkLogsTool,

  manageChromeDownloadsTool,

  manageBrowserCookiesStorageTool,

  setBrowserEmulationTool,

  setNetworkConditionsTool,

  runHeadlessBrowserTool,

  simulateVirtualCursorTool,

  controlIsolatedCdpTool,

  controlChromeCdpTool,

  controlChromeVisionTool,

  screenshotTool,

  playwrightScreenshotTool,

  listRunningChromeTool,

  closeChromeProfileTool,

];





// ─── Subagent Toolsets (depth 2) — keyed by type name ───────────────────────

export const subagentToolsets: Record<string, Tool[]> = {

  researcher: [

    readTool,

    readDocumentTool,

    officeCliTool,

    globTool,

    grepTool,

    ripgrepSearchTool,

    webSearchTool,

    fetchUrlTool,

    searchJournalTool,

    searchHistoryTool,

    loadPinnedSessionTool,

    searchPinnedKnowledgeTool,

    inspectSessionTool,

    inspectBackgroundLogTool,

    getRemoteServiceStatusTool,

    getMuseDirectChatReadinessTool,

    askQuestionTool,

    getSkillsTool,

    useSkillTool,

    rmemorySearchTool,

    rmemoryConversationSearchTool,

    rmemoryReadCosTool,

    readSharedMemoryTool,

    sendMessageTool,

  ],



  coder: [

    transferSshFileTool,

    readTool,

    readDocumentTool,

    officeCliTool,

    writeToFileTool,

    replaceFileContentTool,

    multiReplaceFileContentTool,

    applyPatchTool,

    globTool,

    grepTool,

    ripgrepSearchTool,

    runCommandTool,

    bashTool,

    inspectPortTool,

    freePortTool,

    findProcessTool,

    killProcessTool,

    inspectBackgroundLogTool,

    webSearchTool,

    searchJournalTool,

    askQuestionTool,

    getSkillsTool,

    useSkillTool,

    rmemorySearchTool,

    rmemoryConversationSearchTool,

    rmemoryReadCosTool,

    readSharedMemoryTool,

    getLockStatsTool,

    sendMessageTool,

  ],



  reviewer: [

    readTool,

    readDocumentTool,

    officeCliTool,

    globTool,

    grepTool,

    ripgrepSearchTool,

    inspectBackgroundLogTool,

    webSearchTool,

    searchJournalTool,

    askQuestionTool,

    getSkillsTool,

    useSkillTool,

    rmemorySearchTool,

    rmemoryConversationSearchTool,

    rmemoryReadCosTool,

    readSharedMemoryTool,

  ],



  "software-tester": [

    readTool,

    globTool,

    grepTool,

    runCommandTool,

    bashTool,

    runBackgroundProcessTool,

    manageBackgroundProcessTool,

    inspectPortTool,

    freePortTool,

    findProcessTool,

    killProcessTool,

    inspectBackgroundLogTool,

    getRemoteServiceStatusTool,

    webSearchTool,

    controlChromeCdpTool,

    controlChromeVisionTool,

    screenshotTool,

    playwrightScreenshotTool,

    askQuestionTool,

    getSkillsTool,

    useSkillTool,

    rmemorySearchTool,

    rmemoryConversationSearchTool,

    rmemoryReadCosTool,

  ],



  "security-engineer": [

    readTool,

    globTool,

    grepTool,

    ripgrepSearchTool,

    webSearchTool,

    askQuestionTool,

    getSkillsTool,

    useSkillTool,

    rmemorySearchTool,

    rmemoryConversationSearchTool,

    rmemoryReadCosTool,

    readSharedMemoryTool,

  ],



  "chrome-agent": [

    controlBrowserTabTool,

    controlBrowserMacroSaveTool,

    controlBrowserMacroRunTool,

    listChromeProfilesTool,

    launchChromeProfileTool,

    listRunningChromeTool,

    closeChromeProfileTool,

    getActiveBrowserTabsTool,

    chromeExtensionStatusTool,

    manageChromeBookmarksTool,

    extractPageContentMarkdownTool,

    captureTabFullpagePdfTool,

    manageChromeHistoryTool,

    listChromeExtensionsTool,

    getBrowserConsoleLogsTool,

    getBrowserNetworkLogsTool,

    manageChromeDownloadsTool,

    manageBrowserCookiesStorageTool,

    setBrowserEmulationTool,

    setNetworkConditionsTool,

    runHeadlessBrowserTool,

    simulateVirtualCursorTool,

    controlIsolatedCdpTool,

    controlChromeCdpTool,

    controlChromeVisionTool,

    screenshotTool,

    playwrightScreenshotTool,

    readTool,

    globTool,

    grepTool,

    ripgrepSearchTool,

    webSearchTool,

    askQuestionTool,

    getSkillsTool,

    useSkillTool,

    sendMessageTool,

  ],

};



/** Read-only fallback toolset for unrecognized subagent types */

export const defaultSubagentToolset: Tool[] = [

  readTool,

  globTool,

  grepTool,

  ripgrepSearchTool,

  webSearchTool,

  inspectSessionTool,

  getRemoteServiceStatusTool,

  askQuestionTool,

  getSkillsTool,

  useSkillTool,

  sendMessageTool,

  listToolsTool,

  describeToolTool,

];



/**

 * Options for resolving subagent toolset.

 */

export interface ResolveSubagentToolsetOptions {

  toolset?: string;

  baseType?: string;

  enableWriteTools?: boolean;

}



/**

 * Determine the base specialization type from a subagent type name.

 */

export function resolveBaseTypeFromTypeName(typeName?: string): string | undefined {

  if (!typeName) return undefined;

  const normalized = typeName.toLowerCase().trim();



  // Direct match with built-in subagent types

  if (subagentToolsets[normalized]) return normalized;



  // Coder / file modification patterns

  if (

    normalized.includes("coder") ||

    normalized.includes("coding") ||

    normalized.includes("developer") ||

    normalized.includes("dev") ||

    (normalized.includes("engineer") && !normalized.includes("security")) ||

    normalized.includes("migration") ||

    normalized.includes("port") ||

    normalized.includes("writer") ||

    normalized.includes("editor") ||

    normalized.includes("builder") ||

    normalized.includes("fixer") ||

    normalized.includes("fix") ||

    normalized.includes("patch") ||

    normalized.includes("refactor") ||

    normalized.includes("creator") ||

    normalized.includes("generator") ||

    normalized.includes("dataset") ||

    normalized.includes("scaffold")

  ) {

    return "coder";

  }



  // Software tester / QA patterns

  if (

    normalized.includes("test") ||

    normalized.includes("qa") ||

    normalized.includes("cypress") ||

    normalized.includes("playwright") ||

    normalized.includes("benchmark")

  ) {

    return "software-tester";

  }



  // Security engineer patterns

  if (

    normalized.includes("security") ||

    normalized.includes("vuln") ||

    normalized.includes("audit") ||

    normalized.includes("scanner")

  ) {

    return "security-engineer";

  }



  // Reviewer patterns

  if (

    normalized.includes("review") ||

    normalized.includes("critique") ||

    normalized.includes("evaluat") ||

    normalized.includes("checker")

  ) {

    return "reviewer";

  }



  // Chrome agent patterns

  if (

    normalized.includes("chrome") ||

    normalized.includes("browser") ||

    normalized.includes("web-control") ||

    normalized.includes("dom")

  ) {

    return "chrome-agent";

  }



  // Researcher patterns

  if (

    normalized.includes("research") ||

    normalized.includes("search") ||

    normalized.includes("explore") ||

    normalized.includes("gather") ||

    normalized.includes("scout") ||

    normalized.includes("survey")

  ) {

    return "researcher";

  }



  return undefined;

}



/**

 * Intelligently resolves the toolset for any subagent type.

 * Handles exact matches, explicit options (toolset/baseType/enableWriteTools),

 * and semantic/keyword heuristics so that custom names like "migration-coder"

 * or "python-developer" automatically receive the appropriate tools (e.g. coder).

 */

export function resolveSubagentToolset(

  typeName?: string,

  options?: ResolveSubagentToolsetOptions

): Tool[] {

  if (!typeName && !options) return defaultSubagentToolset;



  // 1. Explicit options

  if (options?.enableWriteTools === true) {

    return subagentToolsets["coder"] || defaultSubagentToolset;

  }

  if (options?.toolset && subagentToolsets[options.toolset]) {

    return subagentToolsets[options.toolset];

  }

  if (options?.baseType && subagentToolsets[options.baseType]) {

    return subagentToolsets[options.baseType];

  }



  if (!typeName) return defaultSubagentToolset;



  // 2. Exact match in subagentToolsets

  if (subagentToolsets[typeName]) {

    return subagentToolsets[typeName];

  }



  // 3. Resolve base type by keyword/semantic heuristic

  const baseType = resolveBaseTypeFromTypeName(typeName);

  if (baseType && subagentToolsets[baseType]) {

    return subagentToolsets[baseType];

  }



  return defaultSubagentToolset;

}
~~~~

## REVISED - src/core/tools/index.ts

~~~~typescript
import fs from "fs";

import path from "path";

import { Tool } from "./types.js";

import {
  studioGenerateTool,
  studioReviseTool,
  studioStatusTool,
  studioUpscaleTool,
  studioListProjectsTool,
  studioInspectProjectTool,
  studioEditProjectTool,
  studioClipEditTool,
  studioDesktopFocusTool,
  motionGenerateTool,
  motionReviseTool,
  motionStatusTool,
  motionUpscaleTool,
} from "./motionAgentTools.js";
import { registerSubagentType } from "./state.js";

import {

  masterToolset,

  superagentToolset,

  subagentToolsets,

  defaultSubagentToolset,

  chromeExtensionToolset,
  delegateToolset
} from "./toolsets.js";

import { loadDynamicHooks } from "./dynamicHooks.js";

import { bumpToolRegistryVersion } from "./toolRegistryVersion.js";



// ─── H2+H8 (audit fix) ─────────────────────────────────────────────────

//

// We must NOT statically import `../prompts.js` here. The prompts

// module depends on the tools registry (or on toolsets.js, which in

// turn lazily imports prompts.js), so a top-level import of

// SUBAGENT_SYSTEM_PROMPTS would create a circular dependency that

// resolves with an empty `{}` at module load time and silently breaks

// subagent system prompts.

//

// We instead lazily import prompts.js inside a tiny async bootstrap

// helper, and defer `registerSubagentType(...)` calls until the

// registry is asked for the first time. This preserves the public

// shape of the module while breaking the cycle.

let _promptsReady: Promise<{ SUBAGENT_SYSTEM_PROMPTS: Record<string, string> }> | null = null;

async function loadPrompts() {

  if (!_promptsReady) {

    _promptsReady = import("../prompts.js").then((m) => ({

      SUBAGENT_SYSTEM_PROMPTS: m.SUBAGENT_SYSTEM_PROMPTS as Record<string, string>,

    }));

  }

  return _promptsReady;

}



import {

  readTool,

  writeTool,

  editTool,

  globTool,

  grepTool,

  ripgrepSearchTool,

  writeToFileTool,

  replaceFileContentTool, 

  multiReplaceFileContentTool, 

  applyPatchTool 

} from "./systemTools.js";



import { 

  bashTool, 

  runCommandTool, 

  runBackgroundProcessTool, 

  manageBackgroundProcessTool,

  inspectBackgroundLogTool

} from "./shellTools.js";



import { 

  webSearchTool, 

  fetchUrlTool 

} from "./networkTools.js";



import { 

  defineSubagentTool, 

  invokeSubagentTool, 

  sendMessageTool, 

  manageSubagentsTool 

} from "./subagentTools.js";



import {

  invokeSuperagentTool,

  awaitSuperagentsTool,

  mergeSuperagentsTool,

  manageSuperagentsTool,

  defineSuperagentTool,

  sendMessageToSuperagentTool,

  readPeerSuperagentFileTool,

} from "./superagentTools.js";



import {

  rmemoryStatusTool,

  rmemorySearchTool,

  rmemoryConversationSearchTool,

  rmemoryReadCosTool,

  rmemorySaveTool,

  rmemoryConversationAddTool,

  rmemoryInspectTool,

  rmemoryExportTool,

  rmemoryDeleteTool,

  rmemoryMigrateLegacyTool,

  rmemoryReviseTool,

  rmemoryMemoryReviewTool,

  rmemoryRetentionReviewTool,

  rmemoryTaskSummaryTool,

  rmemoryArchiveRecoveryTool,
  rmemorySuggestTool,
} from "./rmemoryTools.js";



import { manageMcpTool } from "./mcpTools.js";

import { saveSharedMemoryTool, readSharedMemoryTool } from "./sharedMemoryTools.js";

import { unlockFileTool, getLockStatsTool, resolveConflictTool, generateLockReportTool } from "./lockTools.js";



import { 

  askQuestionTool, 

  scheduleTool, 

  gitActionTool, 

  screenshotTool, 

  playwrightScreenshotTool,

  androidCliTool,

  searchHistoryTool,

  loadPinnedSessionTool,

  searchPinnedKnowledgeTool,

  manageTasksTool,

  gitWorktreeTool,

  listPeerSuperagentsTool,

  managePlanTool,

  getSkillsTool,

  useSkillTool,

  controlBrowserTabTool,

  controlBrowserMacroSaveTool,

  controlBrowserMacroRunTool

} from "./otherTools.js";



import { searchJournalTool } from "./academicSearchTools.js";

import { readDocumentTool } from "./documentReadTools.js";

import { officeCliTool } from "./officeCliTools.js";

import { listChromeProfilesTool } from "./chromeProfileTools.js";

import {

  launchChromeProfileTool,

  getActiveBrowserTabsTool,

  chromeExtensionStatusTool,

  manageChromeBookmarksTool,

  extractPageContentMarkdownTool,

  captureTabFullpagePdfTool,

} from "./chromeBrowserTools.js";

import {

  manageChromeHistoryTool,

  listChromeExtensionsTool,

  getBrowserConsoleLogsTool,

  getBrowserNetworkLogsTool,

  manageChromeDownloadsTool,

} from "./chromeAdvancedTools.js";

import {

  manageBrowserCookiesStorageTool,

  setBrowserEmulationTool,

  setNetworkConditionsTool,

} from "./chromeExtraTools.js";

import {

  listRunningChromeTool,

  closeChromeProfileTool,

  closeChromeWindowTool,

} from "./chromeProcessTools.js";

import {

  runHeadlessBrowserTool,

  simulateVirtualCursorTool,

  controlIsolatedCdpTool,

} from "./advancedAutomationTools.js";

import { controlChromeCdpTool } from "./chromeCdpTools.js";

import { controlChromeVisionTool } from "./chromeVisionTools.js";

import { transferSshFileTool } from "./sshTransferTools.js";

import { cliBridgeTool } from "./cliBridgeTool.js";

import { inspectSessionTool } from "./sessionTools.js";

import { synthesizeSkillTool } from "./synthesizeSkillTool.js";



import {

  inspectPortTool,

  freePortTool,

  findProcessTool,

  killProcessTool,

} from "./processInspectionTools.js";

import { getRemoteServiceStatusTool } from "./remoteServiceTools.js";

import { getMuseDirectChatReadinessTool } from "./remoteChatTools.js";



export {

  getRemoteServiceStatusTool,

  getMuseDirectChatReadinessTool,

  listChromeProfilesTool,

  launchChromeProfileTool,

  getActiveBrowserTabsTool,

  chromeExtensionStatusTool,

  manageChromeBookmarksTool,

  extractPageContentMarkdownTool,

  captureTabFullpagePdfTool,

  manageChromeHistoryTool,

  listChromeExtensionsTool,

  getBrowserConsoleLogsTool,

  getBrowserNetworkLogsTool,

  manageChromeDownloadsTool,

  manageBrowserCookiesStorageTool,

  setBrowserEmulationTool,

  setNetworkConditionsTool,

  listRunningChromeTool,

  closeChromeProfileTool,

  closeChromeWindowTool,

  runHeadlessBrowserTool,

  simulateVirtualCursorTool,

  controlIsolatedCdpTool,

  controlChromeCdpTool,

  controlChromeVisionTool,

  cliBridgeTool,

  inspectSessionTool,

  synthesizeSkillTool,

  inspectPortTool,

  freePortTool,

  findProcessTool,

  killProcessTool,

  inspectBackgroundLogTool,

  switchModeTool,

};

import { manageWorkspaceChainTool, crossWorkspaceExecTool } from "../workspace/workspaceChainTools.js";

import { listToolsTool, describeToolTool } from "./toolDiscoveryTools.js";

import { switchModeTool } from "./modeTools.js";





export const allTools: Tool[] = [
  ...delegateToolset,
  studioGenerateTool,
  studioReviseTool,
  studioStatusTool,
  studioUpscaleTool,
  studioListProjectsTool,
  studioInspectProjectTool,
  studioEditProjectTool,
  studioClipEditTool,
  studioDesktopFocusTool,
  motionGenerateTool,
  motionReviseTool,
  motionStatusTool,
  motionUpscaleTool,
  switchModeTool,

  runHeadlessBrowserTool,

  simulateVirtualCursorTool,

  controlIsolatedCdpTool,

  controlChromeCdpTool,

  controlChromeVisionTool,

  listRunningChromeTool,

  closeChromeProfileTool,

  closeChromeWindowTool,

  listChromeProfilesTool,

  launchChromeProfileTool,

  getActiveBrowserTabsTool,

  chromeExtensionStatusTool,

  manageChromeBookmarksTool,

  extractPageContentMarkdownTool,

  captureTabFullpagePdfTool,

  manageChromeHistoryTool,

  listChromeExtensionsTool,

  getBrowserConsoleLogsTool,

  getBrowserNetworkLogsTool,

  manageChromeDownloadsTool,

  manageBrowserCookiesStorageTool,

  setBrowserEmulationTool,

  setNetworkConditionsTool,

  searchJournalTool,

  readDocumentTool,

  officeCliTool,

  readTool,

  writeTool,

  editTool,

  askQuestionTool,

  globTool,

  grepTool,

  webSearchTool,

  fetchUrlTool,

  ripgrepSearchTool,

  bashTool,

  runBackgroundProcessTool,

  writeToFileTool,

  replaceFileContentTool,

  multiReplaceFileContentTool,

  runCommandTool,

  manageBackgroundProcessTool,

  scheduleTool,

  defineSubagentTool,

  invokeSubagentTool,

  sendMessageTool,

  manageSubagentsTool,

  invokeSuperagentTool,

  awaitSuperagentsTool,

  mergeSuperagentsTool,

  manageSuperagentsTool,

  defineSuperagentTool,

  sendMessageToSuperagentTool,

  applyPatchTool,

  listToolsTool,

  describeToolTool,

  gitActionTool,

  gitWorktreeTool,

  screenshotTool,

  playwrightScreenshotTool,

  androidCliTool,

  searchHistoryTool,

  loadPinnedSessionTool,

  searchPinnedKnowledgeTool,

  manageTasksTool,

  listPeerSuperagentsTool,

  managePlanTool,

  getSkillsTool,

  useSkillTool,

  controlBrowserTabTool,

  controlBrowserMacroSaveTool,

  controlBrowserMacroRunTool,

  manageMcpTool,

  rmemoryStatusTool,

  rmemorySearchTool,

  rmemoryConversationSearchTool,

  rmemoryReadCosTool,

  rmemorySaveTool,

  rmemoryConversationAddTool,

  rmemoryInspectTool,

  rmemoryExportTool,

  rmemoryDeleteTool,

  rmemoryMigrateLegacyTool,

  rmemoryReviseTool,

  rmemoryMemoryReviewTool,

  rmemoryRetentionReviewTool,

  rmemoryTaskSummaryTool,

  rmemoryArchiveRecoveryTool,
  rmemorySuggestTool,
  saveSharedMemoryTool,

  readSharedMemoryTool,

  unlockFileTool,

  getLockStatsTool,

  resolveConflictTool,

  generateLockReportTool,

  readPeerSuperagentFileTool,

  manageWorkspaceChainTool,

  crossWorkspaceExecTool,

  transferSshFileTool,

  cliBridgeTool,

  inspectSessionTool,

  synthesizeSkillTool,

  inspectPortTool,

  freePortTool,

  findProcessTool,

  killProcessTool,

  inspectBackgroundLogTool,

  getRemoteServiceStatusTool,

  getMuseDirectChatReadinessTool,
];



import { TOOL_ALIASES, canonicalizeToolName } from "./toolAliases.js";

export { TOOL_ALIASES, canonicalizeToolName };



export function getToolByName(name: string): Tool | undefined {

  if (!name || typeof name !== "string") return undefined;

  const clean = name.trim().replace(/^['"`]+|['"`]+$/g, "");

  if (!clean) return undefined;



  // 1. Exact match

  const exact = allTools.find((t) => t.name === clean);

  if (exact) return exact;



  // 2. Case-insensitive match

  const lower = clean.toLowerCase();

  const caseMatch = allTools.find((t) => t.name.toLowerCase() === lower);

  if (caseMatch) return caseMatch;



  // 3. Hyphen vs underscore normalization

  const norm = lower.replace(/[-_]/g, "_");

  const normMatch = allTools.find((t) => t.name.toLowerCase().replace(/[-_]/g, "_") === norm);

  if (normMatch) return normMatch;



  // 4. Common aliases

  const aliasTarget = TOOL_ALIASES[norm];

  if (aliasTarget) {

    const aliasMatch = allTools.find((t) => t.name === aliasTarget);

    if (aliasMatch) return aliasMatch;

  }



  return undefined;

}



export function getToolDefinitions(): Array<{

  name: string;

  description: string;

  input_schema: Record<string, unknown>;

}> {

  return allTools.map((t) => ({

    name: t.name,

    description: t.description,

    input_schema: t.parameters,

  }));

}



// Re-export state, helpers, and toolsets

export * from "./types.js";

export * from "./helpers.js";

export * from "./state.js";

export * from "./toolsets.js";

export { killProcessTree } from "./shellTools.js";



// Register default subagent types — performed lazily to break the

// static `../prompts.js` import cycle (audit fix H2+H8). The CLI

// entry point awaits `bootstrapSubagentTypes()` before any subagent

// is invoked.

let _defaultTypesRegistered = false;

export async function bootstrapSubagentTypes(): Promise<void> {

  if (_defaultTypesRegistered) return;

  const { SUBAGENT_SYSTEM_PROMPTS } = await loadPrompts();

  registerSubagentType(

    "researcher",

    "Specialized in codebase research, file analysis, web searching, and gathering context/information without modifications.",

    SUBAGENT_SYSTEM_PROMPTS.researcher

  );

  registerSubagentType(

    "coder",

    "Specialized in writing code, editing files, implementing features, and refactoring codebase files.",

    SUBAGENT_SYSTEM_PROMPTS.coder

  );

  registerSubagentType(

    "reviewer",

    "Specialized in code review, quality checks, debugging, testing, and finding bugs/flaws.",

    SUBAGENT_SYSTEM_PROMPTS.reviewer

  );

  registerSubagentType(

    "software-tester",

    "Specialized in browser testing (Playwright), analyzing console logs/errors, and visual UI/UX design taste checks.",

    SUBAGENT_SYSTEM_PROMPTS["software-tester"]

  );

  registerSubagentType(

    "security-engineer",

    "Specialized in identifying vulnerabilities, performing threat modeling, auditing code, and security architecture review.",

    SUBAGENT_SYSTEM_PROMPTS["security-engineer"]

  );

  registerSubagentType(

    "general",

    "General purpose subagent for multi-disciplinary tasks, versatile execution, and general problem solving.",

    SUBAGENT_SYSTEM_PROMPTS.general

  );

  registerSubagentType(

    "writer",

    "Specialized in technical writing, documentation, blog posts, articles, release notes, and copy creation.",

    SUBAGENT_SYSTEM_PROMPTS.writer

  );

  registerSubagentType(

    "chrome-agent",

    "Specialized subagent for browser automation, web research, Chrome profiles, DOM automation, and handling all Chrome-related tools.",

    SUBAGENT_SYSTEM_PROMPTS["chrome-agent"]

  );

  _defaultTypesRegistered = true;

}



let loadedDynamicTools: Tool[] = [];

let watcher: fs.FSWatcher | null = null;



export function refreshDynamicHooks(): void {

  bumpToolRegistryVersion();

  // 1. Remove previous dynamic tools from all sets

  if (loadedDynamicTools.length > 0) {

    const toRemoveNames = new Set(loadedDynamicTools.map(t => t.name));

    

    const filterArray = (arr: any[]) => {

      for (let i = arr.length - 1; i >= 0; i--) {

        const item = arr[i];

        const name = typeof item === "string" ? item : item?.name;

        if (name && toRemoveNames.has(name)) {

          arr.splice(i, 1);

        }

      }

    };



    if (Array.isArray(allTools)) filterArray(allTools);

    if (Array.isArray(masterToolset)) filterArray(masterToolset);

    if (Array.isArray(superagentToolset)) filterArray(superagentToolset);

    if (Array.isArray(chromeExtensionToolset)) filterArray(chromeExtensionToolset);

    if (Array.isArray(defaultSubagentToolset)) filterArray(defaultSubagentToolset);

    if (subagentToolsets && typeof subagentToolsets === "object") {

      for (const key of Object.keys(subagentToolsets)) {

        if (Array.isArray(subagentToolsets[key])) {

          filterArray(subagentToolsets[key]);

        }

      }

    }

  }



  // 2. Load and add new dynamic tools

  try {

    loadedDynamicTools = loadDynamicHooks();

    if (loadedDynamicTools.length > 0) {

      if (Array.isArray(allTools)) allTools.push(...loadedDynamicTools);

      if (Array.isArray(masterToolset)) masterToolset.push(...loadedDynamicTools);

      if (Array.isArray(superagentToolset)) superagentToolset.push(...loadedDynamicTools);

      if (Array.isArray(chromeExtensionToolset)) chromeExtensionToolset.push(...loadedDynamicTools);

      if (Array.isArray(defaultSubagentToolset)) defaultSubagentToolset.push(...loadedDynamicTools);

      if (subagentToolsets && typeof subagentToolsets === "object") {

        for (const key of Object.keys(subagentToolsets)) {

          if (Array.isArray(subagentToolsets[key])) {

            subagentToolsets[key].push(...loadedDynamicTools);

          }

        }

      }

    }

  } catch (err: any) {

    console.error("[Dynamic Hooks Loader Error]", err.message);

  }



  // 3. Setup file watcher for hot-reloading (skip in Vitest to avoid open handle warnings)

  if (!watcher && !process.env.VITEST) {

    try {

      const hooksRoot = path.join(process.cwd(), "internal-hooks");

      if (fs.existsSync(hooksRoot)) {

        watcher = fs.watch(hooksRoot, { recursive: true }, (eventType, filename) => {

          if (filename && (filename.endsWith("hook.json") || filename.includes("hook.json"))) {

            refreshDynamicHooks();

          }

        });

      }

    } catch (err) {

      // Ignore

    }

  }

}



// Load dynamic internal hooks on startup

refreshDynamicHooks();
~~~~

## REVISED - src/server.ts

~~~~typescript
import http from "http";
import crypto from "node:crypto";
import net from "net";
import { URL } from "url";
import fs from "fs";
import path from "path";
import { tryStatSync } from "./core/tools/helpers.js";
import os from "os";
import { Agent } from "./core/agent.js";
import type { AgentEvent } from "./core/agent.js";
import { getConfig, getSettings, getConfiguredProviders, addTrustedDirectory, ensureDirectoryTrusted, getPresets, getActivePresetId, setActivePresetId, updateSettings, listHistorySessions, getTrustedDirectories, closeHistoryDb, generateSessionId, purgeEmptySessions, getPackageRootDir, getInstalledSkills, getSuperAgentVersion, getRootConfigDir } from "./core/config.js";
import { readChecklistTasks, ReadChecklistResult } from "./core/taskChecklist.js";
import { subagentInstances, superagentInstances, backgroundTasks, scheduledJobs, registerMasterAgent, subscribeToActiveOutput, subscribeToSubagents, subscribeToSuperagents, registerQuestionHandler } from "./core/tools/state.js";
import { evaluateCoreDrain } from "./core/runtime/coreDrainInspection.js";
import { setBrowserControlHandler } from "./core/tools/otherTools.js";
import { getBrowserMacros, saveBrowserMacro, deleteBrowserMacro } from "./core/config/browserMacros.js";
import { execSync } from "child_process";
import { handleServerRoute } from "./serverRoutes.js";
import { lockEventEmitter } from "./core/storage/sharedMemory.js";
import { buildCorsHeaders, ensureServerAuthToken, isRequestAuthorized, isPathInsideOrEqual } from "./core/utils/serverSecurity.js";
import { isCanonicalMotionWorkspaceAllowed } from "./core/motion/workspaceAccess.js";
import { shouldDeliverEventToClient } from "./core/utils/sessionEventScope.js";
import { SessionEventReplay } from "./core/utils/sessionEventReplay.js";
import { appendChatEvent, pruneChatRuntimeLedger, recoverInterruptedChatTurns, replayChatEvents } from "./core/utils/chatRuntimeLedger.js";
import { recordAgentTimeline, projectAgentTimelineEnvelope, bindTlineRootAgent } from "./core/channels/tlineAgentTimeline.js";
import { registerTlineApproval } from "./core/channels/tlineApprovalRegistry.js";

// Forward lock events to connected t-line desktop clients
lockEventEmitter.on("tline_bridge_sync", (syncPayload) => {
  broadcastEvent({
    type: "tline_bridge_sync",
    ...syncPayload
  });
});

const SUPERAGENT_SERVER_LOG_FILE = path.join(os.homedir(), ".superagent-r", "superagent-server.log");

export function logToSuperAgentServerFile(message: string) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  try {
    const dir = path.dirname(SUPERAGENT_SERVER_LOG_FILE);
    // 1 syscall instead of 2: `mkdirSync({ recursive: true })` is a
    // no-op when the directory already exists, so we don't need the
    // existsSync guard.
    fs.mkdirSync(dir, { recursive: true });
    // 1 syscall via statSync to check size threshold (skip the read
    // itself — we just need the size from the stat result).
    const logStat = tryStatSync(SUPERAGENT_SERVER_LOG_FILE);
    if (logStat && logStat.size > 5 * 1024 * 1024) {
      fs.writeFileSync(SUPERAGENT_SERVER_LOG_FILE, `[${timestamp}] [INFO] Log file rotated (exceeded 5MB limit)\n`);
    }
    fs.appendFile(SUPERAGENT_SERVER_LOG_FILE, logLine, () => {});
  } catch (err) {
    // Ignore logging errors
  }
}

// Global Process Crash Handlers to prevent silent crashes and log to superagent-server.log
process.on('uncaughtException', (err: Error) => {
  const errStr = `[FATAL CRASH] Uncaught Exception: ${err?.stack || err?.message || String(err)}`;
  console.error(errStr);
  logToSuperAgentServerFile(errStr);
  process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
  const errStr = `[FATAL ERROR] Unhandled Promise Rejection: ${reason?.stack || reason?.message || String(reason)}`;
  console.error(errStr);
  logToSuperAgentServerFile(errStr);
  process.exit(1);
});

export type ClientMode = "chrome-extension" | "tline";

interface AgentSession {
  agent: Agent;
  workspace: string;
  mode: "single" | "multi";
  clientMode: ClientMode;
  sessionId: string;
  isCliSession: boolean;
  lastActiveTime?: number;
}

let serverDefaultClientMode: ClientMode = "tline";

export function resolveClientMode(
  req: http.IncomingMessage,
  body?: any,
  defaultMode: ClientMode = serverDefaultClientMode
): ClientMode {
  const headerMode = req.headers["x-client-mode"] as string;
  const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  const queryMode = parsedUrl.searchParams.get("clientMode") || parsedUrl.searchParams.get("client_mode");
  const bodyMode = body?.clientMode || body?.client_mode;

  const raw = (bodyMode || headerMode || queryMode || "").toLowerCase();
  if (raw.includes("chrome") || raw.includes("extension") || raw === "ext") {
    return "chrome-extension";
  }
  if (raw.includes("tline") || raw.includes("cli")) {
    return "tline";
  }
  return defaultMode;
}

async function createAgentForMode(
  targetWorkspace: string,
  targetMode: "single" | "multi",
  targetClientMode: ClientMode
): Promise<Agent> {
  let customSystemPrompt: string | undefined = undefined;
  let customTools: any[] | undefined = undefined;

  if (targetClientMode === "chrome-extension") {
    const { CHROME_EXTENSION_SYSTEM_PROMPT } = await import("./core/prompts.js");
    const { chromeExtensionToolset } = await import("./core/tools/toolsets.js");
    customSystemPrompt = CHROME_EXTENSION_SYSTEM_PROMPT;
    // Extension-chat mode: the 12 extension-dependent browser tools STAY ACTIVE
    // here -- this is the only mode where the extension is guaranteed present
    // (the server serves the extension sidepanel chat).
    customTools = chromeExtensionToolset;
  } else {
    // tline mode (SuperAgent CLI / Desktop equivalent): hide the 12
    // extension-dependent browser tools -- the extension is not guaranteed
    // present here. control_chrome_cdp remains as the extension-free path.
    const { filterExtensionChatTools } = await import("./core/tools/toolsets.js");
    if (targetMode === "multi") {
      const { MASTER_AGENT_SYSTEM_PROMPT } = await import("./core/prompts.js");
      const { masterToolset } = await import("./core/tools/toolsets.js");
      customSystemPrompt = MASTER_AGENT_SYSTEM_PROMPT;
      customTools = filterExtensionChatTools(masterToolset);
    } else {
      const { superagentToolset } = await import("./core/tools/toolsets.js");
      customSystemPrompt = undefined;
      customTools = filterExtensionChatTools(superagentToolset);
    }
  }

  // Delegate is a single-agent capability, not a Master orchestration tool.
  if (targetMode === "single" && customTools) {
    const { delegateToolset } = await import("./core/tools/toolsets.js");
    customTools = [...customTools, ...delegateToolset];
  }

  // Discover only tools visible in the actual client mode.
  // T-Line keeps the existing 12 extension-dependent tools hidden.
  if (customTools) {
    const { withModeAwareDiscoveryTools } = await import("./core/tools/toolsets.js");
    customTools = withModeAwareDiscoveryTools(customTools, targetClientMode === "chrome-extension");
  }

  let agent: Agent;
  agent = new Agent(
    (event: AgentEvent) => onEvent(event, agent),
    (toolCall: any, description: string) => onPermission(toolCall, description, agent),
    (question: any, options?: string[], isMultiSelect?: boolean, initialCheckedIndices?: number[], inputType?: string) =>
      onQuestion(question, options, isMultiSelect, initialCheckedIndices, inputType, agent),
    customSystemPrompt,
    customTools,
    targetWorkspace
  );

  if (targetMode === "multi") {
    agent.tier = "master";
    agent.isMultiAgent = true;
    registerMasterAgent(agent);
  } else {
    agent.tier = "single";
  }

  return agent;
}

export const activeSessions = new Map<string, AgentSession>();
let lastActiveWorkspace: string = process.cwd();
let isBrowseDialogOpen = false;
let visionServerProcess: any = null;

export const killVisionServerProcess = () => {
  if (visionServerProcess) {
    try {
      if (process.platform === "win32") {
        try {
          execSync(`taskkill /F /T /PID ${visionServerProcess.pid}`, { stdio: "ignore", windowsHide: true });
        } catch {}
      } else {
        visionServerProcess.kill();
      }
    } catch {}
  }
};

function resolveSession(
  req: http.IncomingMessage,
  requestedSessionId?: string,
  explicitWorkspace?: string
): AgentSession | null {
  const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  let wsPath = explicitWorkspace || (req.headers["x-workspace-path"] as string) || parsedUrl.searchParams.get("workspace") || "";
  const querySessionId = parsedUrl.searchParams.get("sessionId");
  const sessionHeader = req.headers["x-session-id"];
  const targetSessionId = requestedSessionId || querySessionId ||
    (typeof sessionHeader === "string" ? sessionHeader : undefined);
  const reqClientMode = resolveClientMode(req);

  if (wsPath) {
    wsPath = (wsPath.startsWith("ssh:") || wsPath.startsWith("ssh://") || wsPath.startsWith("chain:"))
      ? wsPath
      : path.resolve(wsPath);
  }

  // A session ID is not sufficient authorization on its own. Bind lookups to
  // the requested client mode and workspace so cross-project IDs fail closed.
  if (targetSessionId) {
    for (const session of activeSessions.values()) {
      if (session.sessionId !== targetSessionId || session.clientMode !== reqClientMode) {
        continue;
      }

      if (wsPath && session.workspace.toLowerCase() !== wsPath.toLowerCase()) {
        continue;
      }

      session.lastActiveTime = Date.now();
      return session;
    }
    return null;
  }

  if (wsPath) {
    for (const session of activeSessions.values()) {
      if (session.clientMode === reqClientMode && session.workspace.toLowerCase() === wsPath.toLowerCase()) {
        session.lastActiveTime = Date.now();
        return session;
      }
    }
  }

  for (const session of activeSessions.values()) {
    if (session.clientMode === reqClientMode && session.isCliSession) {
      if (!wsPath || session.workspace.toLowerCase() === wsPath.toLowerCase()) {
        session.lastActiveTime = Date.now();
        return session;
      }
    }
  }

  return null;
}
function isRemoteWorkspaceTarget(p: string): boolean {
  return p.startsWith("ssh:") || p.startsWith("ssh://") || p.startsWith("chain:");
}

function getValidWorkspaceRoots(): string[] {
  const roots = new Set<string>([path.resolve(process.cwd())]);
  // A trusted directory explicitly approved in SuperAgent is a valid API workspace.
  // It is still scoped to this exact trusted root (or its children).
  const candidates: string[] = [lastActiveWorkspace, ...getTrustedDirectories()];
  for (const session of activeSessions.values()) {
    candidates.push(session.workspace);
    const agentWs = (session.agent as any)?.workingDirectory;
    if (typeof agentWs === "string") candidates.push(agentWs);
  }
  for (const c of candidates) {
    if (c && !isRemoteWorkspaceTarget(c)) {
      roots.add(path.resolve(c));
    }
  }
  return Array.from(roots);
}

export function resolveWorkspacePath(req: http.IncomingMessage): string | null {
  const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  const headerWs = req.headers["x-workspace-path"] as string;
  const paramWs = parsedUrl.searchParams.get("workspace");
  const supplied = headerWs || paramWs;
  if (supplied) {
    if (isRemoteWorkspaceTarget(supplied)) return supplied;
    const resolved = path.resolve(supplied);
    const validRoots = getValidWorkspaceRoots();
    if (!validRoots.some((root) => isPathInsideOrEqual(root, resolved))
      || ((parsedUrl.pathname.startsWith("/api/studio") || parsedUrl.pathname.startsWith("/api/motion")) && !isCanonicalMotionWorkspaceAllowed(resolved, validRoots))) {
      logToSuperAgentServerFile(`[Security] Rejected workspace path outside trusted real roots: ${resolved}`);
      return null;
    }
    return resolved;
  }

  const session = resolveSession(req);
  return session ? session.workspace : lastActiveWorkspace;
}

export function registerCliAgent(agent: Agent, workspace: string, mode: "single" | "multi", clientMode: ClientMode = "tline") {
  const targetWorkspace = (workspace.startsWith("ssh:") || workspace.startsWith("ssh://") || workspace.startsWith("chain:"))
    ? workspace
    : path.resolve(workspace);
  activeSessions.set(`${clientMode}:${targetWorkspace}:cli`, {
    agent,
    workspace: targetWorkspace,
    mode,
    clientMode,
    sessionId: generateSessionId(),
    isCliSession: true
  });
  lastActiveWorkspace = targetWorkspace;
}


interface BrowserInstance {
  res: http.ServerResponse;
  clientId: string;
  windowId: string;
  tabTitle: string;
  tabUrl: string;
  profileName: string;
  source: string;
  lastActive: number;
}
const sseClients = new Set<http.ServerResponse>();
const sseClientContexts = new Map<http.ServerResponse, { sessionId?: string; workspace?: string }>();
const browserInstances = new Map<string, BrowserInstance>();

interface PendingPrompt<T> {
  resolve: (value: T) => void;
  ownerAgent?: Agent;
  sessionId?: string;
  workspace: string;
}

const pendingPermissions = new Map<string, PendingPrompt<boolean | "session">>();
const pendingQuestions = new Map<string, PendingPrompt<any>>();
const pendingBrowserControls = new Map<string, {
  resolve: (val: string) => void;
  reject: (err: any) => void;
  controlToken: string;
}>();

/** Max time to wait for the sidepanel client to answer a browser-control request.
 *  Without this, a dead-but-connected sidepanel would hang the caller forever. */
const BROWSER_CONTROL_TIMEOUT_MS = 15000;

function executeBrowserControlOnClient(action: string, target: string, value?: string, instanceId?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const controlId = crypto.randomUUID();
    const controlToken = crypto.randomBytes(32).toString("base64url");
    // Fail-fast: never leave the caller hanging if the sidepanel never answers.
    const timer = setTimeout(() => {
      if (pendingBrowserControls.delete(controlId)) {
        reject(new Error(
          `Timed out after ${BROWSER_CONTROL_TIMEOUT_MS / 1000}s waiting for the Chrome extension sidepanel to respond to '${action}'. ` +
          `The Superagent Chrome Extension must be installed and connected on the target Chrome browser, with its sidepanel open and responsive.`
        ));
      }
    }, BROWSER_CONTROL_TIMEOUT_MS);
    pendingBrowserControls.set(controlId, {
      resolve: (val: string) => { clearTimeout(timer); resolve(val); },
      reject: (err: any) => { clearTimeout(timer); reject(err); },
      controlToken,
    });

    const event = {
      type: "browser_control_required",
      controlId,
      controlToken,
      action,
      target,
      value: value ?? ""
    };

    // Never broadcast executable browser commands to unrelated sessions or tabs.
    // Ambiguous multi-client dispatch must fail closed until the caller selects an instance.
    const live = [...browserInstances.entries()].filter(([, inst]) =>
      inst.res && !inst.res.destroyed && !inst.res.writableEnded);
    const match = instanceId
      ? live.find(([key]) => key === instanceId)
      : live.length === 1 ? live[0] : undefined;
    if (!match) {
      clearTimeout(timer);
      pendingBrowserControls.delete(controlId);
      reject(new Error(instanceId
        ? "Requested Chrome extension instance is not connected."
        : "Browser control needs exactly one connected extension; select an instance explicitly."));
      return;
    }
    const [key, inst] = match;
    try {
      inst.res.write(`data: ${JSON.stringify(event)}\n\n`);
      inst.lastActive = Date.now();
    } catch (err) {
      browserInstances.delete(key);
      clearTimeout(timer);
      pendingBrowserControls.delete(controlId);
      reject(new Error(`Failed to send browser control event: ${err}`));
    }
  });
}

setBrowserControlHandler((action, target, value, instanceId) => {
  if (action === "list_instances") {
    const list = Array.from(browserInstances.entries()).map(([key, inst]) => ({
      instanceId: key,
      clientId: inst.clientId,
      windowId: inst.windowId,
      profileName: inst.profileName,
      tabTitle: inst.tabTitle,
      tabUrl: inst.tabUrl,
      lastActive: new Date(inst.lastActive).toISOString()
    }));
    return Promise.resolve(JSON.stringify(list, null, 2));
  }
  return executeBrowserControlOnClient(action, target, value, instanceId);
});

const chatEventReplay = new SessionEventReplay();
function broadcastEvent(event: any) {
  // Normalize SSE event types for client backward compatibility
  const normalizedEvent = { ...event };
  if (event?.type === "superagent-sessions-changed") {
    normalizedEvent.event = "sessions_changed";
  }

  const sensitiveTypes = new Set([
    "agent_event", "permission_required", "question_required",
    "plan_approval_required", "tool_progress", "browser_control_required",
    "tline_bridge_sync", "error", "subagents_update", "superagents_update",
    "chat_turn_status", "chat_replay_gap",
  ]);
  if (sensitiveTypes.has(normalizedEvent.type) &&
      !normalizedEvent.sessionId && !normalizedEvent.workspace) {
    return; // Fail closed: no recipient context for a sensitive stream.
  }
  // Event journal is T-Line-only and strictly bound to a server-owned active
  // workspace/session pair. Never persist raw event payloads or capability tokens.
  if (typeof normalizedEvent.sessionId === "string" &&
      typeof normalizedEvent.workspace === "string") {
    const owner = [...activeSessions.values()].find(session =>
      session.clientMode === "tline" &&
      session.sessionId === normalizedEvent.sessionId &&
      session.workspace.toLowerCase() === normalizedEvent.workspace.toLowerCase());
    if (owner) {
      // Legacy live subscriptions may fall back to workspace-only ownership.
      // Never persist a subagent from another session into this journal.
      const journalEnvelope = normalizedEvent.type === "subagents_update"
        ? { ...normalizedEvent, subagents: (Array.isArray(normalizedEvent.subagents)
          ? normalizedEvent.subagents : []).filter((sa: any) => {
          const inst = typeof sa?.id === "string" ? subagentInstances.get(sa.id) : undefined;
          return !!inst && (inst.parentAgent === owner.agent ||
            inst.agent?.sessionId === owner.sessionId);
        }) } : normalizedEvent;
      const scope = { sessionId: owner.sessionId, workspace: owner.workspace };
      for (const item of projectAgentTimelineEnvelope(journalEnvelope)) {
        recordAgentTimeline(scope, item);
      }
    }
  }
  const eventJson = JSON.stringify(normalizedEvent);
  let data = `data: ${eventJson}\n\n`;
  if (typeof normalizedEvent.sessionId === "string") {
    try {
      const id = appendChatEvent(normalizedEvent.sessionId, eventJson);
      data = id === null ? data : `id: ${id}\n${data}`;
    } catch (error) {
      // Temporary journal failure must not silently drop live chat progress.
      data = chatEventReplay.publish(normalizedEvent.sessionId, eventJson);
      console.warn("[chat] event journal unavailable; using bounded in-memory replay");
    }
  }
  
  // Log event to the server debug log file
  // Log metadata only; event payloads can include secret browser capabilities.
  logToSuperAgentServerFile(`[Broadcast Event] type=${String(normalizedEvent.type || "unknown")} scoped=${Boolean(normalizedEvent.sessionId || normalizedEvent.workspace)}`);
  
  if (process.env.LOG_STREAM_RESPONSE === 'true') {
    if (normalizedEvent?.event?.type === 'text_delta') {
      process.stdout.write(normalizedEvent.event.text || normalizedEvent.event.delta || '');
    } else if (normalizedEvent?.event?.type === 'message') {
      const sub = normalizedEvent.event;
      const contentStr = typeof sub.content === 'string' ? sub.content : JSON.stringify(sub.content);
      console.log(`\n[SuperAgent][Stream Message] [${sub.role || 'assistant'}]: ${contentStr}`);
    } else if (normalizedEvent?.event?.type) {
      console.log(`\n[SuperAgent][Stream Event] [${normalizedEvent.event.type}]`, JSON.stringify(normalizedEvent.event));
    } else {
      console.log(`\n[SuperAgent][Stream Event]`, JSON.stringify(normalizedEvent));
    }
  }
  for (const client of sseClients) {
    const context = sseClientContexts.get(client);
    if (!shouldDeliverEventToClient(normalizedEvent, context)) continue;

    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
      sseClientContexts.delete(client);
    }
  }
}



function sendJSON(res: http.ServerResponse, status: number, data: any) {
  logToSuperAgentServerFile(`[Response] Status: ${status}`);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...buildCorsHeaders(res.req),
  });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  const MAX_BODY_BYTES = 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        failed = true;
        req.pause();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => { if (!failed) resolve(body); });
    req.on("error", err => { if (!failed) reject(err); });
  });
}

function getSessionForAgent(agentRef?: Agent): AgentSession | undefined {
  if (!agentRef) return undefined;
  for (const session of activeSessions.values()) {
    if (session.agent === agentRef) return session;
  }
  return undefined;
}

// Global Agent Event Handlers
const onEvent = (event: AgentEvent, agentRef?: Agent) => {
  const session = getSessionForAgent(agentRef);
  const sessionId = session?.sessionId || agentRef?.sessionId;
  if (session?.sessionId && agentRef && agentRef.sessionId !== session.sessionId) {
    agentRef.sessionId = session.sessionId;
  }
  const workspace = session?.workspace || agentRef?.workingDirectory;
  const metadata = { ...(sessionId ? { sessionId } : {}), ...(workspace ? { workspace } : {}) };
  if (session) {
    session.lastActiveTime = Date.now();
    if (agentRef && session.clientMode === "tline") {
      bindTlineRootAgent(agentRef, { workspace: session.workspace, sessionId: session.sessionId });
    }
  }
  broadcastEvent({ type: "agent_event", event, ...metadata });
  // When agent finishes a turn and is waiting for plan approval, notify extension clients
  if (event.type === "done" && agentRef && agentRef.planState === "PLANNING_PENDING") {
    broadcastEvent({ type: "plan_approval_required", planState: "PLANNING_PENDING", ...metadata });
  }
};

// Subscribe to active tool output streaming and broadcast it to SSE clients
subscribeToActiveOutput((_output) => {
  // Legacy process-wide output lacks a session key. Agent-scoped events already
  // deliver progress; do not leak unscoped tool output to other workspaces.
});

// Subscribe to subagents/superagents completion notifications to broadcast and/or resume the agent
subscribeToSubagents(() => {
  const activeList = Array.from(subagentInstances.values());

  // Subagent results and prompts are private to the owning workspace/session.
  for (const session of activeSessions.values()) {
    const owned = activeList.filter((inst) => inst.parentAgent
      ? inst.parentAgent === session.agent
      : path.resolve(inst.agent.workingDirectory) === path.resolve(session.workspace));
    if (!owned.length) continue;
    broadcastEvent({
      type: "subagents_update",
      sessionId: session.sessionId,
      workspace: session.workspace,
      subagents: owned.map((inst) => ({
        id: inst.id,
        typeName: inst.typeName,
        role: inst.role,
        status: inst.status,
        result: inst.result,
        logs: inst.logs || [],
        prompt: inst.prompt,
        completedAt: inst.completedAt
      }))
    });
  }

  activeList.forEach((inst) => {
    if (inst.status === "completed" && inst.result && !(inst as any).notified) {
      (inst as any).notified = true;
      const msg = `🤖 [SUBAGENT NOTIFICATION]: Subagent ${inst.id} (${inst.role || inst.typeName}) has completed!\nReport Summary:\n${inst.result}`;
      
      // The matching session receives this notification below.

      for (const session of activeSessions.values()) {
        const isMatch = inst.parentAgent
          ? session.agent === inst.parentAgent
          : path.resolve(session.workspace) === path.resolve(inst.agent.workingDirectory);
        if (!isMatch) continue;
        broadcastEvent({
          type: "agent_event",
          event: { type: "system", content: msg },
          sessionId: session.sessionId,
          workspace: session.workspace,
        });
        if (!session.agent.isAgentRunning()) {
          broadcastEvent({
            type: "agent_event",
            event: { type: "text", content: `\n[SYSTEM TRIGGER] ${msg}\n` },
            sessionId: session.sessionId,
            workspace: session.workspace,
          });
          session.agent.sendMessage(msg).catch(err => {
            broadcastEvent({
              type: "error", message: err.message || String(err),
              sessionId: session.sessionId, workspace: session.workspace,
            });
          });
        }
      }
    }
  });
});

subscribeToSuperagents(() => {
  const activeList = Array.from(superagentInstances.values());
  activeList.forEach((inst) => {
    if (inst.status === "completed" && inst.result && !(inst as any).notified) {
      (inst as any).notified = true;
      const msg = `⚡ [SUPERAGENT NOTIFICATION]: Superagent ${inst.id} (${inst.role}) has completed!\nReport Summary:\n${inst.result}`;
      
      // Scoped delivery takes place in the session loop below.

      for (const session of activeSessions.values()) {
        const isMatch = inst.parentAgent
          ? session.agent === inst.parentAgent
          : path.resolve(session.workspace) === path.resolve(inst.agent.workingDirectory);
        if (!isMatch) continue;
        broadcastEvent({
          type: "agent_event",
          event: { type: "system", content: msg },
          sessionId: session.sessionId, workspace: session.workspace,
        });
        if (!session.agent.isAgentRunning()) {
          broadcastEvent({
            type: "agent_event",
            event: { type: "text", content: `\n[SYSTEM TRIGGER] ${msg}\n` },
            sessionId: session.sessionId, workspace: session.workspace,
          });
          session.agent.sendMessage(msg).catch(err => {
            broadcastEvent({
              type: "error", message: err.message || String(err),
              sessionId: session.sessionId, workspace: session.workspace,
            });
          });
        }
      }
    }
  });
});

function getPromptOwner(ownerAgent?: Agent): { sessionId?: string; workspace: string } {
  if (ownerAgent) {
    for (const session of activeSessions.values()) {
      if (session.agent === ownerAgent) {
        return { sessionId: session.sessionId, workspace: session.workspace };
      }
    }
    const agentWorkspace = (ownerAgent as any).workingDirectory;
    return {
      workspace: typeof agentWorkspace === "string" && agentWorkspace ? agentWorkspace : process.cwd(),
      sessionId: (ownerAgent as any).sessionId,
    };
  }

  // Global/subagent question handlers have no direct agent reference. Only associate
  // them when there is one unambiguous running session in the last active workspace.
  const candidates = [...activeSessions.values()].filter(session =>
    session.agent.isAgentRunning() &&
    session.workspace.toLowerCase() === lastActiveWorkspace.toLowerCase()
  );
  if (candidates.length === 1) {
    return { sessionId: candidates[0].sessionId, workspace: candidates[0].workspace };
  }
  return { workspace: lastActiveWorkspace };
}

const onPermission = (toolCall: any, description: string, ownerAgent: Agent) => {
  return new Promise<boolean | "session">((resolve) => {
    // Cryptographic uniqueness avoids colliding active permission prompts.
    const permissionId = crypto.randomUUID();
    const owner = getPromptOwner(ownerAgent);
    pendingPermissions.set(permissionId, { resolve, ownerAgent, ...owner });
    const session = [...activeSessions.values()].find(item =>
      item.agent === ownerAgent && item.clientMode === "tline" &&
      item.sessionId === owner.sessionId &&
      item.workspace.toLowerCase() === owner.workspace.toLowerCase());
    if (session) registerTlineApproval(permissionId, session.sessionId, session.workspace, () => {
      const pending = pendingPermissions.get(permissionId);
      if (pending && pending.ownerAgent === ownerAgent) {
        pendingPermissions.delete(permissionId);
        pending.resolve(false); // Expiration never becomes implicit approval.
        recordAgentTimeline({ workspace: session.workspace, sessionId: session.sessionId }, {
          kind: "permission_decided", actor: "main", status: "expired",
        });
      }
    });
    broadcastEvent({
      type: "permission_required",
      permissionId,
      toolCall,
      description,
      sessionId: owner.sessionId,
      workspace: owner.workspace,
    });
  });
};

const onQuestion = (
  question: any,
  options?: string[],
  isMultiSelect?: boolean,
  initialCheckedIndices?: number[],
  inputType?: string,
  ownerAgent?: Agent,
) => {
  return new Promise<any>((resolve) => {
    const owner = getPromptOwner(ownerAgent);
    if (!owner.sessionId) {
      resolve(null);
      return;
    }
    const questionId = Math.random().toString(36).substring(2, 9);
    pendingQuestions.set(questionId, { resolve, ownerAgent, ...owner });
    broadcastEvent({
      type: "question_required",
      questionId,
      question,
      options,
      isMultiSelect,
      initialCheckedIndices,
      inputType,
      sessionId: owner.sessionId,
      workspace: owner.workspace,
    });
  });
};

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(150);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

// Best-effort teardown of an idle harvested session: abort any in-flight agent
// work and kill background processes owned by its workspace before removal.
async function teardownIdleSession(session: AgentSession): Promise<void> {
  try {
    session.agent.abort();
  } catch {}
  try {
    const { backgroundTasks, isTaskInWorkspace } = await import("./core/tools/state.js");
    const { killProcessTree } = await import("./core/tools/shellTools.js");
    for (const [id, task] of backgroundTasks.entries()) {
      if (isTaskInWorkspace(task.cwd, session.workspace)) {
        try {
          killProcessTree(task.process.pid);
        } catch {}
        backgroundTasks.delete(id);
      }
    }
  } catch {}
}

export async function runServer(port: number, silent = false, defaultClientMode: ClientMode = "tline") {
  // Override console methods to write server logs to file
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...args: any[]) => {
    originalLog.apply(console, args);
    logToSuperAgentServerFile(`[INFO] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
  };

  console.error = (...args: any[]) => {
    originalError.apply(console, args);
    logToSuperAgentServerFile(`[ERROR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
  };

  console.warn = (...args: any[]) => {
    originalWarn.apply(console, args);
    logToSuperAgentServerFile(`[WARN] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
  };

  logToSuperAgentServerFile(`Initializing SuperAgent Server on port ${port}...`);
  const serverAuthToken = ensureServerAuthToken();

  const inUse = await isPortInUse(port);
  if (inUse) {
    if (!silent) {
      console.warn(`\n⚠️ SuperAgent Server is already running on port ${port}.`);
      console.log(`💡 Exiting to prevent duplicate server instance.\n`);
      process.exit(0);
    }
    return null;
  }

  serverDefaultClientMode = defaultClientMode;
  registerQuestionHandler(onQuestion);
  // A supervised core restart adds a *new* worker while original sessions
  // remain active on their old workers. Never mark another generation's
  // running turns interrupted by applying global crash recovery here.
  try {
    pruneChatRuntimeLedger();
    if (process.env.SUPERAGENT_CORE_WORKER !== "1") {
      recoverInterruptedChatTurns();
    }
  } catch (err: any) {
    console.warn("[chat] turn recovery unavailable:", String(err?.message || err));
  }

  try {
    purgeEmptySessions(24);
  } catch {}

  try {
    const { bootstrapProcessSupervisorOnStartup } = await import("./core/process/processSupervisor.js");
    await bootstrapProcessSupervisorOnStartup({ workspaceRoot: process.cwd(), silent });
  } catch {}

  // Idle workspace session harvesting. Non-CLI sessions are reclaimed after
  // 30 min of inactivity; CLI-attached sessions get a longer 2h grace window
  // because they may simply be paused by a human at the terminal, but they
  // are still reaped eventually to keep the session map bounded in long-
  // running server deployments.
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  const CLI_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
  const harvestTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of activeSessions.entries()) {
      if (session.agent.isAgentRunning()) continue;
      const lastActive = session.lastActiveTime || now;
      const timeout = session.isCliSession ? CLI_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
      if (now - lastActive > timeout) {
        void teardownIdleSession(session).finally(() => {
          activeSessions.delete(key);
        });
      }
    }
  }, 5 * 60 * 1000);

  // Start the Python Vision Server in the background

  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    const cleanup = () => {
      clearInterval(harvestTimer);
      try {
        closeHistoryDb();
      } catch {}
      try {
        const portServerInfoPath = path.join(getRootConfigDir(), `server-info-${port}.json`);
        if (fs.existsSync(portServerInfoPath)) {
          fs.unlinkSync(portServerInfoPath);
        }
      } catch {}
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  } else {
    // Internal rolling generations share a single fixed-port vision helper.
    // They must not start competing Python services at port 8095.
    if (process.env.SUPERAGENT_CORE_WORKER !== "1" || process.env.SUPERAGENT_CORE_VISION_OWNER === "1") {
    try {
      const { execa } = await import("execa");
      const scriptPath = path.join(getPackageRootDir(), "scripts", "vision_server.py");
      visionServerProcess = execa("python", [scriptPath, "8095"], { windowsHide: true });
      if (!silent) {
        console.log("🚀 Starting Python UI-DETR-1 Vision Server on port 8095...");
      }

      visionServerProcess.catch((err: any) => {
        if (!silent) {
          console.error("[Vision Server Process Terminated/Failed]", err.message);
        }
      });
    } catch (err: any) {
      if (!silent) {
        console.error("Failed to spawn Python Vision Server:", err.message);
      }
    }
    }
    const cleanup = () => {
      clearInterval(harvestTimer);
      killVisionServerProcess();
      try {
        closeHistoryDb();
      } catch {}
      try {
        const portServerInfoPath = path.join(getRootConfigDir(), `server-info-${port}.json`);
        if (fs.existsSync(portServerInfoPath)) {
          fs.unlinkSync(portServerInfoPath);
        }
      } catch {}
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  }
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    // Private, loopback-only process inspection. The supervisor explicitly
    // blocks this route from the public listener before proxying.
    if (pathname === "/_core/internal/drain") {
      const secret = process.env.SUPERAGENT_CORE_INSPECT_TOKEN || "";
      const headerValue = req.headers["x-superagent-internal-token"];
      const provided = typeof headerValue === "string" ? headerValue : "";
      const a = Buffer.from(provided);
      const b = Buffer.from(secret);
      const authorized = process.env.SUPERAGENT_CORE_WORKER === "1" &&
        secret.length === 64 && req.method === "GET" &&
        (req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1") &&
        a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!authorized) { res.writeHead(404); res.end(); return; }
      try {
        const { listSessions, listDetachedSessions } = await import("./core/tools/cliBridgeSession.js");
        const { getActiveRemoteTaskSnapshot } = await import("./core/remoteAgent/taskRunner.js");
        const { isMuseWatcherActive } = await import("./core/remoteAgent/museWatcherRegistry.js");
        const { daemonScheduler } = await import("./core/daemon/daemonScheduler.js");
        const report = evaluateCoreDrain(process.pid, process.env.SUPERAGENT_CORE_GENERATION_ID || "", {
          transportIsolated: process.env.SUPERAGENT_CORE_TRANSPORT_ISOLATED === "1",
          visionOwner: process.env.SUPERAGENT_CORE_VISION_OWNER === "1",
          metrics: {
            sessions: activeSessions.size,
            sseClients: sseClients.size,
            browserClients: browserInstances.size,
            pendingPrompts: pendingPermissions.size + pendingQuestions.size + pendingBrowserControls.size,
            backgroundTasks: [...backgroundTasks.values()].filter(t => !t.hasExited).length,
            // Conservative: even completed instance records can own references.
            agents: subagentInstances.size + superagentInstances.size,
            cliBridgeSessions: listSessions().filter(t => t.status !== "exited" && t.status !== "errored").length,
            detachedCliBridgeSessions: listDetachedSessions().length,
            scheduledJobs: scheduledJobs.size,
            remoteTasks: getActiveRemoteTaskSnapshot() ? 1 : 0,
            daemonRunning: daemonScheduler.isRunning() ? 1 : 0,
            museWatcher: isMuseWatcherActive() ? 1 : 0,
          },
        });
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(report));
      } catch {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ safe: false, blockers: ["worker inspection failed"] }));
      }
      return;
    }

    logToSuperAgentServerFile(`[Request] ${req.method} ${pathname} (workspaceHeader=${Boolean(req.headers["x-workspace-path"])})`);

    // Auth gate for the HTTP API (OPTIONS preflight passes through)
    const isApiRoute = pathname === "/api" || pathname.startsWith("/api/");
    if (isApiRoute && req.method === "OPTIONS") {
      res.writeHead(204, buildCorsHeaders(req));
      res.end();
      return;
    }
    // Local-only invitation bootstrap uses per-session cryptographic capabilities,
    // never the long-lived Core server token. Reverse proxies are NOT authorized by
    // default; this exception is restricted to local socket and loopback Host.
    const takeoverLocal = (req.socket.remoteAddress === "127.0.0.1" ||
      req.socket.remoteAddress === "::1" || req.socket.remoteAddress === "::ffff:127.0.0.1") &&
      /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(String(req.headers.host || ""));
    const localInvitationRoute = takeoverLocal && (
      (pathname === "/api/browser/takeover/ui" && req.method === "GET") ||
      (pathname === "/api/browser/takeover/redeem" && req.method === "POST") ||
      (pathname === "/api/browser/takeover/return" && req.method === "POST") ||
      (pathname === "/api/browser/takeover/cancel" && req.method === "POST") ||
      (pathname.startsWith("/api/browser/takeover/vendor/") && req.method === "GET")
    );
    if (isApiRoute && !localInvitationRoute && !isRequestAuthorized(req, parsedUrl)) {
      sendJSON(res, 401, { error: "Unauthorized" });
      return;
    }

    // Resolve a request-local workspace mode; never mutate the process-global mode
    // while handling HTTP requests because multiple workspaces may run concurrently.
    const targetWorkspace = resolveWorkspacePath(req);
    if (targetWorkspace === null) {
      sendJSON(res, 403, { error: "Forbidden workspace" });
      return;
    }

    const { workspaceMode } = await import("./core/ssh/workspaceMode.js");
    const requestSshConfig =
      targetWorkspace && (targetWorkspace.startsWith("ssh:") || targetWorkspace.startsWith("ssh://"))
        ? workspaceMode.parseSshTarget(targetWorkspace) ?? undefined
        : undefined;

    // CORS preflight for non-API routes (none mutate state today)
    if (req.method === "OPTIONS") {
      res.writeHead(204, buildCorsHeaders(req));
      res.end();
      return;
    }

    const { workspaceChainManager } = await import("./core/workspace/WorkspaceChainManager.js");
    await workspaceChainManager.runWithRequestContext(() =>
      workspaceMode.runWithWorkspaceConfig(requestSshConfig, async () => {
        try {
          // Chain activation and route execution share request-local workspace and chain state.
          if (targetWorkspace?.startsWith("chain:")) {
            const chainId = targetWorkspace.substring(6);
            const activeChain = workspaceChainManager.getActiveChain(targetWorkspace);
            if (!activeChain || activeChain.id !== chainId) {
              await workspaceChainManager.activateChain(chainId, targetWorkspace);
            }
          }

          const handled = await handleServerRoute(req, res, pathname, parsedUrl, {
            activeSessions,
            lastActiveWorkspace,
            setLastActiveWorkspace: (ws: string) => { lastActiveWorkspace = ws; },
            isBrowseDialogOpen,
            setIsBrowseDialogOpen: (v: boolean) => { isBrowseDialogOpen = v; },
            serverDefaultClientMode,
            sseClients,
            sseClientContexts,
            browserInstances,
            pendingPermissions,
            pendingQuestions,
            pendingBrowserControls,
            replaySessionEvents: (res: http.ServerResponse, sessionId: string, cursor?: string) => {
              if (cursor === undefined) return;
              try {
                const replay = replayChatEvents(sessionId, cursor);
                if (replay.gap && !res.writableEnded) {
                  res.write(`data: ${JSON.stringify({ type: "chat_replay_gap", sessionId })}\n\n`);
                }
                for (const event of replay.events) {
                  if (!res.writableEnded) res.write(event);
                }
              } catch {
                for (const event of chatEventReplay.since(sessionId, cursor)) {
                  if (!res.writableEnded) res.write(event);
                }
              }
            },
            resolveSession,
            resolveWorkspacePath,
            resolveClientMode,
            createAgentForMode,
            broadcastEvent,
            sendJSON,
            readBody,
            executeBrowserControlOnClient,
            killVisionServerProcess
          });

          if (!handled) {
            sendJSON(res, 404, { error: "Not Found" });
          }
        } catch (err: any) {
          console.error("[SERVER ERROR]", err);
          logToSuperAgentServerFile(`[SERVER ROUTE ERROR] ${err?.stack || err?.message || String(err)}`);
          sendJSON(res, 500, { error: err.message || String(err) });
        }
      })
    );
  });

  server.on("error", (err: any) => {
    logToSuperAgentServerFile(`[SERVER SOCKET ERROR] ${err?.stack || err?.message || String(err)}`);
    if (!silent) {
      console.error("[Server Error]", err);
    }
  });

    server.on("upgrade", async (req, socket, head) => {
    const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "127.0.0.1"}`);
    if (parsedUrl.pathname === "/api/browser/takeover/ws") {
      try {
        const { getTakeoverWebsocketProxy } = await import("./core/browserTakeover/index.js");
        const proxy = getTakeoverWebsocketProxy();
        await proxy.handleUpgrade(req, socket as any, head, isRequestAuthorized);
      } catch {
        socket.destroy();
      }
      return;
    }
    socket.destroy();
  });

  server.listen(port, '127.0.0.1', () => {
    // T-Line's SuperAgent REST core uses this same startup path. Start only
    // the isolated shared-model watchdog; never touch T-Line/MCP/tunnels.
    if(process.env.SUPERAGENT_CORE_WORKER!=="1") {
      void import("./core/senopatiLifecycle.js")
        .then(({scheduleSenopatiLifecycle})=>scheduleSenopatiLifecycle())
        .catch(()=>{});
    }
    // The supervisor owns public auth metadata; private workers must not
    // overwrite shared server-info or invalidate existing client tokens.
    if (process.env.SUPERAGENT_CORE_WORKER !== "1") {
    try {
      const serverInfoPath = path.join(getRootConfigDir(), "server-info.json");
      const portServerInfoPath = path.join(getRootConfigDir(), `server-info-${port}.json`);
      const infoPayload = JSON.stringify({
        port,
        pid: process.pid,
        authToken: serverAuthToken,
        startedAt: Date.now()
      }, null, 2);
      // Atomic replace with best-effort owner-only mode; clients must
      // never observe a partially written token during restart.
      for (const destination of [serverInfoPath, portServerInfoPath]) {
        const pending = destination + "." + process.pid + ".tmp";
        try {
          fs.writeFileSync(pending, infoPayload, { encoding: "utf-8", mode: 0o600 });
          fs.renameSync(pending, destination);
          try { fs.chmodSync(destination, 0o600); } catch { /* Windows ACL may differ */ }
        } finally {
          try { fs.rmSync(pending, { force: true }); } catch {}
        }
      }
    } catch {}
    }
    // Never expose bearer credentials in persisted diagnostic logs.
    logToSuperAgentServerFile('[SERVER] Auth token initialized (redacted).');
    if (!silent) {
      console.log(`\n🚀 SuperAgent Server v${getSuperAgentVersion()} is running at http://localhost:${port}`);
      console.log(`💡 Mode: REST API & Server-Sent Events (SSE)`);
      console.log(`🎯 Default Client Mode: ${serverDefaultClientMode}`);
      console.log(`📂 Current Workspace: ${lastActiveWorkspace}`);
      console.log('[SERVER] Auth token saved to protected server-info (redacted).');
      console.log("💡 API clients should authenticate with Authorization: Bearer or x-auth-token headers. SSE uses authenticated fetch.\n");
    }
  });

  // Start the Chrome Remote WSS bridge silently in the background if not in a test environment
  if (!process.env.VITEST && process.env.NODE_ENV !== "test" && process.env.SUPERAGENT_CORE_WORKER !== "1") {
    try {
      const { ensureRemoteChromeBridge } = await import("./core/tools/remoteChromeBridge.js");
      ensureRemoteChromeBridge().catch(() => {});
    } catch {}
  }

  return server;
}
~~~~

## REVISED - scripts/verify-extension-js.mjs

~~~~javascript
import { readFile, readdir } from "node:fs/promises";

if (!process.versions.bun) throw new Error("Extension syntax validation requires Bun");
const transpiler = new Bun.Transpiler({ loader: "js", target: "browser" });
const files = (await Promise.all(
  ["chrome-extension", "chrome-extension-remote", "chrome-extension-delegate"].map(async (directory) =>
    (await readdir(directory))
      .filter((file) => file.endsWith(".js"))
      .map((file) => directory + "/" + file)
  )
)).flat().sort();

let failed = false;
for (const file of files) {
  try {
    // Parsing/transpilation must never execute Chrome extension code in Bun.
    // Unlike Node's --check, Bun 1.4.x may execute the script under --check.
    const code = await readFile(file, "utf8");
    transpiler.transformSync(code);
    console.log("OK", file);
  } catch (error) {
    failed = true;
    console.error("FAIL", file, error instanceof Error ? error.message : String(error));
  }
}
if (failed) process.exitCode = 1;
else console.log(`Verified ${files.length} extension JavaScript files without executing browser globals.`);
~~~~

## REVISED - src/core/tools/delegateTools.ts

~~~~typescript
import type { Tool } from "./types.js";
import { delegateBridge, type DelegateMethod } from "../delegate/bridge.js";

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

function tool(
  name: DelegateMethod,
  description: string,
  parameters: Record<string, unknown>,
  prepare: (args: Record<string, unknown>) => Record<string, unknown>,
  timeoutMs = 20_000,
): Tool {
  return {
    name, description, parameters,
    async execute(args: Record<string, unknown>, _cwd: string, signal?: AbortSignal): Promise<string> {
      try {
        return await delegateBridge.request(name, prepare(args), signal, timeoutMs);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

const emptyArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  if (Object.keys(args).length) throw new Error("This tool takes no arguments");
  return {};
};

export const delegateCreateChatTool: Tool = tool(
  "delegate.create_chat",
  "Start a new ChatGPT conversation in an existing logged-in chatgpt.com tab. Never reloads to recover.",
  schema({}),
  emptyArgs,
);

export const delegateReadChatTool: Tool = tool(
  "delegate.read_chat",
  "Read current ChatGPT messages, status (working/finished/waiting_for_input), and latest response text. Read-only.",
  schema({}),
  emptyArgs,
);

export const delegateSendMessageTool: Tool = tool(
  "delegate.send_message",
  "Send a message exactly once to the current ChatGPT chat. On timeout it never resends; inspect with delegate.read_chat.",
  schema({ message: { type: "string", minLength: 1, maxLength: 100_000 } }, ["message"]),
  (args) => {
    if (typeof args.message !== "string" || !args.message.trim() || args.message.length > 100_000) {
      throw new Error("DELEGATE_INVALID_MESSAGE: message must be a nonempty string of at most 100000 characters");
    }
    return { message: args.message };
  },
  30_000,
);

export const delegateStopGenerationTool: Tool = tool(
  "delegate.stop_generation",
  "Stop ChatGPT generation only when explicitly requested. Never called as timeout or abort recovery.",
  schema({}),
  emptyArgs,
);
~~~~

## REVISED - src/core/delegate/bridge.ts

~~~~typescript
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

export type DelegateMethod =
  | "delegate.create_chat"
  | "delegate.read_chat"
  | "delegate.send_message"
  | "delegate.stop_generation";

type Pending = {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  detachAbort: () => void;
};

export class DelegateBridge {
  private server: WebSocketServer | undefined;
  private client: WebSocket | undefined;
  private starting: Promise<void> | undefined;
  private pending = new Map<string, Pending>();
  private waiters = new Set<() => void>();

  constructor(readonly port = 17341) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const expectedId = process.env.SUPERAGENT_DELEGATE_EXTENSION_ID?.trim();
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: this.port,
        verifyClient: (info: { origin?: string }) => {
          const origin = info.origin || "";
          if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
          return !expectedId || origin === `chrome-extension://${expectedId}`;
        },
      });
      const onError = (error: Error) => {
        this.starting = undefined;
        reject(new Error(`DELEGATE_BRIDGE_BIND_FAILED: ${error.message}`));
      };
      wss.once("error", onError);
      wss.once("listening", () => {
        wss.off("error", onError);
        this.server = wss;
        wss.on("connection", (ws) => this.onConnection(ws));
        resolve();
      });
    });
    return this.starting;
  }

  private onConnection(ws: WebSocket): void {
    if (this.client?.readyState === WebSocket.OPEN) {
      ws.close(1008, "Delegate extension already connected");
      return;
    }
    let authenticated = false;
    const helloTimer = setTimeout(() => ws.close(1008, "HELLO timeout"), 3000);
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== "object") return;
      } catch {
        return;
      }
      if (!authenticated) {
        if (this.client?.readyState === WebSocket.OPEN && this.client !== ws) {
          ws.close(1008, "Another delegate extension is already connected");
          return;
        }
        if (msg.type !== "hello" || msg.protocol !== "superagent-delegate-v1") {
          ws.close(1008, "Invalid delegate protocol");
          return;
        }
        authenticated = true;
        clearTimeout(helloTimer);
        this.client = ws;
        ws.send(JSON.stringify({ type: "hello_ack", protocol: "superagent-delegate-v1" }));
        for (const wake of this.waiters) wake();
        this.waiters.clear();
        return;
      }
      if (msg.type !== "response" || typeof msg.id !== "string") return;
      const pending = this.pending.get(msg.id);
      if (!pending) return; // late reply: never replay/retry a timed-out send
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.detachAbort();
      if (msg.ok === true) pending.resolve(JSON.stringify(msg.result ?? null));
      else {
        const error = msg.error && typeof msg.error === "object" ? msg.error as Record<string, unknown> : {};
        pending.reject(new Error(`${String(error.code || "DELEGATE_REMOTE_ERROR")}: ${String(error.message || "Extension request failed")}`));
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.client === ws) {
        this.client = undefined;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.detachAbort();
          p.reject(new Error("DELEGATE_EXTENSION_DISCONNECTED: Request not retried"));
          this.pending.delete(id);
        }
      }
    });
    ws.on("error", () => {}); // close event handles outstanding RPCs
  }

  private async connected(signal?: AbortSignal): Promise<WebSocket> {
    await this.start();
    if (this.client?.readyState === WebSocket.OPEN) return this.client;
    // First operation can start the listener. Give the already-installed
    // extension a short opportunity to reconnect, then fail fast.
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("DELEGATE_ABORTED"));
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        reject(new Error("DELEGATE_ABORTED"));
      };
      const timer = setTimeout(finish, 2000);
      this.waiters.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
    });
    const readyClient = this.client as WebSocket | undefined;
    if (!readyClient || readyClient.readyState !== WebSocket.OPEN) {
      throw new Error("DELEGATE_EXTENSION_NOT_CONNECTED: Load chrome-extension-delegate unpacked and keep its service worker enabled");
    }
    return readyClient;
  }

  async request(method: DelegateMethod, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 20_000): Promise<string> {
    const ws = await this.connected(signal);
    if (signal?.aborted) throw new Error("DELEGATE_ABORTED");
    const id = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.detachAbort();
      };
      const abort = () => {
        cleanup();
        // Abort never invokes delegate.stop_generation.
        reject(new Error("DELEGATE_ABORTED: Request not retried; inspect chat before any new send"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("DELEGATE_TIMEOUT: Request may have reached ChatGPT; it was not resent. Read chat before taking further action."));
      }, timeoutMs);
      this.pending.set(id, {
        resolve, reject, timer,
        detachAbort: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        // Exactly one WebSocket transmission per invocation.
        ws.send(JSON.stringify({ type: "request", id, method, params }), (err) => {
          if (err) { cleanup(); reject(new Error(`DELEGATE_TRANSPORT_FAILED: ${err.message}; request not retried`)); }
        });
      } catch (err) {
        cleanup();
        reject(new Error(`DELEGATE_TRANSPORT_FAILED: ${String(err)}; request not retried`));
      }
    });
  }

  async close(): Promise<void> {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.detachAbort();
      p.reject(new Error("DELEGATE_BRIDGE_CLOSED"));
      this.pending.delete(id);
    }
    this.client?.close();
    this.client = undefined;
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export const delegateBridge = new DelegateBridge();
~~~~

## REVISED - chrome-extension-delegate/manifest.json

~~~~json
{
  "manifest_version": 3,
  "name": "SuperAgent Delegate (ChatGPT)",
  "version": "1.0.0",
  "description": "Local-only ChatGPT delegation for SuperAgent; separate from the existing SuperAgent extension.",
  "permissions": ["tabs"],
  "host_permissions": ["https://chatgpt.com/*", "http://127.0.0.1/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["https://chatgpt.com/*"],
    "js": ["content.js"],
    "run_at": "document_idle",
    "all_frames": false
  }],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:17341"
  }
}
~~~~

## REVISED - chrome-extension-delegate/background.js

~~~~javascript
/* Local-only, fixed-method bridge. No execute-script, arbitrary URL, or API-key path. */
const ENDPOINT = "ws://127.0.0.1:17341";
const PROTOCOL = "superagent-delegate-v1";
const METHODS = new Set([
  "delegate.create_chat",
  "delegate.read_chat",
  "delegate.send_message",
  "delegate.stop_generation",
]);

let socket = null;
let reconnectTimer = null;
let isReady = false;
const inFlight = new Set();
const completed = new Map();

function error(code, message) {
  return { code, message };
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  const ws = new WebSocket(ENDPOINT);
  socket = ws;
  isReady = false;
  ws.addEventListener("open", () => {
    send({ type: "hello", protocol: PROTOCOL });
  });
  ws.addEventListener("message", (event) => {
    let envelope;
    try { envelope = JSON.parse(event.data); } catch { return; }
    if (envelope?.type === "hello_ack" && envelope.protocol === PROTOCOL) {
      isReady = true;
      return;
    }
    if (!isReady || envelope?.type !== "request") return;
    void handleRequest(envelope);
  });
  ws.addEventListener("close", () => {
    isReady = false;
    if (socket === ws) socket = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1000);
  });
  ws.addEventListener("error", () => { /* close event schedules reconnect */ });
}

function selectChatTab(tabs) {
  return [...tabs]
    .filter((tab) => typeof tab.id === "number" && /^https:\/\/chatgpt\.com(?:\/|$)/.test(tab.url || ""))
    .sort((a, b) => (Number(b.active) - Number(a.active)) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)))[0];
}

async function waitForContentScript(tabId, ms = 4500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { scope: PROTOCOL, action: "probe" });
      if (response?.ready === true) return;
    } catch {
      // Only a read-only probe is retried while the tab is initializing.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw error("CHATGPT_TAB_NOT_READY", "ChatGPT content script is unavailable. Open a logged-in chatgpt.com tab and try again.");
}

async function dispatchToTab(request) {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const tab = selectChatTab(tabs);
  if (!tab) throw error("CHATGPT_TAB_NOT_FOUND", "Open chatgpt.com in Chrome; no ChatGPT tab is available.");
  await waitForContentScript(tab.id);
  // Dispatch the requested mutation exactly ONCE. A rejected/late
  // response never triggers a second message submission.
  return chrome.tabs.sendMessage(tab.id, {
    scope: PROTOCOL,
    action: "execute",
    id: request.id,
    method: request.method,
    params: request.params || {},
  });
}

async function handleRequest(request) {
  if (typeof request.id !== "string" || !METHODS.has(request.method)) return;
  if (completed.has(request.id)) {
    send(completed.get(request.id));
    return;
  }
  if (inFlight.has(request.id)) return; // never duplicate side effects
  inFlight.add(request.id);
  let response;
  try {
    const result = await dispatchToTab(request);
    if (!result || typeof result !== "object") throw error("DELEGATE_NO_RESPONSE", "ChatGPT tab returned no result; do not auto-resend.");
    if (result.ok !== true) throw result.error || error("DELEGATE_TAB_ERROR", "Request failed in ChatGPT tab");
    response = { type: "response", id: request.id, ok: true, result: result.result };
  } catch (reason) {
    response = {
      type: "response", id: request.id, ok: false,
      error: {
        code: String(reason?.code || "DELEGATE_DISPATCH_FAILED"),
        message: String(reason?.message || reason || "Unknown extension failure"),
      },
    };
  } finally {
    inFlight.delete(request.id);
  }
  // Bounded, per-service-worker deduplication cache. Never automatically replays actions.
  completed.set(request.id, response);
  if (completed.size > 128) completed.delete(completed.keys().next().value);
  send(response);
}

connect();
// Chrome 116+ permits service workers to remain active via WebSocket
// heartbeat, without background tabs, refresh loops, or page reloads.
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) send({ type: "ping" });
  else connect();
}, 20_000);

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
~~~~

## REVISED - chrome-extension-delegate/content.js

~~~~javascript
/* Runs only on https://chatgpt.com/*. All operations use DOM, no page APIs. */
(() => {
  "use strict";
  const SCOPE = "superagent-delegate-v1";
  const completed = new Map();
  const inFlight = new Set();
  let sendActive = false;
  let newChatActive = false;

  const fail = (code, message) => { throw { code, message }; };
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const norm = (text) => String(text || "").replace(/\s+/g, " ").trim();

  const turns = () =>
    Array.from(document.querySelectorAll("[data-message-author-role]"))
      .filter(visible);

  const composer = () =>
    Array.from(document.querySelectorAll(
      '#prompt-textarea[contenteditable="true"], [data-testid="composer"] [contenteditable="true"], textarea#prompt-textarea, textarea[data-testid="prompt-textarea"]'
    )).find(visible);

  const label = (el) => [
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.getAttribute("data-testid"),
    el.textContent,
  ].filter(Boolean).join(" ").toLowerCase();

  const buttons = () => Array.from(document.querySelectorAll("button")).filter(visible);
  const stopButton = () => buttons().find((b) =>
    b.matches('[data-testid="stop-button"], [aria-label="Stop generating"], [aria-label="Stop generation"]') ||
    /^(stop generating|stop generation|stop response)$/.test(norm(b.getAttribute("aria-label") || "").toLowerCase())
  );
  const sendButton = () => buttons().find((b) =>
    b.matches('[data-testid="send-button"], [aria-label="Send prompt"], [aria-label="Send message"]') ||
    /^send (prompt|message)$/.test(norm(b.getAttribute("aria-label") || "").toLowerCase())
  );

  function loginRequired() {
    if (/^\/(auth\/login|login|auth\/signin)(?:\/|$)/.test(location.pathname)) return true;
    if (composer()) return false;
    const authAction = Array.from(document.querySelectorAll("a, button")).filter(visible).some((el) =>
      /^(log in|login|sign in)$/i.test(norm(el.textContent || el.getAttribute("aria-label")))
    );
    return authAction;
  }

  function assertLogin() {
    if (loginRequired()) fail("CHATGPT_LOGIN_REQUIRED", "Sign in to chatgpt.com in this Chrome profile.");
  }

  function waitFor(predicate, ms, reason) {
    return new Promise((resolve, reject) => {
      let complete = false;
      let observer;
      let timer;
      const finish = (value, error) => {
        if (complete) return;
        complete = true;
        observer?.disconnect();
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const inspect = () => {
        try {
          assertLogin();
          const result = predicate();
          if (result) finish(result);
        } catch (err) {
          finish(undefined, err);
        }
      };
      observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(() => finish(undefined, { code: "DELEGATE_DOM_TIMEOUT", message: reason }), ms);
      inspect();
    });
  }

  function readChat() {
    assertLogin();
    const messages = turns().map((node, index) => {
      const role = node.getAttribute("data-message-author-role") || "unknown";
      const body = node.querySelector(".markdown, [data-message-content], [data-testid='conversation-turn-content']")
        || node;
      return { index, role, text: norm(body.innerText || body.textContent) };
    });
    const last = messages.at(-1);
    const running = !!stopButton();
    let status = running ? "working" :
      !last ? "waiting_for_input" : last.role === "user" ? "working" : "finished";
    const latest = [...messages].reverse().find((m) => m.role === "assistant");
    return {
      url: location.href,
      status,
      messages,
      latest_response_text: latest?.text || "",
    };
  }

  function writeComposer(el, text) {
    el.focus();
    if (el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) fail("DELEGATE_COMPOSER_ERROR", "Textarea setter unavailable");
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (el.getAttribute("contenteditable") !== "true") {
      fail("DELEGATE_COMPOSER_ERROR", "ChatGPT composer is not editable");
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    // execCommand insertText triggers the browser's native beforeinput/input
    // lifecycle used by controlled contenteditable composers.
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) {
      // No submit after a failed editor update.
      fail("DELEGATE_COMPOSER_ERROR", "Cannot insert text into ChatGPT editor");
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  async function sendMessage(params) {
    const message = params?.message;
    if (typeof message !== "string" || !message.trim() || message.length > 100_000) {
      fail("DELEGATE_INVALID_MESSAGE", "message must be nonempty text (max 100000 characters)");
    }
    assertLogin();
    const input = await waitFor(composer, 5000, "ChatGPT composer did not appear; no message was sent");
    if (stopButton()) fail("CHATGPT_BUSY", "Generation in progress. Read chat; no message was sent.");
    if (norm(input.innerText || input.value || input.textContent)) {
      fail("CHATGPT_DRAFT_PRESENT", "An unsent draft is already in the composer; it was preserved. No message was sent.");
    }
    const previousUserTurns = turns().filter((node) => node.getAttribute("data-message-author-role") === "user").length;
    writeComposer(input, message);
    // Confirm text is present before attempting to click Send.
    const entered = norm(input.innerText || input.value || input.textContent);
    if (entered !== norm(message)) fail("DELEGATE_COMPOSER_MISMATCH", "Editor text verification failed; no message was sent");
    const submit = await waitFor(() => {
      const b = sendButton();
      return b && !b.disabled ? b : null;
    }, 4000, "ChatGPT Send button not available; no message was sent");
    submit.click(); // exactly one click, never Enter + click
    try {
      await waitFor(
        () => turns().filter((node) => node.getAttribute("data-message-author-role") === "user").length > previousUserTurns,
        14_000,
        "Send was clicked but chat acknowledgement did not appear. Outcome uncertain; inspect via delegate.read_chat. Do not automatically resend."
      );
      return { delivery: "sent", ...readChat() };
    } catch (error) {
      // Do not retry. The UI could still have accepted the send.
      if (error?.code === "DELEGATE_DOM_TIMEOUT") {
        return { delivery: "unknown_after_click", note: error.message, ...readChat() };
      }
      throw error;
    }
  }

  async function createChat() {
    assertLogin();
    const before = location.href;
    const candidates = Array.from(document.querySelectorAll("a, button")).filter(visible);
    const newChat = candidates.find((node) =>
      node.matches('[data-testid="create-new-chat-button"], [data-testid="new-chat-button"]') ||
      /^(new chat|new conversation)$/i.test(norm(node.getAttribute("aria-label") || node.textContent))
    );
    if (!newChat) fail("DELEGATE_NEW_CHAT_UNAVAILABLE", "ChatGPT New chat control not found. No navigation/reload fallback is attempted.");
    newChat.click();
    await waitFor(
      () => composer() && (location.href !== before || turns().length === 0),
      8000,
      "New chat state not confirmed after a single click; inspect chat before retrying"
    );
    return { created: true, ...readChat() };
  }

  async function stopGeneration() {
    assertLogin();
    const stop = stopButton();
    if (!stop) fail("CHATGPT_NOT_GENERATING", "No Stop generation control is visible; nothing was clicked.");
    stop.click();
    return { stop_requested: true, ...readChat() };
  }

  async function dispatch(method, params) {
    switch (method) {
      case "delegate.create_chat":
        if (sendActive || newChatActive) fail("CHATGPT_BUSY", "A ChatGPT mutation is already active; new chat was not started.");
        newChatActive = true;
        try { return await createChat(); } finally { newChatActive = false; }
      case "delegate.read_chat": return readChat();
      case "delegate.send_message":
        if (sendActive || newChatActive) fail("DELEGATE_SEND_IN_FLIGHT", "Another send or new-chat operation is in progress; this request was not submitted.");
        sendActive = true;
        try { return await sendMessage(params); } finally { sendActive = false; }
      case "delegate.stop_generation": return stopGeneration();
      default: fail("DELEGATE_UNKNOWN_METHOD", "Unsupported method");
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || request?.scope !== SCOPE) return false;
    if (request.action === "probe") {
      sendResponse({ ready: true });
      return false;
    }
    if (request.action !== "execute" || typeof request.id !== "string") return false;
    if (completed.has(request.id)) {
      sendResponse(completed.get(request.id));
      return false;
    }
    if (inFlight.has(request.id)) {
      sendResponse({ ok: false, error: { code: "DELEGATE_DUPLICATE_IN_FLIGHT", message: "Request already executing. No second action taken." } });
      return false;
    }
    inFlight.add(request.id);
    Promise.resolve().then(() => dispatch(request.method, request.params || {}))
      .then((result) => ({ ok: true, result }))
      .catch((reason) => ({ ok: false, error: {
        code: String(reason?.code || "DELEGATE_DOM_ERROR"),
        message: String(reason?.message || reason || "Unknown DOM error"),
      } }))
      .then((response) => {
        inFlight.delete(request.id);
        completed.set(request.id, response);
        if (completed.size > 128) completed.delete(completed.keys().next().value);
        sendResponse(response);
      });
    return true;
  });
})();
~~~~

## REVISED - chrome-extension-delegate/README.md

~~~~markdown
# SuperAgent Delegate — isolated ChatGPT extension

This extension is entirely separate from `chrome-extension/`. It contains only
`manifest.json`, `background.js` and `content.js`.

## Setup

1. In Chrome, open `chrome://extensions`, enable Developer mode, and
   **Load unpacked** from `chrome-extension-delegate/`.
2. Keep a logged-in `https://chatgpt.com/` tab open in the same Chrome profile.
3. Open SuperAgent in a **single-agent** T-Line or extension-chat session.
   The first `delegate.*` invocation starts a loopback WebSocket listener
   at `127.0.0.1:17341`. The extension reconnects while its worker runs.
4. Run `list_tools({query:"delegate"})` and
   `describe_tool({names:["delegate.create_chat","delegate.read_chat","delegate.send_message","delegate.stop_generation"]})`.
5. Optional defense in depth: find this unpacked extension's ID on
   `chrome://extensions` and start the server with
   `SUPERAGENT_DELEGATE_EXTENSION_ID=<id>`; the bridge then rejects other
   extension origins.

## Behavior and boundaries

- The only site-specific content script runs on **chatgpt.com**.
- The bridge uses a fixed RPC allowlist. It never executes arbitrary JavaScript
  or accesses cookies, credentials, or non-ChatGPT tabs.
- **create_chat** requires an existing ChatGPT tab and clicks the New chat
  control once. Missing tab, missing control, or login required yields errors.
- **read_chat** returns visible turn text, latest assistant response, and status.
- **send_message** clicks Send exactly once. After a timeout, network loss or
  unknown delivery it never resends; call read_chat before a new explicit send.
- **stop_generation** is only available by an explicit tool call. A timed-out,
  disconnected, or aborted request does not stop generation.
- No DOM reload recovery, scripting into page contexts, or modification of
  `chrome-extension/`.
- ChatGPT may change its DOM. The selectors should be maintained against the
  actual UI; selectors are heuristic and not a public API.
- Local origin restrictions are not cryptographic authentication. For shared
  machines, set the extension ID restriction and block untrusted local clients.
- Model providers may reject dotted tool names; test your selected provider
  before relying on native function calling.


## Verification

Run from the SuperAgent workspace root:

```powershell
bun --bun x tsc --noEmit
bun run verify:extension-js
bun --bun x vitest run tests/delegate.test.ts tests/delegateContent.test.ts tests/extensionChatToolFilter.test.ts
bun scripts/verify-delegate-discovery.ts
```

The discovery smoke script verifies all four delegate tools in single-agent
T-Line and Chrome-extension chat and confirms they are absent from
T-Line Master mode. The 12 existing Chrome-extension-only tools remain
filtered in T-Line. Tests do not open a browser or send a ChatGPT message.

A live end-to-end check requires a running Chrome instance with the
unpacked extension installed and a logged-in ChatGPT tab. DOM selector
compatibility cannot be claimed from simulated-DOM tests alone.

If the composer contains an unsent draft, delegate.send_message returns
CHATGPT_DRAFT_PRESENT instead of overwriting it.
~~~~

## REVISED - tests/delegate.test.ts

~~~~typescript
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import WebSocket from "ws";
import { DelegateBridge } from "../src/core/delegate/bridge.js";
import { getToolByName, getToolDefinitions } from "../src/core/tools/index.js";
import {
  delegateToolset, masterToolset, superagentToolset, chromeExtensionToolset,
  ORCHESTRATION_TOOL_NAMES, EXTENSION_CHAT_HIDDEN_TOOL_NAMES,
  filterExtensionChatTools, withModeAwareDiscoveryTools,
} from "../src/core/tools/toolsets.js";

const names = [
  "delegate.create_chat",
  "delegate.read_chat",
  "delegate.send_message",
  "delegate.stop_generation",
];

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw Error("No port");
  return new Promise((resolve) => listener.close(() => resolve(address.port)));
}

async function connectedBridge(): Promise<{ bridge: DelegateBridge; ws: WebSocket }> {
  const bridge = new DelegateBridge(await freePort());
  await bridge.start();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
    origin: "chrome-extension://" + "a".repeat(32),
    headers: { Origin: "chrome-extension://" + "a".repeat(32) },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", protocol: "superagent-delegate-v1" }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HELLO timeout")), 2000);
    ws.on("message", function handshake(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "hello_ack") {
        clearTimeout(timer);
        ws.off("message", handshake);
        resolve();
      }
    });
  });
  return { bridge, ws };
}

const opened: Array<{ bridge: DelegateBridge; ws: WebSocket }> = [];
afterEach(async () => {
  for (const { bridge, ws } of opened.splice(0)) {
    ws.terminate();
    await bridge.close();
  }
});

describe("delegate registration and visibility", () => {
  it("exports exactly four conforming Tool objects, without modifying Master", () => {
    expect(delegateToolset.map((x) => x.name)).toEqual(names);
    for (const t of delegateToolset) {
      expect(t.parameters.type).toBe("object");
      expect(typeof t.execute).toBe("function");
      expect(ORCHESTRATION_TOOL_NAMES.has(t.name)).toBe(false);
      expect(masterToolset.some((master) => master.name === t.name)).toBe(false);
      expect(EXTENSION_CHAT_HIDDEN_TOOL_NAMES.has(t.name)).toBe(false);
    }
  });

  it("registers the four tools in the global lookup catalog", () => {
    const catalog = getToolDefinitions();
    for (const name of names) {
      expect(getToolByName(name)?.name).toBe(name);
      expect(catalog.some((tool) => tool.name === name)).toBe(true);
    }
  });

  it("exposes all delegate tools via mode-aware discovery in single-agent T-Line and Chrome chat", async () => {
    for (const chrome of [false, true]) {
      const base = chrome ? chromeExtensionToolset : filterExtensionChatTools(superagentToolset);
      const visible = withModeAwareDiscoveryTools([...base, ...delegateToolset], chrome);
      const discover = visible.find((t) => t.name === "list_tools");
      const describe = visible.find((t) => t.name === "describe_tool");
      expect(discover).toBeDefined();
      expect(describe).toBeDefined();
      const listing = await discover!.execute({ query: "delegate" }, process.cwd());
      for (const name of names) expect(listing).toContain(name);
      const details = JSON.parse(await describe!.execute({ names }, process.cwd()));
      expect(details.map((x: { name: string }) => x.name)).toEqual(names);
    }
  });

  it("does not unhide the 12 existing extension-only tools in T-Line mode", () => {
    const filtered = filterExtensionChatTools([...chromeExtensionToolset, ...delegateToolset]);
    expect([...EXTENSION_CHAT_HIDDEN_TOOL_NAMES]).toHaveLength(12);
    for (const name of EXTENSION_CHAT_HIDDEN_TOOL_NAMES) {
      expect(filtered.some((t) => t.name === name)).toBe(false);
    }
    for (const name of names) expect(filtered.some((t) => t.name === name)).toBe(true);
  });
});

describe("delegate bridge", () => {
  it("forwards a request exactly once and returns the reply", async () => {
    const entry = await connectedBridge();
    opened.push(entry);
    let transmissions = 0;
    entry.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "request") {
        transmissions++;
        entry.ws.send(JSON.stringify({
          type: "response", id: msg.id, ok: true, result: { status: "finished" },
        }));
      }
    });
    const result = JSON.parse(await entry.bridge.request("delegate.read_chat", {}, undefined, 2000));
    expect(result.status).toBe("finished");
    expect(transmissions).toBe(1);
  });

  it("does not retry a timed-out request", async () => {
    const entry = await connectedBridge();
    opened.push(entry);
    let transmissions = 0;
    entry.ws.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "request") transmissions++;
    });
    await expect(entry.bridge.request("delegate.send_message", { message: "hello" }, undefined, 80))
      .rejects.toThrow("DELEGATE_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(transmissions).toBe(1);
  });

  it("fails fast when the extension is missing", async () => {
    const bridge = new DelegateBridge(await freePort());
    await expect(bridge.request("delegate.read_chat", {}, undefined, 1000))
      .rejects.toThrow("DELEGATE_EXTENSION_NOT_CONNECTED");
    await bridge.close();
  });

  it("aborts only the RPC, without issuing stop_generation", async () => {
    const entry = await connectedBridge();
    opened.push(entry);
    const calls: string[] = [];
    entry.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "request") calls.push(msg.method);
    });
    const controller = new AbortController();
    const pending = entry.bridge.request("delegate.send_message", { message: "hello" }, controller.signal, 2000);
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    await expect(pending).rejects.toThrow("DELEGATE_ABORTED");
    expect(calls).toEqual(["delegate.send_message"]);
  });

  it("rejects connections without an extension origin", async () => {
    const bridge = new DelegateBridge(await freePort());
    await bridge.start();
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    await expect(new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, response) => reject(new Error(String(response.statusCode))));
    })).rejects.toThrow();
    ws.terminate();
    await bridge.close();
  });
});
~~~~

## REVISED - tests/delegateContent.test.ts

~~~~typescript
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync(
  new URL("../chrome-extension-delegate/content.js", import.meta.url),
  "utf8",
);

type FakeTurn = {
  isConnected: boolean;
  getClientRects: () => number[];
  getAttribute: (name: string) => string | null;
  querySelector: () => null;
  innerText: string;
  textContent: string;
};

class FakeTextarea {
  isConnected = true;
  private current: string;
  constructor(value = "") { this.current = value; }
  get value(): string { return this.current; }
  set value(value: string) { this.current = value; }
  getClientRects(): number[] { return [1]; }
  focus(): void {}
  dispatchEvent(): boolean { return true; }
  getAttribute(): null { return null; }
  get innerText(): string { return ""; }
  get textContent(): string { return this.current; }
}

type Response = { ok: boolean; result?: any; error?: {code: string; message: string} };

function setup(options: {
  path?: string;
  composer?: FakeTextarea | null;
  turns?: FakeTurn[];
  buttons?: any[];
} = {}) {
  const turns: FakeTurn[] = options.turns || [];
  const buttons = options.buttons || [];
  const composer = options.composer === undefined ? new FakeTextarea() : options.composer;
  let listener: (
    request: any,
    sender: any,
    sendResponse: (response: any) => void
  ) => boolean;
  const chrome = {
    runtime: {
      id: "delegate-test-extension",
      onMessage: {
        addListener(callback: typeof listener) { listener = callback; },
      },
    },
  };
  const document = {
    documentElement: {},
    querySelectorAll(selector: string) {
      if (selector.includes("#prompt-textarea") || selector.includes("[data-testid=\\\"composer\\\"]")) {
        return composer ? [composer] : [];
      }
      if (selector === "button" || selector === "a, button") return buttons;
      if (selector === "[data-message-author-role]") return turns;
      return [];
    },
  };
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }
  const ctx = {
    chrome,
    document,
    location: {
      pathname: options.path || "/c/example",
      href: "https://chatgpt.com/c/example",
    },
    MutationObserver: FakeMutationObserver,
    HTMLTextAreaElement: FakeTextarea,
    Event: class { constructor(_type: string, _options: unknown) {} },
    InputEvent: class { constructor(_type: string, _options: unknown) {} },
    setTimeout,
    clearTimeout,
    window: {},
    console,
  };
  vm.runInNewContext(script, ctx, { filename: "content.js" });
  let requestId = 0;
  async function call(method: string, params: object = {}, id?: string): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const accepts = listener(
        {
          scope: "superagent-delegate-v1",
          action: "execute",
          id: id || `test-${++requestId}`,
          method,
          params,
        },
        { id: chrome.runtime.id },
        resolve,
      );
      if (!accepts) reject(new Error("Unexpected listener rejection"));
    });
  }
  return { call, turns, buttons, composer };
}

function turn(role: "assistant" | "user", text: string): FakeTurn {
  return {
    isConnected: true,
    getClientRects: () => [1],
    getAttribute: () => role,
    querySelector: () => null,
    innerText: text,
    textContent: text,
  };
}

function button(kind: "send" | "stop" | "new", onClick: () => void) {
  return {
    isConnected: true,
    disabled: false,
    getClientRects: () => [1],
    getAttribute: (name: string) => name === "aria-label"
      ? kind === "send" ? "Send prompt" : kind === "stop" ? "Stop generating" : "New chat"
      : null,
    matches: (selector: string) => selector.includes(
      kind === "send" ? "send-button" : kind === "stop" ? "stop-button" : "create-new-chat-button"
    ),
    textContent: kind === "new" ? "New chat" : "",
    click: onClick,
  };
}

describe("delegate content script (simulated DOM)", () => {
  it("rejects logged-out chat without clicking anything", async () => {
    let clicks = 0;
    const sim = setup({ path: "/auth/login", buttons: [button("send", () => clicks++)] });
    const result = await sim.call("delegate.send_message", { message: "hello" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CHATGPT_LOGIN_REQUIRED");
    expect(clicks).toBe(0);
  });

  it("preserves an unsent draft and never clicks Send", async () => {
    let clicks = 0;
    const composer = new FakeTextarea("Important unsent draft");
    const sim = setup({ composer, buttons: [button("send", () => clicks++)] });
    const result = await sim.call("delegate.send_message", { message: "new message" });
    expect(result.error?.code).toBe("CHATGPT_DRAFT_PRESENT");
    expect(composer.value).toBe("Important unsent draft");
    expect(clicks).toBe(0);
  });

  it("returns waiting_for_input for an empty chat", async () => {
    const sim = setup();
    const result = await sim.call("delegate.read_chat");
    expect(result.ok).toBe(true);
    expect(result.result.status).toBe("waiting_for_input");
    expect(result.result.messages).toEqual([]);
  });

  it("submits one Send click and deduplicates identical request IDs", async () => {
    let clicks = 0;
    const turns: FakeTurn[] = [];
    const sim = setup({
      turns,
      buttons: [button("send", () => {
        clicks++;
        turns.push(turn("user", "hello ChatGPT"));
      })],
    });
    const requestId = "same-request";
    const first = await sim.call("delegate.send_message", { message: "hello ChatGPT" }, requestId);
    const second = await sim.call("delegate.send_message", { message: "hello ChatGPT" }, requestId);
    expect(first.ok).toBe(true);
    expect(first.result.delivery).toBe("sent");
    expect(second.ok).toBe(true);
    expect(clicks).toBe(1);
  });

  it("never clicks Stop from read_chat and stops once only on explicit call", async () => {
    let stops = 0;
    const sim = setup({ buttons: [button("stop", () => stops++)] });
    const read = await sim.call("delegate.read_chat");
    expect(read.result.status).toBe("working");
    expect(stops).toBe(0);
    const stopped = await sim.call("delegate.stop_generation");
    expect(stopped.ok).toBe(true);
    expect(stopped.result.stop_requested).toBe(true);
    expect(stops).toBe(1);
  });

  it("creates a fresh chat with one click, without reloading", async () => {
    let clicks = 0;
    const turns = [turn("user", "previous chat")];
    const sim = setup({
      turns,
      buttons: [button("new", () => {
        clicks++;
        turns.length = 0;
      })],
    });
    const out = await sim.call("delegate.create_chat");
    expect(out.ok).toBe(true);
    expect(out.result.created).toBe(true);
    expect(clicks).toBe(1);
  });
});
~~~~

## REVISED - scripts/verify-delegate-discovery.ts

~~~~typescript
// Smoke test the actual SuperAgent arrays and discovery wrappers without
// changing the server, loading a model, or contacting ChatGPT.
process.env.VITEST = "true"; // Skip dynamic hook filesystem watcher in this one-off process.
const {
  delegateToolset,
  superagentToolset,
  chromeExtensionToolset,
  masterToolset,
  filterExtensionChatTools,
  withModeAwareDiscoveryTools,
  EXTENSION_CHAT_HIDDEN_TOOL_NAMES,
  ORCHESTRATION_TOOL_NAMES,
} = await import("../src/core/tools/toolsets.js");

const expected = [
  "delegate.create_chat",
  "delegate.read_chat",
  "delegate.send_message",
  "delegate.stop_generation",
];

function assert(condition: boolean, error: string): void {
  if (!condition) throw new Error(error);
}

async function inspect(
  mode: string,
  base: typeof delegateToolset,
  chromeExtensionMode: boolean,
  includeDelegate: boolean,
): Promise<void> {
  const selected = includeDelegate ? [...base, ...delegateToolset] : base;
  const available = withModeAwareDiscoveryTools(selected, chromeExtensionMode);
  const discovery = available.find((t) => t.name === "list_tools");
  assert(!!discovery, `list_tools missing in ${mode}`);
  const response = await discovery!.execute({ query: "delegate" }, process.cwd());
  console.log(`=== ${mode} list_tools({ query: "delegate" }) ===`);
  console.log(response);
  for (const name of expected) {
    assert(response.includes(name) === includeDelegate, `Unexpected ${name} in ${mode}`);
  }
  const hiddenCount = [...EXTENSION_CHAT_HIDDEN_TOOL_NAMES].filter((name) =>
    available.some((tool) => tool.name === name)
  ).length;
  if (!chromeExtensionMode) assert(hiddenCount === 0, `Filtered tool leaked in ${mode}`);
  assert(ORCHESTRATION_TOOL_NAMES.size > 0, "Master tool allowlist missing");
  assert(expected.every((name) => !ORCHESTRATION_TOOL_NAMES.has(name)), "Delegate leaked to Master allowlist");
  console.log(`PASS: delegate=${includeDelegate}, old-extension-hidden-visible-count=${hiddenCount}\n`);
}

await inspect("T-Line single", filterExtensionChatTools(superagentToolset), false, true);
await inspect("Chrome-extension single", chromeExtensionToolset, true, true);
await inspect("T-Line Master", filterExtensionChatTools(masterToolset), false, false);
process.exit(0);
~~~~

## UNCHANGED

- src/core/tools/types.ts
- src/core/tools/toolDiscoveryTools.ts
- src/core/mcp/McpManager.ts
- package.json
- chrome-extension/ (all existing files)

Browser E2E has NOT been run; no Chrome process was running at verification time.
