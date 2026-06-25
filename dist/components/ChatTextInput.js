import { jsx as _jsx } from "react/jsx-runtime";
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
import { useState, useEffect, useRef } from "react";
import { Text, useInput, useStdin } from "ink";
import chalk from "chalk";
import { isImageFilePath } from "../utils/imageUtils.js";
export default function ChatTextInput({ value: originalValue, placeholder = "", focus = true, mask, showCursor = true, onChange, onSubmit, onAttachImage, onPasteImage, onRemoveLastAttachment, attachmentCount = 0, }) {
    const [cursorOffset, setCursorOffset] = useState((originalValue || "").length);
    const lastSentValueRef = useRef(originalValue || "");
    const handleChange = (val) => {
        lastSentValueRef.current = val;
        onChange(val);
    };
    const { stdin } = useStdin();
    const lastRawKeyRef = useRef("");
    useEffect(() => {
        if (!stdin)
            return;
        const handleData = (data) => {
            lastRawKeyRef.current = data.toString();
        };
        stdin.on("data", handleData);
        return () => {
            stdin.off("data", handleData);
        };
    }, [stdin]);
    // Keep cursorOffset within bounds and snap cursor to end when value changes externally.
    useEffect(() => {
        if (!focus || !showCursor)
            return;
        const currentVal = originalValue || "";
        const len = currentVal.length;
        if (currentVal !== lastSentValueRef.current) {
            setCursorOffset(len);
            lastSentValueRef.current = currentVal;
        }
        else {
            if (cursorOffset > len) {
                setCursorOffset(len);
            }
        }
    }, [originalValue, focus, showCursor]);
    // Detect image file paths when value changes.
    // If the entire current input looks like an image path, convert it to attachment.
    useEffect(() => {
        if (!onAttachImage || !originalValue.trim())
            return;
        const trimmed = originalValue.trim();
        if (isImageFilePath(trimmed)) {
            // Small delay to debounce rapid onChange calls
            const timer = setTimeout(() => {
                onAttachImage(trimmed);
                handleChange(""); // Clear the input
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
    useInput((input, key) => {
        // Let parent handle these keys — do not consume them here.
        if (key.upArrow ||
            key.downArrow ||
            (key.ctrl && (input === "c" || input === "\x03")) ||
            key.tab ||
            (key.shift && key.tab)) {
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
                while (pos > 0 && originalValue[pos - 1] === " ")
                    pos--;
                while (pos > 0 && originalValue[pos - 1] !== " ")
                    pos--;
                const nextValue = originalValue.slice(0, pos) + originalValue.slice(cursorOffset);
                setCursorOffset(pos);
                if (nextValue !== originalValue)
                    handleChange(nextValue);
                return;
            }
            return;
        }
        let nextCursorOffset = cursorOffset;
        let nextValue = originalValue;
        const isBackspace = key.backspace ||
            (key.delete &&
                (lastRawKeyRef.current === "\x7f" ||
                    lastRawKeyRef.current === "\x1b\x7f"));
        const isDelete = key.delete && !isBackspace;
        if (key.leftArrow) {
            if (showCursor) {
                nextCursorOffset = Math.max(0, cursorOffset - 1);
            }
        }
        else if (key.rightArrow) {
            if (showCursor) {
                nextCursorOffset = Math.min(originalValue.length, cursorOffset + 1);
            }
        }
        else if (isBackspace) {
            // ── Backspace: delete character BEFORE cursor ──────────────────────
            if (cursorOffset > 0) {
                nextValue =
                    originalValue.slice(0, cursorOffset - 1) +
                        originalValue.slice(cursorOffset);
                nextCursorOffset = cursorOffset - 1;
            }
        }
        else if (isDelete) {
            // ── Delete (forward): delete character AFTER cursor ────────────────
            if (cursorOffset < originalValue.length) {
                nextValue =
                    originalValue.slice(0, cursorOffset) +
                        originalValue.slice(cursorOffset + 1);
                // cursor stays in place
            }
        }
        else if (key.ctrl && input === "a") {
            // Ctrl+A / Home — move to start
            nextCursorOffset = 0;
        }
        else if (key.ctrl && input === "e") {
            // Ctrl+E / End — move to end
            nextCursorOffset = originalValue.length;
        }
        else if (key.ctrl && input === "k") {
            // Ctrl+K — delete to end of line
            nextValue = originalValue.slice(0, cursorOffset);
        }
        else if (key.ctrl && input === "u") {
            // Ctrl+U — delete to start of line
            nextValue = originalValue.slice(cursorOffset);
            nextCursorOffset = 0;
        }
        else if (input) {
            // Regular character insertion at cursor position.
            nextValue =
                originalValue.slice(0, cursorOffset) +
                    input +
                    originalValue.slice(cursorOffset);
            nextCursorOffset = cursorOffset + input.length;
        }
        // Clamp cursor.
        nextCursorOffset = Math.max(0, Math.min(nextCursorOffset, nextValue.length));
        setCursorOffset(nextCursorOffset);
        if (nextValue !== originalValue) {
            handleChange(nextValue);
        }
    }, { isActive: focus });
    return (_jsx(Text, { children: placeholder
            ? value.length > 0
                ? renderedValue
                : renderedPlaceholder
            : renderedValue }));
}
//# sourceMappingURL=ChatTextInput.js.map