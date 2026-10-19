import {
  clearOpenAiMcpTunnelConfigField,
  getOpenAiMcpTunnelConfigStatus,
  setOpenAiMcpTunnelApiKey,
  setOpenAiMcpTunnelId,
} from "./openaiMcpTunnelConfig.js";

export interface OpenAiMcpTunnelConfigCommandResult {
  success: boolean;
  message: string;
}

/** Executes the provider-neutral config subcommands; never returns a secret value. */
export function runOpenAiMcpTunnelConfigCommand(args: string[]): OpenAiMcpTunnelConfigCommandResult {
  const action = (args[0] || "status").toLowerCase();
  const value = args[1];

  try {
    if (action === "status" || action === "show") {
      const status = getOpenAiMcpTunnelConfigStatus();
      const runtimeKeySource = process.env.CONTROL_PLANE_API_KEY?.trim()
        ? "environment variable CONTROL_PLANE_API_KEY is set"
        : status.apiKeyConfigured
          ? `saved encrypted key is configured (${status.apiKeyHint})`
          : "not configured";
      const tunnelId = status.tunnelId || "(not saved)";
      return {
        success: true,
        message: [
          "OpenAI Secure MCP Tunnel configuration",
          `- Saved Tunnel ID : ${tunnelId}`,
          `- Saved runtime key: ${runtimeKeySource}`,
          `- OPENAI_MCP_TUNNEL_ID env: ${process.env.OPENAI_MCP_TUNNEL_ID?.trim() ? "set" : "not set"}`,
          `- CONTROL_PLANE_TUNNEL_ID env: ${process.env.CONTROL_PLANE_TUNNEL_ID?.trim() ? "set (legacy)" : "not set"}`,
          "",
          "Actions: set-id <id>, set-key-env, set-key <runtime-api-key>, clear-id, clear-key, clear",
        ].join("\n"),
      };
    }

    if (action === "set-id" || action === "set-tunnel-id") {
      if (!value) return { success: false, message: "Missing tunnel ID. Usage: mcp tunnel config set-id <tunnel-id>" };
      const id = setOpenAiMcpTunnelId(value);
      return { success: true, message: `Saved OpenAI Tunnel ID: ${id}` };
    }

    if (action === "set-key-env") {
      const envKey = process.env.CONTROL_PLANE_API_KEY?.trim();
      if (!envKey) {
        return { success: false, message: "CONTROL_PLANE_API_KEY is not set in this SuperAgent process. Set it in the environment, then run config set-key-env." };
      }
      setOpenAiMcpTunnelApiKey(envKey);
      return { success: true, message: "OpenAI runtime API key copied from CONTROL_PLANE_API_KEY and saved encrypted. The key value was not displayed." };
    }

    if (action === "set-key" || action === "set-api-key") {
      if (!value) {
        return {
          success: false,
          message: "Missing runtime API key. Usage: mcp tunnel config set-key <key>. Use a key with Tunnels Read + Use permission. The value is encrypted at rest and never echoed.",
        };
      }
      setOpenAiMcpTunnelApiKey(value);
      return { success: true, message: "OpenAI runtime API key saved encrypted. The key value was not displayed." };
    }

    if (action === "clear-id") {
      clearOpenAiMcpTunnelConfigField("tunnelId");
      return { success: true, message: "Saved OpenAI Tunnel ID cleared. Environment variables, if set, still take precedence." };
    }

    if (action === "clear-key") {
      clearOpenAiMcpTunnelConfigField("apiKey");
      return { success: true, message: "Saved OpenAI runtime API key cleared. CONTROL_PLANE_API_KEY, if set, still takes precedence." };
    }

    if (action === "clear") {
      clearOpenAiMcpTunnelConfigField("all");
      return { success: true, message: "Saved OpenAI MCP Tunnel configuration cleared. Environment variables, if set, still take precedence." };
    }

    return {
      success: false,
      message: `Unknown OpenAI tunnel config action "${action}". Use status, set-id, set-key-env, set-key, clear-id, clear-key, or clear.`,
    };
  } catch (error) {
    return {
      success: false,
      message: `OpenAI tunnel configuration failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
