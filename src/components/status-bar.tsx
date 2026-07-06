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
  const spinnerFrames = [0, 1, 2, 3, 4, 3, 2, 1];
  const activeIdx = spinnerFrames[frame];

  React.useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % 8);
    }, 120);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text bold>
      <Text color="gray">[</Text>
      <Text color={activeIdx === 0 ? "redBright" : "gray"}>{activeIdx === 0 ? "▰" : "▱"}</Text>
      <Text color={activeIdx === 1 ? "yellowBright" : "gray"}>{activeIdx === 1 ? "▰" : "▱"}</Text>
      <Text color={activeIdx === 2 ? "greenBright" : "gray"}>{activeIdx === 2 ? "▰" : "▱"}</Text>
      <Text color={activeIdx === 3 ? "cyanBright" : "gray"}>{activeIdx === 3 ? "▰" : "▱"}</Text>
      <Text color={activeIdx === 4 ? "magentaBright" : "gray"}>{activeIdx === 4 ? "▰" : "▱"}</Text>
      <Text color="gray">] </Text>
    </Text>
  );
}

function ColorfulLoadingText() {
  const [frame, setFrame] = React.useState(0);
  const colors = ["redBright", "yellowBright", "greenBright", "cyanBright", "blueBright", "magentaBright"];
  const text = "Processing...";

  React.useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % colors.length);
    }, 120);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text bold>
      {text.split("").map((char, idx) => {
        const color = colors[(idx + frame) % colors.length];
        return <Text key={idx} color={color}>{char}</Text>;
      })}
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
        <StatusBarSpinner />
        <ColorfulLoadingText />
      </Box>
    </Box>
  );
});

