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

function LoadingIndicator() {
  const [bright, setBright] = React.useState(true);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setBright((prev) => !prev);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const color = bright ? "blueBright" : "blue";

  return (
    <Text bold color={color}>
      ⠿ Processing...
    </Text>
  );
}

export const StatusBar = memo(function StatusBar(props: StatusBarProps) {
  const {
    modelName,
    contextPercentage,
    activeContextUsage,
    contextLimit,
    messageCount,
    runningTasksCount,
    runningSubagentsCount,
    gitBranch,
    formatCompactNumber,
    isProcessing = false,
  } = props;

  if (!isProcessing) {
    return (
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Box justifyContent="space-between">
          <Box>
            <Text color="greenBright" bold>● READY</Text>
            <Text color="gray"> │ </Text>
            <Text color="cyanBright" bold>{modelName}</Text>
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
          </Box>
          <Box>
            <Text color="blueBright" bold>
              Ctx: {contextPercentage}% ({formatCompactNumber(activeContextUsage)}/{formatCompactNumber(contextLimit)})
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box>
        <LoadingIndicator />
      </Box>
    </Box>
  );
});

