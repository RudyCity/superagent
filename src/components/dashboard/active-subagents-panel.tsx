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
      {visibleAgents.map((inst, index) => {
        const isLast = index === visibleAgents.length - 1;
        const branchChar = isLast ? "└──" : "├──";
        const action = getLatestSubagentAction(inst.logs);
        return (
          <Text key={inst.id} color="yellow">
            │  {branchChar} Action: {inst.id}: <Text italic color="white">{action}</Text> | Role: {inst.role} ({inst.status})
          </Text>
        );
      })}
    </Box>
  );
}
