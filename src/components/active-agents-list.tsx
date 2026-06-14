import React from "react";
import { Box, Text } from "ink";
import { superagentInstances, subagentInstances, backgroundTasks } from "../core/tools.js";

function getLatestSubagentAction(logs: string[]): string {
  if (!logs || logs.length === 0) return "Initializing...";
  for (let i = logs.length - 1; i >= 0; i--) {
    const raw = logs[i].trim();
    if (raw) {
      let clean = raw
        .replace(/^.*?───\[\s*/, "")
        .replace(/\s*\]$/, "")
        .replace(/^[│┌├└─\s]+/, "")
        .trim();
      clean = clean.replace(/^Description:\s*/i, "");
      clean = clean.replace(/^Args:\s*/i, "");
      if (clean) {
        return clean.length > 80 ? clean.slice(0, 80) + "..." : clean;
      }
    }
  }
  return "Processing...";
}

function getLatestSuperagentAction(logs: string[]): string {
  if (!logs || logs.length === 0) return "Initializing...";
  for (let i = logs.length - 1; i >= 0; i--) {
    const raw = logs[i].trim();
    if (raw) {
      let clean = raw
        .replace(/^\[THINK\]\s*/i, "")
        .replace(/^\[TOOL:START\]\s*/i, "")
        .replace(/^\[TOOL:SUCCESS\]\s*/i, "")
        .replace(/^\[TOOL:FAILED\]\s*/i, "")
        .replace(/^\[ERROR\]\s*/i, "")
        .replace(/^[│┌├└─\s]+/, "")
        .trim();
      if (clean) {
        return clean.length > 80 ? clean.slice(0, 80) + "..." : clean;
      }
    }
  }
  return "Processing...";
}

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
}

export function ActiveAgentsList({
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
}: ActiveAgentsListProps) {
  if (runningSuperagentsCount === 0 && runningSubagentsCount === 0 && runningTasksCount === 0) {
    return null;
  }

  const runningSuperagents = Array.from(superagentInstances.values()).filter((s) => s.status === "running");
  const runningSubagents = Array.from(subagentInstances.values()).filter((s) => s.status === "running");
  const runningProcs = Array.from(backgroundTasks.entries()).filter(([_, task]) => !task.hasExited);

  return (
    <Box flexDirection="column" marginBottom={0}>
      {runningSuperagentsCount > 0 && (() => {
        const totalSA = runningSuperagents.length;
        const hasScroll = totalSA > maxSuperagentsVisible;
        const scrollIndicator = hasScroll
          ? ` [Scroll: ${superagentsScrollOffset + 1}-${Math.min(totalSA, superagentsScrollOffset + maxSuperagentsVisible)}/${totalSA}]`
          : "";
        const helpText = focusMode === "superagents" ? " [↑/▼ Scroll • Esc Exit]" : "";
        const visibleSA = runningSuperagents.slice(superagentsScrollOffset, superagentsScrollOffset + maxSuperagentsVisible);
        return (
          <Box flexDirection="column">
            <Text color={focusMode === "superagents" ? "green" : "cyan"} bold>
              ┌───[ ⚡ ACTIVE SUPERAGENTS ]{scrollIndicator}{helpText}
            </Text>
            {visibleSA.map((inst) => (
              <Box key={inst.id} flexDirection="column">
                <Text color="cyan">
                  ├─── [{inst.id}] Role: {inst.role} ({inst.status})
                </Text>
                <Text color="cyan">
                  │    ├─── Task: <Text color="white">{inst.task}</Text>
                </Text>
                <Text color="cyan">
                  │    └─ Action: <Text italic color="white">{getLatestSuperagentAction(inst.logs)}</Text>
                </Text>
              </Box>
            ))}
          </Box>
        );
      })()}

      {runningSubagentsCount > 0 && (() => {
        const totalSubs = runningSubagents.length;
        const hasScroll = totalSubs > maxSubagentsVisible;
        const scrollIndicator = hasScroll
          ? ` [Scroll: ${subagentsScrollOffset + 1}-${Math.min(totalSubs, subagentsScrollOffset + maxSubagentsVisible)}/${totalSubs}]`
          : "";
        const helpText = focusMode === "subagents" ? " [↑/▼ Scroll • Esc Exit]" : "";
        const visibleSubs = runningSubagents.slice(subagentsScrollOffset, subagentsScrollOffset + maxSubagentsVisible);
        const isFirstHeader = runningSuperagentsCount === 0;
        return (
          <Box flexDirection="column" marginTop={0}>
            <Text color={focusMode === "subagents" ? "green" : "yellow"} bold>
              {isFirstHeader ? "┌───" : "├───"}[ 🤖 ACTIVE SUBAGENTS ]{scrollIndicator}{helpText}
            </Text>
            {visibleSubs.map((inst) => (
              <Box key={inst.id} flexDirection="column">
                <Text color="yellow">
                  ├─── [{inst.id}] Type: {inst.typeName} | Role: {inst.role} ({inst.status})
                </Text>
                <Text color="yellow">
                  │    └─ Action: <Text italic color="white">{getLatestSubagentAction(inst.logs)}</Text>
                </Text>
              </Box>
            ))}
          </Box>
        );
      })()}

      {runningTasksCount > 0 && (() => {
        const totalProcs = runningProcs.length;
        const hasScroll = totalProcs > maxProcsVisible;
        const scrollIndicator = hasScroll
          ? ` [Scroll: ${procsScrollOffset + 1}-${Math.min(totalProcs, procsScrollOffset + maxProcsVisible)}/${totalProcs}]`
          : "";
        const helpText = focusMode === "procs" ? " [↑/▼ Scroll • Esc Exit]" : "";
        const visibleProcs = runningProcs.slice(procsScrollOffset, procsScrollOffset + maxProcsVisible);
        const isFirstHeader = runningSuperagentsCount === 0 && runningSubagentsCount === 0;
        return (
          <Box flexDirection="column" marginTop={0}>
            <Text color={focusMode === "procs" ? "green" : "cyan"} bold>
              {isFirstHeader ? "┌───" : "├───"}[ ⚙️ ACTIVE PROCESSES ]{scrollIndicator}{helpText}
            </Text>
            {visibleProcs.map(([id, task]) => (
              <Text key={id} color="cyan">
                ├─── [{id}] Command: {task.command}
              </Text>
            ))}
          </Box>
        );
      })()}
    </Box>
  );
}
