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
  tdaiMemorySearchTool,
  tdaiConversationSearchTool,
  tdaiReadCosTool,
  tdaiMemorySaveTool,
  tdaiConversationAddTool,
} from "./tencentdbMemoryTools.js";
import { manageMcpTool } from "./mcpTools.js";
import { saveSharedMemoryTool } from "./sharedMemoryTools.js";

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
  manageMcpTool,
  readTool,              // read-only: inspect results
  globTool,
  grepTool,
  gitWorktreeTool,
  manageTasksTool,
  managePlanTool,
  getSkillsTool,
  useSkillTool,
  controlBrowserTabTool,
  controlBrowserMacroSaveTool,
  controlBrowserMacroRunTool,
  writeToFileTool,       // for planning files
  replaceFileContentTool,// for planning files
  multiReplaceFileContentTool, // for planning files
  runCommandTool,        // for running validation / test commands
  bashTool,              // for running validation / test commands
  tdaiMemorySearchTool,
  tdaiConversationSearchTool,
  tdaiReadCosTool,
  tdaiMemorySaveTool,
  tdaiConversationAddTool,
];

// ─── Superagent Toolset (depth 1) ────────────────────────────────────────────
// Full development toolset. Scoped to own worktree at runtime via permission layer.
export const superagentToolset: Tool[] = [
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
  screenshotTool,
  controlBrowserTabTool,
  controlBrowserMacroSaveTool,
  controlBrowserMacroRunTool,
  androidCliTool,
  readPeerSuperagentFileTool, // read files from peer Superagent worktrees
  tdaiMemorySearchTool,
  tdaiConversationSearchTool,
  tdaiReadCosTool,
  tdaiMemorySaveTool,
  tdaiConversationAddTool,
  saveSharedMemoryTool,
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
  screenshotTool,
  controlBrowserTabTool,
  controlBrowserMacroSaveTool,
  controlBrowserMacroRunTool,
  androidCliTool,
  tdaiMemorySearchTool,
  tdaiConversationSearchTool,
  tdaiReadCosTool,
  tdaiMemorySaveTool,
  tdaiConversationAddTool,
  saveSharedMemoryTool,
];


// ─── Subagent Toolsets (depth 2) — keyed by type name ───────────────────────
export const subagentToolsets: Record<string, Tool[]> = {
  researcher: [
    readTool,
    globTool,
    grepTool,
    ripgrepSearchTool,
    webSearchTool,
    fetchUrlTool,
    searchHistoryTool,
    loadPinnedSessionTool,
    searchPinnedKnowledgeTool,
    askQuestionTool,
    getSkillsTool,
    useSkillTool,
    tdaiMemorySearchTool,
    tdaiConversationSearchTool,
    tdaiReadCosTool,
    tdaiMemorySaveTool,
    tdaiConversationAddTool,
    saveSharedMemoryTool,
  ],

  coder: [
    readTool,
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
    askQuestionTool,
    getSkillsTool,
    useSkillTool,
    tdaiMemorySearchTool,
    tdaiConversationSearchTool,
    tdaiReadCosTool,
    tdaiMemorySaveTool,
    tdaiConversationAddTool,
    saveSharedMemoryTool,
  ],

  reviewer: [
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
    tdaiMemorySearchTool,
    tdaiConversationSearchTool,
    tdaiReadCosTool,
  ],

  "manual-tester": [
    readTool,
    globTool,
    grepTool,
    runCommandTool,
    bashTool,
    runBackgroundProcessTool,
    screenshotTool,
    webSearchTool,
    askQuestionTool,
    getSkillsTool,
    useSkillTool,
    tdaiMemorySearchTool,
    tdaiConversationSearchTool,
    tdaiReadCosTool,
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
];