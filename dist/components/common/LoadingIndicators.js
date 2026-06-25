import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useState, useEffect } from "react";
import { Text, Box } from "ink";
export function LoadingIndicator() {
    const [frame, setFrame] = useState(0);
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    useEffect(() => {
        const interval = setInterval(() => {
            setFrame((prev) => (prev + 1) % frames.length);
        }, 250);
        return () => clearInterval(interval);
    }, []);
    return _jsxs(Text, { color: "yellow", children: [frames[frame], " Thinking..."] });
}
export function ToolLoadingIndicator() {
    const [frame, setFrame] = useState(0);
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    useEffect(() => {
        const interval = setInterval(() => {
            setFrame((prev) => (prev + 1) % frames.length);
        }, 120);
        return () => clearInterval(interval);
    }, []);
    return _jsxs(Text, { color: "yellow", children: [frames[frame], " Running system tool..."] });
}
export function ProcessingIndicator({ scrollOffset }) {
    const [frame, setFrame] = useState(0);
    const progressFrames = [
        "[■□□□□□□□□□]",
        "[■■□□□□□□□□]",
        "[■■■□□□□□□□]",
        "[■■■■□□□□□□]",
        "[■■■■■□□□□□]",
        "[■■■■■■□□□□]",
        "[■■■■■■■□□□]",
        "[■■■■■■■■□□]",
        "[■■■■■■■■■□]",
        "[■■■■■■■■■■]",
    ];
    const pulseFrames = ["   ", ".  ", ".. ", "..."];
    useEffect(() => {
        const interval = setInterval(() => {
            setFrame((prev) => (prev + 1) % 40);
        }, 150);
        return () => clearInterval(interval);
    }, []);
    const pulse = pulseFrames[frame % pulseFrames.length];
    const barIndex = Math.floor(frame / 4) % progressFrames.length;
    const bar = progressFrames[barIndex];
    return (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { dimColor: true, children: ["Processing", pulse, " (Ctrl+C to abort) "] }), scrollOffset > 0 && (_jsxs(Text, { color: "yellow", bold: true, children: ["[New outputs streaming at bottom - ", bar, "]"] }))] }));
}
export function ThinkingSpinner({ type = "orchestrating" }) {
    const [frame, setFrame] = useState(0);
    const spinners = ["▰▱▱▱▱▱▱", "▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱", "▰▰▰▰▱▱▱", "▰▰▰▰▰▱▱", "▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰"];
    useEffect(() => {
        const timer = setInterval(() => {
            setFrame((prev) => (prev + 1) % spinners.length);
        }, 150);
        return () => clearInterval(timer);
    }, []);
    const label = type === "orchestrating" ? "ORCHESTRATING" : "PROCESSING";
    return _jsxs(Text, { color: "yellow", bold: true, children: ["\u26A1 ", label, " [", spinners[frame], "] "] });
}
export function ActiveStatusBadge() {
    const [activeBlink, setActiveBlink] = useState(true);
    useEffect(() => {
        const timer = setInterval(() => {
            setActiveBlink((prev) => !prev);
        }, 600);
        return () => clearInterval(timer);
    }, []);
    return activeBlink ? (_jsx(Text, { color: "black", backgroundColor: "yellow", bold: true, children: "\u25CF ACTIVE" })) : (_jsx(Text, { color: "yellow", bold: true, children: "  ACTIVE" }));
}
export function BlinkingCursor() {
    const [activeBlink, setActiveBlink] = useState(true);
    useEffect(() => {
        const timer = setInterval(() => {
            setActiveBlink((prev) => !prev);
        }, 600);
        return () => clearInterval(timer);
    }, []);
    return _jsx(Text, { color: "green", bold: true, children: activeBlink ? "█" : " " });
}
export function SessionSpinner() {
    const [frame, setFrame] = useState(0);
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    useEffect(() => {
        const timer = setInterval(() => {
            setFrame((prev) => (prev + 1) % spinnerFrames.length);
        }, 120);
        return () => clearInterval(timer);
    }, []);
    return _jsxs(Text, { color: "yellow", bold: true, children: [spinnerFrames[frame], " "] });
}
//# sourceMappingURL=LoadingIndicators.js.map