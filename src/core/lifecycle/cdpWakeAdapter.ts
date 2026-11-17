/**
 * Optional outbound CDP notification: never executes the scheduled task.
 * The approved ChatGPT tab receives a wake-up notice and its MCP worker must
 * independently claim/complete work using its own project grants.
 * Any uncertain send is never silently retried.
 */
import { delegateBridge } from "../delegate/bridge.js";
import { withSemanticDelegateTarget } from "../tools/delegateTools.js";
import {
  listCdpWakeCandidates, reserveCdpWake, settleCdpWake,
  type CdpWakeCandidate,
} from "./externalLifecycle.js";

const TAB_URL = /^https:\/\/chatgpt\.com(?:\/|$)/;
type TabInfo = { tabId: number; url: string; title: string; ready: boolean; status: string };
type TabList = { tabs: TabInfo[]; total: number };
function exactTab(list: TabList, tabId: number): TabInfo | undefined {
  return list.tabs.find(tab => tab.tabId === tabId && TAB_URL.test(tab.url)
    && tab.ready === true && tab.status === "idle");
}
async function readTabs(clientId: string): Promise<TabList> {
  const raw = await delegateBridge.request("delegate.list_tabs", {}, undefined, 10_000, clientId);
  const result: unknown = JSON.parse(raw);
  if (!result || typeof result !== "object" || !Array.isArray((result as any).tabs)) {
    throw new Error("Delegate did not confirm ChatGPT tab inventory.");
  }
  return result as TabList;
}
/** Only paired, idle ChatGPT tabs are offered to the focused native Tray operator. */
export async function listApprovedCdpTargets(): Promise<Array<{ clientId: string; label: string; tabs: TabInfo[] }>> {
  const output: Array<{ clientId: string; label: string; tabs: TabInfo[] }> = [];
  for (const connection of delegateBridge.listConnections()) {
    try {
      const inventory = await readTabs(connection.clientId);
      output.push({
        clientId: connection.clientId, label: connection.label,
        tabs: inventory.tabs.filter(tab => exactTab(inventory, tab.tabId)).map(tab => ({
          tabId: tab.tabId, url: tab.url, title: tab.title, ready: tab.ready, status: tab.status,
        })),
      });
    } catch {
      output.push({ clientId: connection.clientId, label: connection.label, tabs: [] });
    }
  }
  return output;
}
export async function verifyApprovedCdpTarget(clientId: string, tabId: number): Promise<void> {
  if (!delegateBridge.listConnections().some(c => c.clientId === clientId)) {
    throw new Error("The selected paired Chrome Delegate profile is offline.");
  }
  const inventory = await readTabs(clientId);
  if (!exactTab(inventory, tabId)) {
    throw new Error("Selected ChatGPT tab is not verified idle/ready; no CDP binding was created.");
  }
}
let draining = false;
/** Called by the host-owned daemon scheduler; single-flight + durable per-stage reservations. */
export async function dispatchCdpWakeNotifications(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const online = new Set(delegateBridge.listConnections().map(c => c.clientId));
    const candidates = listCdpWakeCandidates().filter(c => online.has(c.clientId));
    for (const candidate of candidates) {
      try {
        await verifyApprovedCdpTarget(candidate.clientId, candidate.tabId);
      } catch {
        // Offline/busy/unverified is not a delivery attempt. Leave task queued.
        continue;
      }
      const reserved = reserveCdpWake(candidate);
      if (!reserved) continue;
      await dispatchOne(reserved);
    }
  } finally { draining = false; }
}
async function dispatchOne(job: CdpWakeCandidate & { requestId: string }) {
  const message = [
    "SuperAgent scheduled external delegation is ready.",
    "Worker: " + job.workerId,
    "Workflow: " + job.workflowId,
    "Run: " + job.runId,
    "Step: " + job.stepId,
    "",
    "If you opted in as this worker, use your approved SuperAgent MCP connection.",
    "Call superagent_lifecycle(action=worker.claim, workerId=" + job.workerId + ")",
    "to receive the scoped instructions and lease. Do not act before claiming.",
    "If you reconnected, first resume the worker using your privately held resume token.",
    "When finished, return your result with worker.complete and the lease proof.",
    "This does not grant any access to internal SuperAgent agents.",
  ].join("\n");
  const params = { tabId: job.tabId, message };
  try {
    await withSemanticDelegateTarget("delegate.send_message", job.clientId, job.tabId, false,
      async clientId => delegateBridge.executeOnce(job.requestId, "delegate.send_message",
        clientId, params, () => delegateBridge.request(
          "delegate.send_message", params, undefined, 45_000, clientId)));
    settleCdpWake(job, true);
  } catch (error) {
    // Failed/timeout transport may have delivered the message. Never replay
    // without explicit operator reconciliation. The queued task remains claimable.
    settleCdpWake(job, false, error instanceof Error ? error.message : "Delivery uncertain");
  }
}
