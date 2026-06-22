import React from "react";
import { Box, Text } from "ink";
import { formatCompactNumber } from "../../utils/text.js";

export interface DashboardStatusBarProps {
  activeModel: string;
  contextPercentage: string;
  activeContextUsage: number;
  contextLimit: number;
  lastSpeed: number | null;
  masterPromptTokens: number;
  masterCompletionTokens: number;
  historicalSuperagentTokens: number;
  activeSuperagentsCount: number;
  subagentInstances: any; // Map or registry of subagents
  worktreeCount: number;
  runningTasksCount: number;
  runningSubagentsCount: number;
  activeWTs: string[];
  activeWizard: any;
  wizardOptions: string[];
  focusArea: string;
}

export function DashboardStatusBar({
  activeModel,
  contextPercentage,
  activeContextUsage,
  contextLimit,
  lastSpeed,
  masterPromptTokens,
  masterCompletionTokens,
  historicalSuperagentTokens,
  activeSuperagentsCount,
  subagentInstances,
  worktreeCount,
  runningTasksCount,
  runningSubagentsCount,
  activeWTs,
  activeWizard,
  wizardOptions,
  focusArea,
}: DashboardStatusBarProps) {
  const subagentTokens = Array.from(subagentInstances.values()).reduce(
    (acc: number, i: any) => acc + (i.tokenUsage?.prompt || 0) + (i.tokenUsage?.completion || 0),
    0
  );

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box>
          <Text>
            <Text color="green" bold>🟢 ONLINE</Text>
            <Text color="gray"> │ </Text>
            <Text color="yellow" bold>{activeModel}</Text>
            <Text color="gray"> │ </Text>
            <Text color="green" bold>Ctx: {contextPercentage}% ({formatCompactNumber(activeContextUsage)}/{formatCompactNumber(contextLimit)})</Text>
            <Text color="gray"> │ </Text>
            <Text color="yellow">▲ {formatCompactNumber(masterPromptTokens)}</Text>
            <Text color="gray"> │ </Text>
            <Text color="green">▼ {formatCompactNumber(masterCompletionTokens)}</Text>
          </Text>
        </Box>
        <Box>
          <Text>
            {lastSpeed !== null && (
              <>
                <Text color="cyan" bold>⚡ {lastSpeed.toFixed(1)} t/s</Text>
                <Text color="gray"> │ </Text>
              </>
            )}
            <Text color="blue" bold>Master: {(masterPromptTokens + masterCompletionTokens).toLocaleString()}t</Text>
            <Text color="gray"> │ </Text>
            <Text color="cyan" bold>Superagents({activeSuperagentsCount} active): {(historicalSuperagentTokens || 0).toLocaleString()}t</Text>
            <Text color="gray"> │ </Text>
            <Text color="yellow" bold>Subagents: {subagentTokens.toLocaleString()}t</Text>
            <Text color="gray"> │ </Text>
            <Text color="blue" bold>Worktrees: {worktreeCount}</Text>
            <Text color="gray"> │ </Text>
            <Text color="yellow" bold>Proc: {runningTasksCount}</Text>
            <Text color="gray"> • </Text>
            <Text color="blue" bold>Sub: {runningSubagentsCount}</Text>
          </Text>
        </Box>
      </Box>
      <Box flexDirection="row" justifyContent="space-between" marginTop={0}>
        <Box>
          <Text>
            <Text color="gray">Workspace: </Text>
            <Text color="white" bold>{process.cwd()}</Text>
          </Text>
        </Box>
      </Box>
      {activeWTs.length > 0 && (
        <Box flexDirection="row" marginTop={0}>
          <Text color="gray">Active branches: </Text>
          <Text color="cyan" bold>{activeWTs.join(", ")}</Text>
        </Box>
      )}
      <Box flexDirection="row" marginTop={0}>
        {activeWizard ? (
          <Text color="yellow">
            <Text bold color="yellow">⚡ [WIZARD] </Text>
            {activeWizard.isMultiSelect ? (
              <Text color="gray" dimColor>[▲/▼] Navigate  [Space] Select/Toggle  [Enter] Confirm  [Esc] Cancel</Text>
            ) : wizardOptions.length > 0 ? (
              <Text color="gray" dimColor>[▲/▼] Navigate  [Enter] Select  [Esc] Cancel</Text>
            ) : (
              <Text color="gray" dimColor>[Type text...]  [Enter] Submit  [Esc] Cancel</Text>
            )}
          </Text>
        ) : (
          <Text color="gray" dimColor>
            <Text bold color="cyan">[{focusArea.toUpperCase()}] </Text>
            {focusArea === "input" && (
              <Text>[Tab] Focus List  [▲/▼] History  [Ctrl+T] Toggle Truncate  [Ctrl+C] Exit/Interrupt</Text>
            )}
            {focusArea === "list" && (
              <Text>[▲/▼] Select Session  [1-9] Quick Select  [Enter] View Logs  [Tab] Cycle Focus  [Esc] Focus Input</Text>
            )}
            {focusArea === "logs" && (
              <Text>[▲/▼] Scroll Logs  [Esc] Focus List  [Tab] Cycle Focus</Text>
            )}
            {focusArea === "checklist" && (
              <Text>[▲/▼] Scroll Checklist  [Esc] Focus Input  [Tab] Cycle Focus</Text>
            )}
            {focusArea === "agents" && (
              <Text>[▲/▼] Scroll Agents  [Esc] Focus Input  [Tab] Cycle Focus</Text>
            )}
            {focusArea === "procs" && (
              <Text>[▲/▼] Scroll Processes  [Esc] Focus Input  [Tab] Cycle Focus</Text>
            )}
          </Text>
        )}
      </Box>
    </Box>
  );
}
