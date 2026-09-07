import fs from "fs";
import path from "path";
import { Tool } from "./types.js";
import { loadSessionFromDb, getHistoryDb, SessionRecord, MessageRecord } from "../storage/historyDb.js";
import { getRootConfigDir } from "../config/paths.js";

export interface ParsedTask {
  status: "completed" | "in_progress" | "pending";
  text: string;
  lineNumber: number;
}

export interface TaskChecklistSummary {
  total: number;
  completed: ParsedTask[];
  inProgress: ParsedTask[];
  pending: ParsedTask[];
  taskFilePath?: string;
}

export interface SessionInspectionResult {
  found: boolean;
  sessionId: string;
  sessionRecord: SessionRecord | null;
  tasks: TaskChecklistSummary;
  planContent?: string;
  planFilePath?: string;
  walkthroughContent?: string;
  recentMessages: Array<{
    role: string;
    content: string;
    timestamp: number;
    toolCalls?: string;
  }>;
  firstChat?: string;
  lastChat?: string;
  formattedReport: string;
  suggestedAction: string;
}

/**
 * Extract clean session ID from raw input string.
 * Supports patterns like:
 * - "Session: sess_1788744193171_qdfllz"
 * - "sess_1788744193171_qdfllz"
 * - "path/to/sess_1788744193171_qdfllz.json"
 */
export function extractSessionId(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();

  // Pattern: (Session:\s*)?(sess_\d+_[a-zA-Z0-9]+)
  const match = trimmed.match(/(?:Session:\s*)?(sess_\d+_[a-zA-Z0-9]+)/i);
  if (match) {
    return match[1];
  }

  // Pattern from json file path
  const jsonMatch = trimmed.match(/(sess_\d+_[a-zA-Z0-9]+)\.json/i);
  if (jsonMatch) {
    return jsonMatch[1];
  }

  return trimmed;
}

/**
 * Scan candidate paths for a session's task checklist file.
 */
export function findTaskFile(sessionId: string, workingDirectory?: string, sessionFilePath?: string): string | null {
  const root = getRootConfigDir();
  const candidates: string[] = [];

  if (sessionFilePath) {
    candidates.push(sessionFilePath.replace(/\.json$/, "_task.md"));
  }

  for (const mode of ["single", "multi"]) {
    candidates.push(path.join(root, "history", mode, sessionId, `${sessionId}_task.md`));
    candidates.push(path.join(root, "history", mode, sessionId, "_task.md"));
    candidates.push(path.join(root, "history", mode, sessionId, "task.md"));
  }
  candidates.push(path.join(root, "history", sessionId, `${sessionId}_task.md`));
  candidates.push(path.join(root, "history", sessionId, "_task.md"));

  if (workingDirectory && fs.existsSync(workingDirectory)) {
    candidates.push(path.join(workingDirectory, "_task.md"));
    candidates.push(path.join(workingDirectory, "task.md"));
    candidates.push(path.join(workingDirectory, "tasks.md"));
    candidates.push(path.join(workingDirectory, `${sessionId}_task.md`));
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch {}
    }
  }

  // Deep search in history folders for matching session substring
  try {
    const historyDir = path.join(root, "history");
    for (const mode of ["single", "multi"]) {
      const modeDir = path.join(historyDir, mode);
      if (!fs.existsSync(modeDir)) continue;
      const dirs = fs.readdirSync(modeDir);
      for (const d of dirs) {
        if (d.includes(sessionId) || sessionId.includes(d)) {
          const sessDir = path.join(modeDir, d);
          const taskFile = path.join(sessDir, `${d}_task.md`);
          if (fs.existsSync(taskFile)) return taskFile;
          const altTask = path.join(sessDir, "_task.md");
          if (fs.existsSync(altTask)) return altTask;
        }
      }
    }
  } catch {}

  return null;
}

/**
 * Scan candidate paths for a session's plan file.
 */
