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
  rmemoryStatus?: "online" | "offline" | "checking" | "disabled";
  activeDevHook?: string | null;
  workspace?: string;
  focus?: string;
  isProcessing?: boolean;
  activeChainName?: string | null;
  activeChainNodeCount?: number;
}

function LoadingIndicator() {
  const [frame, setFrame] = React.useState(0);
  const rPulseColors = ["cyan", "cyanBright", "yellow", "white", "magenta"];

  React.useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % 5);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const rColor = rPulseColors[frame % rPulseColors.length];

  return (
    <Text bold color="cyan">
      <Text color={rColor}>[R]</Text>
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
    rmemoryStatus,
    activeChainName,
    activeChainNodeCount,
  } = props;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {/* Line 1: Environment & Session */}
      <Box>
        {isProcessing ? (
          <LoadingIndicator />
        ) : (
          <Text color="gray" bold>● READY</Text>
        )}
        <Text color="gray"> • </Text>
        <Text color="cyanBright" bold>{modelName}</Text>
        {presetName && (
          <>
            <Text color="gray"> • </Text>
            <Text color="gray">◆ {presetName}</Text>
          </>
        )}
        {gitBranch && (
          <>
            <Text color="gray"> • </Text>
            <Text color="gray">🌿 {gitBranch}</Text>
          </>
        )}
        {activeChainName && (
          <>
            <Text color="gray"> • </Text>
            <Text color="magentaBright" bold>🔗 Chain: {activeChainName}{activeChainNodeCount ? ` (${activeChainNodeCount} nodes)` : ""}</Text>
          </>
        )}
      </Box>

      {/* Line 2: Metrics & Context */}
      <Box justifyContent="space-between" marginTop={0}>
        <Box>
          <Text color="white">Msg: {messageCount}</Text>
          <Text color="gray"> • </Text>
          <Text color={runningTasksCount > 0 ? "yellowBright" : "gray"}>Proc: {runningTasksCount}</Text>
          <Text color="gray"> • </Text>
          <Text color={runningSubagentsCount > 0 ? "cyanBright" : "gray"}>Sub: {runningSubagentsCount}</Text>
          {lastSpeed !== null && (
            <>
              <Text color="gray"> • </Text>
              <Text color="yellowBright" bold>⚡ {lastSpeed.toFixed(1)} t/s</Text>
            </>
          )}
          {rmemoryStatus === "online" && (
            <>
              <Text color="gray"> • </Text>
              <Text color="magenta" bold>🧠 Mem: ON</Text>
            </>
          )}
          {rmemoryStatus === "offline" && (
            <>
              <Text color="gray"> • </Text>
              <Text color="red" bold>🧠 Mem: OFFLINE</Text>
            </>
          )}
          {rmemoryStatus === "checking" && (
            <>
              <Text color="gray"> • </Text>
              <Text color="yellow" bold>🧠 Mem: CHECKING</Text>
            </>
          )}
          {(rmemoryStatus === "disabled" || !rmemoryStatus) && (
            <>
              <Text color="gray"> • </Text>
              <Text color="gray" dimColor>🧠 Mem: OFF</Text>
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

