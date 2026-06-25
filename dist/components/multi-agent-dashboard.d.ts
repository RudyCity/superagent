import React from "react";
import { Agent } from "../core/agent.js";
import type { QuestionItem } from "../core/agent.js";
export interface AgentSession {
    id: string;
    type: "MASTER" | "SUPERAGENT" | "SUBAGENT" | "TASK";
    task: string;
    status: "WORKING" | "COMPLETED" | "IDLE" | "ERROR" | "PAUSED";
    tokens: number;
    logs: string[];
    branch?: string;
    worktreePath?: string;
    speed?: number;
    parentId?: string;
}
export declare function MultiAgentDashboard({ agent, autoResume, registerLogHandler, registerEventHandler, registerQuestionHandlerRef, }: {
    agent: Agent;
    autoResume?: boolean | string;
    registerLogHandler: (handler: (msg: string) => void) => void;
    registerEventHandler?: (handler: (event: any) => void) => void;
    registerQuestionHandlerRef?: (setter: (q: string | QuestionItem[], opts?: string[], isMultiSelect?: boolean, initialCheckedIndices?: number[]) => Promise<string | string[]>) => void;
}): React.JSX.Element;
//# sourceMappingURL=multi-agent-dashboard.d.ts.map