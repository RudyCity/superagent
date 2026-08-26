/**
 * toolsets.ts — Per-tier tool definitions for the 3-tier multi-agent system.
 *
 * Master Agent  (depth 0): orchestration only — no direct coding
 * Superagent    (depth 1): full dev toolset, scoped to own worktree
 * Subagent      (depth 2): restricted toolset per specialization type
 */

import { Tool } from "./types.js";
import {
  readTool,
  editTool,
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
  runHeadlessBrowserTool,
  simulateVirtualCursorTool,
  controlIsolatedCdpTool,
} from "./advancedAutomationTools.js";

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
  rmemorySearchTool,
  rmemoryConversationSearchTool,
  rmemoryReadCosTool,
  rmemorySaveTool,
  rmemoryConversationAddTool,
} from "./rmemoryTools.js";

import { manageMcpTool } from "./mcpTools.js";
import { saveSharedMemoryTool, readSharedMemoryTool } from "./sharedMemoryTools.js";
import { manageWorkspaceChainTool, crossWorkspaceExecTool } from "../workspace/workspaceChainTools.js";
import { unlockFileTool, getLockStatsTool, resolveConflictTool, generateLockReportTool } from "./lockTools.js";
import { transferSshFileTool } from "./sshTransferTools.js";

// ─── Master Agent Toolset (depth 0) ─────────────────────────────────────────
// Orchestration only. The Master Agent MUST NOT directly modify code or
// run arbitrary shell — those are the Superagent's job. This was previously
// violated (writeToFileTool, bashTool, etc. were in the master toolset).
// See: AGENTS.md §"Master Agent Planning" + the security audit in
// sess_1787733100811_xetwt4_walkthrough.md (C3).
export const masterToolset: Tool[] = [
  // ── Superagent orchestration (the core job of the Master) ──
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
  officeCliTool,
  // ── Planning & session management (writes only to ~/.superagent-r/) ──
  scheduleTool,
  manageTasksTool,
  managePlanTool,
  getSkillsTool,
  useSkillTool,
  // The three write tools below ARE allowed in the master toolset because
  // the Master owns its own plan/task/walkthrough artifacts. The runtime
  // path-allowlist in the write tools' .execute() blocks writes to the
  // codebase for tier==="master" callers, so the Master cannot directly
  // edit source files. Codebase edits MUST be delegated to Superagents.
  writeToFileTool,
  replaceFileContentTool,
  multiReplaceFileContentTool,
  // ── Long-term memory & shared state (read+write, scoped to memory store) ──
  rmemorySearchTool,
  rmemoryConversationSearchTool,
  rmemoryReadCosTool,
  rmemorySaveTool,
  rmemoryConversationAddTool,
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
  transferSshFileTool,
  readTool,
  readDocumentTool,
  officeCliTool,
  writeToFileTool,
  replaceFileContentTool,
  multiReplaceFileContentTool,
  editTool,
  applyPatchTool,
  globTool,
  grepTool,
  ripgrepSearchTool,
  bashTool,
  runCommandTool,
  runBackgroundProcessTool,
  manageBackgroundProcessTool,
  webSearchTool,
  fetchUrlTool,
  searchJournalTool,
  gitActionTool,         // commit to own branch
  gitWorktreeTool,
  manageTasksTool,
  managePlanTool,
  getSkillsTool,
  useSkillTool,
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
  androidCliTool,
  playwrightScreenshotTool,
  readPeerSuperagentFileTool, // read files from peer Superagent worktrees
  rmemorySearchTool,
  rmemoryConversationSearchTool,
  rmemoryReadCosTool,
  rmemorySaveTool,
  rmemoryConversationAddTool,
  saveSharedMemoryTool,
  readSharedMemoryTool,
  getLockStatsTool,
  generateLockReportTool,
  manageWorkspaceChainTool,
  crossWorkspaceExecTool,
];

// ─── Chrome Extension Toolset (depth 1) ──────────────────────────────────────
export const chromeExtensionToolset: Tool[] = [
  readTool,
  writeToFileTool,
  replaceFileContentTool,
  multiReplaceFileContentTool,
  editTool,
  applyPatchTool,
  globTool,
  grepTool,
  ripgrepSearchTool,
  bashTool,
  runCommandTool,
  runBackgroundProcessTool,
  manageBackgroundProcessTool,
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
  androidCliTool,
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
  screenshotTool,
  playwrightScreenshotTool,
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
    askQuestionTool,
    getSkillsTool,
    useSkillTool,
    rmemorySearchTool,
    rmemoryConversationSearchTool,
    rmemoryReadCosTool,
    rmemorySaveTool,
    rmemoryConversationAddTool,
    saveSharedMemoryTool,
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
    editTool,
    applyPatchTool,
    globTool,
    grepTool,
    ripgrepSearchTool,
    runCommandTool,
    bashTool,
    webSearchTool,
    searchJournalTool,
    askQuestionTool,
    getSkillsTool,
    useSkillTool,
    rmemorySearchTool,
    rmemoryConversationSearchTool,
    rmemoryReadCosTool,
    rmemorySaveTool,
    rmemoryConversationAddTool,
    saveSharedMemoryTool,
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
    webSearchTool,
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
  askQuestionTool,
  getSkillsTool,
  useSkillTool,
  sendMessageTool,
];