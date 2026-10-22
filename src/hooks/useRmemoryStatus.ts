

import { useEffect, useState } from "react";
import { getRMemoryDiagnostics } from "../core/rmemoryUtil.js";

export type RmemoryStatus = "online" | "offline" | "checking" | "disabled";

export function readRmemoryStatus(): RmemoryStatus {
  try {
    const health = getRMemoryDiagnostics();
    if (!health.enabled) return "disabled";
    if (health.degraded) return "offline";
    return health.indexReady ? "online" : "checking";
  } catch {
    return "offline";
  }
}

export function useRmemoryStatus(): RmemoryStatus {
  const [status, setStatus] = useState<RmemoryStatus>(readRmemoryStatus);
  useEffect(() => {
    const refresh = () => setStatus(readRmemoryStatus());
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);
  return status;
}

