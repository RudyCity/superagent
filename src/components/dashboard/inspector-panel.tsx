import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import path from "path";
import { AgentSession } from "../multi-agent-dashboard.js";

// Render inline Markdown formatting like bold, code blocks, links, and file/web URLs
export function renderLogInlineStyles(
  text: string,
  defaultColor: string,
  isBold: boolean,
  dimColor: boolean
): React.ReactNode {
  const parsedElements: React.ReactNode[] = [];
  let currentText = text;

  while (currentText.length > 0) {
    const boldIdx = currentText.indexOf("**");
    const codeIdx = currentText.indexOf("`");
    const linkIdx = currentText.indexOf("[");

    // Check for raw URLs (file:///, http://, https://)
    const fileUrlIdx = currentText.indexOf("file://");
    const httpUrlIdx = currentText.indexOf("http://");
    const httpsUrlIdx = currentText.indexOf("https://");

    let rawUrlIdx = -1;
    if (fileUrlIdx !== -1) rawUrlIdx = fileUrlIdx;
    if (httpUrlIdx !== -1 && (rawUrlIdx === -1 || httpUrlIdx < rawUrlIdx)) rawUrlIdx = httpUrlIdx;
    if (httpsUrlIdx !== -1 && (rawUrlIdx === -1 || httpsUrlIdx < rawUrlIdx)) rawUrlIdx = httpsUrlIdx;

    let minIdx = -1;
    let tokenType: "bold" | "code" | "link" | "rawUrl" | "none" = "none";

    if (boldIdx !== -1) {
      minIdx = boldIdx;
      tokenType = "bold";
    }

    if (codeIdx !== -1 && (minIdx === -1 || codeIdx < minIdx)) {
      minIdx = codeIdx;
      tokenType = "code";
    }

    if (linkIdx !== -1 && (minIdx === -1 || linkIdx < minIdx)) {
      const closeBracketIdx = currentText.indexOf("]", linkIdx);
      if (closeBracketIdx !== -1 && currentText[closeBracketIdx + 1] === "(") {
        const closeParenIdx = currentText.indexOf(")", closeBracketIdx + 2);
        if (closeParenIdx !== -1) {
          minIdx = linkIdx;
          tokenType = "link";
        }
      }
    }

    if (rawUrlIdx !== -1 && (minIdx === -1 || rawUrlIdx < minIdx)) {
      const remainingFromUrl = currentText.slice(rawUrlIdx);
      const match = remainingFromUrl.match(/^(file:\/\/\/[^\s`'"\(\)\[\]<>]+|https?:\/\/[^\s`'"\(\)\[\]<>]+)/);
      if (match) {
        minIdx = rawUrlIdx;
        tokenType = "rawUrl";
      }
    }

    if (tokenType === "none" || minIdx === -1) {
      parsedElements.push(
        <Text key={parsedElements.length} color={defaultColor} bold={isBold} dimColor={dimColor}>
          {currentText}
        </Text>
      );
      break;
    }

    if (minIdx > 0) {
      parsedElements.push(
        <Text key={parsedElements.length} color={defaultColor} bold={isBold} dimColor={dimColor}>
          {currentText.slice(0, minIdx)}
        </Text>
      );
    }

    currentText = currentText.slice(minIdx);

    if (tokenType === "bold") {
      const nextBoldIdx = currentText.indexOf("**", 2);
      if (nextBoldIdx !== -1) {
        const boldContent = currentText.slice(2, nextBoldIdx);
        parsedElements.push(
          <Text key={parsedElements.length} bold color="yellow">
            {boldContent}
          </Text>
        );
        currentText = currentText.slice(nextBoldIdx + 2);
      } else {
        parsedElements.push(
          <Text key={parsedElements.length} color={defaultColor} bold={isBold} dimColor={dimColor}>
            {currentText.slice(0, 2)}
          </Text>
        );
        currentText = currentText.slice(2);
      }
    } else if (tokenType === "code") {
      const nextCodeIdx = currentText.indexOf("`", 1);
      if (nextCodeIdx !== -1) {
        const codeContent = currentText.slice(1, nextCodeIdx);
        parsedElements.push(
          <Text key={parsedElements.length} color="cyan" bold>
            {codeContent}
          </Text>
        );
        currentText = currentText.slice(nextCodeIdx + 1);
      } else {
        parsedElements.push(
          <Text key={parsedElements.length} color={defaultColor} bold={isBold} dimColor={dimColor}>
            {currentText.slice(0, 1)}
          </Text>
        );
        currentText = currentText.slice(1);
      }
    } else if (tokenType === "link") {
      const closeBracketIdx = currentText.indexOf("]");
      const closeParenIdx = currentText.indexOf(")", closeBracketIdx + 2);
      const linkText = currentText.slice(1, closeBracketIdx);
      const linkUrl = currentText.slice(closeBracketIdx + 2, closeParenIdx);

      const osc8Link = `\u001B]8;;${linkUrl}\u0007${linkText}\u001B]8;;\u0007`;
      parsedElements.push(
        <Text key={parsedElements.length} color="cyan" underline>
          {osc8Link}
        </Text>
      );
      currentText = currentText.slice(closeParenIdx + 1);
    } else if (tokenType === "rawUrl") {
      const match = currentText.match(/^(file:\/\/\/[^\s`'"\(\)\[\]<>]+|https?:\/\/[^\s`'"\(\)\[\]<>]+)/);
      if (match) {
        let url = match[0];
        while (url.length > 0 && /[.,;:!?]$/.test(url)) {
          url = url.slice(0, -1);
        }
        const osc8Link = `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`;
        parsedElements.push(
          <Text key={parsedElements.length} color="cyan" underline>
            {osc8Link}
          </Text>
        );
        currentText = currentText.slice(url.length);
      } else {
        parsedElements.push(
          <Text key={parsedElements.length} color={defaultColor} bold={isBold} dimColor={dimColor}>
            {currentText[0]}
          </Text>
        );
        currentText = currentText.slice(1);
      }
    }
  }

  return <>{parsedElements}</>;
}

export function ThinkingSpinner({ type = "orchestrating" }: { type?: "orchestrating" | "processing" }) {
  const [frame, setFrame] = useState(0);
  const spinners = ["▰▱▱▱▱▱▱", "▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱", "▰▰▰▰▱▱▱", "▰▰▰▰▰▱▱", "▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰"];
  
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % spinners.length);
    }, 150);
    return () => clearInterval(timer);
  }, []);

  const label = type === "orchestrating" ? "ORCHESTRATING" : "PROCESSING";
  return <Text color="yellow" bold>⚡ {label} [{spinners[frame]}] </Text>;
}

export function ToolLoadingIndicator() {
  const [frame, setFrame] = useState(0);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % frames.length);
    }, 120);
    return () => clearInterval(interval);
  }, []);

  return <Text color="yellow">{frames[frame]} Running system tool...</Text>;
}

