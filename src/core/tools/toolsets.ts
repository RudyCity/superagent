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

// ─── Master Agent Toolset (depth 0) ─────────────────────────────────────────
// Focused on orchestration. Does NOT write code itself.
export const masterToolset: Tool[] = [
  askQuestionTool,
  invokeSuperagentTool,  // spawn superagent in worktree
  awaitSuperagentsTool,  // wait for all superagents to finish
  mergeSuperagentsTool,  // merge all completed branches
  manageSuperagentsTool, // list/logs/report/kill superagents
  defineSuperagentTool,  // define custom superagent types
  sendMessageToSuperagentTool, // send follow-up message to superagent
  manageSubagentsTool,   // monitor/kill subagents if needed
  scheduleTool,
  searchHistoryTool,
  loadPinnedSessionTool,
  searchPinnedKnowledgeTool,
  webSearchTool,
  searchJournalTool,
  readDocumentTool,
  officeCliTool,
  manageMcpTool,
  readTool,              // read-only: inspect results
  globTool,
  grepTool,
  gitWorktreeTool,
  manageTasksTool,
  managePlanTool,
  getSkillsTool,
  useSkillTool,
  writeToFileTool,       // for planning files
  replaceFileContentTool,// for planning files
  multiReplaceFileContentTool, // for planning files
  runCommandTool,        // for running validation / test commands
  bashTool,              // for running validation / test commands
  rmemorySearchTool,
  rmemoryConversationSearchTool,
  rmemoryReadCosTool,
  rmemorySaveTool,
  rmemoryConversationAddTool,
  saveSharedMemoryTool,
  readSharedMemoryTool,
  manageWorkspaceChainTool,
  crossWorkspaceExecTool,
];

// ─── Superagent Toolset (depth 1) ────────────────────────────────────────────
// Full development toolset. Scoped to own worktree at runtime via permission layer.
export const superagentToolset: Tool[] = [
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
  readPeerSuperagentFileTool, // read files from peer Superagent worktrees
  rmemorySearchTool,
  rmemoryConversationSearchTool,
  rmemoryReadCosTool,
  rmemorySaveTool,
  rmemoryConversationAddTool,
  saveSharedMemoryTool,
  readSharedMemoryTool,
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
    defineSubagentTool,
    invokeSubagentTool,
    sendMessageTool,
    manageSubagentsTool,
  ],

  coder: [
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
    defineSubagentTool,
    invokeSubagentTool,
    sendMessageTool,
    manageSubagentsTool,
  ],

  reviewer: [
    readTool,
    readDocumentTool,
    officeCliTool,
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
    runCommandTool,
    bashTool,
    webSearchTool,
    askQuestionTool,
    getSkillsTool,
    useSkillTool,
    rmemorySearchTool,
    rmemoryConversationSearchTool,
    rmemoryReadCosTool,
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
    readTool,
    globTool,
    grepTool,
    ripgrepSearchTool,
    webSearchTool,
    askQuestionTool,
    getSkillsTool,
    useSkillTool,
    defineSubagentTool,
    invokeSubagentTool,
    sendMessageTool,
    manageSubagentsTool,
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
  defineSubagentTool,
  invokeSubagentTool,
  sendMessageTool,
  manageSubagentsTool,
];