import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";

const rPulseColors = ["cyan", "cyanBright", "yellow", "white", "magenta", "yellow"];

export function LoadingIndicator() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % 6);
    }, 120);
    return () => clearInterval(interval);
  }, []);

  const rColor = rPulseColors[frame % rPulseColors.length];

  return (
    <Text color="yellow">
      <Text bold color={rColor}>[R]</Text>
    </Text>
  );
}

export function ToolLoadingIndicator() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % 6);
    }, 120);
    return () => clearInterval(interval);
  }, []);

  const rColor = rPulseColors[frame % rPulseColors.length];

  return (
    <Text color="yellow">
      <Text bold color={rColor}>[R]</Text>
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
