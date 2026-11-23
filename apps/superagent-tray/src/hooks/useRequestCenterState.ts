import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ActiveRuleRequest,
  IncomingAccessRequest,
} from "../components/RequestCenterPanel";

export interface UseRequestCenterStateOptions {
  apiBaseUrl?: string;
  pollIntervalMs?: number;
}

export function useRequestCenterState(options: UseRequestCenterStateOptions = {}) {
  const apiBaseUrl = options.apiBaseUrl ?? "http://127.0.0.1:7888";
  const pollIntervalMs = options.pollIntervalMs ?? 3000;

  const [incomingRequests, setIncomingRequests] = useState<IncomingAccessRequest[]>([]);
  const [activeRuleRequests, setActiveRuleRequests] = useState<ActiveRuleRequest[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const refreshRequests = useCallback(async () => {
    try {
      const [incomingRes, ruleRes] = await Promise.all([
        fetch(`${apiBaseUrl}/api/access-manager/requests/incoming`).catch(() => null),
        fetch(`${apiBaseUrl}/api/access-manager/requests/rules`).catch(() => null),
      ]);

      if (incomingRes && incomingRes.ok) {
        const data = await incomingRes.json();
        setIncomingRequests(Array.isArray(data?.requests) ? data.requests : []);
      }

      if (ruleRes && ruleRes.ok) {
        const data = await ruleRes.json();
        setActiveRuleRequests(Array.isArray(data?.requests) ? data.requests : []);
      }
    } catch {
      // Abaikan error sementara saat polling
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    setLoading(true);
    void refreshRequests().finally(() => setLoading(false));

    const timer = window.setInterval(() => {
      void refreshRequests();
    }, pollIntervalMs);

    const unlistenNew = listen("access-manager://new-request", () => {
      void refreshRequests();
    });

    return () => {
      window.clearInterval(timer);
      void unlistenNew.then((fn) => fn());
    };
  }, [pollIntervalMs, refreshRequests]);

  const approveIncoming = useCallback(
    async (id: string, mode: "once" | "always") => {
      await fetch(`${apiBaseUrl}/api/access-manager/requests/incoming/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      await refreshRequests();
    },
    [apiBaseUrl, refreshRequests]
  );

  const denyIncoming = useCallback(
    async (id: string) => {
      await fetch(`${apiBaseUrl}/api/access-manager/requests/incoming/${encodeURIComponent(id)}/deny`, {
        method: "POST",
      });
      await refreshRequests();
    },
    [apiBaseUrl, refreshRequests]
  );

  const approveRule = useCallback(
    async (id: string, permanent: boolean) => {
      await fetch(`${apiBaseUrl}/api/access-manager/requests/rules/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permanent }),
      });
      await refreshRequests();
    },
    [apiBaseUrl, refreshRequests]
  );

  const denyRule = useCallback(
    async (id: string) => {
      await fetch(`${apiBaseUrl}/api/access-manager/requests/rules/${encodeURIComponent(id)}/deny`, {
        method: "POST",
      });
      await refreshRequests();
    },
    [apiBaseUrl, refreshRequests]
  );

  const openCenter = useCallback(async (category?: "incoming_access" | "active_rule") => {
    await invoke("open_request_center", { category: category ?? null });
  }, []);

  return {
    incomingRequests,
    activeRuleRequests,
    loading,
    refreshRequests,
    approveIncoming,
    denyIncoming,
    approveRule,
    denyRule,
    openCenter,
  };
}
