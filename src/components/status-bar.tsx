import React from "react";
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
}

export function StatusBar(props: StatusBarProps) {
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
  } = props;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between" paddingX={0}>
        <Box>
          <Text>
            <Text color="green" bold>🟢 ONLINE</Text>
            <Text color="gray"> │ </Text>
            <Text color="cyan" bold>{modelName}</Text>
            {lastSpeed !== null && (
              <>
                <Text color="gray"> │ </Text>
                <Text color="yellow" bold>⚡ {lastSpeed.toFixed(1)} t/s</Text>
              </>
            )}
            <Text color="gray"> │ </Text>
            <Text color="white">Msg: {messageCount}</Text>
            <Text color="gray"> • </Text>
            <Text color="yellow">Proc: {runningTasksCount}</Text>
            <Text color="gray"> • </Text>
            <Text color="magenta">Sub: {runningSubagentsCount}</Text>
          </Text>
        </Box>
        <Box>
          <Text color="magenta" bold>
            Ctx: {contextPercentage}% ({formatCompactNumber(activeContextUsage)}/{formatCompactNumber(contextLimit)})
          </Text>
        </Box>
      </Box>
      <Box justifyContent="space-between" paddingX={0} marginTop={0}>
        <Box>
          <Text>
            <Text color="gray">Workspace: </Text>
            <Text dimColor>{process.cwd()}</Text>
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
      <Box justifyContent="space-between" paddingX={0} marginTop={0}>
        <Box>
          <Text>
            <Text color="gray">Shortcuts: </Text>
            <Text color="cyan">Ctrl+C</Text><Text dimColor> Exit</Text>
            <Text color="gray"> │ </Text>
            <Text color="cyan">Ctrl+P</Text><Text dimColor> Checkpoint</Text>
            <Text color="gray"> │ </Text>
            <Text color="cyan">Esc</Text><Text dimColor> Clear</Text>
            <Text color="gray"> │ </Text>
            <Text color="cyan">↑/↓</Text><Text dimColor> History</Text>
            <Text color="gray"> │ </Text>
            <Text color="cyan">Tab</Text><Text dimColor> Autocomplete</Text>
            <Text color="gray"> │ </Text>
            <Text color="cyan">Ctrl+↑/↓</Text><Text dimColor> Scroll</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
