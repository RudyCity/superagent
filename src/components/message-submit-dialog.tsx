/**
 * MessageSubmitDialog - Shown when the user submits a new message while the AI
 * is still processing. Offers three options:
 *   1. Queue   - Add the message to the agent's pending queue (current run
 *                finishes first, then the new message is processed).
 *   2. Insert  - Stop the current run immediately and start this message now.
 *   3. Back    - Discard the submitted message and restore it to the input.
 *
 * Keyboard:
 *   Up/Left   - move selection up
 *   Down/Right- move selection down
 *   Enter     - confirm the highlighted option
 *   Esc       - cancel (= Back)
 */

import React, { useState, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";

export type MessageSubmitChoice = "queue" | "insert" | "back";

interface MessageSubmitDialogProps {
  messagePreview: string;
  attachmentCount: number;
  queuedCount: number;
  onChoose: (choice: MessageSubmitChoice) => void;
}

const OPTIONS: Array<{ id: MessageSubmitChoice; label: string; hint: string }> = [
  {
    id: "queue",
    label: "Queue",
    hint: "Wait for the current run to finish, then process this message.",
  },
  {
    id: "insert",
    label: "Insert",
    hint: "Stop the current run now and process this message immediately.",
  },
  {
    id: "back",
    label: "Back",
    hint: "Discard this message and return to the input.",
  },
];

function buildPreview(text: string, attachmentCount: number): string {
  const MAX_LINES = 5;
  const MAX_WIDTH = 60;
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const truncatedByLines = lines.slice(0, MAX_LINES);
  const moreLines = lines.length > MAX_LINES ? lines.length - MAX_LINES : 0;
  const truncatedByWidth = truncatedByLines.map((line) =>
    line.length > MAX_WIDTH ? `${line.slice(0, MAX_WIDTH - 1)}…` : line,
  );
  let preview = truncatedByWidth.join("\n");
  if (moreLines > 0) preview += `\n… (${moreLines} more line${moreLines > 1 ? "s" : ""})`;
  if (attachmentCount > 0) {
    const noun = attachmentCount === 1 ? "attachment" : "attachments";
    preview += `\n[${attachmentCount} ${noun}]`;
  }
  return preview;
}

export function MessageSubmitDialog({
  messagePreview,
  attachmentCount,
  queuedCount,
  onChoose,
}: MessageSubmitDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const handlerRef = useRef<(input: string, key: any) => void>();
  const onChooseRef = useRef(onChoose);
  onChooseRef.current = onChoose;

  handlerRef.current = (input, key) => {
    if (key.upArrow || key.leftArrow) {
      setSelectedIndex((idx) => (idx - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }
    if (key.downArrow || key.rightArrow) {
      setSelectedIndex((idx) => (idx + 1) % OPTIONS.length);
      return;
    }
    if (key.escape) {
      onChooseRef.current("back");
      return;
    }
    if (key.return) {
      onChooseRef.current(OPTIONS[selectedIndex].id);
      return;
    }
    // Number-key shortcuts: 1 = Queue, 2 = Insert, 3 = Back
    if (input === "1") {
      onChooseRef.current("queue");
      return;
    }
    if (input === "2") {
      onChooseRef.current("insert");
      return;
    }
    if (input === "3") {
      onChooseRef.current("back");
      return;
    }
  };

  useInput((input, key) => {
    handlerRef.current?.(input, key);
  });

  const preview = buildPreview(messagePreview, attachmentCount);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
      <Box marginBottom={1}>
        <Text bold color="yellow">
          ⚠  AI is still processing — how should we handle the new message?
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {OPTIONS.map((opt, idx) => {
          const isSelected = idx === selectedIndex;
          const cursor = isSelected ? "❯" : " ";
          const color = isSelected ? "cyan" : "gray";
          const queuedSuffix =
            opt.id === "queue" && queuedCount > 0
              ? ` (${queuedCount} already queued)`
              : "";
          return (
            <Box key={opt.id} flexDirection="column">
              <Box>
                <Text color={color}>
                  {`  ${cursor} `}
                  <Text bold color={isSelected ? "cyan" : undefined}>
                    {`${idx + 1}. ${opt.label}`}
                  </Text>
                  {queuedSuffix ? <Text color="yellow">{queuedSuffix}</Text> : null}
                </Text>
              </Box>
              {isSelected ? (
                <Box marginLeft={6}>
                  <Text color="gray" dimColor>
                    {opt.hint}
                  </Text>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="gray">Message preview:</Text>
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          marginTop={0}
        >
          <Text wrap="wrap">{preview || "(empty)"}</Text>
        </Box>
      </Box>

      <Box>
        <Text color="gray" dimColor>
          [↑/↓] select  [1/2/3] shortcut  [Enter] confirm  [Esc] back
        </Text>
      </Box>
    </Box>
  );
}
