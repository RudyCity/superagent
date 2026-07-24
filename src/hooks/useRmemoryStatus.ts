

import { useEffect, useState } from "react";
import { getSettings } from "../core/config/jsonConfig.js";

export type RmemoryStatus = "online" | "offline" | "checking" | "disabled";

export function useRmemoryStatus(): RmemoryStatus {
  const getInitialStatus = (): RmemoryStatus => {
    try {
      const settings = getSettings();
      return settings?.enableRmemory ? "online" : "disabled";
    } catch {
      return "disabled";
    }
  };

  const [status, setStatus] = useState<RmemoryStatus>(getInitialStatus);

  useEffect(() => {
    setStatus(getInitialStatus());
  }, []);

  return status;
}

