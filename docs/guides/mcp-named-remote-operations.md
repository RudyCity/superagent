# Cloudflare Remote-managed Named Tunnel — secure operations

Version: SuperAgent source **1.14.93**. Applies to Windows, macOS and Linux.
This is **not a production cutover approval**. Existing MCP Quick Tunnel
sessions, ownership, Cloudflare DNS and OAuth tokens must remain unchanged.

## Your existing Cloudflare configuration

- Cloudflare zone: \`rcity.web.id\`
- Intended permanent endpoint: \`https://mcp.rcity.web.id/mcp\`
- Remote-managed Cloudflare tunnel: \`superagent-mcp-rcity\`
- Tunnel UUID: \`b2e8c6d9-9317-4d9e-b381-826af22e1778\`
- Dashboard route origin: \`http://127.0.0.1:19320\`
- Private MCP owner: port \`19321\`
- Original MCP Quick Tunnel owner: port \`9227\` — **never reuse or restart**

## 1. Configure in Tray

Settings → Cloudflare Named Tunnel. Select **Remote-managed · token file**.
Save the verified hostname/UUID, Anchor port, owner port and absolute
\`cloudflared\` executable path. The form saves only metadata into
\`~/.superagent-r/mcp-named-tunnel-settings.json\`. It cannot activate a
tunnel or change the live Gemini client.

Use **Import Cloudflare Token File** to select the token from an OS-native
file picker. The native application validates the token's embedded tunnel
UUID and account/secret structure, then copies it into a private profile
folder with user-only OS permissions. It persists **only the path**, never
the raw token. The original selected token file remains unchanged; remove
the source using an approved secure file procedure after verifying import.
Do not paste token bytes into an input, terminal command, issue, chat,
project log, or Git checkout.

The Cloudflare dashboard's \`service install TOKEN\` sample can expose
the token in command arguments or service metadata. Prefer the private
token-file form \`cloudflared tunnel run --token-file ABSOLUTE_PATH\`;
the Tray passes those flags as discrete arguments and suppresses logs.
Do not install a Windows service through the sample command before
evaluating its credential and restart behavior.

## 2. Start a new independent Anchor (separate from connector)

From a trusted SuperAgent source checkout with Bun installed and the
same private \`SUPERAGENT_CONFIG_DIR\` used by the Tray:

\`\`\`powershell
bun scripts/mcp-tunnel-anchor.ts start-profile 19320 --reviewed
\`\`\`

The program checks the saved **remote-managed** token file, tunnel UUID,
cloudflared executable and Anchor port **without launching cloudflared**.
It binds only \`127.0.0.1:19320\`, advertises the fixed public URL and
writes an authenticated private lease. This process must stay running
independently; opening or closing the Tray does not own its lifecycle.
The old live Quick Tunnel is untouched.

For an initial owner (a **different** internal port):

\`\`\`powershell
superagent mcp tunnel start --port 19321 --provider cloudflare --mcp-auth oauth --anchor-port 19320
bun scripts/mcp-tunnel-anchor.ts plan 19320 19321
\`\`\`

Review the exact Anchor PID, old/new owner IDs and fixed URL. If the
first attachment plan reports a null previous owner, activate only the
plan ID returned by the running Anchor:

\`\`\`powershell
bun scripts/mcp-tunnel-anchor.ts activate 19320 19321 <PLAN_ID> none --reviewed
\`\`\`

Do not reuse old Gemini OAuth sessions. A replacement owner must respect
the drained sessions and single OAuth writer gate. An owner restart is
**not** an authorization to replay tools or replace a URL.

## 3. Native connector plan / start / stop

After a valid credential import and verified local Anchor, use
**Review Connector Plan**. **Start Named Connector** checks the exact
Cloudflare tunnel ID and opens a native OS confirmation; it starts only
\`cloudflared tunnel run --token-file ABSOLUTE_PATH\`, without invoking
Cloudflare's dangerous service-install-with-token command. It registers
a private PID/start-time lease. **Stop Named Connector** requires that
same verified process identity and an independent native confirmation.

The native owner proof rejects unknown executables, a mismatched command
line, stale or reused PIDs, or a conflicting lease. It cannot be used to
stop the original Quick Tunnel. A stale/ambiguous lease is intentionally
**not** automatically removed. Review it before any manual recovery.

Use **Check Real Health** to see the following independent signals:

1. Token file and connector PID/command-line ownership.
2. Authenticated loopback Anchor lease and process-birth identity.
3. Authenticated private MCP owner/back-end health.
4. Cloudflare HTTPS response and an MCP OAuth Bearer challenge when present.

An HTTPS 530 means Cloudflare has no functioning connector. A 502/503
may indicate an origin or owner problem. A 401 is **not** sufficient to
prove OAuth/PKCE or Gemini authorization. The app never returns
\`readyForCutover:true\` from these read-only probes alone.

## 4. OS lifecycle and reboot recovery

The local Start/Stop control manages an explicitly owned connector process
only. **It does not install an OS service, guarantee restart after reboot
or manage the independent Anchor/owner startup order.** These are separate,
operator-approved deployment controls:

- **Windows:** use a dedicated Windows service/task with protected
  \`--token-file\` arguments and an absolute binary path, never an
  inline token; separately supervise the Anchor and owner with verified
  startup dependencies. Avoid the existing production Core/Tray service.
- **macOS:** use LaunchDaemon/LaunchAgent profiles with absolute paths and
  a private credential file, respecting keychain/user ownership and a
  non-root Core/owner process.
- **Linux:** use systemd units with \`ExecStart\` arguments for a private
  token file, restrictive \`User\`/\`ProtectHome\`/\`UMask\`, and explicit
  Anchor/owner dependencies. Do not treat a healthy \`cloudflared\` process
  as proof of a healthy MCP server.

**Do not register auto-start services until** end-to-end tests on the
new hostname, safe recovery, stale lease reconciliation, and explicit
operator approval are complete. OS service installation and reboot drills
are currently *not verified* in any of the three target operating systems.

## 5. Gemini client migration / rollback

Client cutover remains blocked until all of these have evidence:

- Cloudflare DNS and TLS point to the intended tunnel UUID and hostname.
- Connector, Anchor and owner all show authenticated independent health.
- Gemini and ChatGPT OAuth discovery, PKCE login, reconnect, and \`tools/list\`
  work through the **new** issuer and hostname.
- No in-flight tool effects or old sessions are silently replayed.
- Owner/backend handoff, connector restart and reboot drill preserve the
  fixed hostname; failure modes and rollback are documented.
- The user explicitly approves switching the client endpoint.

Keep \`https://tigers-dame-sys-lid.trycloudflare.com/mcp\` running until
the client has been separately verified on the named hostname. Rolling
back means restoring the **client endpoint** (and reauthorizing if
necessary), not deleting DNS or killing arbitrary processes.
