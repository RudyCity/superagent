import { resolveCarriageReturns } from "./text.js";

/**
 * Bound only the dashboard's in-memory live representation. Agent/session logs
 * are stored separately and must not be truncated by this helper.
 */
export const MAX_DASHBOARD_LIVE_LOG_CHARS = 64 * 1024;
const TRUNCATION_NOTICE = "\n[older live output omitted from dashboard]\n";
const KNOWN_TAG = /^\[(?:AGENT|MASTER|USER|TOOL START|TOOL END|ERROR|AUTO-APPROVE|QUESTION)\]/;

/**
 * Carriage-return cleanup has to run on bounded text: cleaning the entire
 * growing output after every token is quadratic and can starve CLI input.
 */
export function normalizeDashboardLiveLog(value: string): string {
  if (value.length <= MAX_DASHBOARD_LIVE_LOG_CHARS) {
    return resolveCarriageReturns(value);
  }

  const tag = value.match(KNOWN_TAG)?.[0] || "";
  const keep = MAX_DASHBOARD_LIVE_LOG_CHARS - tag.length - TRUNCATION_NOTICE.length;
  return resolveCarriageReturns(tag + TRUNCATION_NOTICE + value.slice(-keep));
}

export function appendDashboardLiveLog(previous: string, fragment: string): string {
  // Previous is already bounded; huge tool fragments are bounded before CR
  // normalization too, so one event cannot stall the terminal.
  return normalizeDashboardLiveLog(previous + fragment);
}
