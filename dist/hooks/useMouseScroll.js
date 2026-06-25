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
                const colStr = match.groups?.col;
                const rowStr = match.groups?.row;
                const action = match.groups?.action;
                // --- Scroll wheel ---
                if (btn === "64" || btn === "65") {
                    const isUp = btn === "64";
                    const y = rowStr ? parseInt(rowStr, 10) : 0;
                    // Find which section was scrolled (hovered)
                    let hoveredSection = null;
                    if (y > 0) {
                        for (const section of ctx.sections) {
                            if (y >= section.startRow && y <= section.endRow) {
                                hoveredSection = section;
                                break;
                            }
                        }
                    }
                    const sectionName = hoveredSection?.name;
                    if (sectionName === "chat") {
                        if (ctx.focusedResponseIndex !== null) {
                            ctx.setFocusedResponseOffset((prev) => {
                                if (isUp) {
                                    return Math.max(0, prev - 1);
                                }
                                else {
                                    const maxOffset = Math.max(0, ctx.responseLinesCount - ctx.focusWindowHeight);
                                    return Math.min(prev + 1, maxOffset);
                                }
                            });
                        }
                        else {
                            ctx.scrollChat(isUp ? "up" : "down");
                        }
                    }
                    else if (sectionName === "wizard" && ctx.activeWizard?.type === "plan_approve") {
                        ctx.setActiveWizard?.((curr) => {
                            if (!curr)
                                return null;
                            const currentOffset = parseInt(curr.data?.scrollOffset || "0", 10);
                            const nextOffset = isUp ? Math.max(0, currentOffset - 1) : currentOffset + 1;
                            return { ...curr, data: { ...curr.data, scrollOffset: String(nextOffset) } };
                        });
                    }
                    else if (sectionName === "superagents" ||
                        sectionName === "subagents" ||
                        sectionName === "procs" ||
                        sectionName === "checklist") {
                        scrollSection(ctx, sectionName, isUp ? "up" : "down");
                    }
                    else {
                        // Fallback scroll behavior if no section matches or hover detection isn't active
                        if (ctx.activeWizard?.type === "plan_approve") {
                            ctx.setActiveWizard?.((curr) => {
                                if (!curr)
                                    return null;
                                const currentOffset = parseInt(curr.data?.scrollOffset || "0", 10);
                                const nextOffset = isUp ? Math.max(0, currentOffset - 1) : currentOffset + 1;
                                return { ...curr, data: { ...curr.data, scrollOffset: String(nextOffset) } };
                            });
                        }
                        else if (ctx.focusedResponseIndex !== null) {
                            ctx.setFocusedResponseOffset((prev) => {
                                if (isUp)
                                    return Math.max(0, prev - 1);
                                const maxOffset = Math.max(0, ctx.responseLinesCount - ctx.focusWindowHeight);
                                return Math.min(prev + 1, maxOffset);
                            });
                        }
                        else if (ctx.focusMode === "superagents" ||
                            ctx.focusMode === "subagents" ||
                            ctx.focusMode === "procs" ||
                            ctx.focusMode === "checklist") {
                            scrollSection(ctx, ctx.focusMode, isUp ? "up" : "down");
                        }
                        else {
                            ctx.scrollChat(isUp ? "up" : "down");
                        }
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
                        if (sectionName === "procs") {
                            ctx.setFocusMode("procs");
                        }
                        else {
                            ctx.toggleCollapse(sectionName);
                        }
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
                            // Check if clicked on a chat line
                            let handledClick = false;
                            for (const pos of ctx.visibleLinePositions) {
                                if (y >= pos.startRow && y <= pos.endRow) {
                                    // Nested child line click → toggle child expand/collapse
                                    if (pos.parentIndex !== undefined && pos.childIndex !== undefined && pos.isCollapsible && ctx.toggleChildExpand) {
                                        ctx.toggleChildExpand(pos.parentIndex, pos.childIndex);
                                        handledClick = true;
                                    }
                                    // Collapsible line click → toggle expand/collapse
                                    else if (pos.isCollapsible && ctx.toggleLineExpand) {
                                        ctx.toggleLineExpand(pos.index);
                                        handledClick = true;
                                    }
                                    // Truncated assistant line click → open scroll view
                                    else if (pos.isTruncated && pos.type === "assistant") {
                                        ctx.openResponseAtIndex(pos.index);
                                        handledClick = true;
                                    }
                                    break;
                                }
                            }
                            if (!handledClick) {
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
                            if (ctx.activeWizard?.type === "plan_approve") {
                                if (ctx.activeWizard.step === 2) {
                                    ctx.setFocusMode("input");
                                    break;
                                }
                                // In PlanApprovalDialog step 1, OPTIONS.length is 3.
                                // The footer hint takes 1 line at the bottom.
                                const optEndRow = clickedSection.endRow - 1;
                                const optStartRow = optEndRow - 3 + 1; // 3 options
                                if (y < optStartRow) {
                                    ctx.setActiveWizard?.((curr) => curr ? { ...curr, data: { ...curr.data, focus: "plan" } } : null);
                                }
                                else if (y >= optStartRow && y <= optEndRow) {
                                    ctx.setActiveWizard?.((curr) => curr ? { ...curr, data: { ...curr.data, focus: "actions" } } : null);
                                    const idx = y - optStartRow;
                                    ctx.setWizardSelectedIndex?.(idx);
                                }
                            }
                            else if (ctx.activeWizard) {
                                // Clicking on options for any other WizardDialog
                                const options = ctx.wizardOptions || [];
                                const total = options.length;
                                if (total > 0) {
                                    const maxVisible = 10;
                                    const numericSelectedIndex = Math.min(Math.max(0, ctx.wizardSelectedIndex || 0), total - 1);
                                    let start = 0;
                                    let end = total;
                                    if (total > maxVisible) {
                                        start = Math.max(0, numericSelectedIndex - Math.floor(maxVisible / 2));
                                        end = start + maxVisible;
                                        if (end > total) {
                                            end = total;
                                            start = Math.max(0, end - maxVisible);
                                        }
                                    }
                                    const visibleCount = end - start;
                                    const hasBelow = end < total;
                                    const optEndRow = clickedSection.endRow - (hasBelow ? 1 : 0);
                                    const optStartRow = optEndRow - visibleCount + 1;
                                    if (y >= optStartRow && y <= optEndRow) {
                                        const idx = start + (y - optStartRow);
                                        if (idx >= 0 && idx < total) {
                                            ctx.setWizardSelectedIndex?.(idx);
                                        }
                                    }
                                }
                            }
                            else {
                                ctx.setFocusMode("input");
                            }
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