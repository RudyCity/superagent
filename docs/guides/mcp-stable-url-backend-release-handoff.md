# Stable-URL MCP backend release handoff (2026-11-14)

## Scope and actual guarantee

SuperAgent may upgrade an MCP **backend generation** without replacing the authenticated
MCP owner, the loopback listener, the Cloudflare **Quick Tunnel** process or its public
OAuth issuer. Sessions established before a cutover remain pinned to their previous
backend generation until normal retirement. New sessions use the activated release.
An HTTP request, including a potentially non-idempotent `tools/call`, is **never**
implicitly replayed or moved mid-flight.

This is **not** a guarantee that a Quick Tunnel URL survives an owner crash, OS reboot,
`cloudflared` crash or an upgrade of the owner executable. The current tunnel is a
child of the owner process and its shutdown path intentionally terminates it. Never
attempt an in-place owner replacement under the current Quick Tunnel. A separately
owned Tunnel Anchor and a one-time, independently verified handoff must be designed
and tested before full owner updates are called zero-downtime.

## Implementation (v1.14.87)

- The existing owner remains the stable ingress and does not load arbitrary backend
  code from user-supplied paths. An operator stages a **complete**, verified standalone
  release at:
  `<SUPERAGENT_CONFIG_DIR or ~/.superagent-r>/mcp-backend-releases/<compiled-build-sha256>/`
- That directory must contain `package.json`, `dist/cli.js`,
  `dist/core-build-identity.json`, all compiled modules and the standalone runtime
  dependencies needed to execute it. Bundle extraction is **not** performed by the
  live owner. The release/installer downloader must first verify the official
  release asset SHA-256 and provenance; the compiled build digest is an additional
  consistency check, **not** a replacement for signed release verification.
- `verifyMcpBackendRelease` validates that the staged path is address-by-digest,
  that the manifest matches the compiled tree, and that key roots and files are
  regular (not symlinks). Stage with a trusted installer and do not mutate staged
  bytes after verification.
- Private loopback owner API, protected by the existing owner nonce and host guard:
  `GET /_internal/owner/backend/plan?digest=<sha>` returns the current backend PID,
  stable URL and candidate digest without mutation.
  `POST /_internal/owner/backend/activate?digest=<sha>&expectedBackendPid=<pid>&expectedPublicUrl=<url>&reviewed=1`
  checks operator review and optimistic identities and re-verifies release bytes
  before creating a new generation. A compatible IPC protocol version is mandatory.
  It promotes **only after** the candidate starts and confirms readiness, otherwise
  the old generation keeps serving. The existing old generations are never force-killed
  as a consequence of a failed plan or failed candidate.
- Existing `/_internal/owner/reload` remains compatible; subsequent backend-only
  reloads use the most recently activated staged version, without replacing owner.
- OAuth issuer and public URL never change during successful backend activation;
  existing OAuth grants remain scoped to their original issuer.

## Operator commands (do not run on the live owner without reviewed evidence)

```powershell
# Read-only: inspect the release's manifest digest and verify the complete bundle.
bun scripts/mcp-backend-release.ts plan 9227 <compiled-build-sha256>

# The plan provides the exact OWNER_PID, BACKEND_PID and PUBLIC_URL.
# Apply only after full release checksum verification, a reviewed update window,
# and an accepted plan from the same authenticated owner.
bun scripts/mcp-backend-release.ts activate 9227 <compiled-build-sha256> <OWNER_PID> <BACKEND_PID> <PUBLIC_URL> --reviewed

# Verify owner and URL unchanged; MCP sessions and OAuth remain available.
bun src/cli.tsx mcp status
```

The CLI fails closed when the owner lease, OS owner identity, previous backend PID,
public URL, staged digest or explicit review does not match. Do **not** retry a timed-out
activation blindly: inspect owner status and release digest first.

## Stage 2: official GitHub Release acquisition (v1.14.88)

The tagged Windows CI job builds `SuperAgent-MCP-Backend-<version>-windows-x64.tgz` from the verified
standalone package. It independently extracts and checks the candidate before uploading
it. The unified release gate now requires **12 binary/archive/metadata assets plus
`SHA256SUMS.txt` (13 public assets)**, including this backend-only artifact.

On the operator's Windows machine, use these separate commands:

```powershell
# Read-only: enumerate a published and checksummed prerelease candidate.
bun scripts/stage-mcp-backend-release.ts --check
bun scripts/stage-mcp-backend-release.ts --check --tag=v1.14.88-rc.1

# Download/verify and atomically stage a specific published tag, no activation.
bun scripts/stage-mcp-backend-release.ts --stage --tag=v1.14.88-rc.1

# Separate review: only when the **installed owner** supports private plan/activate.
bun scripts/mcp-backend-release.ts plan 9227 <compiled-build-digest>
```

The updater verifies the official GitHub release and tag commit, pinned asset URL,
`SHA256SUMS.txt`, asset byte length/digest, embedded source-commit identity,
manifest-build consistency and archive path/link safety. Private repository access
uses `GH_TOKEN` or `GITHUB_TOKEN` in the operator's environment; no token is logged
or written to the staged receipt.

**The downloader never activates an update.** Activation remains a separate,
operator-reviewed operation using exact owner PID, backend PID and public URL.
An old installed owner will not acquire new control endpoints merely because
the source repository has been rebuilt. Do not restart Quick Tunnel to install
an owner update; the Quick Tunnel hostname is not guaranteed to survive.

R0-R7 signing/OS-keystore/native-installer gates and release provenance
remain mandatory. A tagged GitHub release must actually publish the new
asset before staging against that tag can succeed.

## Stage 3: independently owned tunnel anchor (v1.14.89)

A separately run Tunnel Anchor may own the Quick Tunnel and proxy traffic to a reviewed private MCP owner. Explicit `--anchor-port` owner mode does not create or stop cloudflared. Only reviewed handoffs from fully drained owners are permitted. **This does not adopt or preserve an already running Quick Tunnel during the first migration**; do not change the current Gemini URL. See [Independent MCP Tunnel Anchor](mcp-independent-tunnel-anchor.md) for the isolated procedure, controls, and operational limits.

## Proof and remaining gates

- `bun run build`, focused unit tests and a real localhost **isolated mock tunnel**
  integration exercise verify the plan/activate path, unchanged owner/URL, old-session
  preservation, OAuth behavior, and rejection of unsigned/modified/stale candidates.
- Runtime installation uses `C:\Users\USER\AppData\Local\SuperAgent\standalone\dist\cli.js`.
  The source repository and running installed owner are different artifacts. Merely
  building the source or reloading the installed old worker does not activate code
  not yet installed in a verified complete standalone release.
- The next release pipeline phase must stage immutable, signed/verified standalone
  bundles side-by-side, use the private plan/activate command, and reconcile its
  outcome before an updater marks the installation complete. The exact installed
  owner remains untouched. No automated owner replacement or tunnel reassignment.
- R0–R7 and the independent installer/release verification gates remain enforced.
  No live Quick Tunnel migration or release promotion is authorized by this document.