export function findPlanFile(sessionId: string, workingDirectory?: string, sessionFilePath?: string): string | null {
  const root = getRootConfigDir();
  const candidates: string[] = [];

  if (sessionFilePath) {
    candidates.push(sessionFilePath.replace(/\.json$/, "_plan.md"));
  }

  for (const mode of ["single", "multi"]) {
    candidates.push(path.join(root, "history", mode, sessionId, `${sessionId}_plan.md`));
    candidates.push(path.join(root, "history", mode, sessionId, "_plan.md"));
    candidates.push(path.join(root, "history", mode, sessionId, "plan.md"));
    candidates.push(path.join(root, "history", mode, sessionId, "implementation_plan.md"));
  }

  if (workingDirectory && fs.existsSync(workingDirectory)) {
    candidates.push(path.join(workingDirectory, "_plan.md"));
    candidates.push(path.join(workingDirectory, "plan.md"));
    candidates.push(path.join(workingDirectory, "implementation_plan.md"));
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch {}
    }
  }

  return null;
}

/**
 * Parse a markdown task checklist into structured groups.
 */
export function parseTaskChecklist(content: string): TaskChecklistSummary {
  const lines = content.split(/\r?\n/);
  const completed: ParsedTask[] = [];
  const inProgress: ParsedTask[] = [];
  const pending: ParsedTask[] = [];

  lines.forEach((line, index) => {
    const match = line.match(/^\s*[-*+]\s*\[([ xX/])\]\s*(.+)$/);
    if (match) {
      const mark = match[1].toLowerCase();
      const text = match[2].trim();
      const task: ParsedTask = {
        status: mark === "x" ? "completed" : mark === "/" ? "in_progress" : "pending",
        text,
        lineNumber: index + 1,
      };
      if (task.status === "completed") {
        completed.push(task);
      } else if (task.status === "in_progress") {
        inProgress.push(task);
      } else {
        pending.push(task);
      }
    }
  });

  return {
    total: completed.length + inProgress.length + pending.length,
    completed,
    inProgress,
    pending,
  };
}

/**
 * Inspect a session by ID or search term.
 */
