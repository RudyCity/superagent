import React, { memo, useState, useEffect } from "react";
import { Box, Text } from "ink";
import { getSubagentActionStreams } from "../../utils/uiHelpers.js";

interface ActiveSubagentsPanelProps {
  subagentInstances: Map<string, any>;
  agentsScrollOffset: number;
  maxAgentsVisible: number;
  focusArea: string;
  getLatestSubagentAction: (logs: string[], prompt?: string) => string;
}

export const ActiveSubagentsPanel = memo(function ActiveSubagentsPanel({
  subagentInstances,
  agentsScrollOffset,
  maxAgentsVisible,
  focusArea,
  getLatestSubagentAction,
}: ActiveSubagentsPanelProps) {
  const [streamTick, setStreamTick] = useState(0);
  const runningAgents = Array.from(subagentInstances.values()).filter((s) => s.status === "running");

  useEffect(() => {
    if (runningAgents.length === 0) return;
    const timer = setInterval(() => {
      setStreamTick((t) => (t + 1) % 1000);
    }, 2500);
    return () => clearInterval(timer);
  }, [runningAgents.length]);

  if (runningAgents.length === 0) {
    return null;
  }

  const totalAgents = runningAgents.length;
  const hasScroll = totalAgents > maxAgentsVisible;
  const scrollIndicator = hasScroll
    ? ` [Scroll: ${agentsScrollOffset + 1}-${Math.min(totalAgents, agentsScrollOffset + maxAgentsVisible)}/${totalAgents}]`
    : "";
  const helpText = focusArea === "agents" ? " [↑/▼ Scroll │ Esc Exit]" : "";
  const visibleAgents = runningAgents.slice(agentsScrollOffset, agentsScrollOffset + maxAgentsVisible);

  return (
    <Box flexDirection="column">
      <Text color={focusArea === "agents" ? "gray" : "yellow"} bold wrap="truncate">
        ┌───[ 🤖 ACTIVE SUBAGENTS ]{scrollIndicator}{helpText}
      </Text>
      {visibleAgents.map((inst, index) => {
        const isLast = index === visibleAgents.length - 1;
        const branchChar = isLast ? "└──" : "├──";
        const streams = getSubagentActionStreams(inst.logs, inst.prompt);
        const action = streams[streamTick % streams.length];
        return (
          <Text key={inst.id} color="yellow" wrap="truncate">
            │  {branchChar} Action: {inst.id}: <Text italic color="white">{action}</Text> | Role: {inst.role} ({inst.status})
          </Text>
        );
      })}
    </Box>
  );
});

