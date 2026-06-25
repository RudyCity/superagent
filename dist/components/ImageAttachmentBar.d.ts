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
import type { ImageAttachment } from "../utils/imageUtils.js";
interface Props {
    attachments: ImageAttachment[];
    onRemove: (id: string) => void;
    focused?: boolean;
}
export default function ImageAttachmentBar({ attachments, onRemove: _onRemove, focused, }: Props): React.JSX.Element | null;
export {};
//# sourceMappingURL=ImageAttachmentBar.d.ts.map