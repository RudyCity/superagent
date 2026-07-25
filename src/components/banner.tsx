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

import { getSettings } from "../core/config.js";

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

export interface BannerProps {
  classifierStatus?: "offline" | "loading" | "online";
  embeddingStatus?: "offline" | "loading" | "online";
  workspacePath?: string;
}

export function Banner({ classifierStatus, embeddingStatus, workspacePath }: BannerProps = {}) {
  const hasGit = isGitRepo();

  let rmemoryActive = false;
  let configClassifierActive = false;
  try {
    const settings = getSettings();
    rmemoryActive = !!settings.enableRmemory;
    configClassifierActive = settings.classifierEnabled !== false;
  } catch {
    // Ignore config read failures
  }

  const cStatus = classifierStatus || (configClassifierActive ? "online" : "offline");
  const eStatus = embeddingStatus || (rmemoryActive ? "online" : "offline");

  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      <Box flexDirection="row" alignItems="center">
        {/* Info Column */}
        <Box flexDirection="column" justifyContent="center">
          <Box flexDirection="row" marginBottom={1} alignItems="center">
            <Text color="red" bold>S U P E R</Text>
            <Text color="white" bold>A G E N T</Text>
            <Text color="gray"> ● </Text>
            <Text color="yellow" bold>v{version}</Text>
            <Text color="gray"> • </Text>
            <Text color="cyan" bold>Workspace: {workspacePath || process.cwd()}</Text>
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

