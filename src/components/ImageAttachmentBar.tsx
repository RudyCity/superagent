/**
 * ImageAttachmentBar — Ink component that shows image attachments above the
 * chat input area.
 *
 * Renders one line per attachment with filename, size, and removal hint.
 *
 * Example output (in terminal):
 *
 *   📎 screenshot.png (142KB)  [Backspace to remove]
 *   📎 diagram.jpg (89KB)
 */

import React from "react";
import { Box, Text } from "ink";
import chalk from "chalk";
import type { ImageAttachment } from "../utils/imageUtils.js";
import { formatFileSize } from "../utils/imageUtils.js";

interface Props {
  attachments: ImageAttachment[];
  onRemove: (id: string) => void;
  focused?: boolean;
}

export default function ImageAttachmentBar({
  attachments,
  onRemove: _onRemove,
  focused = true,
}: Props) {
  if (attachments.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={0}>
      {attachments.map((att, idx) => (
        <Box key={att.id} flexDirection="row" gap={1}>
          <Text>
            {chalk.cyan("📎")}
            {" "}
            <Text color="cyan">{att.filename}</Text>
            {" "}
            <Text dimColor>({formatFileSize(att.sizeBytes)})</Text>
            {focused && idx === attachments.length - 1 && (
              <Text dimColor>{"  · Ctrl+W to remove"}</Text>
            )}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
