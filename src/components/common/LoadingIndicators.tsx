import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";

const rPulseColors = ["cyan", "cyanBright", "yellow", "white", "magenta", "yellow"];

export function LoadingIndicator() {
  const [frame, setFrame] = useState(0);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % frames.length);
    }, 120);
    return () => clearInterval(interval);
  }, []);

  const rColor = rPulseColors[frame % rPulseColors.length];

  return (
    <Text color="yellow">
      <Text bold color={rColor}>[R] </Text>
      {frames[frame]} Thinking...
    </Text>
  );
}

export function ToolLoadingIndicator() {
  const [frame, setFrame] = useState(0);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % frames.length);
    }, 120);
    return () => clearInterval(interval);
  }, []);

  const rColor = rPulseColors[frame % rPulseColors.length];

  return (
    <Text color="yellow">
      <Text bold color={rColor}>[R] </Text>
      {frames[frame]} Running system tool...
    </Text>
  );
}

export function ProcessingIndicator({ scrollOffset }: { scrollOffset: number }) {
  const [frame, setFrame] = useState(0);
  const progressFrames = [
    "[■□□□□□□□□□]",
    "[■■□□□□□□□□]",
    "[■■■□□□□□□□]",
    "[■■■■□□□□□□]",
    "[■■■■■□□□□□]",
    "[■■■■■■□□□□]",
    "[■■■■■■■□□□]",
    "[■■■■■■■■□□]",
    "[■■■■■■■■■□]",
    "[■■■■■■■■■■]",
  ];
  const pulseFrames = ["   ", ".  ", ".. ", "..."];

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % 40);
    }, 150);
    return () => clearInterval(interval);
  }, []);

  const pulse = pulseFrames[frame % pulseFrames.length];
  const barIndex = Math.floor(frame / 4) % progressFrames.length;
  const bar = progressFrames[barIndex];
  const rColor = rPulseColors[frame % rPulseColors.length];

  return (
    <Box flexDirection="row">
      <Text bold color={rColor}>[R] </Text>
      <Text dimColor>Processing{pulse} (Ctrl+C to abort) </Text>
      {scrollOffset > 0 && (
        <Text color="yellow" bold>
          [New outputs streaming at bottom - {bar}]
        </Text>
      )}
    </Box>
  );
}

export function ThinkingSpinner({ type = "orchestrating" }: { type?: "orchestrating" | "processing" }) {
  const [frame, setFrame] = useState(0);
  const spinners = ["▰▱▱▱▱▱▱", "▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱", "▰▰▰▰▱▱▱", "▰▰▰▰▰▱▱", "▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰"];
  
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % spinners.length);
    }, 150);
    return () => clearInterval(timer);
  }, []);

  const label = type === "orchestrating" ? "ORCHESTRATING" : "PROCESSING";
  const rColor = rPulseColors[frame % rPulseColors.length];

  return (
    <Text color="yellow" bold>
      ⚡ <Text color={rColor}>[R]</Text> {label} {spinners[frame]}{" "}
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
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % spinnerFrames.length);
    }, 120);
    return () => clearInterval(timer);
  }, []);

  const rColor = rPulseColors[frame % rPulseColors.length];

  return (
    <Text color="yellow" bold>
      <Text color={rColor}>[R] </Text>
      {spinnerFrames[frame]}{" "}
    </Text>
  );
}
