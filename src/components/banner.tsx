import React from "react";
import { Box, Text } from "ink";

export function Banner() {
  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      <Text color="cyan" bold>
        {`   _____ _    _ _____  ______ _____          _____ ______ _   _ _______ 
  / ____| |  | |  __ \\|  ____|  __ \\   /\\   / ____|  ____| \\ | |__   __|
 | (___ | |  | | |__) | |__  | |__) | /  \\ | |  __| |__  |  \\| |  | |   
  \\___ \\| |  | |  ___/|  __| |  _  / / /\\ \\| | |_ |  __| | . \` |  | |   
  ____) | |__| | |    | |____| | \\ \\/ ____ \\ |__| | |____| |\\  |  | |   
 |_____/ \\____/|_|    |______|_|  \\_/_/    \\_\\_____|______|_| \\_|  |_|   `}
      </Text>
      <Box flexDirection="row" marginTop={1}>
        <Text color="magenta" bold>[ COGNITIVE SYSTEM INTERFACE v2.0 ]</Text>
        <Text color="gray"> ── </Text>
        <Text dimColor>Type your query or </Text>
        <Text bold color="yellow">/help</Text>
      </Box>
      <Text color="cyan">────────────────────────────────────────────────────────────────────────</Text>
    </Box>
  );
}
