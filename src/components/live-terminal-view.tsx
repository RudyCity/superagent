/**
 * LiveTerminalView — Boxed inline live terminal output component.
 * Renders a bordered viewport streaming the most recent N lines of active
 * command output during tool execution, with a pulsing LIVE badge and
 * elapsed time display.
 */
import React, { useState, useEffect, memo } from "react";
import { Box, Text } from "ink";
import { wrapTextForDisplay } from "../utils/responseScroll.js";
import { getTerminalTailLines } from "../utils/terminalStream.js";

const LIVE_PULSE_COLORS = ["green", "greenBright", "cyan", "cyanBright", "green", "greenBright"];

export interface LiveTerminalViewProps {
  /** Raw streaming text from the active process (may contain carriage returns) */
  activeToolOutput: string;
  /** Maximum number of output lines to display in the viewport */
  maxLines?: number;
  /** Available width for the terminal box (content only, not borders) */
  viewportWidth?: number;
  /** Whether to show a fallback placeholder when output is empty */
  showPlaceholder?: boolean;
  /** Elapsed seconds (from parent, avoids timer per-component) */
  elapsedSeconds?: number;
  /** Label prefix shown in the box header */
  headerPrefix?: string;
}

export const LiveTerminalView = memo(function LiveTerminalView({
  activeToolOutput,
  maxLines = 10,
  viewportWidth = 80,
  showPlaceholder = true,
  elapsedSeconds,
  headerPrefix = "",
}: LiveTerminalViewProps) {
  const [frame, setFrame] = useState(0);
  const [localElapsed, setLocalElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % LIVE_PULSE_COLORS.length);
    }, 180);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (elapsedSeconds !== undefined) return;
    const interval = setInterval(() => {
      setLocalElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [elapsedSeconds]);

  const currentElapsed = elapsedSeconds !== undefined ? elapsedSeconds : localElapsed;
  const liveColor = LIVE_PULSE_COLORS[frame % LIVE_PULSE_COLORS.length];

  // Compute tail lines with carriage-return normalization via terminalStream
  const tailLines = getTerminalTailLines(activeToolOutput, maxLines);

  // Wrap each line to fit viewport
  const innerWidth = Math.max(10, viewportWidth - 4); // subtract box borders and padding
  const wrappedLines: string[] = [];
  for (const line of tailLines) {
    const wrapped = wrapTextForDisplay(line, innerWidth);
    for (const w of wrapped) {
      wrappedLines.push(w);
    }
  }
  const displayLines = wrappedLines.slice(-maxLines);
  const hasOutput = displayLines.length > 0;

  return (
    <Box flexDirection="column" marginTop={0}>
      {/* Header row */}
      <Box flexDirection="row">
        <Text color="gray" dimColor>{headerPrefix}</Text>
        <Text color="gray" dimColor>┌── [ </Text>
        <Text bold color={liveColor}> LIVE</Text>
        <Text color="gray" dimColor> ] </Text>
        <Text color="gray" dimColor>SYSTEM_CALL_OUTPUT</Text>
        <Text color="gray" dimColor> ({currentElapsed}s) ──</Text>
      </Box>

      {/* Output lines */}
      {hasOutput ? (
        displayLines.map((line, idx) => (
          <Box key={idx} flexDirection="row">
            <Text color="gray" dimColor>{headerPrefix}│ </Text>
            <Text color="gray">{line}</Text>
          </Box>
        ))
      ) : showPlaceholder ? (
        <Box flexDirection="row">
          <Text color="gray" dimColor>{headerPrefix}│ </Text>
          <Text color="gray" dimColor>Command executing, awaiting output...</Text>
        </Box>
      ) : null}

      {/* Footer row */}
      <Box flexDirection="row">
        <Text color="gray" dimColor>{headerPrefix}</Text>
        <Text color="gray" dimColor>└─────────────────────────── </Text>
        <Text color="gray" dimColor>{hasOutput ? `↓ live · ${displayLines.length} line${displayLines.length !== 1 ? "s" : ""}` : "waiting"}</Text>
        <Text color="gray" dimColor> ──</Text>
      </Box>
    </Box>
  );
});

export default LiveTerminalView;
