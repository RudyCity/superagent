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

import React, { useState, useEffect, useRef } from "react";
import { Text, useInput, useStdin } from "ink";
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
  /** Force immediate (non-debounced) parent state updates (e.g., active wizard) */
  immediate?: boolean;
};

const BLINK_ON = "\x1b[5m";
const BLINK_OFF = "\x1b[25m";
function blinkInverse(text: string): string {
  return `${BLINK_ON}\x1b[7m${text}\x1b[27m${BLINK_OFF}`;
}

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
  immediate = false,
}: Props) {
  const [localValue, setLocalValue] = useState(originalValue || "");
  const [cursorOffset, setCursorOffset] = useState(
    (originalValue || "").length
  );

  const lastSentValueRef = useRef(originalValue || "");
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const debounceOnChange = (val: string, forceImmediate = false) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    const shouldUpdateImmediately =
      forceImmediate ||
      immediate ||
      val === "" ||
      val.startsWith("/") ||
      val.startsWith("!") ||
      val.length - (lastSentValueRef.current || "").length > 5 ||
      val.includes("\n");

    if (shouldUpdateImmediately) {
      lastSentValueRef.current = val;
      onChange(val);
    } else {
      debounceTimerRef.current = setTimeout(() => {
        lastSentValueRef.current = val;
        onChange(val);
        debounceTimerRef.current = null;
      }, 100);
    }
  };

  const handleChange = (val: string, forceImmediate = false) => {
    setLocalValue(val);
    debounceOnChange(val, forceImmediate);
  };

  const { internal_eventEmitter } = useStdin();
  const lastRawKeyRef = useRef("");

  useEffect(() => {
    if (!internal_eventEmitter) return;
    const handleInput = (data: Buffer | string) => {
      lastRawKeyRef.current = data.toString();
    };
    internal_eventEmitter.on("input", handleInput);
    return () => {
      internal_eventEmitter.off("input", handleInput);
    };
  }, [internal_eventEmitter]);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Sync localValue with originalValue when it changes externally.
  // Keep cursorOffset within bounds and snap cursor to end when value changes externally.
  useEffect(() => {
    const currentVal = originalValue || "";
    const len = currentVal.length;
    if (currentVal !== lastSentValueRef.current) {
      setLocalValue(currentVal);
      lastSentValueRef.current = currentVal;
      if (focus && showCursor) {
        setCursorOffset(len);
      }
    } else {
      if (focus && showCursor && cursorOffset > len) {
        setCursorOffset(len);
      }
    }
  }, [originalValue, focus, showCursor]);

  // Detect image file paths when value changes.
  // If the entire current input looks like an image path, convert it to attachment.
  useEffect(() => {
    if (!onAttachImage || !localValue.trim()) return;
    const trimmed = localValue.trim();
    if (isImageFilePath(trimmed)) {
      // Small delay to debounce rapid onChange calls
      const timer = setTimeout(() => {
        onAttachImage(trimmed);
        handleChange("", true); // Clear the input immediately
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [localValue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build displayed value with cursor highlight.
  // Performance: for very long input, only render a window around cursor position
  // to avoid O(n) per-char ANSI processing on every keystroke.
  const value = mask ? mask.repeat(localValue.length) : localValue;
  let renderedValue = value;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? blinkInverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : blinkInverse(" ");

    const DISPLAY_WINDOW = 500; // max chars to render with per-char cursor blink
    if (value.length > DISPLAY_WINDOW * 2) {
      // Truncated display: show window around cursor
      const windowStart = Math.max(0, Math.min(cursorOffset - Math.floor(DISPLAY_WINDOW / 2), value.length - DISPLAY_WINDOW));
      const windowEnd = Math.min(value.length, windowStart + DISPLAY_WINDOW);
      const before = value.slice(0, windowStart);
      const visible = value.slice(windowStart, windowEnd);
      const after = value.slice(windowEnd);
      let result = "";
      if (before.length > 0) result += chalk.grey(`⋯${before.length}⋯`);
      const localCursor = cursorOffset - windowStart;
      let i = 0;
      for (const char of visible) {
        result += i === localCursor ? blinkInverse(char) : char;
        i++;
      }
      if (after.length > 0) result += chalk.grey(`⋯${after.length}⋯`);
      if (cursorOffset === value.length) {
        result += blinkInverse(" ");
      }
      renderedValue = result;
    } else {
      renderedValue = value.length > 0 ? "" : blinkInverse(" ");
      let i = 0;
      for (const char of value) {
        renderedValue +=
          i === cursorOffset ? blinkInverse(char) : char;
        i++;
      }
      // Cursor block at end when cursor past last character.
      if (value.length > 0 && cursorOffset === value.length) {
        renderedValue += blinkInverse(" ");
      }
    }
  }

  useInput(
    (input, key) => {
      const isInternalCtrl = key.ctrl && (
        input === "v" ||
        input === "w" ||
        input === "a" ||
        input === "e" ||
        input === "k" ||
        input === "u"
      );

      // Let parent handle these keys — do not consume them here.
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && !isInternalCtrl) ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }

      // ── Strip SGR mouse escape sequences that leak from terminal clicks ──
      if (input && (input.startsWith("[<") || input.startsWith("\x1b[<") || input.startsWith("\u001b[<"))) {
        return;
      }

      if (key.return) {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        lastSentValueRef.current = localValue;
        onChange(localValue);
        onSubmit?.(localValue);
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
        if (localValue === "" && attachmentCount > 0) {
          onRemoveLastAttachment?.();
          return;
        }
        // Otherwise fall through to default Ctrl+W word-delete (handled below)
        if (localValue !== "") {
          // Delete word before cursor
          let pos = cursorOffset;
          while (pos > 0 && localValue[pos - 1] === " ") pos--;
          while (pos > 0 && localValue[pos - 1] !== " ") pos--;
          const nextValue =
            localValue.slice(0, pos) + localValue.slice(cursorOffset);
          setCursorOffset(pos);
          if (nextValue !== localValue) handleChange(nextValue);
          return;
        }
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = localValue;

      const isBackspace =
        key.backspace ||
        (key.delete &&
          (/^[\x7f]+$/.test(lastRawKeyRef.current) ||
            /^(\x1b\x7f)+$/.test(lastRawKeyRef.current) ||
            /^\x08+$/.test(lastRawKeyRef.current)));
      const isDelete = key.delete && !isBackspace;

      if (key.leftArrow) {
        if (showCursor) {
          nextCursorOffset = Math.max(0, cursorOffset - 1);
        }
      } else if (key.rightArrow) {
        if (showCursor) {
          nextCursorOffset = Math.min(localValue.length, cursorOffset + 1);
        }
      } else if (isBackspace) {
        // ── Backspace: delete character BEFORE cursor ──────────────────────
        if (cursorOffset > 0) {
          nextValue =
            localValue.slice(0, cursorOffset - 1) +
            localValue.slice(cursorOffset);
          nextCursorOffset = cursorOffset - 1;
        }
      } else if (isDelete) {
        // ── Delete (forward): delete character AFTER cursor ────────────────
        if (cursorOffset < localValue.length) {
          nextValue =
            localValue.slice(0, cursorOffset) +
            localValue.slice(cursorOffset + 1);
          // cursor stays in place
        }
      } else if (key.ctrl && input === "a") {
        // Ctrl+A / Home — move to start
        nextCursorOffset = 0;
      } else if (key.ctrl && input === "e") {
        // Ctrl+E / End — move to end
        nextCursorOffset = localValue.length;
      } else if (key.ctrl && input === "k") {
        // Ctrl+K — delete to end of line
        nextValue = localValue.slice(0, cursorOffset);
      } else if (key.ctrl && input === "u") {
        // Ctrl+U — delete to start of line
        nextValue = localValue.slice(cursorOffset);
        nextCursorOffset = 0;
      } else if (input) {
        // Git Bash may deliver combined \x7f bytes from held-down
        // backspace repeat. Ink's parseKeypress doesn't match them,
        // leaving raw bytes as input instead of setting key.delete.
        if (
          /^[\x7f\x08]+$/.test(input) ||
          /^(\x1b\x7f)+$/.test(input)
        ) {
          // Treat each control byte as one backspace deletion
          const deleteCount = [...input].filter(
            (c) => c === "\x7f" || c === "\x08"
          ).length;
          if (cursorOffset >= deleteCount) {
            nextValue =
              localValue.slice(0, cursorOffset - deleteCount) +
              localValue.slice(cursorOffset);
            nextCursorOffset = cursorOffset - deleteCount;
          } else {
            nextValue = localValue.slice(cursorOffset);
            nextCursorOffset = 0;
          }
        } else {
          // Regular character insertion at cursor position.
          nextValue =
            localValue.slice(0, cursorOffset) +
            input +
            localValue.slice(cursorOffset);
          nextCursorOffset = cursorOffset + input.length;
        }
      }

      // Clamp cursor.
      nextCursorOffset = Math.max(
        0,
        Math.min(nextCursorOffset, nextValue.length)
      );

      setCursorOffset(nextCursorOffset);

      if (nextValue !== localValue) {
        handleChange(nextValue);
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
