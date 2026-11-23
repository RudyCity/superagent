import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  triggerRequestOsNotification,
  type RequestNotificationInput,
} from "../utils/osNotification";

const invokeMock = vi.fn().mockResolvedValue(undefined);
const isPermissionGrantedMock = vi.fn().mockResolvedValue(true);
const requestPermissionMock = vi.fn().mockResolvedValue("granted");

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => isPermissionGrantedMock(),
  requestPermission: () => requestPermissionMock(),
}));

describe("triggerRequestOsNotification", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    isPermissionGrantedMock.mockClear();
    requestPermissionMock.mockClear();
  });

  it("mengirim notifikasi OS native untuk permintaan akses masuk dan melakukan deduplikasi", async () => {
    const payload: RequestNotificationInput = {
      request_id: "incoming:req_test_1",
      category: "incoming_access",
      source_name: "Gemini MCP",
      target_label: "t-line",
      summary: "Meminta izin (read, write)",
    };

    await triggerRequestOsNotification(payload);
    await triggerRequestOsNotification(payload);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("notify_access_request", { payload });
  });

  it("mengirim notifikasi OS native untuk permintaan aturan aktif", async () => {
    const payload: RequestNotificationInput = {
      request_id: "rule:rule_test_1",
      category: "active_rule",
      source_name: "Gemini MCP",
      target_label: "D:\\backup from pc asus\\Documents Development\\t-line",
      summary: "Aturan aktif (recursive) diminta",
    };

    await triggerRequestOsNotification(payload);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("notify_access_request", { payload });
  });
});
