import React, { useState, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";

export interface StartupPromptProps {
  onSelect: (choice: "wizard" | "terminal") => void;
}

export function StartupPrompt({ onSelect }: StartupPromptProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const handlerRef = useRef<(input: string, key: any) => void>();
  handlerRef.current = (input, key) => {
    if (key.upArrow || key.leftArrow) {
      setSelectedIndex(0);
    } else if (key.downArrow || key.rightArrow) {
      setSelectedIndex(1);
    } else if (input === "1") {
      setSelectedIndex(0);
      onSelect("wizard");
    } else if (input === "2") {
      setSelectedIndex(1);
      onSelect("terminal");
    } else if (key.escape) {
      onSelect("terminal");
    } else if (key.return) {
      if (selectedIndex === 0) {
        onSelect("wizard");
      } else {
        onSelect("terminal");
      }
    }
  };

  const stableHandler = useCallback((input: string, key: any) => {
    handlerRef.current?.(input, key);
  }, []);

  useInput(stableHandler);

  return (
    <Box flexDirection="column" paddingX={2} marginY={1}>
      {/* ══ TOP BANNER ══ */}
      <Box flexDirection="row" width="100%">
        <Text bold color="yellow">╔══[ </Text>
        <Text bold color="cyan">🚀 SUPERAGENT</Text>
        <Text bold color="yellow"> │ </Text>
        <Text bold color="magenta">FIRST-RUN SETUP</Text>
        <Text bold color="yellow"> ]══╗</Text>
      </Box>

      <Box flexDirection="row" width="100%">
        <Text bold color="yellow">║  </Text>
        <Text color="white" bold>No AI provider or API key is currently configured.</Text>
      </Box>

      <Box flexDirection="row" width="100%">
        <Text bold color="yellow">║  </Text>
        <Text color="gray">How would you like to get started?</Text>
      </Box>

      <Box flexDirection="row" width="100%">
        <Text bold color="yellow">╚════════════════════════════════════════════════════════╝</Text>
      </Box>

      {/* ══ OPTIONS ══ */}
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" width="100%">
          {selectedIndex === 0 ? (
            <Text bold color="green">▶ [ 1. Run Setup Wizard (Configure Provider & API Key) ]</Text>
          ) : (
            <Text color="gray" dimColor>    [ 1. Run Setup Wizard (Configure Provider & API Key) ]</Text>
          )}
        </Box>
        <Box flexDirection="row" width="100%" marginTop={0.5}>
          {selectedIndex === 1 ? (
            <Text bold color="cyan">▶ [ 2. Enter Terminal Directly (Explore commands or manual /login) ]</Text>
          ) : (
            <Text color="gray" dimColor>    [ 2. Enter Terminal Directly (Explore commands or manual /login) ]</Text>
          )}
        </Box>
      </Box>

      {/* ══ FOOTER HINT ══ */}
      <Box flexDirection="row" width="100%" marginTop={1}>
        <Text color="gray" dimColor>Use </Text>
        <Text color="cyan" bold>↑/↓</Text>
        <Text color="gray" dimColor> or keys </Text>
        <Text color="cyan" bold>1/2</Text>
        <Text color="gray" dimColor> · </Text>
        <Text color="cyan" bold>Enter</Text>
        <Text color="gray" dimColor> to select · </Text>
        <Text color="yellow" bold>Esc</Text>
        <Text color="gray" dimColor> to skip</Text>
      </Box>
    </Box>
  );
}