export async function inspectSession(
  rawQuery: string,
  options: { messageLimit?: number; includeMessages?: boolean } = {}
): Promise<SessionInspectionResult> {
  const messageLimit = options.messageLimit ?? 8;
  const includeMessages = options.includeMessages ?? true;

  let targetId = extractSessionId(rawQuery);
  let sessionRecord: SessionRecord | null = null;
  let messages: MessageRecord[] = [];

  // 1. Try exact load from SQLite
  if (targetId) {
    const loaded = loadSessionFromDb(targetId);
    if (loaded.session) {
      sessionRecord = loaded.session;
      messages = loaded.messages;
    }
  }

  // 2. If not found, fuzzy search SQLite sessions table
  if (!sessionRecord) {
    try {
      const db = getHistoryDb();
      const query = targetId || rawQuery.trim();
      const stmt = db.prepare(`
        SELECT id, file_path as filePath, display_name as displayName, message_count as messageCount,
               last_modified as lastModified, preview, working_directory as workingDirectory,
               plan_state as planState, active_preset as activePreset
        FROM sessions
        WHERE id = ? OR id LIKE ? OR display_name LIKE ? OR file_path LIKE ?
        ORDER BY last_modified DESC LIMIT 1
      `);
      const matched = stmt.get(query, `%${query}%`, `%${query}%`, `%${query}%`) as SessionRecord | undefined;
      if (matched) {
        targetId = matched.id;
        const loaded = loadSessionFromDb(targetId);
        sessionRecord = loaded.session || matched;
        messages = loaded.messages;
      }
    } catch {}
  }

  // 3. Fallback: if session record not found, check filesystem for task/plan files
  const taskFilePath = findTaskFile(targetId, sessionRecord?.workingDirectory, sessionRecord?.filePath);
  const planFilePath = findPlanFile(targetId, sessionRecord?.workingDirectory, sessionRecord?.filePath);

  let tasks: TaskChecklistSummary = {
    total: 0,
    completed: [],
    inProgress: [],
    pending: [],
  };

  if (taskFilePath && fs.existsSync(taskFilePath)) {
    try {
      const content = fs.readFileSync(taskFilePath, "utf8");
      tasks = parseTaskChecklist(content);
      tasks.taskFilePath = taskFilePath;
    } catch {}
  }

  let planContent: string | undefined;
  if (planFilePath && fs.existsSync(planFilePath)) {
    try {
      planContent = fs.readFileSync(planFilePath, "utf8");
    } catch {}
  }

  // If still completely unfound
  if (!sessionRecord && !taskFilePath) {
    let recentListStr = "";
    try {
      const db = getHistoryDb();
      const recents = db.prepare("SELECT id, display_name as displayName, last_modified as lastModified, working_directory as workingDirectory FROM sessions ORDER BY last_modified DESC LIMIT 5").all() as any[];
      if (recents.length > 0) {
        recentListStr = "\n\nRecent active sessions available:\n" + recents.map((r) => `- ${r.id} (${r.displayName || "Untitled"} | ${r.workingDirectory || "N/A"})`).join("\n");
      }
    } catch {}

    const notFoundMsg = `Session "${rawQuery}" could not be found in history database or local storage.${recentListStr}`;
    return {
      found: false,
      sessionId: targetId || rawQuery,
      sessionRecord: null,
      tasks,
      recentMessages: [],
      formattedReport: notFoundMsg,
      suggestedAction: "Verify the session ID or select one from the recent sessions list.",
    };
  }

  // Extract recent messages
  const recentSlice = includeMessages ? messages.slice(-messageLimit) : [];
  const recentMessagesFormatted = recentSlice.map((m) => {
    let toolSummary = "";
    if (m.toolCalls) {
      try {
        const parsed = JSON.parse(m.toolCalls);
        if (Array.isArray(parsed)) {
          toolSummary = parsed.map((tc: any) => tc.function?.name || tc.name || "tool").join(", ");
        }
      } catch {}
    }
    return {
      role: m.role,
      content: m.content || "",
      timestamp: m.timestamp,
      toolCalls: toolSummary || undefined,
    };
  });

  // Build human-readable formatted report
  const reportLines: string[] = [];
  reportLines.push("=== Peer Terminal Session Inspection ===");
  reportLines.push(`Session ID: ${targetId}`);
  if (sessionRecord) {
    reportLines.push(`Display Name: ${sessionRecord.displayName || "Untitled"}`);
    reportLines.push(`Working Directory: ${sessionRecord.workingDirectory || "(root workspace)"}`);
    reportLines.push(`Last Modified: ${new Date(sessionRecord.lastModified).toLocaleString()}`);
    reportLines.push(`Total Messages in Session: ${sessionRecord.messageCount || messages.length}`);
    if (sessionRecord.planState) {
      reportLines.push(`Plan State: ${sessionRecord.planState}`);
    }
  }

  reportLines.push("");
  reportLines.push("=== Task Checklist Overview ===");
  if (tasks.total > 0) {
    const percentDone = Math.round((tasks.completed.length / tasks.total) * 100);
    reportLines.push(`Total Tasks: ${tasks.total}`);
    reportLines.push(`- Completed [x]: ${tasks.completed.length} (${percentDone}%)`);
    reportLines.push(`- In Progress [/]: ${tasks.inProgress.length}`);
    reportLines.push(`- Pending [ ]: ${tasks.pending.length} (${100 - percentDone}%)`);
    if (tasks.taskFilePath) {
      reportLines.push(`Task File: ${tasks.taskFilePath}`);
    }

    if (tasks.inProgress.length > 0) {
      reportLines.push("");
      reportLines.push("=== Currently In-Progress in Terminal 1 ===");
      for (const t of tasks.inProgress) {
        reportLines.push(`- [/] ${t.text}`);
      }
    }

    if (tasks.pending.length > 0) {
      reportLines.push("");
      reportLines.push("=== Remaining Pending Tasks (Available for Terminal 2 to assist) ===");
      const showCount = Math.min(10, tasks.pending.length);
      for (let i = 0; i < showCount; i++) {
        reportLines.push(`- [ ] ${tasks.pending[i].text}`);
      }
      if (tasks.pending.length > showCount) {
        reportLines.push(`... and ${tasks.pending.length - showCount} more pending tasks.`);
      }
    }
  } else {
    reportLines.push("No explicit task checklist (_task.md) found for this session.");
  }

  if (planContent) {
    reportLines.push("");
    reportLines.push("=== Implementation Plan Summary ===");
    const planLines = planContent.split(/\r?\n/).slice(0, 15).join("\n");
    reportLines.push(planLines);
    if (planContent.split(/\r?\n/).length > 15) {
      reportLines.push("... (plan truncated)");
    }
  }

  if (recentMessagesFormatted.length > 0) {
    reportLines.push("");
    reportLines.push("=== Recent Activity in Terminal 1 ===");
    for (const rm of recentMessagesFormatted) {
      const timeStr = rm.timestamp ? new Date(rm.timestamp).toLocaleTimeString() : "";
      const prefix = `[${rm.role.toUpperCase()}${timeStr ? ` @ ${timeStr}` : ""}]`;
      const toolText = rm.toolCalls ? ` [Called tools: ${rm.toolCalls}]` : "";
      const textPreview = rm.content ? rm.content.replace(/\r?\n/g, " ").slice(0, 140) : "(no text)";
      reportLines.push(`${prefix}${toolText} ${textPreview}`);
    }
  }

  reportLines.push("");
  reportLines.push("=== Suggested Collaboration Next Steps ===");
  if (tasks.inProgress.length > 0) {
    reportLines.push(`- Terminal 1 is currently handling: "${tasks.inProgress[0].text}". Avoid modifying the same files simultaneously.`);
  }
  if (tasks.pending.length > 0) {
    reportLines.push(`- Terminal 2 can take over the next pending task: "${tasks.pending[0].text}".`);
    reportLines.push("- Recommendation: Work in an isolated git branch or git worktree to avoid file lock collisions.");
  } else if (tasks.total > 0 && tasks.completed.length === tasks.total) {
    reportLines.push("- All tasks in this session are already marked completed [x].");
  }

  const formattedReport = reportLines.join("\n");

  let suggestedAction = "Review the tasks above and pick pending tasks to execute in parallel or continue.";
  if (tasks.pending.length > 0) {
    suggestedAction = `Help Terminal 1 by taking on pending task: "${tasks.pending[0].text}"`;
  }

  return {
    found: true,
    sessionId: targetId,
    sessionRecord,
    tasks,
    planContent,
    planFilePath: planFilePath || undefined,
    recentMessages: recentMessagesFormatted,
    firstChat: sessionRecord?.firstChat,
    lastChat: sessionRecord?.lastChat,
    formattedReport,
    suggestedAction,
  };
}

