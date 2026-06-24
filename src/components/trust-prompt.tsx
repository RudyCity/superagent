import React, { useState, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";

interface TrustPromptProps {
  directoryPath: string;
  onAccept: () => void;
  onReject: () => void;
}

export function TrustPrompt({ directoryPath, onAccept, onReject }: TrustPromptProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const handlerRef = useRef<(input: string, key: any) => void>();
  handlerRef.current = (input, key) => {
    if (key.upArrow || key.leftArrow) {
      setSelectedIndex(0);
    } else if (key.downArrow || key.rightArrow) {
      setSelectedIndex(1);
    } else if (key.return) {
      if (selectedIndex === 0) {
        onAccept();
      } else {
        onReject();
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
        <Text bold color="red">🛡️ SECURITY</Text>
        <Text bold color="yellow"> │ </Text>
        <Text bold color="cyan">TRUST DIRECTORY</Text>
        <Text bold color="yellow"> ]══╗</Text>
      </Box>
      
      <Box flexDirection="row" width="100%">
        <Text bold color="yellow">║  </Text>
        <Text color="white" bold>Do you trust the files and authors in this directory?</Text>
      </Box>
      
      <Box flexDirection="row" width="100%">
        <Text bold color="yellow">║  </Text>
        <Text color="gray">Directory: </Text>
        <Text color="cyan" bold>{directoryPath}</Text>
      </Box>
      
      <Box flexDirection="row" width="100%">
        <Text bold color="yellow">║  </Text>
        <Text color="gray">AI agents will have access to execute commands, search, and edit files.</Text>
      </Box>
      
      <Box flexDirection="row" width="100%">
        <Text bold color="yellow">╚══════════════════════════════════════════════════════╝</Text>
      </Box>

      {/* ══ OPTIONS ══ */}
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" width="100%">
          {selectedIndex === 0 ? (
            <Text bold color="green">▶ [ Trust and Start ]</Text>
          ) : (
            <Text color="gray" dimColor>  [ Trust and Start ]</Text>
          )}
        </Box>
        <Box flexDirection="row" width="100%" marginTop={0.5}>
          {selectedIndex === 1 ? (
            <Text bold color="red">▶ [ Don't Trust and Exit ]</Text>
          ) : (
            <Text color="gray" dimColor>  [ Don't Trust and Exit ]</Text>
          )}
        </Box>
      </Box>

      {/* ══ FOOTER HINT ══ */}
      <Box flexDirection="row" width="100%" marginTop={1}>
        <Text color="gray" dimColor>Use </Text>
        <Text color="cyan" bold>↑/↓</Text>
        <Text color="gray" dimColor> to navigate · </Text>
        <Text color="cyan" bold>Enter</Text>
        <Text color="gray" dimColor> to select</Text>
      </Box>
    </Box>
  );
}
