/**
 * Phase 4n: private-loopback, read-only incident dashboard.
 * Only fixed enums, numbers and generated hex incident IDs are rendered.
 * No credentials, workspace paths, batch IDs or payloads are accepted.
 */
import type { Incident, IncidentSummary } from "../remoteAgent/museIncidentCenter.js";
export function renderMuseIncidentDashboard(summary: IncidentSummary, incidents: Incident[]): string {
  const rows = incidents.slice(-50).reverse().map(i => {
    const ago = new Date(i.updatedAt).toISOString();
    return "<tr><td><code>" + i.id + "</code></td><td>" + i.kind +
      "</td><td>" + i.condition + "</td><td>" + i.status +
      "</td><td>" + ago + "</td></tr>";
  }).join("");
  const cell = (label: string, value: number) =>
    "<div class=\"metric\"><span>" + label + "</span><strong>" + value + "</strong></div>";
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"refresh\" content=\"15\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>Muse Recovery Incidents</title><style>" +
    "*{box-sizing:border-box}body{margin:0;background:#101521;color:#e7eaf0;font:15px system-ui,Arial,sans-serif}" +
    "main{max-width:1100px;margin:auto;padding:38px 25px}header{display:flex;justify-content:space-between;align-items:center;gap:15px}" +
    "h1{font-size:25px;margin:0}p,small{color:#9ca9bf}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:28px 0}" +
    ".metric{border:1px solid #293447;background:#1a2433;border-radius:13px;padding:18px;display:flex;flex-direction:column;gap:12px}" +
    ".metric span{color:#aab4c4}.metric strong{font-size:32px}.scroll{overflow-x:auto;border:1px solid #293447;border-radius:13px}" +
    "table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:15px;border-bottom:1px solid #293447}" +
    "th{color:#9ba9bd}code{font-size:12px}a{color:#a5c3ff}footer{margin-top:18px}</style></head><body><main>" +
    "<header><h1>Muse Recovery Incidents</h1><small>Owner port " + summary.port +
    " · Local-only · Auto-refresh 15s</small></header>" +
    "<p>Sanitized operational status. Acknowledgement never resolves an incident or resumes a tool.</p>" +
    "<section class=\"metrics\">" +
    cell("Open", summary.open) + cell("Acknowledged", summary.acknowledged) +
    cell("Resolved", summary.resolved) + cell("Queued", summary.pending) +
    cell("Sent", summary.sent) + "</section>" +
    "<h2>Incident history</h2><div class=\"scroll\"><table><thead><tr>" +
    "<th>Incident ID</th><th>Type</th><th>Condition</th><th>Status</th><th>Last update</th>" +
    "</tr></thead><tbody>" + (rows || "<tr><td colspan=\"5\">No incidents recorded</td></tr>") +
    "</tbody></table></div><footer><small>Read-only. For ACK use the guarded CLI command. " +
    "The incident log is local and is not independently tamper-proof.</small></footer></main></body></html>";
}
