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
import React from "react";
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
export default function ChatTextInput({ value: originalValue, placeholder, focus, mask, showCursor, onChange, onSubmit, onAttachImage, onPasteImage, onRemoveLastAttachment, attachmentCount, }: Props): React.JSX.Element;
export {};
//# sourceMappingURL=ChatTextInput.d.ts.map