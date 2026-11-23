import React, { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  triggerRequestOsNotification,
  type RequestCategory,
} from "../utils/osNotification";

export interface IncomingAccessRequest {
  id: string;
  connectionName: string;
  projectId: string;
  projectPath: string;
  capabilities: string[];
  reason: string;
  createdAt: number;
}

export interface ActiveRuleRequest {
  id: string;
  connectionName: string;
  projectId?: string;
  targetPath: string;
  accessMode: "read" | "write" | "execute" | "recursive";
  reason: string;
  createdAt: number;
}

interface RequestCenterPanelProps {
  incomingRequests: IncomingAccessRequest[];
  activeRuleRequests: ActiveRuleRequest[];
  onApproveIncoming: (id: string, mode: "once" | "always") => Promise<void>;
  onDenyIncoming: (id: string) => Promise<void>;
  onApproveRule: (id: string, permanent: boolean) => Promise<void>;
  onDenyRule: (id: string) => Promise<void>;
}

export const RequestCenterPanel: React.FC<RequestCenterPanelProps> = ({
  incomingRequests,
  activeRuleRequests,
  onApproveIncoming,
  onDenyIncoming,
  onApproveRule,
  onDenyRule,
}) => {
  const [activeSubTab, setActiveSubTab] =
    useState<RequestCategory>("incoming_access");

  const totalPending = incomingRequests.length + activeRuleRequests.length;

  useEffect(() => {
    for (const req of incomingRequests) {
      void triggerRequestOsNotification({
        request_id: `incoming:${req.id}`,
        category: "incoming_access",
        source_name: req.connectionName || "MCP Client",
        target_label: req.projectId,
        summary: `Meminta izin (${req.capabilities.join(", ")})`,
      });
    }
  }, [incomingRequests]);

  useEffect(() => {
    for (const rule of activeRuleRequests) {
      void triggerRequestOsNotification({
        request_id: `rule:${rule.id}`,
        category: "active_rule",
        source_name: rule.connectionName || "MCP Client",
        target_label: rule.targetPath,
        summary: `Aturan aktif (${rule.accessMode}) diminta`,
      });
    }
  }, [activeRuleRequests]);

  useEffect(() => {
    const unlisten = listen<RequestCategory | null>(
      "access-manager://focus-request-center",
      (event) => {
        if (event.payload === "incoming_access" || event.payload === "active_rule") {
          setActiveSubTab(event.payload);
        }
      }
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const badgeCounts = useMemo(
    () => ({
      incoming: incomingRequests.length,
      rules: activeRuleRequests.length,
    }),
    [incomingRequests.length, activeRuleRequests.length]
  );

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between border-b border-zinc-800 pb-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">
            Pusat Permintaan
          </h2>
          <p className="text-xs text-zinc-400">
            Kelola permintaan akses proyek masuk dan persetujuan aturan aktif host secara terpusat.
          </p>
        </div>
        <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-300">
          {totalPending} Menunggu
        </span>
      </header>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setActiveSubTab("incoming_access")}
          className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
            activeSubTab === "incoming_access"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          }`}
        >
          <span>Permintaan Akses Masuk</span>
          <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[11px]">
            {badgeCounts.incoming}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveSubTab("active_rule")}
          className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
            activeSubTab === "active_rule"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          }`}
        >
          <span>Permintaan Aturan Aktif</span>
          <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[11px]">
            {badgeCounts.rules}
          </span>
        </button>
      </div>

      {activeSubTab === "incoming_access" && (
        <div className="space-y-2.5">
          {incomingRequests.length === 0 ? (
            <p className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4 text-xs text-zinc-400">
              Tidak ada permintaan akses masuk yang tertunda.
            </p>
          ) : (
            incomingRequests.map((req) => (
              <div
                key={req.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-zinc-100">
                    {req.projectId}{" "}
                    <span className="font-normal text-zinc-400">
                      • dari {req.connectionName}
                    </span>
                  </div>
                  <span className="text-[11px] text-zinc-500">
                    {req.projectPath}
                  </span>
                </div>
                <p className="text-xs text-zinc-300">{req.reason}</p>
                <div className="flex flex-wrap gap-1.5">
                  {req.capabilities.map((cap) => (
                    <span
                      key={cap}
                      className="rounded bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-300"
                    >
                      {cap}
                    </span>
                  ))}
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void onDenyIncoming(req.id)}
                    className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Tolak
                  </button>
                  <button
                    type="button"
                    onClick={() => void onApproveIncoming(req.id, "once")}
                    className="rounded-md bg-zinc-700 px-2.5 py-1 text-xs text-white hover:bg-zinc-600"
                  >
                    Izinkan Sekali
                  </button>
                  <button
                    type="button"
                    onClick={() => void onApproveIncoming(req.id, "always")}
                    className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500"
                  >
                    Selalu Izinkan
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeSubTab === "active_rule" && (
        <div className="space-y-2.5">
          {activeRuleRequests.length === 0 ? (
            <p className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4 text-xs text-zinc-400">
              Tidak ada permintaan aturan aktif yang tertunda.
            </p>
          ) : (
            activeRuleRequests.map((rule) => (
              <div
                key={rule.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-zinc-100">
                    Aturan Path / Eksekusi{" "}
                    <span className="font-normal text-zinc-400">
                      • {rule.connectionName}
                    </span>
                  </div>
                  <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
                    {rule.accessMode}
                  </span>
                </div>
                <div className="rounded bg-zinc-950 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200">
                  {rule.targetPath}
                </div>
                <p className="text-xs text-zinc-300">{rule.reason}</p>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void onDenyRule(rule.id)}
                    className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Tolak
                  </button>
                  <button
                    type="button"
                    onClick={() => void onApproveRule(rule.id, false)}
                    className="rounded-md bg-zinc-700 px-2.5 py-1 text-xs text-white hover:bg-zinc-600"
                  >
                    Izinkan Sesi Ini
                  </button>
                  <button
                    type="button"
                    onClick={() => void onApproveRule(rule.id, true)}
                    className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500"
                  >
                    Simpan ke Aturan Aktif
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
};
