import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";
export function TrustPrompt({ directoryPath, onAccept, onReject }) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const handlerRef = useRef();
    handlerRef.current = (input, key) => {
        if (key.upArrow || key.leftArrow) {
            setSelectedIndex(0);
        }
        else if (key.downArrow || key.rightArrow) {
            setSelectedIndex(1);
        }
        else if (key.return) {
            if (selectedIndex === 0) {
                onAccept();
            }
            else {
                onReject();
            }
        }
    };
    const stableHandler = useCallback((input, key) => {
        handlerRef.current?.(input, key);
    }, []);
    useInput(stableHandler);
    return (_jsxs(Box, { flexDirection: "column", paddingX: 2, marginY: 1, children: [_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { bold: true, color: "yellow", children: "\u2554\u2550\u2550[ " }), _jsx(Text, { bold: true, color: "red", children: "\uD83D\uDEE1\uFE0F SECURITY" }), _jsx(Text, { bold: true, color: "yellow", children: " \u2502 " }), _jsx(Text, { bold: true, color: "cyan", children: "TRUST DIRECTORY" }), _jsx(Text, { bold: true, color: "yellow", children: " ]\u2550\u2550\u2557" })] }), _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { bold: true, color: "yellow", children: "\u2551  " }), _jsx(Text, { color: "white", bold: true, children: "Do you trust the files and authors in this directory?" })] }), _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { bold: true, color: "yellow", children: "\u2551  " }), _jsx(Text, { color: "gray", children: "Directory: " }), _jsx(Text, { color: "cyan", bold: true, children: directoryPath })] }), _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { bold: true, color: "yellow", children: "\u2551  " }), _jsx(Text, { color: "gray", children: "AI agents will have access to execute commands, search, and edit files." })] }), _jsx(Box, { flexDirection: "row", width: "100%", children: _jsx(Text, { bold: true, color: "yellow", children: "\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D" }) }), _jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Box, { flexDirection: "row", width: "100%", children: selectedIndex === 0 ? (_jsx(Text, { bold: true, color: "green", children: "\u25B6 [ Trust and Start ]" })) : (_jsx(Text, { color: "gray", dimColor: true, children: "  [ Trust and Start ]" })) }), _jsx(Box, { flexDirection: "row", width: "100%", marginTop: 0.5, children: selectedIndex === 1 ? (_jsx(Text, { bold: true, color: "red", children: "\u25B6 [ Don't Trust and Exit ]" })) : (_jsx(Text, { color: "gray", dimColor: true, children: "  [ Don't Trust and Exit ]" })) })] }), _jsxs(Box, { flexDirection: "row", width: "100%", marginTop: 1, children: [_jsx(Text, { color: "gray", dimColor: true, children: "Use " }), _jsx(Text, { color: "cyan", bold: true, children: "\u2191/\u2193" }), _jsx(Text, { color: "gray", dimColor: true, children: " to navigate \u00B7 " }), _jsx(Text, { color: "cyan", bold: true, children: "Enter" }), _jsx(Text, { color: "gray", dimColor: true, children: " to select" })] })] }));
}
//# sourceMappingURL=trust-prompt.js.map