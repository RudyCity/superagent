import React from "react";
import { Box, Text } from "ink";

const MAX_HISTORY_VISIBLE = 10;

interface HistoryPanelProps {
  history: string[];
  historySelectedIndex: number;
  focusMode: string;
}

export function HistoryPanel({
  history,
  historySelectedIndex,
  focusMode,
}: HistoryPanelProps) {
  if (focusMode !== "history") return null;

  const uniqueHistory = Array.from(new Set(history));
  if (uniqueHistory.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          ┌─── [ <Text bold color="yellow">📜 INPUT HISTORY</Text>
          <Text dimColor> [↑/↓ Navigate • Enter Select • Esc Close]</Text> ]
        </Text>
        <Text color="gray" dimColor>
          │  (no history yet)
        </Text>
        <Text color="yellow">└─────────────────────────────────</Text>
      </Box>
    );
  }

  // Determine visible window centered around selected index
  const total = uniqueHistory.length;
  const half = Math.floor(MAX_HISTORY_VISIBLE / 2);
  let startIdx = Math.max(0, historySelectedIndex - half);
  let endIdx = Math.min(total, startIdx + MAX_HISTORY_VISIBLE);
  // Adjust startIdx if endIdx hit the ceiling
  startIdx = Math.max(0, endIdx - MAX_HISTORY_VISIBLE);

  const visibleEntries = uniqueHistory.slice(startIdx, endIdx);
  const hiddenAbove = startIdx;
  const hiddenBelow = total - endIdx;

  const scrollInfo =
    total > MAX_HISTORY_VISIBLE
      ? ` [${historySelectedIndex + 1}/${total}]`
      : "";

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text bold color="yellow">
        ┌─── [ <Text bold color="yellow">📜 INPUT HISTORY</Text>
        {scrollInfo && <Text color="cyan">{scrollInfo}</Text>}
        <Text dimColor> [↑/↓ Navigate • Enter Select • Esc Close]</Text> ]
      </Text>

      {/* Hidden above indicator */}
      {hiddenAbove > 0 && (
        <Text color="gray" dimColor>
          │  ↑ {hiddenAbove} more above
        </Text>
      )}

      {/* History entries */}
      {visibleEntries.map((entry, idx) => {
        const absoluteIdx = startIdx + idx;
        const isSelected = absoluteIdx === historySelectedIndex;
        const displayEntry =
          entry.length > 60 ? entry.slice(0, 57) + "..." : entry;

        return (
          <Box key={absoluteIdx} flexDirection="row">
            <Text color={isSelected ? "yellow" : "gray"}>
              {isSelected ? "│ ❯ " : "│   "}
            </Text>
            <Text
              color={isSelected ? "white" : "gray"}
              bold={isSelected}
              dimColor={!isSelected}
            >
              {displayEntry}
            </Text>
          </Box>
        );
      })}

      {/* Hidden below indicator */}
      {hiddenBelow > 0 && (
        <Text color="gray" dimColor>
          │  ↓ {hiddenBelow} more below
        </Text>
      )}

      {/* Footer */}
      <Text color="yellow">
        └─────────────────────────────────
      </Text>
    </Box>
  );
}
