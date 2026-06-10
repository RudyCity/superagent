import React from "react";
import { Box, Text } from "ink";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let version = "1.1.0";
try {
  const pkgPath = path.join(__dirname, "..", "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  version = pkg.version;
} catch (e) {
  // fallback
}

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
            <Text color="magenta" bold>COGNITIVE SYSTEM INTERFACE v{version}</Text>
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

