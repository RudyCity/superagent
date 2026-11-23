import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

export type RequestCategory = "incoming_access" | "active_rule";

export interface RequestNotificationInput {
  request_id: string;
  category: RequestCategory;
  source_name: string;
  target_label: string;
  summary: string;
}

const notifiedRequestIds = new Set<string>();

export async function ensureOsNotificationPermission(): Promise<boolean> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === "granted";
    }
    return granted;
  } catch {
    return false;
  }
}

export async function triggerRequestOsNotification(
  payload: RequestNotificationInput
): Promise<void> {
  if (notifiedRequestIds.has(payload.request_id)) return;
  notifiedRequestIds.add(payload.request_id);

  await ensureOsNotificationPermission();
  await invoke("notify_access_request", { payload });
}
