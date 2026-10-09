import { useEffect, useState } from "react";
import { checkVisionServerHealth } from "../core/tools/chromeVisionTools.js";

export function useVisionStatus(pollIntervalMs = 5000): boolean {
  const [isActive, setIsActive] = useState<boolean>(false);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const healthy = await checkVisionServerHealth();
        if (mounted) setIsActive(Boolean(healthy));
      } catch {
        if (mounted) setIsActive(false);
      }
    };

    check();
    const interval = setInterval(check, pollIntervalMs);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [pollIntervalMs]);

  return isActive;
}
