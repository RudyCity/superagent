/**
 * Dedicated observer: runs independently of a channel host, so an owner crash
 * does not silence the watchdog. Observes only identity-verified loopback
 * health; never takes a listener, MCP tunnel, lease, or replay lock.
 */
import { MuseIncidentCenter } from "../remoteAgent/museIncidentCenter.js";
export async function observeIndependentChannelHost(
  center: MuseIncidentCenter, verifyOwner: () => Promise<boolean>,
  now = Date.now(),
): Promise<boolean> {
  let online = false;
  try { online = await verifyOwner(); } catch { online = false; }
  center.observeHost(online, now);
  return online;
}
