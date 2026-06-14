import React from "react";
import { Box, Text } from "ink";

interface ActiveSubagentsPanelProps {
  subagentInstances: Map<string, any>;
  agentsScrollOffset: number;
  maxAgentsVisible: number;
  focusArea: string;
  getLatestSubagentAction: (logs: string[]) => string;
}

export function ActiveSubagentsPanel({
  subagentInstances,
  agentsScrollOffset,
  maxAgentsVisible,
  focusArea,
  getLatestSubagentAction,
}: ActiveSubagentsPanelProps) {
  const runningAgents = Array.from(subagentInstances.values()).filter((s) => s.status === "running");
  if (runningAgents.length === 0) {
    return null;
  }

  const totalAgents = runningAgents.length;
  const hasScroll = totalAgents > maxAgentsVisible;
  const scrollIndicator = hasScroll
    ? ` [Scroll: ${agentsScrollOffset + 1}-${Math.min(totalAgents, agentsScrollOffset + maxAgentsVisible)}/${totalAgents}]`
    : "";
  const helpText = focusArea === "agents" ? " [↑/▼ Scroll • Esc Exit]" : "";
  const visibleAgents = runningAgents.slice(agentsScrollOffset, agentsScrollOffset + maxAgentsVisible);

  return (
    <Box flexDirection="column">
      <Text color={focusArea === "agents" ? "green" : "yellow"} bold>
        ┌───[ 🤖 ACTIVE SUBAGENTS ]{scrollIndicator}{helpText}
      </Text>
      {visibleAgents.map((inst) => (
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
}
