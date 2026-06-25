import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
import chalk from "chalk";
import { formatFileSize } from "../utils/imageUtils.js";
export default function ImageAttachmentBar({ attachments, onRemove: _onRemove, focused = true, }) {
    if (attachments.length === 0)
        return null;
    return (_jsx(Box, { flexDirection: "column", marginBottom: 0, children: attachments.map((att, idx) => (_jsx(Box, { flexDirection: "row", gap: 1, children: _jsxs(Text, { children: [chalk.cyan("📎"), " ", _jsx(Text, { color: "cyan", children: att.filename }), " ", _jsxs(Text, { dimColor: true, children: ["(", formatFileSize(att.sizeBytes), ")"] }), focused && idx === attachments.length - 1 && (_jsx(Text, { dimColor: true, children: "  · Ctrl+W to remove" }))] }) }, att.id))) }));
}
//# sourceMappingURL=ImageAttachmentBar.js.map