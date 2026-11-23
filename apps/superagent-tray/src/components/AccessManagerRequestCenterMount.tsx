import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RequestCenterPanel } from "./components/RequestCenterPanel";
import { useRequestCenterState } from "./hooks/useRequestCenterState";
import { ensureOsNotificationPermission } from "./utils/osNotification";

export type AccessManagerTab =
  | "request_center"
  | "project_access"
  | "active_rules";

export interface AccessManagerRequestCenterMountProps {
  apiBaseUrl?: string;
  defaultTab?: AccessManagerTab;
  renderProjectAccessTab?: () => React.ReactNode;
  renderActiveRulesTab?: () => React.ReactNode;
}

/**
 * Wrapper siap-pasang untuk Access Manager di SuperAgent Tray yang menyatukan:
 * 1. Pusat Permintaan (Permintaan Akses Masuk + Permintaan Aturan Aktif)
 * 2. Akses Proyek
 * 3. Aturan Aktif
 * Serta sinkronisasi notifikasi OS native Windows, Linux, dan macOS.
 */
export const AccessManagerRequestCenterMount: React.FC<
  AccessManagerRequestCenterMountProps
> = ({
  apiBaseUrl,
  defaultTab = "request_center",
  renderProjectAccessTab,
  renderActiveRulesTab,
}) => {
  const [activeTab, setActiveTab] = useState<AccessManagerTab>(defaultTab);

  const {
    incomingRequests,
    activeRuleRequests,
    loading,
    refreshRequests,
    approveIncoming,
    denyIncoming,
    approveRule,
    denyRule,
  } = useRequestCenterState({ apiBaseUrl });

  const totalPending = incomingRequests.length + activeRuleRequests.length;

  useEffect(() => {
    void ensureOsNotificationPermission();
  }, []);

  useEffect(() => {
    const unlisten = listen("access-manager://focus-request-center", () => {
      setActiveTab("request_center");
      void refreshRequests();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshRequests]);

  const handleTestOsNotification = async () => {
    await invoke("notify_access_request", {
      payload: {
        request_id: `test:${Date.now()}`,
        category: "incoming_access",
        source_name: "SuperAgent Tray",
        target_label: "Pusat Permintaan",
        summary: "Uji notifikasi desktop lintas OS aktif",
      },
    });
  };

  return (
    <div className="flex flex-col gap-4 text-zinc-100">
      <nav className="flex items-center justify-between border-b border-zinc-800 pb-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("request_center")}
            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              activeTab === "request_center"
                ? "bg-emerald-600 text-white"
                : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            <span>Pusat Permintaan</span>
            <span className="rounded-full bg-black/30 px-1.5 py-0.5 text-[11px]">
              {totalPending}
            </span>
          </button>

          {renderProjectAccessTab && (
            <button
              type="button"
              onClick={() => setActiveTab("project_access")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                activeTab === "project_access"
                  ? "bg-zinc-800 text-white"
                  : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              }`}
            >
              Akses Proyek
            </button>
          )}

          {renderActiveRulesTab && (
            <button
              type="button"
              onClick={() => setActiveTab("active_rules")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                activeTab === "active_rules"
                  ? "bg-zinc-800 text-white"
                  : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              }`}
            >
              Aturan Aktif
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refreshRequests()}
            disabled={loading}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading ? "Memuat..." : "Muat Ulang"}
          </button>
          <button
            type="button"
            onClick={() => void handleTestOsNotification()}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          >
            Tes Notif OS
          </button>
        </div>
      </nav>

      {activeTab === "request_center" && (
        <RequestCenterPanel
          incomingRequests={incomingRequests}
          activeRuleRequests={activeRuleRequests}
          onApproveIncoming={approveIncoming}
          onDenyIncoming={denyIncoming}
          onApproveRule={approveRule}
          onDenyRule={denyRule}
        />
      )}

      {activeTab === "project_access" && renderProjectAccessTab?.()}
      {activeTab === "active_rules" && renderActiveRulesTab?.()}
    </div>
  );
};
