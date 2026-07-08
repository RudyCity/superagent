import React, { memo } from "react";
import { Box, Text } from "ink";

export interface StatusBarProps {
  modelName: string;
  presetName?: string;
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

function LoadingIndicator() {
  const [frame, setFrame] = React.useState(0);
  const frames = [
    "▰▱▱▱▱",
    "▱▰▱▱▱",
    "▱▱▰▱▱",
    "▱▱▱▰▱",
    "▱▱▱▱▰",
    "▱▱▱▰▱",
    "▱▱▰▱▱",
    "▱▰▱▱▱",
  ];

  React.useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % frames.length);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text bold color="blueBright">
      [{frames[frame]}] Processing...
    </Text>
  );
}

export const StatusBar = memo(function StatusBar(props: StatusBarProps) {
  const {
    modelName,
    presetName,
    contextPercentage,
    activeContextUsage,
    contextLimit,
    messageCount,
    runningTasksCount,
    runningSubagentsCount,
    gitBranch,
    formatCompactNumber,
    lastSpeed,
    isProcessing = false,
  } = props;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Box>
          {/* Left badge: spinner when processing, READY when idle */}
          {isProcessing ? (
            <LoadingIndicator />
          ) : (
            <Text color="gray" bold>● READY</Text>
          )}
          <Text color="gray"> │ </Text>
          <Text color="cyanBright" bold>{modelName}</Text>
          {presetName && (
            <>
              <Text color="gray"> │ </Text>
              <Text color="gray">◆ {presetName}</Text>
            </>
          )}
          {gitBranch && (
            <>
              <Text color="gray"> │ </Text>
              <Text color="gray">🌿 {gitBranch}</Text>
            </>
          )}
          <Text color="gray"> │ </Text>
          <Text color="white">Msg: {messageCount}</Text>
          <Text color="gray"> │ </Text>
          <Text color={runningTasksCount > 0 ? "yellowBright" : "gray"}>Proc: {runningTasksCount}</Text>
          <Text color="gray"> • </Text>
          <Text color={runningSubagentsCount > 0 ? "cyanBright" : "gray"}>Sub: {runningSubagentsCount}</Text>
          {lastSpeed !== null && (
            <>
              <Text color="gray"> │ </Text>
              <Text color="yellowBright" bold>⚡ {lastSpeed.toFixed(1)} t/s</Text>
            </>
          )}
        </Box>
        <Box>
          <Text color="blueBright" bold>
            Ctx: {contextPercentage}% ({formatCompactNumber(activeContextUsage)}/{formatCompactNumber(contextLimit)})
          </Text>
        </Box>
      </Box>
    </Box>
  );
});