export function BlinkingCursor() {
  const [activeBlink, setActiveBlink] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveBlink((prev) => !prev);
    }, 600);
    return () => clearInterval(timer);
  }, []);

  return <Text color="green" bold>{activeBlink ? "█" : " "}</Text>;
}

interface InspectorPanelProps {
  selectedSession: AgentSession;
  focusArea: string;
  logScrollOffset: number;
  isHistoryTruncated: boolean;
  feedWidth: number;
  logBoxHeight: number;
  visibleLogs: React.ReactNode[];
  isExecutingTool: boolean;
  timeLeft: number | null;
  activeToolLines: string[];
  workspaceHeight: number;
}

export function InspectorPanel({
  selectedSession,
  focusArea,
  logScrollOffset,
  isHistoryTruncated,
  feedWidth,
  logBoxHeight,
  visibleLogs,
  isExecutingTool,
  timeLeft,
  activeToolLines,
  workspaceHeight,
}: InspectorPanelProps) {
  return (
    <Box
      flexDirection="column"
      width="58%"
      height={workspaceHeight}
      justifyContent="flex-start"
    >
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Box flexDirection="row">
          <Text bold color={focusArea === "logs" ? "green" : "cyan"}>
            🔎 INSPECT: {selectedSession.id.slice(0, 20)}
            <Text color="gray" dimColor> {isHistoryTruncated ? "(Truncated)" : "(Full)"}</Text>
          </Text>
          {logScrollOffset > 0 && (
            <Text color="yellow" bold> [Scroll: -{logScrollOffset} - Esc to snap bottom]</Text>
          )}
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
          <Text color="blue" bold>({selectedSession.branch || "main"})</Text>
          {selectedSession.type === "SUPERAGENT" && selectedSession.worktreePath && (
            <Text color="gray" dimColor>wt: ...{selectedSession.worktreePath.slice(-30)}</Text>
          )}
        </Box>
      </Box>
      
      {(() => {
        const taskStr = selectedSession.task || "";
        const normalizedTask = taskStr.replace(/\r\n/g, "\n").replace(/\r/g, "");
        const lines = normalizedTask.split("\n").filter(line => line.trim() !== "");
        if (lines.length === 0) return null;

        if (isHistoryTruncated) {
          const displayLine = lines[0];
          const suffix = lines.length > 1 ? " ... (Truncated, Ctrl+T for full)" : "";
          return (
            <Text color="white" bold wrap="truncate-end">
              Task: <Text color="gray" bold={false}>{displayLine}{suffix}</Text>
            </Text>
          );
        }

        return (
          <Box flexDirection="column" width={feedWidth}>
            <Text color="white" bold>Task:</Text>
            {lines.map((line, idx) => (
              <Text key={idx} color="gray">{line}</Text>
            ))}
          </Box>
        );
      })()}

      {/* Log Window */}
      <Box flexDirection="column" marginTop={1} height={logBoxHeight} paddingX={1} justifyContent="flex-start">
        {visibleLogs}
        {selectedSession.status === "WORKING" && logScrollOffset === 0 && (selectedSession.type !== "MASTER" || !isExecutingTool) && (() => {
          const isIdleTask = selectedSession.task.startsWith("Idle") || selectedSession.task.startsWith("Error");
          const spinnerType = (selectedSession.type === "MASTER" && !isIdleTask) ? "orchestrating" : "processing";
          return (
            <Box flexDirection="row" marginTop={1}>
              <ThinkingSpinner type={spinnerType} />
              <BlinkingCursor />
            </Box>
          );
        })()}
        {selectedSession.type === "MASTER" && isExecutingTool && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow">
              ├─── [ <Text bold color="yellow">⚙️ SYSTEM_CALL: EXECUTING...{timeLeft !== null ? ` (${timeLeft}s left)` : ""}</Text> ]
            </Text>
            <Box flexDirection="row">
              <Text color="yellow">│    </Text>
              <ToolLoadingIndicator />
            </Box>
            {activeToolLines.length > 0 && (
              <>
                <Text color="yellow">
                  ├─── [ <Text bold color="yellow">⚙️ SYSTEM_CALL_OUTPUT (LIVE)</Text> ]
                </Text>
                {activeToolLines.map((line, idx) => (
                  <Box key={idx} flexDirection="row">
                    <Text color="yellow">│    </Text>
                    <Text color="gray">{line}</Text>
                  </Box>
                ))}
              </>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
