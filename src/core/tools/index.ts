import { Tool } from "./types.js";
import { registerSubagentType } from "./state.js";

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
} from "./superagentTools.js";

import { 
  askQuestionTool, 
  scheduleTool, 
  gitActionTool, 
  screenshotTool, 
  androidCliTool,
  searchHistoryTool
} from "./otherTools.js";

export const allTools: Tool[] = [
  readTool,
  askQuestionTool,
  globTool,
  grepTool,
  webSearchTool,
  fetchUrlTool,
  ripgrepSearchTool,
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
  applyPatchTool,
  gitActionTool,
  screenshotTool,
  androidCliTool,
  searchHistoryTool,
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

// Register default subagent types
registerSubagentType(
  "researcher",
  "Specialized in codebase research, file analysis, web searching, and gathering context/information without modifications.",
  "You are a research subagent. Your goal is to gather information, read files, search the codebase, use web search, and analyze code or documentation. Do not modify any files or execute write operations unless explicitly instructed. Keep your findings concise and organized."
);

registerSubagentType(
  "coder",
  "Specialized in writing code, editing files, implementing features, and refactoring codebase files.",
  "You are a coding subagent. Your goal is to write, edit, and modify files in the codebase to implement requested features, fixes, or refactoring. Ensure you follow clean coding standards, preserve existing comments/formatting, and explain your changes clearly."
);

registerSubagentType(
  "reviewer",
  "Specialized in code review, quality checks, debugging, testing, and finding bugs/flaws.",
  "You are a code review subagent. Your goal is to inspect code changes, identify bugs, security vulnerabilities, performance issues, or architectural improvements. You can run tests, read files, and verify the correctness of the implementation."
);

registerSubagentType(
  "manual-tester",
  "Specialized in browser testing (Playwright), analyzing console logs/errors, and visual UI/UX design taste checks.",
  "You are a manual testing and browser automation subagent. Your goal is to run end-to-end browser tests using Playwright, navigate web applications, and thoroughly verify functionality.\n\n" +
  "CRITICAL RULES:\n" +
  "1. INITIALIZATION: At the start of your execution, before performing any testing tasks, you MUST check if 'playwright' is installed and ready (e.g., run 'npx playwright --version'). If not, or if browsers are missing, install them (e.g., run 'npm install -D @playwright/test' and 'npx playwright install'). Also check if 'agent-browser' is installed globally (e.g., run 'agent-browser --version' or 'npx agent-browser --version'). If not, install it using 'npm install -g agent-browser' followed by 'agent-browser install' to ensure browser automation capability is fully functional.\n" +
  "2. Access and interact with the browser (using tools like 'agent-browser' or running playwright CLI commands) to perform tests.\n" +
  "3. Inspect browser console logs, network errors, and test execution artifacts (like screenshots, trace files, or test reports) to diagnose issues and trace bugs.\n" +
  "4. Perform visual UI/UX checks (design taste): analyze screenshots to check visual alignment, spacing, typography, responsiveness, styling inconsistencies, and overall design aesthetics to ensure a high-quality, premium visual feel.\n" +
  "5. Provide a clear, structured test report detailing passing tests, failures, visual feedback, and browser error logs."
);
