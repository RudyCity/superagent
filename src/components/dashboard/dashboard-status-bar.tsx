import React, { memo } from "react";
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
  rmemoryStatus?: "online" | "offline" | "checking" | "disabled";
  workspace?: string;
  isProcessing?: boolean;
}

function StatusBarSpinner() {
  const [frame, setFrame] = React.useState(0);
  const rPulseColors = ["cyan", "cyanBright", "yellow", "white", "magenta"];

  React.useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % 5);
    }, 120);
    return () => clearInterval(timer);
  }, []);

  const rColor = rPulseColors[frame % rPulseColors.length];
  return <Text color={rColor} bold>[R]</Text>;
}

export const DashboardStatusBar = memo(function DashboardStatusBar({
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
  rmemoryStatus,
  workspace,
  isProcessing = false,
}: DashboardStatusBarProps) {
  const subagentTokens = Array.from(subagentInstances.values()).reduce(
    (acc: number, i: any) => acc + (i.tokenUsage?.prompt || 0) + (i.tokenUsage?.completion || 0),
    0
  );

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {/* Row 1: Engine Status */}
      <Box flexDirection="row">
        {isProcessing && (
          <>
            <StatusBarSpinner />
            <Text color="yellow" bold>Processing...</Text>
            <Text color="gray"> • </Text>
          </>
        )}
        <Text color="cyan" bold>🤖 {activeModel}</Text>
        <Text color="gray"> • </Text>
        <Text color="gray" bold>Ctx: {contextPercentage}% ({formatCompactNumber(activeContextUsage)}/{formatCompactNumber(contextLimit)})</Text>
        {lastSpeed !== null && (
          <>
            <Text color="gray"> • </Text>
            <Text color="yellow" bold>⚡ {lastSpeed.toFixed(1)} t/s</Text>
          </>
        )}
        <Text color="gray"> • </Text>
        {rmemoryStatus === "online" && (
          <Text color="magenta" bold>🧠 Mem: ON</Text>
        )}
        {rmemoryStatus === "offline" && (
          <Text color="red" bold>🧠 Mem: OFFLINE</Text>
        )}
        {rmemoryStatus === "checking" && (
          <Text color="yellow" bold>🧠 Mem: CHECKING</Text>
        )}
        {(rmemoryStatus === "disabled" || !rmemoryStatus) && (
          <Text color="gray" dimColor>🧠 Mem: OFF</Text>
        )}
      </Box>

      {/* Row 2: Tokens & stats */}
      <Box flexDirection="row">
        <Text color="gray">Tokens: </Text>
        <Text color="white">Master: </Text>
        <Text color="cyan" bold>{(masterPromptTokens + masterCompletionTokens).toLocaleString()}t </Text>
        <Text color="gray" dimColor>(▲{formatCompactNumber(masterPromptTokens)} ▼{formatCompactNumber(masterCompletionTokens)})</Text>
        <Text color="gray"> • </Text>
        <Text color="white">Super: </Text>
        <Text color="magenta" bold>{(historicalSuperagentTokens || 0).toLocaleString()}t </Text>
        <Text color="gray" dimColor>({activeSuperagentsCount} act)</Text>
        <Text color="gray"> • </Text>
        <Text color="white">Sub: </Text>
        <Text color="yellow" bold>{subagentTokens.toLocaleString()}t </Text>
        <Text color="gray" dimColor>({runningSubagentsCount} run)</Text>
        <Text color="gray"> • </Text>
        <Text color="white">Proc: </Text>
        <Text color="gray" bold>{runningTasksCount}</Text>
        <Text color="gray"> • </Text>
        <Text color="white">WT: </Text>
        <Text color="cyan" bold>{worktreeCount}</Text>
      </Box>

      {/* Row 3: Workspace */}
      <Box flexDirection="row">
        <Text color="gray">Workspace: </Text>
        <Text color="white" bold>{workspace || process.cwd()}</Text>
      </Box>

      {/* Row 4: Active Branches (Optional) */}
      {activeWTs.length > 0 && (
        <Box flexDirection="row">
          <Text color="gray">Active branches: </Text>
          <Text color="cyan" bold>{activeWTs.join(", ")}</Text>
        </Box>
      )}

      {/* Row 5: Wizard / Controls */}
      <Box flexDirection="row">
        {activeWizard ? (
          <Text color="yellow">
            <Text bold color="yellow">⚡ WIZARD </Text>
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
              <Text>[Tab] Focus List  [▲/▼] History  [Ctrl+T] Toggle Truncate  [Ctrl+C] Exit</Text>
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
});
