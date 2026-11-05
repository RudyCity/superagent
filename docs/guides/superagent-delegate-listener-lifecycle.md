# SuperAgent Delegate Listener Lifecycle

## Ownership and user preference

The Chrome Delegate extension is a WebSocket **client** of the local
`ws://127.0.0.1:17341` listener, not a process manager. Only the verified Core
worker should host that listener. A manual Start/Stop operation on the
authenticated localhost desktop API stores a versioned preference under
`<SUPERAGENT_CONFIG_DIR>/delegate/listener-preference-v1.json`. Without an
override the config root is `~/.superagent-r`.

The default is ON when no preference exists. An explicit Stop saves OFF, and
subsequent Core boots and blue-green handovers respect it. Malformed or
symlinked preference files fail closed rather than silently resetting to ON.
`SUPERAGENT_DELEGATE_BRIDGE=0` takes precedence and prevents automatic boot.
A supervisor handover uses an internal token and `transient: true`; it never
changes the user's ON/OFF setting.

## Diagnostics and recovery

Open **SuperAgent Tray → Delegate** and click Refresh. The local authenticated
`GET /api/desktop/delegate/status` exposes `running`, `desiredEnabled`,
`healthy`, `pendingRequests`, `openSockets` and connected profiles.
`healthy` is **current-worker-local**: it does not prove another process
cannot bind the port. Tray polls the status every five seconds.

When **Start Listener** encounters `EADDRINUSE`, the server attempts a
**manual-only** verified handover:

1. Read the Core supervisor checkpoint, confirm the requesting process is its
   currently active, generation-ID-matching, bearer-authenticated worker.
2. Inspect each recorded former generation over the private loopback inspection
   endpoint, verifying the original worker PID, generation ID, and isolation.
3. Require exactly one old running listener; require zero pending RPCs (or,
   for a legacy worker without a pending count, zero open sockets).
4. Ask that owner to release only its Delegate listener and start the new
   listener. If startup fails, attempt to restore the former owner. Never
   terminate a process, replay a chat action or rotate a public tunnel URL.
5. Reject unknown or changing ownership and surface an actionable error.

An explicit Stop on a worker without a local listener safely releases a single verified retained owner, while refusing to interrupt pending calls. Concurrent Start/Stop requests on the same process are serialized by a fail-closed transition guard.

The supervisor also restores a listener on a verified candidate when an active
worker crashes and the saved preference is ON. Every worker handover still
checks for in-flight Delegate calls and fails closed when safety is uncertain.

## Pairing behavior

Pairing codes expire after 10 minutes, are issued only by a running listener,
and are rotated via **Renew Code** in Tray. The Chrome extension saves the
issued bearer in its private profile storage; the Core persists a
origin-bound digest, never the bearer. If the extension says pairing is
required, get a **fresh** code from Tray, then use Save Pairing in the Chrome
extension popup. The extension should be reloaded at `chrome://extensions`
after JavaScript source changes.

## Tests and rollout

```sh
bun run build
bun run verify:extension-js
bun --bun x vitest run tests/delegateListenerLifecycle.test.ts tests/delegateListenerSocketE2E.test.ts tests/coreDelegateHandover.test.ts tests/desktopDelegateUi.test.ts tests/delegateStatus.test.ts
bun run tray:check
```

The socket E2E test creates a private ephemeral localhost listener, performs
real origin-validated pairing, then verifies persisted OFF and an authenticated
reconnect using the stored digest. It never sends chat content or changes
an existing Chrome profile.

**Rollout:** the source build and tests alone do not update already-running
Core supervisor or a packaged Tray executable. Restart/recover the supervised
Core only through its verified lifecycle protocol. Upgrade the Tray only after
the build is trusted and the lifecycle manager confirms there are no foreign
or uncertain Tray owners. Never use `taskkill`, a blind process reset, or
manual ledger deletion to force a deployment.
