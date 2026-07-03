import React, { memo } from "react";
import { Box, Text } from "ink";

export interface StatusBarProps {
  modelName: string;
  contextPercentage: number;
  tokensUp: number;
  tokensDown: number;
  liveStreamTokens: number;
  activeContextUsage: number;
  contextLimit: number;
  messageCount: number;
  runningTasksCount: number;
  runningSubagentsCount: number;
  gitBranch: string;
  worktreeCount: number;
  lastSpeed: number | null;
  formatCompactNumber: (val: number) => string;
  tencentdbStatus?: "online" | "offline" | "checking" | "disabled";
  activeDevHook?: string | null;
  workspace?: string;
  focus?: string;
  isProcessing?: boolean;
}

function StatusBarSpinner() {
  const [frame, setFrame] = React.useState(0);
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  React.useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % spinnerFrames.length);
    }, 120);
    return () => clearInterval(timer);
  }, []);

  return <Text color="yellow" bold>{spinnerFrames[frame]} </Text>;
}

export const StatusBar = memo(function StatusBar(props: StatusBarProps) {
  const {
    modelName,
    contextPercentage,
    tokensUp,
    tokensDown,
    liveStreamTokens,
    activeContextUsage,
    contextLimit,
    messageCount,
    runningTasksCount,
    runningSubagentsCount,
    gitBranch,
    worktreeCount,
    lastSpeed,
    formatCompactNumber,
    tencentdbStatus,
    activeDevHook,
    workspace,
    focus,
    isProcessing = false,
  } = props;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between" paddingX={0}>
        <Box>
          <Text>
            <Text color="cyan" bold>{modelName}</Text>
            {isProcessing && (
              <>
                <Text color="gray"> │ </Text>
                <StatusBarSpinner />
                <Text color="yellow" bold>Processing...</Text>
              </>
            )}
            {lastSpeed !== null && (
              <>
                <Text color="gray"> │ </Text>
                <Text color="yellow" bold>⚡ {lastSpeed.toFixed(1)} t/s</Text>
              </>
            )}
            {focus && focus !== "off" && (
              <>
                <Text color="gray"> │ </Text>
                <Text color="green" bold>🎯 Focus: {focus.toUpperCase()}</Text>
              </>
            )}
            <Text color="gray"> │ </Text>
            <Text color="white">Msg: {messageCount}</Text>
            <Text color="gray"> • </Text>
            <Text color="yellow">Proc: {runningTasksCount}</Text>
            <Text color="gray"> • </Text>
            <Text color="blue">Sub: {runningSubagentsCount}</Text>
            <Text color="gray"> │ </Text>
            {tencentdbStatus === "online" && (
              <Text color="magenta" bold>🧠 Mem: ON</Text>
            )}
            {tencentdbStatus === "offline" && (
              <Text color="red" bold>🧠 Mem: OFFLINE</Text>
            )}
            {tencentdbStatus === "checking" && (
              <Text color="yellow" bold>🧠 Mem: CHECKING</Text>
            )}
            {(tencentdbStatus === "disabled" || !tencentdbStatus) && (
              <Text color="gray" dimColor>🧠 Mem: OFF</Text>
            )}
          </Text>
        </Box>
        <Box>
          <Text color="blue" bold>
            Ctx: {contextPercentage}% ({formatCompactNumber(activeContextUsage)}/{formatCompactNumber(contextLimit)})
          </Text>
        </Box>
      </Box>
      <Box justifyContent="space-between" paddingX={0} marginTop={0}>
        <Box>
          <Text>
            <Text color="gray">Workspace: </Text>
            <Text dimColor>{workspace || process.cwd()}</Text>
            {gitBranch && (
              <>
                <Text color="gray"> │ </Text>
                <Text color="gray">Branch: </Text>
                <Text color="green" bold>🌿 {gitBranch}</Text>
              </>
            )}
            {worktreeCount > 0 && (
              <>
                <Text color="gray"> │ </Text>
                <Text color="blue" bold>Worktrees: {worktreeCount}</Text>
              </>
            )}
            {activeDevHook && (
              <>
                <Text color="gray"> │ </Text>
                <Text color="magenta" bold>🪝 dev {activeDevHook} hook</Text>
              </>
            )}
          </Text>
        </Box>
        <Box>
          <Text>
            <Text color="yellow">▲ {formatCompactNumber(tokensUp)}</Text>
            <Text color="gray"> │ </Text>
            <Text color="green">▼ {formatCompactNumber(tokensDown + liveStreamTokens)}</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
});
