import React, { memo, useState, useEffect } from "react";
import { Box, Text } from "ink";
import { superagentInstances, subagentInstances, backgroundTasks, isTaskInWorkspace } from "../core/tools.js";
import { getSubagentActionStreams, getLatestSubagentAction, getLatestSuperagentAction } from "../utils/uiHelpers.js";

interface ActiveAgentsListProps {
  focusMode: string;
  runningSuperagentsCount: number;
  runningSubagentsCount: number;
  runningTasksCount: number;
  superagentsScrollOffset: number;
  subagentsScrollOffset: number;
  procsScrollOffset: number;
  maxSuperagentsVisible: number;
  maxSubagentsVisible: number;
  maxProcsVisible: number;
  collapsedSections: { superagents: boolean; subagents: boolean; procs: boolean };
  workspace?: string;
  procsSelectedIndex?: number;
}

export const ActiveAgentsList = memo(function ActiveAgentsList({
  focusMode,
  runningSuperagentsCount,
  runningSubagentsCount,
  runningTasksCount,
  superagentsScrollOffset,
  subagentsScrollOffset,
  procsScrollOffset,
  maxSuperagentsVisible,
  maxSubagentsVisible,
  maxProcsVisible,
  collapsedSections,
  workspace,
  procsSelectedIndex,
}: ActiveAgentsListProps) {
  const [streamTick, setStreamTick] = useState(0);

  useEffect(() => {
    if (runningSubagentsCount === 0) return;
    const timer = setInterval(() => {
      setStreamTick((t) => (t + 1) % 1000);
    }, 2500);
    return () => clearInterval(timer);
  }, [runningSubagentsCount]);

  if (runningSuperagentsCount === 0 && runningSubagentsCount === 0 && runningTasksCount === 0) {
    return null;
  }

  const runningSuperagents = Array.from(superagentInstances.values()).filter((s) => s.status === "running");
  const runningSubagents = Array.from(subagentInstances.values()).filter((s) => s.status === "running");
  const workspacePath = workspace || process.cwd();
  const runningProcs = Array.from(backgroundTasks.entries()).filter(([_, task]) => !task.hasExited && !task.isHidden && isTaskInWorkspace(task.cwd, workspacePath));

  return (
    <Box flexDirection="column" marginBottom={0}>
      {/* === SUPERAGENTS === */}
      {runningSuperagentsCount > 0 && (() => {
        const totalSA = runningSuperagents.length;
        const isCollapsed = collapsedSections.superagents;
        const isFocused = focusMode === "superagents";
        const collapseIcon = isCollapsed ? "▶" : "▼";
        const headerColor = isFocused ? "gray" : "cyan";

        if (isCollapsed) {
          return (
            <Box flexDirection="column">
              <Text color={headerColor} bold>
                ┌───[ {collapseIcon} ⚡ ACTIVE SUPERAGENTS ({totalSA}) ] <Text dimColor italic>click to expand</Text>
              </Text>
            </Box>
          );
        }

        const hasScroll = totalSA > maxSuperagentsVisible;
        const scrollIndicator = hasScroll
          ? ` [Scroll: ${superagentsScrollOffset + 1}-${Math.min(totalSA, superagentsScrollOffset + maxSuperagentsVisible)}/${totalSA}]`
          : "";
        const helpText = isFocused ? " [↑/▼ Scroll │ Esc Exit]" : "";
        const visibleSA = runningSuperagents.slice(superagentsScrollOffset, superagentsScrollOffset + maxSuperagentsVisible);
        return (
          <Box flexDirection="column">
            <Text color={headerColor} bold>
              ┌───[ {collapseIcon} ⚡ ACTIVE SUPERAGENTS ]{scrollIndicator}{helpText} <Text dimColor italic>click header to collapse</Text>
            </Text>
            {visibleSA.map((inst) => (
              <Box key={inst.id} flexDirection="column">
                <Text color="cyan" wrap="truncate">
                  ├─── [{inst.id}] Role: {inst.role} ({inst.status})
                </Text>
                <Text color="cyan" wrap="truncate">
                  │    ├─── Task: <Text color="white">{inst.task}</Text>
                </Text>
                <Text color="cyan" wrap="truncate">
                  │    └─ Action: <Text italic color="white">{getLatestSuperagentAction(inst.logs, inst.task)}</Text>
                </Text>
              </Box>
            ))}
          </Box>
        );
      })()}

      {/* === SUBAGENTS === */}
      {runningSubagentsCount > 0 && (() => {
        const totalSubs = runningSubagents.length;
        const isCollapsed = collapsedSections.subagents;
        const isFocused = focusMode === "subagents";
        const collapseIcon = isCollapsed ? "▶" : "▼";
        const headerColor = isFocused ? "gray" : "yellow";
        const isFirstHeader = runningSuperagentsCount === 0;
        const branchPrefix = isFirstHeader ? "┌───" : "├───";

        if (isCollapsed) {
          return (
            <Box flexDirection="column" marginTop={0}>
              <Text color={headerColor} bold>
                {branchPrefix}[ {collapseIcon} 🤖 ACTIVE SUBAGENTS ({totalSubs}) ] <Text dimColor italic>click to expand</Text>
              </Text>
            </Box>
          );
        }

        const hasScroll = totalSubs > maxSubagentsVisible;
        const scrollIndicator = hasScroll
          ? ` [Scroll: ${subagentsScrollOffset + 1}-${Math.min(totalSubs, subagentsScrollOffset + maxSubagentsVisible)}/${totalSubs}]`
          : "";
        const helpText = isFocused ? " [↑/▼ Scroll │ Esc Exit]" : "";
        const visibleSubs = runningSubagents.slice(subagentsScrollOffset, subagentsScrollOffset + maxSubagentsVisible);
        return (
          <Box flexDirection="column" marginTop={0}>
            <Text color={headerColor} bold>
              {branchPrefix}[ {collapseIcon} 🤖 ACTIVE SUBAGENTS ]{scrollIndicator}{helpText} <Text dimColor italic>click header to collapse</Text>
            </Text>
            {visibleSubs.map((inst, index) => {
              const isLast = index === visibleSubs.length - 1;
              const branchChar = isLast ? "└──" : "├──";
              const streams = getSubagentActionStreams(inst.logs, inst.prompt);
              const currentAction = streams[streamTick % streams.length];
              return (
                <Text key={inst.id} color="yellow" wrap="truncate">
                  │  {branchChar} Action: {inst.id}: <Text italic color="white">{currentAction}</Text> | Role: {inst.role} ({inst.status})
                </Text>
              );
            })}
          </Box>
        );
      })()}

      {/* === PROCESSES === */}
      {runningTasksCount > 0 && (() => {
        const totalProcs = runningProcs.length;
        const isCollapsed = collapsedSections.procs;
        const isFocused = focusMode === "procs";
        const collapseIcon = isCollapsed ? "▶" : "▼";
        const headerColor = isFocused ? "gray" : "cyan";
        const isFirstHeader = runningSuperagentsCount === 0 && runningSubagentsCount === 0;
        const branchPrefix = isFirstHeader ? "┌───" : "├───";

        if (isCollapsed) {
          return (
            <Box flexDirection="column" marginTop={0}>
              <Text color={headerColor} bold>
                {branchPrefix}[ {collapseIcon} ⚙️ ACTIVE PROCESSES ({totalProcs}) ] <Text dimColor italic>click to expand</Text>
              </Text>
            </Box>
          );
        }

        const hasScroll = totalProcs > maxProcsVisible;
        const scrollIndicator = hasScroll
          ? ` [Scroll: ${procsScrollOffset + 1}-${Math.min(totalProcs, procsScrollOffset + maxProcsVisible)}/${totalProcs}]`
          : "";
        const helpText = isFocused ? " [↑/▼ Scroll │ Esc Exit]" : "";
        const visibleProcs = runningProcs.slice(procsScrollOffset, procsScrollOffset + maxProcsVisible);
        return (
          <Box flexDirection="column" marginTop={0}>
            <Text color={headerColor} bold>
              {branchPrefix}[ {collapseIcon} ⚙️ ACTIVE PROCESSES ]{scrollIndicator}{helpText} <Text dimColor italic>click header to collapse</Text>
            </Text>
            {visibleProcs.map(([id, task], index) => {
              const absIndex = procsScrollOffset + index;
              const isSelected = isFocused && absIndex === procsSelectedIndex;
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
      })()}
    </Box>
  );
});
