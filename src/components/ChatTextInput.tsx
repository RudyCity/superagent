/**
 * ChatTextInput - Custom terminal text input component for the chat interface.
 *
 * Fixes over ink-text-input v6:
 *  1. Backspace deletes the character BEFORE the cursor (standard behaviour).
 *  2. Delete (forward-delete) deletes the character AFTER the cursor — ink-text-input
 *     erroneously treated both keys identically (both deleted char before cursor).
 *  3. Ctrl+A / Home  → move cursor to start of line.
 *  4. Ctrl+E / End   → move cursor to end of line.
 *  5. Ctrl+K         → delete from cursor to end of line.
 *  6. Ctrl+U         → delete from cursor to start of line.
 *
 * Image attachment additions:
 *  7. Auto-detects image file paths pasted into the input and converts them to
 *     attachments via onAttachImage callback.
 *  8. Ctrl+W with empty input → removes the last attachment.
 *  9. Ctrl+V (paste) triggers clipboard image check via onPasteImage callback.
 */

import React, { useState, useEffect } from "react";
import { Text, useInput } from "ink";
import chalk from "chalk";
import type { ImageAttachment } from "../utils/imageUtils.js";
import { isImageFilePath } from "../utils/imageUtils.js";

type Props = {
  value: string;
  placeholder?: string;
  focus?: boolean;
  mask?: string;
  showCursor?: boolean;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  /** Called when an image file path is detected in the input text */
  onAttachImage?: (filePath: string) => void;
  /** Called when Ctrl+V is pressed — parent handles clipboard image detection */
  onPasteImage?: () => void;
  /** Called when Ctrl+W is pressed with empty input — remove last attachment */
  onRemoveLastAttachment?: () => void;
  /** Current attachments (used to decide whether Ctrl+W should remove) */
  attachmentCount?: number;
};

export default function ChatTextInput({
  value: originalValue,
  placeholder = "",
  focus = true,
  mask,
  showCursor = true,
  onChange,
  onSubmit,
  onAttachImage,
  onPasteImage,
  onRemoveLastAttachment,
  attachmentCount = 0,
}: Props) {
  const [cursorOffset, setCursorOffset] = useState(
    (originalValue || "").length
  );

  // Keep cursorOffset within bounds when value changes externally.
  useEffect(() => {
    if (!focus || !showCursor) return;
    const len = (originalValue || "").length;
    if (cursorOffset > len) {
      setCursorOffset(len);
    }
  }, [originalValue, focus, showCursor]);

  // Detect image file paths when value changes.
  // If the entire current input looks like an image path, convert it to attachment.
  useEffect(() => {
    if (!onAttachImage || !originalValue.trim()) return;
    const trimmed = originalValue.trim();
    if (isImageFilePath(trimmed)) {
      // Small delay to debounce rapid onChange calls
      const timer = setTimeout(() => {
        onAttachImage(trimmed);
        onChange(""); // Clear the input
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [originalValue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build displayed value with cursor highlight.
  const value = mask ? mask.repeat(originalValue.length) : originalValue;
  let renderedValue = value;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(" ");

    renderedValue = value.length > 0 ? "" : chalk.inverse(" ");
    let i = 0;
    for (const char of value) {
      renderedValue +=
        i === cursorOffset ? chalk.inverse(char) : char;
      i++;
    }
    // Cursor block at the end when cursor is past last character.
    if (value.length > 0 && cursorOffset === value.length) {
      renderedValue += chalk.inverse(" ");
    }
  }

  useInput(
    (input, key) => {
      // Let parent handle these keys — do not consume them here.
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && input === "c") ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }

      if (key.return) {
        onSubmit?.(originalValue);
        return;
      }

      // ── Ctrl+V — trigger clipboard image detection ─────────────────────────
      if (key.ctrl && input === "v") {
        // Fire the clipboard check in the parent; normal paste still proceeds
        // through the terminal's own paste mechanism (text arrives via onChange).
        onPasteImage?.();
        return;
      }

      // ── Ctrl+W — remove last attachment when input is empty ─────────────────
      if (key.ctrl && input === "w") {
        if (originalValue === "" && attachmentCount > 0) {
          onRemoveLastAttachment?.();
          return;
        }
        // Otherwise fall through to default Ctrl+W word-delete (handled below)
        if (originalValue !== "") {
          // Delete word before cursor
          let pos = cursorOffset;
          while (pos > 0 && originalValue[pos - 1] === " ") pos--;
          while (pos > 0 && originalValue[pos - 1] !== " ") pos--;
          const nextValue =
            originalValue.slice(0, pos) + originalValue.slice(cursorOffset);
          setCursorOffset(pos);
          if (nextValue !== originalValue) onChange(nextValue);
          return;
        }
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;

      if (key.leftArrow) {
        if (showCursor) {
          nextCursorOffset = Math.max(0, cursorOffset - 1);
        }
      } else if (key.rightArrow) {
        if (showCursor) {
          nextCursorOffset = Math.min(originalValue.length, cursorOffset + 1);
        }
      } else if (key.backspace) {
        // ── Backspace: delete character BEFORE cursor ──────────────────────
        if (cursorOffset > 0) {
          nextValue =
            originalValue.slice(0, cursorOffset - 1) +
            originalValue.slice(cursorOffset);
          nextCursorOffset = cursorOffset - 1;
        }
      } else if (key.delete) {
        // ── Delete (forward): delete character AFTER cursor ────────────────
        if (cursorOffset < originalValue.length) {
          nextValue =
            originalValue.slice(0, cursorOffset) +
            originalValue.slice(cursorOffset + 1);
          // cursor stays in place
        }
      } else if (key.ctrl && input === "a") {
        // Ctrl+A / Home — move to start
        nextCursorOffset = 0;
      } else if (key.ctrl && input === "e") {
        // Ctrl+E / End — move to end
        nextCursorOffset = originalValue.length;
      } else if (key.ctrl && input === "k") {
        // Ctrl+K — delete to end of line
        nextValue = originalValue.slice(0, cursorOffset);
      } else if (key.ctrl && input === "u") {
        // Ctrl+U — delete to start of line
        nextValue = originalValue.slice(cursorOffset);
        nextCursorOffset = 0;
      } else if (input) {
        // Regular character insertion at cursor position.
        nextValue =
          originalValue.slice(0, cursorOffset) +
          input +
          originalValue.slice(cursorOffset);
        nextCursorOffset = cursorOffset + input.length;
      }

      // Clamp cursor.
      nextCursorOffset = Math.max(
        0,
        Math.min(nextCursorOffset, nextValue.length)
      );

      setCursorOffset(nextCursorOffset);

      if (nextValue !== originalValue) {
        onChange(nextValue);
      }
    },
    { isActive: focus }
  );

  return (
    <Text>
      {placeholder
        ? value.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}
