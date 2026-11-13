# Stage 3 — Independent MCP Quick Tunnel Anchor (2026-11-14)

## Guarantee and existing-URL constraint

The **Tunnel Anchor** is an independently operated long-lived process. It owns the `cloudflared` Quick Tunnel and its local loopback ingress. The replaceable MCP owner binds a **different** loopback port behind the Anchor. The owner does **not** create or stop `cloudflared` when started with `--anchor-port`. After a deliberately established Anchor, a reviewed, drained-owner handoff can preserve that Anchor's public URL.

**There is no safe in-place adoption of the currently live Quick Tunnel.** Its `cloudflared` child and process-exit handler belong to the existing owner. Creating a new Quick Tunnel produces a new random `trycloudflare.com` hostname. Stage 3 does not migrate the existing Gemini/ChatGPT URL, change an existing OAuth issuer, restart an owner, or install a permanent Windows task. It only implements the architecture and isolated proof. Losing the Anchor/cloudflared process or rebooting still risks losing the random hostname. A durable hostname requires a named tunnel.

## Components

- `src/core/runtime/mcpTunnelAnchor.ts`: independent loopback listener + tunnel lifecycle, strict public path allowlist, authenticated local `/_internal/anchor/status|plan|activate`, explicit review and optimistic owner identities. Streaming clients are not replayed.
- `src/core/runtime/mcpTunnelAnchorLease.ts`: private on-disk owner lease; before control, verifies exact kernel listener PID, Windows process birth, authenticated nonce, URL and tunnel PID.
- `src/core/runtime/mcpReloadableOwner.ts`: `externalPublicBaseUrl` and separate lifecycle; the owner uses the Anchor issuer and **does not spawn or stop a tunnel**. Its `/stop` calls the managed shutdown hook to clear the owner lease.
- `src/core/runtime/mcpManagedTunnelOwner.ts`: `--anchor-port` validates the separate Anchor. A second owner is blocked until the old verified owner is drained and has zero active sessions/in-flight requests, preserving a single writable OAuth issuer. New/old owner authentication modes and tool safety modes must match.
- `scripts/mcp-tunnel-anchor.ts`: manual `start`, `status`, `plan`, `activate`; an explicit `--reviewed` step is required. No unattended migration, no persistent job installation.

## Operator sequence (isolated profile and ports only; not the live Gemini tunnel)

Keep a single `SUPERAGENT_CONFIG_DIR` private to the test, e.g. an existing disposable child of `~/.superagent-local-staging/`. Never reuse the production OAuth profile or the active owner port. In a dedicated terminal:

```powershell
bun scripts/mcp-tunnel-anchor.ts start 19320
```

From a separate terminal with the **same profile**:

```powershell
bun scripts/mcp-tunnel-anchor.ts status 19320
superagent mcp tunnel start --provider cloudflare --mcp-auth static-bearer --port 19321 --anchor-port 19320
bun scripts/mcp-tunnel-anchor.ts plan 19320 19321
```

The plan reports a random `planId`, the exact public URL, Anchor PID, previous owner PID, new owner PID/port, expiry and whether the previous owner must drain. The operator explicitly checks these facts before activating:

```powershell
bun scripts/mcp-tunnel-anchor.ts activate 19320 19321 <PLAN_ID> none --reviewed
```

After the first owner is attached, a later owner replacement requires the *old owner to be explicitly drained*, with zero sessions and in-flight requests. Run a new plan and activate with the **actual previous owner PID** in place of `none`. A different OAuth mode, tool-safety mode, URL, PID or port is rejected. When the new owner is serving, the old owner may be stopped without closing the independent Anchor.

## Stage 4 — independent read-only health observer

The standalone observer checks the Anchor lease, authenticated localhost status, Windows kernel listener/process-birth identity, persisted Cloudflare target and **cloudflared command-line ownership**, and the managed MCP owner lease/backend health. It never starts, stops, adopts or restarts a service, changes the OAuth issuer, or replays a tool call. It emits `verified_local`, `unattached`, `degraded`, or `unavailable` with a machine-readable reason and no secrets. **Local verification does not certify external Cloudflare edge reachability.**

```powershell
bun scripts/mcp-tunnel-anchor-watch.ts once 19320
bun scripts/mcp-tunnel-anchor-watch.ts watch 19320 15
```

`once` exits 0 only when locally verified and 2 otherwise. `watch` runs as a separate optional observer, reports transitions and periodic evidence, and stops on SIGINT/SIGTERM. The Anchor `status` command also shows this health observation, distinguishing an attached owner from a verified healthy one.

There is **no automatic restart** and no installed startup task. Losing the original Quick Tunnel means its random hostname cannot be restored; a persistent service and guaranteed hostname require an explicitly approved named Cloudflare tunnel and OS-native restart/recovery gates. An unavailable process is an alert, not permission to create or take over a replacement.

## Recovery and limits

- If the old owner exits or crashes **without verified drain**, Anchor returns 503 rather than silently routing to a different process. Do not replay non-idempotent tool calls. Automatic crash recovery and takeover of orphaned OAuth writer state are not implemented or certified.
- The Anchor itself is currently not independently supervised across machine reboot. Stopping Anchor ends its Quick Tunnel. Do not install/uninstall/update it by replacing its live PID.
- OAuth tokens are scoped to the issuer, and persistent storage protects against stale writers, but **zero-disruption OAuth client continuity has not been certified on live Gemini/ChatGPT**. Isolated tests use a mock tunnel and static-bearer owner.
- The current `trycloudflare.com` URL cannot be transferred from the existing owner without risks of rotation. Do not attempt live migration as a shortcut to make an update appear complete.
- R0–R7 release/installer, OS security, authentic publication, and production cutover gates remain unchanged.

## Verification

Run `bun run build`, `bun --bun x vitest run tests/mcpTunnelAnchor.test.ts tests/mcpTunnelAnchorManagedOwner.test.ts tests/mcpReloadableOwner.test.ts tests/mcpManagedTunnelOwnerLifecycle.test.ts tests/mcpTunnelAnchorObserver.test.ts --maxWorkers=2`. Tests use disposable private ports/fixtures and mock the external Cloudflare tunnel; the real Gemini URL and production owner are **not** touched.
