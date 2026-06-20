import { useEffect } from "react";
/**
 * Hook to enable mouse wheel scroll + click support in the terminal for the single-agent app.
 * Uses a ref-based approach so the event listener is registered once and always reads
 * the latest context values from the ref on each event.
 */
export function useMouseScroll(ctxRef) {
    useEffect(() => {
        if (!process.stdin.isTTY)
            return;
        // Enable SGR extended mouse tracking (button events + SGR coordinates)
        const enableMouseTracking = "\x1b[?1000h\x1b[?1006h";
        const disableMouseTracking = "\x1b[?1006l\x1b[?1000l";
        const handleMouseInput = (data) => {
            const ctx = ctxRef.current;
            if (!ctx)
                return;
            const text = data.toString("utf8");
            const matches = text.matchAll(/\x1b\[<(?<btn>\d+);(?<col>\d+);(?<row>\d+)(?<action>[Mm])/g);
            for (const match of matches) {
                const btn = match.groups?.btn;
                const rowStr = match.groups?.row;
                const action = match.groups?.action;
                // --- Scroll wheel ---
                if (btn === "64") {
                    // Scroll up
                    if (ctx.focusedResponseIndex !== null) {
                        ctx.setFocusedResponseOffset((prev) => Math.max(0, prev - 1));
                    }
                    else if (ctx.focusMode === "superagents" ||
                        ctx.focusMode === "subagents" ||
                        ctx.focusMode === "procs" ||
                        ctx.focusMode === "checklist") {
                        scrollSection(ctx, ctx.focusMode, "up");
                    }
                    else {
                        ctx.scrollChat("up");
                    }
                    continue;
                }
                if (btn === "65") {
                    // Scroll down
                    if (ctx.focusedResponseIndex !== null) {
                        ctx.setFocusedResponseOffset((prev) => {
                            const maxOffset = Math.max(0, ctx.responseLinesCount - ctx.focusWindowHeight);
                            return Math.min(prev + 1, maxOffset);
                        });
                    }
                    else if (ctx.focusMode === "superagents" ||
                        ctx.focusMode === "subagents" ||
                        ctx.focusMode === "procs" ||
                        ctx.focusMode === "checklist") {
                        scrollSection(ctx, ctx.focusMode, "down");
                    }
                    else {
                        ctx.scrollChat("down");
                    }
                    continue;
                }
                // --- Click (button 0, press action "M") ---
                if (btn === "0" && action === "M" && rowStr) {
                    const y = parseInt(rowStr, 10);
                    // Find which section was clicked
                    let clickedSection = null;
                    for (const section of ctx.sections) {
                        if (y >= section.startRow && y <= section.endRow) {
                            clickedSection = section;
                            break;
                        }
                    }
                    if (!clickedSection)
                        continue;
                    const name = clickedSection.name;
                    // Handle header clicks → toggle collapse
                    if (name.endsWith("_header")) {
                        const sectionName = name.replace("_header", "");
                        ctx.toggleCollapse(sectionName);
                        continue;
                    }
                    switch (name) {
                        case "chat": {
                            if (ctx.focusedResponseIndex !== null) {
                                // Close focused response view on click
                                ctx.setFocusedResponseIndex(null);
                                ctx.setFocusedResponseOffset(0);
                                break;
                            }
                            // Check if clicked on a truncated chat line
                            let clickedTruncatedLine = false;
                            for (const pos of ctx.visibleLinePositions) {
                                if (y >= pos.startRow && y <= pos.endRow) {
                                    if (pos.isTruncated && pos.type === "assistant") {
                                        ctx.openResponseAtIndex(pos.index);
                                        clickedTruncatedLine = true;
                                    }
                                    break;
                                }
                            }
                            if (!clickedTruncatedLine) {
                                ctx.setFocusMode("chat");
                            }
                            break;
                        }
                        case "superagents":
                            ctx.setFocusMode("superagents");
                            break;
                        case "subagents":
                            ctx.setFocusMode("subagents");
                            break;
                        case "procs":
                            ctx.setFocusMode("procs");
                            break;
                        case "checklist":
                            ctx.setFocusMode("checklist");
                            break;
                        case "input":
                        case "wizard":
                            ctx.setFocusMode("input");
                            break;
                        // statusbar: ignore clicks
                    }
                }
            }
        };
        process.stdout.write(enableMouseTracking);
        process.stdin.on("data", handleMouseInput);
        return () => {
            process.stdin.off("data", handleMouseInput);
            process.stdout.write(disableMouseTracking);
        };
    }, []); // Empty deps - listener registered once, reads latest ctx from ref
}
function scrollSection(ctx, section, direction) {
    switch (section) {
        case "superagents":
            ctx.setSuperagentsScrollOffset((prev) => {
                if (direction === "up")
                    return Math.max(0, prev - 1);
                const maxScroll = Math.max(0, ctx.runningSuperagentsCount - ctx.maxSuperagentsVisible);
                return Math.min(prev + 1, maxScroll);
            });
            break;
        case "subagents":
            ctx.setSubagentsScrollOffset((prev) => {
                if (direction === "up")
                    return Math.max(0, prev - 1);
                const maxScroll = Math.max(0, ctx.runningSubagentsCount - ctx.maxSubagentsVisible);
                return Math.min(prev + 1, maxScroll);
            });
            break;
        case "procs":
            ctx.setProcsScrollOffset((prev) => {
                if (direction === "up")
                    return Math.max(0, prev - 1);
                const maxScroll = Math.max(0, ctx.runningTasksCount - ctx.maxProcsVisible);
                return Math.min(prev + 1, maxScroll);
            });
            break;
        case "checklist":
            ctx.setChecklistScrollOffset((prev) => {
                if (direction === "up")
                    return Math.max(0, prev - 1);
                const maxScroll = Math.max(0, ctx.checklistTasksCount - ctx.maxChecklistVisible);
                return Math.min(prev + 1, maxScroll);
            });
            break;
    }
}
//# sourceMappingURL=useMouseScroll.js.map