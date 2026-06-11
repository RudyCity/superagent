import React from "react";
import { Box, Text } from "ink";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

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

function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function Banner() {
  const hasGit = isGitRepo();

  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      <Box flexDirection="row" alignItems="center">
        {/* Mascot Column - Simple Garuda Mascot (Yellow/Gold) */}
        <Box flexDirection="column" marginRight={3} alignItems="center">
          <Box flexDirection="row">
            <Text color="yellow" bold> ◥█◣  ▲  ◢█◤ </Text>
          </Box>
          <Box flexDirection="row">
            <Text color="yellow" bold>  ◥██ █ ██◤  </Text>
          </Box>
          <Box flexDirection="row">
            <Text color="yellow" bold>   ◥█████◤   </Text>
          </Box>
          <Box flexDirection="row">
            <Text color="yellow" bold>     ◥█◤     </Text>
          </Box>
        </Box>

        {/* Info Column */}
        <Box flexDirection="column" justifyContent="center">
          <Box flexDirection="row" marginBottom={1} alignItems="center">
            <Text color="red" bold>S U P E R</Text>
            <Text color="white" bold>A G E N T</Text>
            <Text color="gray"> │ </Text>
            <Text color="yellow" bold>COGNITIVE SYSTEM v{version}</Text>
            <Text color="gray"> │ </Text>
            <Text color="green" bold>● READY</Text>
          </Box>
          <Box flexDirection="row">
            <Text dimColor>Type your query or </Text>
            <Text bold color="cyan">/help</Text>
            <Text dimColor> to explore commands</Text>
          </Box>
        </Box>
      </Box>

      {!hasGit && (
        <Box marginTop={1} paddingX={1}>
          <Text color="yellow">⚠ </Text>
          <Text dimColor>Git not detected in this project. Checkpoints won't capture code state.</Text>
          <Text dimColor> Run </Text>
          <Text bold color="cyan">git init</Text>
          <Text dimColor> or </Text>
          <Text bold color="cyan">/init</Text>
          <Text dimColor> to enable full checkpoint features.</Text>
        </Box>
      )}
    </Box>
  );
}

