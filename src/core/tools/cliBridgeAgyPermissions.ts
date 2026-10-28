/**
 * Interpret bounded AGY print-mode output without treating process exit 0
 * as proof that a requested tool action was authorized or completed.
 * Never retry a denied action, downgrade permissions or enable full-auto.
 */
export type AgyBridgeSignal = {
  modeWarning?: string;
  permissionDenied?: string;
};

export function inspectAgyBridgeLine(line: string): AgyBridgeSignal {
  const trimmed = line.trim();
  if (/^warning:\s*--mode\s+\S+\s+is not available for this account/i.test(trimmed)) {
    return { modeWarning: "Requested AGY execution mode is unavailable for this account; AGY fell back to request-review. Headless permissions may be denied." };
  }
  if (/^(?:jetski:|agy:).*no output produced.*(?:permission|auto-denied)/i.test(trimmed)) {
    return { permissionDenied: "AGY headless execution could not obtain required tool approval." };
  }
  if (/permission check failed|user denied permission|permission.*auto-?denied|denied.*permission|action rejected by permission policy/i.test(trimmed)) {
    return { permissionDenied: `AGY tool execution blocked by permission check: ${trimmed.slice(0, 200)}` };
  }
  if (!trimmed.startsWith("{") || trimmed.length > 65536) return {};
  try {
    const event = JSON.parse(trimmed) as Record<string, any>;
    if (event.event === "result" && Array.isArray(event.result?.denied_actions) && event.result.denied_actions.length) {
      const firstAction = event.result.denied_actions[0];
      const desc = typeof firstAction === "string" ? firstAction : JSON.stringify(firstAction);
      return { permissionDenied: `AGY reported denied_actions in its final result: ${desc}` };
    }
    if (event.event === "step_update" && event.step_update?.state === "ERROR") {
      const details = event.step_update?.tool_info?.error;
      const message = String(details?.message ?? "");
      if (/permission check failed|user denied permission|permission.*auto-?denied|denied.*permission|action rejected by permission policy/i.test(message)) {
        const toolName = event.step_update?.tool_info?.name ? ` for tool '${event.step_update.tool_info.name}'` : "";
        return { permissionDenied: `AGY reported a denied tool permission${toolName}: ${message}` };
      }
    }
  } catch { /* Untrusted/non-JSON output is not a status signal. */ }
  return {};
}

export function inspectAgyBridgeOutput(output: string): AgyBridgeSignal {
  const aggregate: AgyBridgeSignal = {};
  for (const line of output.split(/\r?\n/)) {
    const signal = inspectAgyBridgeLine(line);
    if (signal.modeWarning) aggregate.modeWarning = signal.modeWarning;
    if (signal.permissionDenied) aggregate.permissionDenied = signal.permissionDenied;
  }
  return aggregate;
}

export const AGY_PERMISSION_RECOVERY =
  "Permission blocked. Configure narrowly scoped AGY permissions.allow rules in AGY settings and explicitly approve needed actions, then start a fresh delegation. " +
  "Headless request-review cannot prompt. Never automatically retry a denied tool or escalate to full-auto; only use unrestricted permissions with separate explicit user authorization.";
