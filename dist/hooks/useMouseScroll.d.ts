import { type MutableRefObject } from "react";
export interface SectionBoundary {
    name: string;
    startRow: number;
    endRow: number;
    isHeader?: boolean;
}
export interface ChatLinePosition {
    index: number;
    startRow: number;
    endRow: number;
    isTruncated: boolean;
    type: string;
}
export interface SingleAgentMouseContext {
    scrollChat: (direction: "up" | "down", amount?: number) => void;
    terminalHeight: number;
    focusMode: string;
    setFocusMode: (mode: any) => void;
    setScrollOffset: (val: number | ((prev: number) => number)) => void;
    focusedResponseIndex: number | null;
    setFocusedResponseIndex: (val: number | null) => void;
    setFocusedResponseOffset: (val: number | ((prev: number) => number)) => void;
    focusWindowHeight: number;
    responseLinesCount: number;
    sections: SectionBoundary[];
    setSuperagentsScrollOffset: (val: number | ((prev: number) => number)) => void;
    setSubagentsScrollOffset: (val: number | ((prev: number) => number)) => void;
    setProcsScrollOffset: (val: number | ((prev: number) => number)) => void;
    setChecklistScrollOffset: (val: number | ((prev: number) => number)) => void;
    runningSuperagentsCount: number;
    runningSubagentsCount: number;
    runningTasksCount: number;
    checklistTasksCount: number;
    maxSuperagentsVisible: number;
    maxSubagentsVisible: number;
    maxProcsVisible: number;
    maxChecklistVisible: number;
    toggleCollapse: (section: string) => void;
    openResponseAtIndex: (index: number) => void;
    visibleLinePositions: ChatLinePosition[];
}
/**
 * Hook to enable mouse wheel scroll + click support in the terminal for the single-agent app.
 * Uses a ref-based approach so the event listener is registered once and always reads
 * the latest context values from the ref on each event.
 */
export declare function useMouseScroll(ctxRef: MutableRefObject<SingleAgentMouseContext | null>): void;
//# sourceMappingURL=useMouseScroll.d.ts.map