/**
 * Bounded, process-local observation state for browser/Electron terminal targets.
 * No terminal transcripts, secrets or command arguments are persisted on disk.
 */
import type { TerminalResult } from "./chromeCdpTerminal.js";

export type TerminalPane = TerminalResult["terminals"][number];
export type TerminalSession = {
  targetId: string;
  terminalId: string;
  index: number;
  kind: string;
  selector: string;
  source: string;
  updatedAt: number;
  changedAt: number;
  cursor: number;
  currentText: string;
  agent: string | null;
  recentActions: Array<{ action: string; at: number; dispatched: boolean }>;
  pendingVerification?: { marker: string; at: number };
};

const sessions = new Map<string, TerminalSession>();
const MAX_SESSIONS = 80;
const MAX_SESSION_CHARS = 20000;
const EXPIRE_MS = 30 * 60 * 1000;

export function findCliAgent(text: string): string | null {
  // Avoid claiming a running agent based solely on a historical transcript.
  const recent = text.slice(-1200);
  if (/\bclaude\s+code\b|\bclaude\s+(?:sonnet|opus)\b/i.test(recent)) return "claude-code (signature)";
  if (/\bcodex\b/i.test(recent)) return "codex (signature)";
  if (/\bantigravity\b/i.test(recent)) return "antigravity (signature)";
  if (/\b(?:gemini\s+cli|gemini\s+code)\b/i.test(recent)) return "gemini-cli (signature)";
  if (/\b(?:aider|opencode)\b/i.test(recent)) return "cli-agent (signature)";
  return null;
}

function sessionKey(targetId: string, id: string): string {
  return targetId + "\x00" + id;
}

function prune(): void {
  const now = Date.now();
  for (const [key, state] of sessions) {
    if (now - state.updatedAt > EXPIRE_MS) sessions.delete(key);
  }
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
}

export function appendedTerminalText(oldText: string, newText: string): {
  delta: string;
  reset: boolean;
} {
  if (!oldText) return { delta: newText, reset: false };
  if (oldText === newText) return { delta: "", reset: false };
  if (newText.startsWith(oldText)) return { delta: newText.slice(oldText.length), reset: false };
  // Scrollback windows often overlap after older lines are evicted.
  for (let length = Math.min(oldText.length, newText.length); length > 4; length--) {
    if (oldText.endsWith(newText.slice(0, length))) return { delta: newText.slice(length), reset: false };
  }
  // Snapshot reset, pane recreation or alternate screen: do not claim an append.
  return { delta: newText, reset: true };
}

export function observeTerminal(targetId: string, terminal: TerminalPane): {
  changed: boolean;
  delta: string;
  reset: boolean;
  cursor: number;
  session: TerminalSession;
} {
  prune();
  const id = terminal.terminalId || "index:" + terminal.index;
  const key = sessionKey(targetId, id);
  const previous = sessions.get(key);
  const rawText = terminal.lines.join("\n").slice(-MAX_SESSION_CHARS);
  const { delta, reset } = appendedTerminalText(previous?.currentText || "", rawText);
  const now = Date.now();
  const next: TerminalSession = {
    targetId, terminalId: id, index: terminal.index, kind: terminal.kind,
    selector: terminal.selector, source: terminal.source, updatedAt: now,
    changedAt: delta ? now : (previous?.changedAt || now),
    cursor: delta ? (previous?.cursor || 0) + 1 : (previous?.cursor || 0),
    currentText: rawText, agent: findCliAgent(rawText),
    recentActions: previous?.recentActions || [],
    pendingVerification: previous?.pendingVerification && now - previous.pendingVerification.at < EXPIRE_MS
      ? previous.pendingVerification : undefined,
  };
  sessions.set(key, next);
  return { changed: !!delta, delta: delta.slice(-12000), reset, cursor: next.cursor, session: next };
}

export function recordTerminalAction(
  targetId: string, terminalId: string, action: string, dispatched: boolean
): void {
  const s = sessions.get(sessionKey(targetId, terminalId));
  if (!s) return;
  s.recentActions.push({ action, at: Date.now(), dispatched });
  s.recentActions.splice(0, Math.max(0, s.recentActions.length - 20));
}

export function setPendingTerminalVerification(targetId: string, terminalId: string, marker: string): void {
  const session = sessions.get(sessionKey(targetId, terminalId));
  if (session) session.pendingVerification = { marker, at: Date.now() };
}
export function pendingTerminalVerification(targetId: string, terminalId: string): string | null {
  const item = sessions.get(sessionKey(targetId, terminalId))?.pendingVerification;
  return item && Date.now() - item.at < EXPIRE_MS ? item.marker : null;
}
export function clearPendingTerminalVerification(targetId: string, terminalId: string): void {
  const item = sessions.get(sessionKey(targetId, terminalId));
  if (item) delete item.pendingVerification;
}

export function getTerminalSessions(): Array<Omit<TerminalSession, "currentText" | "pendingVerification"> & { outputChars: number; awaitingCompletion: boolean }> {
  prune();
  return Array.from(sessions.values()).map(({ currentText, pendingVerification, ...s }) =>
    ({ ...s, outputChars: currentText.length, awaitingCompletion: !!pendingVerification }));
}

export function clearTerminalSessions(targetId?: string): void {
  if (!targetId) { sessions.clear(); return; }
  for (const [key, s] of sessions) if (s.targetId === targetId) sessions.delete(key);
}

const HAZARD_RULES = [
  /(?:^|\s)(?:rm\s+-[\w]*r[\w]*f|rm\s+-[\w]*f[\w]*r|rmdir\s+\/s|del\s+\/s|format\s+[a-z]:|diskpart|mkfs\b|dd\s+if=)/i,
  /(?:^|\s)(?:git\s+(?:reset\s+--hard|clean\s+-f|push\s+--force)|docker\s+(?:system\s+prune|volume\s+prune))\b/i,
  /(?:^|\s)(?:shutdown|reboot|poweroff)\b/i,
];
export function terminalCommandRisk(text: string): { blocked: boolean; reason: string } {
  const value = text.trim();
  if (!value) return { blocked: true, reason: "Empty command." };
  if (/[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(text)) return { blocked: true, reason: "Multiline/control characters are not allowed." };
  if (HAZARD_RULES.some((pattern) => pattern.test(value))) {
    return { blocked: true, reason: "Potentially destructive shell command. Explicit allow_dangerous:true is required." };
  }
  return { blocked: false, reason: "" };
}
