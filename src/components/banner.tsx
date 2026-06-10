import React from "react";
import { Box, Text } from "ink";

export function Banner() {
  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      <Box flexDirection="row" alignItems="center">
        {/* Mascot Column */}
        <Box flexDirection="column" marginRight={3} alignItems="center">
          <Text color="yellow">   ▲   </Text>
          <Text color="yellow">  /█\  </Text>
          <Text color="yellow"> ▞███▚ </Text>
          <Text color="yellow">▐▛█▀█▜▌</Text>
          <Text color="yellow">  ▐█▌  </Text>
        </Box>

        {/* Info Column */}
        <Box flexDirection="column" justifyContent="center">
          <Box flexDirection="row" marginBottom={1}>
            <Text color="cyan" bold>SUPERAGENT</Text>
            <Text color="gray"> │ </Text>
            <Text color="magenta" bold>COGNITIVE SYSTEM INTERFACE v2.0</Text>
          </Box>
          <Box flexDirection="row">
            <Text dimColor>Type your query or </Text>
            <Text bold color="yellow">/help</Text>
            <Text dimColor> to see available commands</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

