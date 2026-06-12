import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";

interface WizardDialogProps {
  title: string;
  description?: string;
  borderColor: "yellow" | "cyan" | "magenta" | "green" | "gray" | "white" | "red";
  options: string[];
  selectedIndex: number;
  maxVisible?: number;
  isMultiSelect?: boolean;
  selectedSet?: Set<number>;
  marginY?: number;
  isLoading?: boolean;
  searchQuery?: string;
  searchPlaceholder?: string;
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

export function WizardDialog({
  title,
  description,
  borderColor,
  options = [],
  selectedIndex = 0,
  maxVisible,
  isMultiSelect = false,
  selectedSet,
  marginY = 1,
  isLoading = false,
  searchQuery,
  searchPlaceholder = "Type to filter...",
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
    <Box flexDirection="column" marginY={marginY}>
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

      {/* Search bar — shown when searchQuery prop is provided */}
      {searchQuery !== undefined && (
        <Box flexDirection="row">
          <Text color={borderColor}>│ </Text>
          <Text color="cyan" bold>🔍 </Text>
          <Text color="white">{searchQuery || <Text color="gray" dimColor>{searchPlaceholder}</Text>}</Text>
          <Text color="cyan" bold>█</Text>
        </Box>
      )}

      {/* Loading indicator */}
      {isLoading && (
        <Box flexDirection="row">
          <Text color={borderColor}>│ </Text>
          <WizardSpinner color={borderColor} />
          <Text color="yellow">  Fetching models from API...</Text>
        </Box>
      )}

      {/* Spacer after search/loading */}
      {(searchQuery !== undefined || isLoading) && (
        <Box flexDirection="row"><Text color={borderColor}>│</Text></Box>
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
        const isChecked = selectedSet?.has(originalIndex) ?? false;
        const optStr = typeof opt === "string" ? opt : JSON.stringify(opt);
        const checkPrefix = isMultiSelect ? (isChecked ? "[x] " : "[ ] ") : "";
        return (
          <Box key={`${optStr}-${originalIndex}`} flexDirection="row">
            <Text color={borderColor}>│ </Text>
            <Text color={isSelected ? borderColor : "gray"} bold={isSelected}>
              {isSelected ? "❯ " : "  "} {checkPrefix}{optStr}
            </Text>
          </Box>
        );
      })}

      {/* Empty state when no options match */}
      {!isLoading && total === 0 && searchQuery !== undefined && (
        <Box flexDirection="row">
          <Text color={borderColor}>│ </Text>
          <Text color="gray" dimColor>  No models match "{searchQuery || ""}". Try a different term.</Text>
        </Box>
      )}

      {end < total && (
        <Box flexDirection="row">
          <Text color={borderColor}>│ </Text>
          <Text color="yellow">   ▼ ... ({total - end} more options below) ...</Text>
        </Box>
      )}
    </Box>
  );
}
