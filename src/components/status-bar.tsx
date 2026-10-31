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
  rmemoryStatus?: "online" | "offline" | "ready" | "disabled";
  activeDevHook?: string | null;
  workspace?: string;
  isProcessing?: boolean;
  activeChainName?: string | null;
  activeChainNodeCount?: number;
  activeLocks?: number;
  yoloMode?: boolean;
  fullYoloMode?: boolean;
  isVisionActive?: boolean;
}

function LoadingIndicator() {
  // A text status conveys activity without rapid color cycling or flashing.
  return <Text color="cyan">● WORKING</Text>;
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
    activeLocks,
    yoloMode,
    fullYoloMode,
    isVisionActive,
  } = props;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {/* Line 1: Environment & Session */}
      <Box flexWrap="nowrap">
        {isProcessing ? (
          <LoadingIndicator />
        ) : (
          <Text color="gray" bold>● READY</Text>
        )}
        <Text color="gray"> • </Text>
        <Text color="white" wrap="truncate-end">{modelName}</Text>
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
            <Text color="gray" wrap="truncate-end">🔗 Chain: {activeChainName}{activeChainNodeCount ? ` (${activeChainNodeCount} nodes)` : ""}</Text>
          </>
        )}
        {fullYoloMode ? (
          <>
            <Text color="gray"> • </Text>
            <Text color="redBright" bold>⚡ YOLO FULL</Text>
          </>
        ) : yoloMode ? (
          <>
            <Text color="gray"> • </Text>
            <Text color="redBright" bold>🔥 YOLO</Text>
          </>
        ) : null}
      </Box>

      {/* Line 2: Metrics & Context */}
      <Box justifyContent="space-between" marginTop={0} flexWrap="nowrap">
        <Box flexWrap="nowrap" flexShrink={1}>
          <Text color="white">Msg: {messageCount}</Text>
          {activeLocks && activeLocks > 0 ? (
            <>
              <Text color="gray"> • </Text>
              <Text color="yellowBright" bold>🔒 {activeLocks}</Text>
            </>
          ) : null}
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
          {isVisionActive ? (
            <>
              <Text color="gray"> • </Text>
              <Text color="greenBright" bold>👁 DETR: ON </Text>
            </>
          ) : null}
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
          {rmemoryStatus === "ready" && (
            <>
              <Text color="gray"> • </Text>
              <Text color="cyan" bold>🧠 Mem: READY</Text>
            </>
          )}
          {(rmemoryStatus === "disabled" || !rmemoryStatus) && (
            <>
              <Text color="gray"> • </Text>
              <Text color="gray" dimColor>🧠 Mem: OFF</Text>
            </>
          )}
        </Box>
        <Box flexShrink={0}>
          <Text color="blueBright" bold>
            Ctx: {contextPercentage}% ({formatCompactNumber(activeContextUsage)}/{formatCompactNumber(contextLimit)})
          </Text>
        </Box>
      </Box>
    </Box>
  );
});
