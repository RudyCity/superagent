import React from "react";
import { Box, Text } from "ink";

interface WizardDialogProps {
  title: string;
  description?: string;
  borderColor: "yellow" | "cyan" | "magenta" | "green" | "gray" | "white" | "red";
  options: string[];
  selectedIndex: number;
  maxVisible?: number;
}

export function WizardDialog({
  title,
  description,
  borderColor,
  options = [],
  selectedIndex = 0,
  maxVisible,
}: WizardDialogProps) {
  const actualOptions = Array.isArray(options) ? options : [];
  const total = actualOptions.length;
  let visibleOptions = actualOptions;
  let start = 0;
  let end = total;

  if (maxVisible && total > maxVisible) {
    start = Math.max(0, selectedIndex - Math.floor(maxVisible / 2));
    end = start + maxVisible;
    if (end > total) {
      end = total;
      start = Math.max(0, end - maxVisible);
    }
    visibleOptions = actualOptions.slice(start, end);
  }

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Top border connecting to the timeline */}
      <Text color={borderColor}>
        ├───[ <Text bold color={borderColor}>{title}</Text> ]
      </Text>

      {/* Description lines prefixed with timeline line */}
      {description && (
        <Box flexDirection="row">
          <Text color={borderColor}>│ </Text>
          <Text color="white">{description}</Text>
        </Box>
      )}

      {/* Optional spacer if description is present */}
      {description && (
        <Box flexDirection="row">
          <Text color={borderColor}>│ </Text>
        </Box>
      )}

      {/* Options prefixed with timeline line */}
      {start > 0 && (
        <Box flexDirection="row">
          <Text color={borderColor}>│ </Text>
          <Text color="yellow">   ▲ ... ({start} more options above) ...</Text>
        </Box>
      )}

      {visibleOptions.map((opt, idx) => {
        const originalIndex = start + idx;
        const isSelected = originalIndex === selectedIndex;
        const optStr = typeof opt === "string" ? opt : JSON.stringify(opt);
        return (
          <Box key={`${optStr}-${originalIndex}`} flexDirection="row">
            <Text color={borderColor}>│ </Text>
            <Text color={isSelected ? borderColor : "gray"} bold={isSelected}>
              {isSelected ? "❯ " : "  "} {optStr}
            </Text>
          </Box>
        );
      })}


      {end < total && (
        <Box flexDirection="row">
          <Text color={borderColor}>│ </Text>
          <Text color="yellow">   ▼ ... ({total - end} more options below) ...</Text>
        </Box>
      )}
    </Box>
  );
}
