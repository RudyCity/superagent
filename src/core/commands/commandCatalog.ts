/**
 * Canonical command-domain metadata for command help and contextual suggestions.
 *
 * Keep cross-domain options out of another domain's tree. Runtime handlers remain
 * responsible for validation; this catalog drives discoverability and help text.
 */
export type CommandDomain = "muse" | "telegram" | "mcp" | "server";

export const COMMAND_DOMAIN_DESCRIPTIONS: Record<CommandDomain, string> = {
  muse: "Coordinate remote Muse tasks, watch sessions, and Muse WebSocket connectivity.",
  telegram: "Manage the direct Telegram bot/group integration independently of Muse task steering.",
  mcp: "Manage Model Context Protocol servers and MCP tunnel providers.",
  server: "Manage SuperAgent's REST/SSE server exposure.",
};

export const MUSE_TUNNEL_SUGGESTIONS = [
  "/muse tunnel list",
  "/muse tunnel start",
  "/muse tunnel restart",
  "/muse tunnel status",
  "/muse tunnel stop",
  "/muse tunnel stop all",
  "/muse tunnel doctor",
  "/muse tunnel prompt",
  "/muse tunnel guide",
];

export const TELEGRAM_SUGGESTIONS = [
  "/telegram status",
  "/telegram doctor",
  "/telegram send",
  "/telegram config",
  "/telegram fallback status",
  "/telegram fallback start",
  "/telegram fallback stop",
];

/** Persistent MCP tool-catalog mode selection; shared with dashboard autocomplete. */
/** User-facing SuperAgent Studio entry points. Internal file IDs remain motion-* for compatibility. */
export const STUDIO_SUGGESTIONS = [
  "/studio help",
  "/studio generate",
  "/studio new",
  "/studio list",
  "/studio inspect",
  "/studio effects",
  "/studio presets",
  "/studio apply-effect",
  "/studio apply-preset",
  "/studio import-image",
  "/studio import-audio",
  "/studio edit",
  "/studio edit-json",
  "/studio frame",
  "/studio render",
  "/studio jobs",
  "/studio status",
  "/studio recovery",
  "/studio cancel",
  "/studio queue-recovery",
  "/studio storage",
  "/studio supervisor-status",
  "/studio queue",
  "/studio doctor",
] as const;

export const MCP_USE_SUGGESTIONS = [
  "/mcp use gateway",
  "/mcp use full",
  "/mcp use status",
] as const;

export const MCP_TUNNEL_SUGGESTIONS = [
  "/mcp tunnel providers",
  "/mcp tunnel config status",
  "/mcp tunnel config set-id",
  "/mcp tunnel config set-key-env",
  "/mcp tunnel config set-key",
  "/mcp tunnel list",
  "/mcp tunnel start --provider cloudflare",
  "/mcp tunnel start --provider openai --tunnel-id",
  "/mcp tunnel restart",
  "/mcp tunnel stop",
  "/mcp tunnel status",
  "/mcp tunnel doctor --provider openai",
];

export const SERVER_TUNNEL_SUGGESTIONS = [
  "/server tunnel list",
  "/server tunnel start",
  "/server tunnel restart",
  "/server tunnel status",
  "/server tunnel stop",
  "/server tunnel doctor",
];

export const MCP_TUNNEL_PROVIDERS = [
  {
    id: "cloudflare",
    label: "Cloudflare Quick Tunnel",
    description: "Public HTTPS Streamable HTTP endpoint for an MCP server.",
    requiredOptions: [] as string[],
  },
  {
    id: "openai",
    label: "OpenAI Secure MCP Tunnel",
    description: "Outbound-only secure tunnel identified by an OpenAI tunnel ID; use --tunnel-id or OPENAI_MCP_TUNNEL_ID.",
    requiredOptions: [],
  },
] as const;

export function getMcpTunnelProviderDescription(provider: string): string | undefined {
  return MCP_TUNNEL_PROVIDERS.find((entry) => entry.id === provider.toLowerCase())?.description;
}

export function getMcpTunnelProvidersHelp(): string {
  return [
    "MCP tunnel providers:",
    ...MCP_TUNNEL_PROVIDERS.map((entry) =>
      `- ${entry.id}: ${entry.label} — ${entry.description}`
    ),
    "",
    "Examples:",
    "  /mcp tunnel start --provider cloudflare",
    "  /mcp tunnel start --provider openai --tunnel-id <id>",
    "  /mcp tunnel config set-id <id>",
    "  /mcp tunnel config set-key <runtime-api-key>",
    "  /mcp tunnel config set-key-env",
    "  /mcp tunnel config status",
    "  (or set OPENAI_MCP_TUNNEL_ID and run /mcp tunnel start --provider openai)",
  ].join("\n");
}
