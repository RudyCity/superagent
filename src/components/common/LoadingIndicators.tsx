import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";

const rPulseColors = ["cyan", "cyanBright", "yellow", "white", "magenta", "yellow"];

export function LoadingIndicator({ text }: { text?: string } = {}) {
  const [frame, setFrame] = useState(0);
  const [thinkingIndex, setThinkingIndex] = useState(0);

  const thinkingPhrases = [
    "Thinking...",
    "Analyzing request context...",
    "Formulating implementation plan...",
    "Searching local files...",
    "Querying codebase structures...",
    "Checking constraints & instructions...",
    "Processing logic tokens...",
    "Evaluating trade-offs...",
    "Synthesizing response...",
    "Preparing execution context..."
  ];

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % 6);
    }, 120);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (text) return;
    const interval = setInterval(() => {
      setThinkingIndex((prev) => (prev + 1) % thinkingPhrases.length);
    }, 2000);
    return () => clearInterval(interval);
  }, [text, thinkingPhrases.length]);

  const rColor = rPulseColors[frame % rPulseColors.length];
  const displayText = text || thinkingPhrases[thinkingIndex];

  return (
    <Text color="yellow">
      <Text bold color={rColor}>[R]</Text>
      <Text color="gray"> {displayText}</Text>
    </Text>
  );
}

export function ToolLoadingIndicator({ toolName, toolDesc }: { toolName?: string; toolDesc?: string } = {}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % 6);
    }, 120);
    return () => clearInterval(interval);
  }, []);

  const rColor = rPulseColors[frame % rPulseColors.length];

  let displayMsg = "Executing system call...";
  if (toolName) {
    if (toolName === "command") {
      const cleanDesc = toolDesc ? toolDesc.replace(/\r?\n/g, " ") : "";
      displayMsg = `Running: ${cleanDesc}`;
    } else {
      displayMsg = `Invoking tool: ${toolName}`;
      if (toolDesc) {
        const cleanDesc = toolDesc.replace(/\r?\n/g, " ");
        displayMsg += ` (${cleanDesc})`;
      }
    }
  }

  if (displayMsg.length > 70) {
    displayMsg = displayMsg.substring(0, 67) + "...";
  }

  return (
    <Text color="yellow">
      <Text bold color={rColor}>[R]</Text>
      <Text color="gray"> {displayMsg}</Text>
    </Text>
  );
}

export function ProcessingIndicator({ scrollOffset }: { scrollOffset: number }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % 6);
    }, 150);
    return () => clearInterval(interval);
  }, []);

  const rColor = rPulseColors[frame % rPulseColors.length];

  return (
    <Box flexDirection="row">
      <Text bold color={rColor}>[R]</Text>
      <Text dimColor> (Ctrl+C to abort)</Text>
      {scrollOffset > 0 && (
        <Text color="yellow" bold>
          [New outputs streaming at bottom]
        </Text>
      )}
    </Box>
  );
}

export function ThinkingSpinner({ type = "orchestrating" }: { type?: "orchestrating" | "processing" }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % 6);
    }, 150);
    return () => clearInterval(timer);
  }, []);

  const label = type === "orchestrating" ? "ORCHESTRATING" : "PROCESSING";
  const rColor = rPulseColors[frame % rPulseColors.length];

  return (
    <Text color="yellow" bold>
      <Text color={rColor}>[R]</Text> {label}{" "}
    </Text>
  );
}

export function ActiveStatusBadge() {
  const [activeBlink, setActiveBlink] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveBlink((prev) => !prev);
    }, 600);
    return () => clearInterval(timer);
  }, []);

  return activeBlink ? (
    <Text color="black" backgroundColor="yellow" bold>● ACTIVE R</Text>
  ) : (
    <Text color="yellow" bold>  ACTIVE R</Text>
  );
}

export function BlinkingCursor() {
  const [activeBlink, setActiveBlink] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveBlink((prev) => !prev);
    }, 600);
    return () => clearInterval(timer);
  }, []);

  return <Text color="green" bold>{activeBlink ? "█" : " "}</Text>;
}

export function SessionSpinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % 6);
    }, 120);
    return () => clearInterval(timer);
  }, []);

  const rColor = rPulseColors[frame % rPulseColors.length];

  return (
    <Text color="yellow" bold>
      <Text color={rColor}>[R]</Text>
    </Text>
  );
}
