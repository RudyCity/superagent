import { useState, useEffect } from "react";
import { getSettings } from "../core/config/jsonConfig.js";
import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";
export function useTencentdbStatus() {
    const settings = getSettings();
    const enableTencentdbMemory = settings.enableTencentdbMemory;
    const gatewayUrl = settings.tencentdbGatewayUrl;
    const apiKey = settings.tencentdbGatewayApiKey;
    const serviceId = settings.tencentdbServiceId;
    const [status, setStatus] = useState(enableTencentdbMemory ? "checking" : "disabled");
    useEffect(() => {
        let active = true;
        let timer = null;
        const checkHealth = async () => {
            const s = getSettings();
            if (!s.enableTencentdbMemory) {
                if (active)
                    setStatus("disabled");
                return;
            }
            if (active)
                setStatus("checking");
            const endpoint = s.tencentdbGatewayUrl || "http://127.0.0.1:8420";
            const client = new MemoryClient({
                endpoint,
                apiKey: s.tencentdbGatewayApiKey || "sk-xxxx",
                serviceId: s.tencentdbServiceId || "default",
            });
            try {
                const checkPromise = client.listScenarios({});
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1500));
                await Promise.race([checkPromise, timeoutPromise]);
                if (active)
                    setStatus("online");
            }
            catch {
                if (active)
                    setStatus("offline");
            }
        };
        checkHealth();
        // Read polling interval from settings (default 30s, minimum 5s)
        const settings2 = getSettings();
        const pollMs = Math.max(5000, (settings2.tencentdbPollIntervalMs || 30000));
        timer = setInterval(checkHealth, pollMs);
        return () => {
            active = false;
            if (timer)
                clearInterval(timer);
        };
    }, [enableTencentdbMemory, gatewayUrl, apiKey, serviceId]);
    return status;
}
//# sourceMappingURL=useTencentdbStatus.js.map