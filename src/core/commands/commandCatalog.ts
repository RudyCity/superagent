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

export const MUSE_HOST_SUGGESTIONS = [
  "/muse host status",
  "/muse host config status",
  "/muse host config set-webhook",
  "/muse host config disable",
  "/muse host help",
  "/muse host steer",
  "/muse host task",
  "/muse host abort",
  "/muse host replay-result",
  "/muse host resume-untouched",
] as const;

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

/** All advertised /brain and /scratch subcommands must be backed by brainCommand.ts.
 * MCP-only task.credential.* and delegate.promote.batch are intentionally absent
 * here: listing them as slash commands would imply execution support.
 */
export const BRAIN_SUGGESTIONS = [
  "/brain help",
  "/brain create",
  "/brain list",
  "/brain inspect",
  "/brain files",
  "/brain metrics",
  "/brain storage",
  "/brain retention",
  "/brain resume",
  "/brain search",
  "/brain annotate",
  "/brain promote",
  "/brain remember",
  "/brain clean",
  "/brain clean.confirm",
  "/brain task.create",
  "/brain task.list",
  "/brain task.claim",
  "/brain task.resume",
  "/brain task.checkpoint",
  "/brain task.transfer",
  "/brain task.complete",
  "/brain task.reconcile",
  "/brain task.launch.inspect",
  "/brain task.launch.recover",
  "/brain artifact.recover",
  "/brain delegate.start agy",
  "/brain delegate.start claude",
  "/brain delegate.start codex",
  "/brain jobs",
  "/brain get",
  "/brain tail",
  "/brain cancel",
] as const;

export const BRAIN_SUGGESTION_DESCRIPTIONS: Record<string,string> = {
  "/brain help": "Display all Brain CLI actions, including nested task, job and recovery operations.",
  "/brain task.reconcile": "Reconcile persisted CLI Bridge jobs safely; never retry work implicitly.",
  "/brain task.launch.inspect": "Inspect a reserved CLI launch and find only evidence-matched Bridge jobs.",
  "/brain task.launch.recover": "Attach a verified job with explicit operator confirmation. Never retries.",
  "/brain artifact.recover": "Recover an interrupted journaled artifact batch without deleting unrelated files.",
  "/brain task.create": "Create a session-scoped multi-agent task.",
  "/brain task.list": "List tasks for the current Brain session.",
  "/brain task.claim": "Claim task ownership for an agent ID (local CLI operator).",
  "/brain task.resume": "Read saved task checkpoints and handoffs.",
  "/brain task.checkpoint": "Save a bounded task checkpoint.",
  "/brain task.transfer": "Transfer task ownership to another member.",
  "/brain task.complete": "Mark an explicitly claimed task completed.",
  "/brain delegate.start agy": "Start an AGY delegation in a newly isolated Brain task scratch.",
  "/brain delegate.start claude": "Start a Claude delegation in a newly isolated Brain task scratch.",
  "/brain delegate.start codex": "Start a Codex delegation in a newly isolated Brain task scratch.",
  "/brain jobs": "List persisted delegated CLI jobs.",
  "/brain get": "Inspect a delegated job by ID.",
  "/brain tail": "Show recent output of a delegated job.",
  "/brain cancel": "Request cancellation of a delegated job.",
  "/brain clean": "Prepare a guarded scratch cleanup challenge; no immediate deletion.",
  "/brain clean.confirm": "Confirm an existing cleanup challenge explicitly.",
  "/brain promote": "Promote one verified output artifact from a delegation.",
  "/brain remember": "Explicitly save a verified artifact candidate to project RMemory.",
};

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

export const SENOPATI_RUNTIME_SUGGESTIONS = [
  "/senopati help",
  "/senopati status",
  "/senopati autostart on",
  "/senopati autostart off",
] as const;

export const CORE_RUNTIME_SUGGESTIONS = [
  "/core help",
  "/core status",
  "/core restart",
  "/core rollback",
  "/core drain",
] as const;

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
