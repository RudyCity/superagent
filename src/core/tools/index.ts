import fs from "fs";
import path from "path";
import { Tool } from "./types.js";
import { registerSubagentType } from "./state.js";
import {
  masterToolset,
  superagentToolset,
  subagentToolsets,
  defaultSubagentToolset,
  chromeExtensionToolset
} from "./toolsets.js";
import { loadDynamicHooks } from "./dynamicHooks.js";

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
  manageBackgroundProcessTool 
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
  rmemorySearchTool,
  rmemoryConversationSearchTool,
  rmemoryReadCosTool,
  rmemorySaveTool,
  rmemoryConversationAddTool,
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
  runHeadlessBrowserTool,
  simulateVirtualCursorTool,
  controlIsolatedCdpTool,
} from "./advancedAutomationTools.js";
import { transferSshFileTool } from "./sshTransferTools.js";
import { cliBridgeTool } from "./cliBridgeTool.js";

export {
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
  cliBridgeTool,
};
import { manageWorkspaceChainTool, crossWorkspaceExecTool } from "../workspace/workspaceChainTools.js";


export const allTools: Tool[] = [
  runHeadlessBrowserTool,
  simulateVirtualCursorTool,
  controlIsolatedCdpTool,
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
  rmemorySearchTool,
  rmemoryConversationSearchTool,
  rmemoryReadCosTool,
  rmemorySaveTool,
  rmemoryConversationAddTool,
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
];

export function getToolByName(name: string): Tool | undefined {
  return allTools.find((t) => t.name === name);
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