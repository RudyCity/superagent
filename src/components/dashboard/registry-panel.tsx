import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { AgentSession } from "../multi-agent-dashboard.js";

function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

// Active status badge with blinking effect
export function ActiveStatusBadge() {
  const [activeBlink, setActiveBlink] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveBlink((prev) => !prev);
    }, 600);
    return () => clearInterval(timer);
  }, []);

  return activeBlink ? (
    <Text color="black" backgroundColor="yellow" bold>● ACTIVE</Text>
  ) : (
    <Text color="yellow" bold>  ACTIVE</Text>
  );
}

export function SessionSpinner() {
  const [frame, setFrame] = useState(0);
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % spinnerFrames.length);
    }, 120);
    return () => clearInterval(timer);
  }, []);

  return <Text color="yellow" bold>{spinnerFrames[frame]} </Text>;
}

export function renderStatusBadge(status: AgentSession["status"]) {
  if (status === "WORKING") {
    return <ActiveStatusBadge />;
  }
  if (status === "PAUSED") return <Text color="black" backgroundColor="magenta" bold> PAUSE </Text>;
  if (status === "COMPLETED") return <Text color="black" backgroundColor="green" bold> DONE </Text>;
  if (status === "ERROR") return <Text color="black" backgroundColor="red" bold> FAIL </Text>;
  return <Text color="black" backgroundColor="gray" bold> IDLE </Text>;
}

export const tierIcon: Record<AgentSession["type"], string> = {
  MASTER:     "👑",
  SUPERAGENT: "⚡",
  SUBAGENT:   "🔍",
  TASK:       "⚙",
};

export const tierColor: Record<AgentSession["type"], string> = {
  MASTER:     "magenta",
  SUPERAGENT: "cyan",
  SUBAGENT:   "yellow",
  TASK:       "gray",
};

interface RegistryPanelProps {
  sessions: AgentSession[];
  selectedIndex: number;
  focusArea: string;
  startIdx: number;
  visibleSessions: AgentSession[];
  getLatestSuperagentAction: (logs: string[]) => string;
  getLatestSubagentAction: (logs: string[]) => string;
  leftTopHeight: number;
}

export function RegistryPanel({
  sessions,
  selectedIndex,
  focusArea,
  startIdx,
  visibleSessions,
  getLatestSuperagentAction,
  getLatestSubagentAction,
  leftTopHeight,
}: RegistryPanelProps) {
  return (
    <Box 
      flexDirection="column" 
      paddingX={1}
      height={leftTopHeight}
      marginBottom={1}
    >
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text bold color={focusArea === "list" ? "green" : "cyan"}>📡 WORKSPACE REGISTRY | {sessions.length} threads</Text>
        {focusArea === "list" && (
          <Text color="gray" dimColor> [↑/▼ Navigate • Enter Inspect]</Text>
        )}
      </Box>
      {sessions.length === 0 ? (
        <Box flexDirection="row" marginTop={0}>
          <Text color="gray" dimColor>No active agent threads detected</Text>
        </Box>
      ) : (
        visibleSessions.map((session, index) => {
          const globalIndex = startIdx + index;
          const isSelected = globalIndex === selectedIndex;
          const color = isSelected ? (focusArea === "list" ? "green" : "cyan") : tierColor[session.type];
          
          const isFocused = focusArea === "list";
          const rowBg = isSelected && isFocused ? "green" : undefined;
          const rowTextColor = isSelected && isFocused ? "white" : color;
          const tokenColor = isSelected && isFocused ? "white" : "cyan";
          
          const getDepth = (s: AgentSession) => {
            return s.type === "MASTER" ? 0 
                 : s.type === "SUPERAGENT" ? 1 
                 : s.type === "TASK" ? 1
                 : (s.parentId === "master" ? 1 : 2);
          };

          const hasMoreSiblings = (idx: number, d: number): boolean => {
            for (let i = idx + 1; i < sessions.length; i++) {
              const s = sessions[i];
              const sDepth = getDepth(s);
              if (sDepth < d) {
                break;
              }
              if (sDepth === d) {
                return true;
              }
            }
            return false;
          };

          const depth = getDepth(session);
          let prefix = "";
          if (depth === 0) {
            prefix = `${tierIcon[session.type]} `;
          } else if (depth === 1) {
            const hasMore = hasMoreSiblings(globalIndex, 1);
            prefix = (hasMore ? "├── " : "└── ") + `${tierIcon[session.type]} `;
          } else if (depth === 2) {
            let parentIndex = -1;
            const parentId = session.parentId;
            for (let i = globalIndex - 1; i >= 0; i--) {
              const s = sessions[i];
              if (s.type === "SUPERAGENT" && s.id.endsWith(parentId || "")) {
                parentIndex = i;
                break;
              }
            }

            const parentHasMore = parentIndex !== -1 && hasMoreSiblings(parentIndex, 1);
            const level1 = parentHasMore ? "│   " : "    ";
            const hasMore = hasMoreSiblings(globalIndex, 2);
            const level2 = hasMore ? "├── " : "└── ";
            prefix = level1 + level2 + `${tierIcon[session.type]} `;
          }

          let label = "";
          
          if (session.type === "MASTER") {
            label = `master ❯ ${session.task}`;
          } else if (session.type === "SUPERAGENT") {
            const action = getLatestSuperagentAction(session.logs);
            const role = session.id.split("-")[1] || "superagent";
            label = `${role} ❯ ${action}`;
          } else if (session.type === "SUBAGENT") {
            const action = getLatestSubagentAction(session.logs);
            const name = session.id.split("-")[0];
            label = `${name} ❯ ${action}`;
          } else {
            label = `${session.id.slice(0, 14)}`;
          }

          if (isSelected && isFocused) {
            label = stripAnsi(label);
          }
          
          const isActive = session.status === "WORKING";
          const isSpinner = !isSelected && isActive;
          const indicatorColor = isSelected
            ? (focusArea === "list" ? "green" : "cyan")
            : (isActive ? "yellow" : "gray");

          return (
            <Box key={session.id} flexDirection="row" justifyContent="space-between" marginTop={0}>
              <Box flexDirection="row" flexShrink={1}>
                <Text bold={isSelected} color={indicatorColor}>
                  {isSelected ? "▶ " : (isSpinner ? <SessionSpinner /> : "  ")}
                </Text>
                <Text bold={isSelected} backgroundColor={rowBg} wrap="truncate-end">
                  <Text color={isSelected && isFocused ? "white" : "gray"} dimColor={!isSelected || !isFocused}>
                    [{String(globalIndex + 1).padStart(2, " ")}]{" "}
                  </Text>
                  <Text color={rowTextColor}>
                    {prefix}
                    {label}
                  </Text>
                </Text>
              </Box>
              <Box flexShrink={0}>
                {renderStatusBadge(session.status)}
                {session.speed !== undefined && session.speed > 0 && (
                  <Text color={isSelected && isFocused ? "white" : "yellow"} backgroundColor={rowBg} bold> ⚡{session.speed.toFixed(1)}t/s</Text>
                )}
                {session.tokens > 0 
                  ? <Text color={tokenColor} backgroundColor={rowBg} dimColor={!isSelected || !isFocused}> {session.tokens.toLocaleString()}t</Text>
                  : <Text color={isSelected && isFocused ? "white" : "gray"} backgroundColor={rowBg} dimColor> --</Text>
                }
              </Box>
            </Box>
          );
        })
      )}
    </Box>
  );
}
