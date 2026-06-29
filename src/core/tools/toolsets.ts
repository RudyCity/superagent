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
import { fastcontextTool } from "./fastcontextTool.js";
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
} from "./otherTools.js";

import {
  invokeSuperagentTool,
  awaitSuperagentsTool,
  mergeSuperagentsTool,
  manageSuperagentsTool,
  defineSuperagentTool,
  sendMessageToSuperagentTool,
} from "./superagentTools.js";

import {
  tdaiMemorySearchTool,
  tdaiConversationSearchTool,
  tdaiReadCosTool,
  tdaiMemorySaveTool,
  tdaiConversationAddTool,
} from "./tencentdbMemoryTools.js";
import { manageMcpTool } from "./mcpTools.js";

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
  fastcontextTool,       // AI-powered repo explorer
  manageMcpTool,
  readTool,              // read-only: inspect results
  globTool,
  grepTool,
  gitWorktreeTool,
  manageTasksTool,
  managePlanTool,
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
  fastcontextTool,       // AI-powered repo explorer
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
  androidCliTool,
  tdaiMemorySearchTool,
  tdaiConversationSearchTool,
  tdaiReadCosTool,
  tdaiMemorySaveTool,
  tdaiConversationAddTool,
];

// ─── Subagent Toolsets (depth 2) — keyed by type name ───────────────────────
export const subagentToolsets: Record<string, Tool[]> = {
  researcher: [
    readTool,
    globTool,
    grepTool,
    ripgrepSearchTool,
    fastcontextTool,     // AI-powered repo explorer (uses researcher tier model)
    webSearchTool,
    fetchUrlTool,
    searchHistoryTool,
    loadPinnedSessionTool,
    searchPinnedKnowledgeTool,
    askQuestionTool,
    tdaiMemorySearchTool,
    tdaiConversationSearchTool,
    tdaiReadCosTool,
    tdaiMemorySaveTool,
    tdaiConversationAddTool,
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
    fastcontextTool,     // AI-powered repo explorer
    runCommandTool,
    bashTool,
    webSearchTool,
    askQuestionTool,
    tdaiMemorySearchTool,
    tdaiConversationSearchTool,
    tdaiReadCosTool,
    tdaiMemorySaveTool,
    tdaiConversationAddTool,
  ],

  reviewer: [
    readTool,
    globTool,
    grepTool,
    ripgrepSearchTool,
    fastcontextTool,     // AI-powered repo explorer
    runCommandTool,
    bashTool,
    webSearchTool,
    askQuestionTool,
    tdaiMemorySearchTool,
    tdaiConversationSearchTool,
    tdaiReadCosTool,
    tdaiMemorySaveTool,
    tdaiConversationAddTool,
  ],

  "manual-tester": [
    readTool,
    globTool,
    grepTool,
    fastcontextTool,     // AI-powered repo explorer
    runCommandTool,
    bashTool,
    runBackgroundProcessTool,
    screenshotTool,
    webSearchTool,
    askQuestionTool,
    tdaiMemorySearchTool,
    tdaiConversationSearchTool,
    tdaiReadCosTool,
    tdaiMemorySaveTool,
    tdaiConversationAddTool,
  ],
};

/** Fallback toolset for unrecognized subagent types */
export const defaultSubagentToolset: Tool[] = [
  readTool,
  globTool,
  grepTool,
  fastcontextTool,       // AI-powered repo explorer
  manageMcpTool,
  webSearchTool,
  writeToFileTool,
  replaceFileContentTool,
  runCommandTool,
  bashTool,
  askQuestionTool,
  tdaiMemorySearchTool,
  tdaiConversationSearchTool,
  tdaiReadCosTool,
  tdaiMemorySaveTool,
  tdaiConversationAddTool,
];