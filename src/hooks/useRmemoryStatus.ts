

import { useEffect, useState } from "react";
import { getSettings } from "../core/config.js";

export type RmemoryStatus = "online" | "offline" | "checking" | "disabled";

export function useRmemoryStatus(): RmemoryStatus {
  const [status, setStatus] = useState<RmemoryStatus>("checking");

  useEffect(() => {
    try {
      const settings = getSettings();
      if (settings.enableRmemory) {
        setStatus("online");
      } else {
        setStatus("disabled");
      }
    } catch {
      setStatus("disabled");
    }
  }, []);

  return status;
}
