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
  gitWorktreeTool,
} from "./otherTools.js";

import {
  invokeSuperagentTool,
  awaitSuperagentsTool,
  mergeSuperagentsTool,
  manageSuperagentsTool,
  defineSuperagentTool,
  sendMessageToSuperagentTool,
} from "./superagentTools.js";

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
  webSearchTool,
  readTool,              // read-only: inspect results
  globTool,
  grepTool,
  gitWorktreeTool,
  writeToFileTool,       // for planning files
  replaceFileContentTool,// for planning files
  multiReplaceFileContentTool, // for planning files
  runCommandTool,        // for running validation / test commands
  bashTool,              // for running validation / test commands
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
  defineSubagentTool,    // define specialized subagents
  invokeSubagentTool,    // spawn subagents (depth 2)
  sendMessageTool,
  manageSubagentsTool,
  askQuestionTool,
  scheduleTool,
  searchHistoryTool,
  screenshotTool,
  androidCliTool,
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
  ],

  reviewer: [
    readTool,
    globTool,
    grepTool,
    ripgrepSearchTool,
    runCommandTool,
    bashTool,
    webSearchTool,
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
  ],
};

/** Fallback toolset for unrecognized subagent types */
export const defaultSubagentToolset: Tool[] = [
  readTool,
  globTool,
  grepTool,
  webSearchTool,
  writeToFileTool,
  replaceFileContentTool,
  runCommandTool,
  bashTool,
];
