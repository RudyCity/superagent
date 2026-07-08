import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { wrapTextForDisplay } from "../utils/responseScroll.js";
import { getSettings } from "../core/config.js";

interface WizardDialogProps {
  title: string;
  description?: string;
  borderColor: "yellow" | "cyan" | "blue" | "green" | "gray" | "white" | "red";
  options: string[];
  selectedIndex: number;
  maxVisible?: number;
  isMultiSelect?: boolean;
  selectedSet?: Set<number>;
  marginY?: number;
  marginTop?: number;
  marginBottom?: number;
  isLoading?: boolean;
  searchQuery?: string;
  searchPlaceholder?: string;
  terminalWidth?: number;
}

function WizardSpinner({ color }: { color: string }) {
  const [frame, setFrame] = useState(0);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  useEffect(() => {
    const t = setInterval(() => setFrame(f => (f + 1) % frames.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color={color as any} bold>{frames[frame]}</Text>;
}

const DIALOG_COLORS = ["red", "yellow", "green", "blue", "magenta", "cyan"];

export function renderDialogBodyText(text: string): React.ReactNode {
  const regex = /(5\.\s+Struktur\s+Direktori\s+Tools|Struktur\s+Direktori\s+Tools)/gi;
  if (!regex.test(text)) {
    return text;
  }

  regex.lastIndex = 0;
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, index) => {
        if (regex.test(part)) {
          return (
            <React.Fragment key={index}>
              {part.split("").map((char, charIdx) => {
                const color = DIALOG_COLORS[charIdx % DIALOG_COLORS.length];
                return (
                  <Text key={charIdx} bold color={color as any}>
                    {char}
                  </Text>
                );
              })}
            </React.Fragment>
          );
        }
        return part;
      })}
    </>
  );
}

export function WizardDialog({
  title,
  description,
  borderColor,
  options = [],
  selectedIndex = 0,
  maxVisible = 10,
  isMultiSelect = false,
  selectedSet,
  marginY,
  marginTop,
  marginBottom,
  isLoading = false,
  searchQuery,
  searchPlaceholder = "Type to filter...",
  terminalWidth,
}: WizardDialogProps) {
  const finalMarginTop = marginTop !== undefined ? marginTop : (marginY !== undefined ? marginY : 1);
  const finalMarginBottom = marginBottom !== undefined ? marginBottom : (marginY !== undefined ? marginY : 0);
  const actualOptions = Array.isArray(options) ? options : [];
  const total = actualOptions.length;
  let visibleOptions = actualOptions;
  let start = 0;
  let end = total;

  const rawSelectedIndex = typeof selectedIndex === "number" ? selectedIndex : Number(selectedIndex);
  const numericSelectedIndex = total > 0 ? Math.min(Math.max(0, rawSelectedIndex), total - 1) : 0;

  if (maxVisible && total > maxVisible) {
    start = Math.max(0, numericSelectedIndex - Math.floor(maxVisible / 2));
    end = start + maxVisible;
    if (end > total) {
      end = total;
      start = Math.max(0, end - maxVisible);
    }
    visibleOptions = actualOptions.slice(start, end);
  }

  const hideTimeline = getSettings().hideTimeline ?? false;
  const marginPrefix = hideTimeline ? "  " : "│ ";

  return (
    <Box flexDirection="column" marginTop={finalMarginTop} marginBottom={finalMarginBottom}>
      {/* Top border connecting to the timeline */}
      <Box flexDirection="row" width="100%">
        <Text color={borderColor} wrap="truncate-end">
          {hideTimeline ? "  [ " : "├───[ "}<Text bold color={borderColor}>{renderDialogBodyText(title)}</Text> ]
        </Text>
      </Box>

      {/* Description lines prefixed with timeline line */}
      {description && (() => {
        const widthVal = terminalWidth || (process.stdout.columns || 110);
        const maxTextWidth = Math.max(10, widthVal - 4);
        const descLines = wrapTextForDisplay(description, maxTextWidth);
        return (
          <>
            {descLines.map((line, idx) => (
              <Box key={idx} flexDirection="row" width="100%">
                <Text color={borderColor}>{marginPrefix}</Text>
                <Text color="white">{renderDialogBodyText(line)}</Text>
              </Box>
            ))}
            <Box flexDirection="row">
              <Text color={borderColor}>{marginPrefix}</Text>
            </Box>
          </>
        );
      })()}

      {/* Search bar — shown when searchQuery prop is provided */}
      {searchQuery !== undefined && (
        <Box flexDirection="row" width="100%">
          <Text color={borderColor}>{marginPrefix}</Text>
          <Text color="cyan" bold>🔍 </Text>
          <Box flexShrink={1}>
            <Text color="white" wrap="truncate-start">
              {searchQuery || <Text color="gray" dimColor>{searchPlaceholder}</Text>}
            </Text>
          </Box>
          <Text color="cyan" bold>█</Text>
        </Box>
      )}

      {/* Loading indicator */}
      {isLoading && (
        <Box flexDirection="row" width="100%">
          <Text color={borderColor}>{marginPrefix}</Text>
          <WizardSpinner color={borderColor} />
          <Box flexShrink={1}>
            <Text color="yellow" wrap="truncate-end">  Fetching models from API...</Text>
          </Box>
        </Box>
      )}

      {/* Spacer after search/loading */}
      {(searchQuery !== undefined || isLoading) && (
        <Box flexDirection="row"><Text color={borderColor}>{marginPrefix}</Text></Box>
      )}

      {/* Options prefixed with timeline line */}
      {start > 0 && (
        <Box flexDirection="row" width="100%">
          <Text color={borderColor}>{marginPrefix}</Text>
          <Box flexShrink={1}>
            <Text color="yellow" wrap="truncate-end">   ▲ ... ({start} more options above) ...</Text>
          </Box>
        </Box>
      )}

      {visibleOptions.map((opt, idx) => {
        const originalIndex = start + idx;
        const isSelected = originalIndex === numericSelectedIndex;
        const isChecked = selectedSet?.has(originalIndex) ?? false;
        const optStr = typeof opt === "string" ? opt : JSON.stringify(opt);
        const checkPrefix = isMultiSelect ? (isChecked ? "[x] " : "[ ] ") : "";
        return (
          <Box key={`${optStr}-${originalIndex}`} flexDirection="row" width="100%">
            <Text color={borderColor}>{marginPrefix}</Text>
            <Box flexDirection="row" flexShrink={1}>
              <Text color={isSelected ? borderColor : "gray"} bold={isSelected} wrap="truncate-end">
                {isSelected ? "❯ " : "  "} {checkPrefix}{renderDialogBodyText(optStr)}
              </Text>
            </Box>
          </Box>
        );
      })}

      {/* Empty state when no options match */}
      {!isLoading && total === 0 && searchQuery !== undefined && (
        <Box flexDirection="row" width="100%">
          <Text color={borderColor}>{marginPrefix}</Text>
          <Box flexShrink={1}>
            <Text color="gray" dimColor wrap="truncate-end">  No models match "{searchQuery || ""}". Try a different term.</Text>
          </Box>
        </Box>
      )}

      {end < total && (
        <Box flexDirection="row" width="100%">
          <Text color={borderColor}>{marginPrefix}</Text>
          <Box flexShrink={1}>
            <Text color="yellow" wrap="truncate-end">   ▼ ... ({total - end} more options below) ...</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
