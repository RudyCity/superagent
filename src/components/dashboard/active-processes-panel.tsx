import React, { memo } from "react";
import { Box, Text } from "ink";
import { isTaskInWorkspace } from "../../core/tools/state.js";

interface ActiveProcessesPanelProps {
  backgroundTasks: Map<string, any>;
  procsScrollOffset: number;
  maxProcsVisible: number;
  focusArea: string;
  runningSubagentsCount: number;
  workspace?: string;
  procsSelectedIndex?: number;
}

export const ActiveProcessesPanel = memo(function ActiveProcessesPanel({
  backgroundTasks,
  procsScrollOffset,
  maxProcsVisible,
  focusArea,
  runningSubagentsCount,
  workspace,
  procsSelectedIndex,
}: ActiveProcessesPanelProps) {
  const workspacePath = workspace || process.cwd();
  const runningProcs = Array.from(backgroundTasks.entries()).filter(([id, task]) => !task.hasExited && !task.isHidden && isTaskInWorkspace(task.cwd, workspacePath));
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
      <Text color={focusArea === "procs" ? "gray" : "cyan"} bold>
        {isFirstHeader ? "┌───" : "├───"}[ ⚙️ ACTIVE PROCESSES ]{scrollIndicator}{helpText}
      </Text>
      {visibleProcs.map(([id, task], index) => {
        const absIndex = procsScrollOffset + index;
        const isSelected = focusArea === "procs" && absIndex === procsSelectedIndex;
        const prefix = isSelected ? "├─── ▶" : "├───  ";
        const textColor = isSelected ? "white" : "cyan";
        return (
          <Text key={id} color={textColor}>
            {prefix} [{id}] Command: {task.command}
          </Text>
        );
      })}
    </Box>
  );
});