/**
 * Tool: inspect_session
 * Allows any agent tier (Master, Superagent, Subagent) to inspect a peer terminal session.
 */
export const inspectSessionTool: Tool = {
  name: "inspect_session",
  description:
    "Inspect, read, and track another terminal session's progress given a session identifier (e.g., 'Session: sess_...' or 'sess_...'). Retrieves its working directory, task checklist (_task.md), implementation plan, and recent activity so this terminal can assist or take over pending tasks.",
  parameters: {
    type: "object",
    properties: {
      session: {
        type: "string",
        description:
          "The session ID or prompt string (e.g. 'Session: sess_1788744193171_qdfllz', 'sess_1788744193171_qdfllz', a JSON file path, or search query for the session).",
      },
      include_messages: {
        type: "boolean",
        description: "Whether to include recent chat history and tool actions from the target session. Default: true.",
      },
      message_limit: {
        type: "number",
        description: "Number of recent messages to inspect from the session transcript. Default: 8.",
      },
    },
    required: ["session"],
  },
  async execute(args, cwd, signal) {
    const rawSession = (args.session as string) || "";
    if (!rawSession) {
      return "Error: The 'session' parameter is required.";
    }

    const includeMessages = args.include_messages !== false;
    const messageLimit = typeof args.message_limit === "number" ? args.message_limit : 8;

    try {
      const result = await inspectSession(rawSession, {
        includeMessages,
        messageLimit,
      });
      return result.formattedReport;
    } catch (err: any) {
      return `Error inspecting session "${rawSession}": ${err?.message || String(err)}`;
    }
  },
};
