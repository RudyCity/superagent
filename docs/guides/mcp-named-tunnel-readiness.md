# MCP Named Tunnel readiness — Stage 5 (2026-11-14)

## Goal and hard boundary

Prepare a Cloudflare **locally managed named tunnel** for a new, stable
operator-owned hostname, without changing the current live Quick Tunnel, DNS,
OAuth issuer, Core/owner process, or Chrome/Gemini MCP connection.

The named connector and Anchor are distinct OS process lifecycles. A named tunnel
UUID + DNS hostname can survive a **connector restart**; this does not promise
zero downtime, OAuth token portability, or an automatically installed Windows
service. A lost Quick Tunnel cannot be transparently adopted by a named tunnel.
The original Gemini client must remain on the current URL until separately
approved client reauthorization and cutover verification.

## Operator-supplied local inputs — no credentials stored in Git

Prepare an **operator-private** JSON spec outside the checkout, not under
a shared project. The spec contains paths, *not* actual tunnel secrets:

\`\`\`json
{
  "schemaVersion": 1,
  "tunnelId": "123e4567-e89b-42d3-a456-426614174000",
  "hostname": "mcp.example.org",
  "credentialsFile": "C:\\Users\\USER\\.cloudflared\\123e4567-e89b-42d3-a456-426614174000.json",
  "cloudflaredPath": "C:\\Program Files\\cloudflared\\cloudflared.exe"
}
\`\`\`

Replace example UUID, host and paths with independently verified values.
The Cloudflare \`TunnelSecret\` remains in Cloudflare's original credentials
file (restricted to its operator); do not put it in the spec, commit, screenshots
or chat. The spec checker validates UUID and hostname, exact credential
\`TunnelID\`, safe regular files, and expected binary name. **It does not prove
the DNS record or Cloudflare credentials are accepted by the network.**

Choose an unused Anchor port, different from both the existing MCP owner port
and the protected Core port. Use a private \`SUPERAGENT_CONFIG_DIR\` consistently
for the plan, staging and Anchor process. First:

\`\`\`powershell
bun scripts/mcp-named-tunnel.ts plan 19320 C:\private\mcp-named-spec.json
\`\`\`

Plan is read-only and displays the proposed public URL, local target, manifest
SHA-256 and explicit \`dnsConfigured:false\` and
\`externalConnectorVerified:false\`. After operator review:

\`\`\`powershell
bun scripts/mcp-named-tunnel.ts stage 19320 C:\private\mcp-named-spec.json --reviewed
\`\`\`

Staging writes **only** a new private config
\`mcp-named-19320.yml\` (fails closed if an existing config differs):

\`\`\`yaml
tunnel: 123e4567-e89b-42d3-a456-426614174000
credentials-file: C:\Users\USER\.cloudflared\123e4567-e89b-42d3-a456-426614174000.json
ingress:
  - hostname: mcp.example.org
    service: http://127.0.0.1:19320
  - service: http_status:404
\`\`\`

Verify the exact generated config locally using the operator's Cloudflare
binary and Cloudflare-supported validation commands:

\`\`\`powershell
& "C:\Program Files\cloudflared\cloudflared.exe" tunnel --config "C:\private\mcp-named-19320.yml" ingress validate
& "C:\Program Files\cloudflared\cloudflared.exe" tunnel --config "C:\private\mcp-named-19320.yml" ingress rule "https://mcp.example.org/mcp"
\`\`\`

Those examples contain placeholders; use the *actual* staged path returned
by the tool. Do not make changes to DNS or run an external connector as a
"test" on the active machine without explicit approval.

## Separate Anchor and connector lifecycle

A **reviewed** named Anchor start may be performed only after preflight;
it does **not** launch cloudflared or change DNS:

\`\`\`powershell
bun scripts/mcp-tunnel-anchor.ts start-named 19320 C:\private\mcp-named-spec.json --reviewed
\`\`\`

The response reports \`tunnelMode:"named-external"\` and
\`externalConnectorVerified:false\`. It does not claim the external hostname
is reachable. The independently managed named connector uses the same
generated configuration and may be installed as an OS service only via the
operator-approved Cloudflare/system-service procedure. **Do not reuse the
current Quick Tunnel owner PID or try to reroute the original URL.**

The existing private owner \`--anchor-port\` workflow and reviewed, drained
owner handoff still apply. The local Anchor observer deliberately classifies
\`named-external\` as \`NAMED_CONNECTOR_UNVERIFIED\` until a separately
audited process + Cloudflare edge verification is implemented. A running local
listener, YAML file, successful build or DNS declaration alone do not
establish end-to-end readiness. Disable automatic cutover.

## Live cutover gates (all still BLOCKED pending operator evidence)

1. Operator chooses the intended owned domain and confirms control of the
   relevant Cloudflare zone and named tunnel UUID.
2. Verify the Cloudflare tunnel credential provenance, hostname DNS CNAME to
   \`<UUID>.cfargotunnel.com\`, TLS, ingress validation, exact localhost
   origin, external connector process identity and independent supervision.
3. On a separate private profile, prove OAuth/PKCE, Gemini and ChatGPT MCP
   init/tools/auth, idle reconnect, request drain, restart, and failure
   semantics without carrying live session IDs or hidden token migrations.
4. Verify Windows native service recovery, reboot behavior, retained hostname,
   immutable release provenance and approved rollback plan.
5. Request explicit operator approval for DNS/production client reauthorization
   and cutover. Only then can the old Quick Tunnel be retired.

All plan/stage actions are local and do not use Cloudflare APIs, call DNS, deploy,
rotate credentials, kill a PID, or restart production processes.

Reference: Cloudflare's "Create a locally-managed tunnel" and
"Configuration file" developer documentation, including mandatory
\`http_status:404\` catch-all rules.
