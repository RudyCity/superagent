/**
 * TunnelMenuDialog — shown when the user presses ESC while a tunnel is active.
 *
 *   Up/Down - move selection
 *   Enter   - confirm the highlighted option
 *   1/2/3   - shortcuts
 *   Esc     - cancel (= Lanjut)
 */

import React, { useState, useRef } from "react";
import { Box, Text, useInput } from "ink";

export type TunnelMenuChoice = "stop" | "message" | "back";

interface TunnelMenuDialogProps {
  tunnelCount: number;
  onChoose: (choice: TunnelMenuChoice) => void;
}

const OPTIONS: Array<{ id: TunnelMenuChoice; label: string; hint: string }> = [
  {
    id: "stop",
    label: "Stop tunnel",
    hint: "Hentikan semua tunnel + watcher yang aktif.",
  },
  {
    id: "message",
    label: "Kirim pesan ke Muse",
    hint: "Isi pesan di input, Enter untuk kirim via tunnel.",
  },
  {
    id: "back",
    label: "Lanjut",
    hint: "Tutup menu, kembali ke input.",
  },
];

export function TunnelMenuDialog({ tunnelCount, onChoose }: TunnelMenuDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const onChooseRef = useRef(onChoose);
  onChooseRef.current = onChoose;

  useInput((input, key) => {
    if (key.upArrow || key.leftArrow) {
      setSelectedIndex((idx) => (idx - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }
    if (key.downArrow || key.rightArrow) {
      setSelectedIndex((idx) => (idx + 1) % OPTIONS.length);
      return;
    }
    if (key.escape) {
      onChooseRef.current("back");
      return;
    }
    if (key.return) {
      onChooseRef.current(OPTIONS[selectedIndex].id);
      return;
    }
    if (input === "1") {
      onChooseRef.current("stop");
      return;
    }
    if (input === "2") {
      onChooseRef.current("message");
      return;
    }
    if (input === "3") {
      onChooseRef.current("back");
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>🚇 Tunnel aktif ({tunnelCount}) — menu ESC</Text>
      {OPTIONS.map((opt, idx) => (
        <Text key={opt.id} color={idx === selectedIndex ? "cyan" : undefined}>
          {idx === selectedIndex ? "❯" : "  "}[{idx + 1}] {opt.label}{" "}
          <Text dimColor>— {opt.hint}</Text>
        </Text>
      ))}
      <Text dimColor>↑/↓ pilih • Enter ok • 1/2/3 shortcut • Esc tutup</Text>
    </Box>
  );
}
