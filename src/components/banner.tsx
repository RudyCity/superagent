import React from "react";
import { Box, Text } from "ink";

export function Banner() {
  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      <Text bold color="cyan">⚡ SUPERAGENT | Interactive CLI Coding Assistant</Text>
      <Text dimColor>Type your message or <Text bold color="yellow">/help</Text> for commands</Text>
      <Text dimColor>──────────────────────────────────────────────────────────────</Text>
    </Box>
  );
}
