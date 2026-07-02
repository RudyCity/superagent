import React from "react";
import { Box, Text } from "ink";

interface ActiveProcessesPanelProps {
  backgroundTasks: Map<string, any>;
  procsScrollOffset: number;
  maxProcsVisible: number;
  focusArea: string;
  runningSubagentsCount: number;
}

export function ActiveProcessesPanel({
  backgroundTasks,
  procsScrollOffset,
  maxProcsVisible,
  focusArea,
  runningSubagentsCount,
}: ActiveProcessesPanelProps) {
  const runningProcs = Array.from(backgroundTasks.entries()).filter(([id, task]) => !task.hasExited && !task.isHidden);
  if (runningProcs.length === 0) {
    return null;
  }

  const totalProcs = runningProcs.length;
  const hasScroll = totalProcs > maxProcsVisible;
  const scrollIndicator = hasScroll
    ? ` [Scroll: ${procsScrollOffset + 1}-${Math.min(totalProcs, procsScrollOffset + maxProcsVisible)}/${totalProcs}]`
    : "";
  const helpText = focusArea === "procs" ? " [↑/▼ Scroll • Esc Exit]" : "";
  const visibleProcs = runningProcs.slice(procsScrollOffset, procsScrollOffset + maxProcsVisible);
  const isFirstHeader = runningSubagentsCount === 0;

  return (
    <Box flexDirection="column" marginTop={0}>
      <Text color={focusArea === "procs" ? "green" : "cyan"} bold>
        {isFirstHeader ? "┌───" : "├───"}[ ⚙️ ACTIVE PROCESSES ]{scrollIndicator}{helpText}
      </Text>
      {visibleProcs.map(([id, task]) => (
        <Text key={id} color="cyan">
          ├─── [{id}] Command: {task.command}
        </Text>
      ))}
    </Box>
  );
}
