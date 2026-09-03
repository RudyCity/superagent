import React from "react";
import { Box, Text } from "ink";
import { wrapTextForDisplay, visibleLength } from "../utils/responseScroll.js";
import type { WrappedChatLine } from "./chat-area.js";

/**
 * Extracts thinking/reasoning tags from content if not already supplied separately.
 * Supports <think>, <thought>, <reasoning>, and <thinking> tags.
 */
export function extractThinkingAndContent(
  content: string,
  reasoning?: string
): { cleanContent: string; reasoning: string } {
  let finalReasoning = (reasoning || "").trim();
  let cleanContent = content;

  if (!finalReasoning && content) {
    const thinkRegex = /<(?:think|thought|reasoning|thinking)(?:\s+[^>]*)?>([\s\S]*?)<\/(?:think|thought|reasoning|thinking)>/gi;
    let match: RegExpExecArray | null;
    const extractedParts: string[] = [];
    while ((match = thinkRegex.exec(content)) !== null) {
      if (match[1]?.trim()) {
        extractedParts.push(match[1].trim());
      }
    }
    if (extractedParts.length > 0) {
      finalReasoning = extractedParts.join("\n\n");
      cleanContent = content.replace(thinkRegex, "").trim();
    }
  }

  return { cleanContent, reasoning: finalReasoning };
}

export interface WrapThinkingOptions {
  reasoning: string;
  isExpanded: boolean;
  lineIndex: number;
  chatWidth: number;
  hideTimeline: boolean;
  isStreaming?: boolean;
}

/**
 * Wraps reasoning / thinking process into cyberpunk styled WrappedChatLine objects
 * with support for collapsed and expanded views.
 */
export function wrapThinkingToLines({
  reasoning,
  isExpanded,
  lineIndex,
  chatWidth,
  hideTimeline,
  isStreaming = false,
}: WrapThinkingOptions): WrappedChatLine[] {
  const cleanReasoning = reasoning.trim();
  if (!cleanReasoning) {
    return [];
  }

  const result: WrappedChatLine[] = [];
  const marginSpaces = hideTimeline ? "  " : "│    ";
  const rLines = cleanReasoning.split("\n");
  const lineCount = rLines.length;

  if (!isExpanded && !isStreaming) {
    // Collapsed single-line preview
    const labelText = `▶ 🧠 Thought process (${lineCount} line${lineCount === 1 ? "" : "s"}) [click or Ctrl+O to expand]`;
    const node = (
      <Box flexDirection="row">
        <Text color="gray" dimColor>{marginSpaces}</Text>
        <Text color="cyan" dimColor>
          ▶ 🧠 <Text italic>Thought process</Text> ({lineCount} line{lineCount === 1 ? "" : "s"}) <Text dimColor>[click to expand]</Text>
        </Text>
      </Box>
    );
    result.push({
      node,
      lineIndex,
      type: "thinking",
      isCollapsible: true,
      isThinking: true,
      length: visibleLength(marginSpaces + labelText),
    });
    return result;
  }

  // Expanded or actively streaming view
  const toggleLabel = isStreaming
    ? `▼ 🧠 Thinking process (live)`
    : `▼ 🧠 Thought process [click or Ctrl+O to collapse]`;
  const toggleNode = (
    <Box flexDirection="row">
      <Text color="gray" dimColor>{marginSpaces}</Text>
      <Text color="cyan" dimColor>
        ▼ 🧠 <Text italic>Thought process</Text> {isStreaming ? <Text dimColor>(streaming...)</Text> : <Text dimColor>[click or Ctrl+O to collapse]</Text>}
      </Text>
    </Box>
  );
  result.push({
    node: toggleNode,
    lineIndex,
    type: "thinking",
    isCollapsible: !isStreaming,
    isThinking: true,
    length: visibleLength(marginSpaces + toggleLabel),
  });

  // Top border of thinking box
  const topBoxNode = (
    <Box flexDirection="row">
      <Text color="gray" dimColor>{marginSpaces}</Text>
      <Text color="gray" dimColor>┌─── [ 🧠 REASONING PROCESS ]</Text>
    </Box>
  );
  result.push({ node: topBoxNode, lineIndex, type: "thinking", isThinking: true });

  // Body lines
  const innerWidth = Math.max(10, chatWidth - marginSpaces.length - 4);
  for (const rLine of rLines) {
    const subLines = wrapTextForDisplay(rLine, innerWidth);
    for (const subLine of subLines) {
      const lineNode = (
        <Box flexDirection="row">
          <Text color="gray" dimColor>{marginSpaces}│ </Text>
          <Text color="gray" dimColor italic>{subLine || " "}</Text>
        </Box>
      );
      result.push({ node: lineNode, lineIndex, type: "thinking", isThinking: true });
    }
  }

  // If currently streaming thinking, append a loading indicator inside the box
  if (isStreaming) {
    const streamingNode = (
      <Box flexDirection="row">
        <Text color="gray" dimColor>{marginSpaces}│ </Text>
        <Text color="yellow" dimColor>⠋ </Text>
        <Text color="gray" dimColor italic>thinking...</Text>
      </Box>
    );
    result.push({ node: streamingNode, lineIndex, type: "thinking", isThinking: true });
  }

  // Bottom border of thinking box
  const bottomBoxNode = (
    <Box flexDirection="row">
      <Text color="gray" dimColor>{marginSpaces}</Text>
      <Text color="gray" dimColor>└─── [ END REASONING ]</Text>
    </Box>
  );
  result.push({ node: bottomBoxNode, lineIndex, type: "thinking", isThinking: true });

  // Spacer line
  const spacerNode = (
    <Box flexDirection="row">
      <Text color="gray" dimColor>{marginSpaces}</Text>
    </Box>
  );
  result.push({ node: spacerNode, lineIndex, type: "thinking", isThinking: true });

  return result;
}
