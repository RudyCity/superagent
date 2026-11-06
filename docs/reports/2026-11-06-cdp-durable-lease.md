# Delegate-CDP durable lease journal — Worker B

Date: 2026-11-06. Scope: one shared SuperAgent checkout on branch main. This report describes the Worker B implementation, NOT a deployed runtime upgrade. No services, live configuration, existing owner ledgers, browser sessions, or secrets were changed.

## Files and contracts

- src/core/browserTransport/delegateLeaseJournal.ts — opt-in, versioned journal with HMAC authentication, SHA-256 capability digests, atomic replace, exclusive non-reclaiming writer lock, bounded resource use, strict schema validation, CAS sequence, per-Core writer epoch, expiry, verified retirement gate and explicit owner-token recovery.
- src/core/browserTransport/sessionCoordinator.ts — preserves existing synchronous claim, observer/contributor, invite, share, FIFO, revision, handover and heartbeat API. Adds configureDelegateLeaseJournal(journal), recoverDelegateTarget(clientId,tabId,agentId,originalToken), and retireExpiredDelegateLeases(). Successful mutating paths checkpoint when configured; auth verifies the journal before accepting a command. Persistence is NOT enabled by default.
- tests/delegateDurableLeaseRecovery.test.ts — isolated private temporary directories and mocked Core module reloads; no real project settings or live journal.
- This report.

The journal filename is fixed to delegate-leases.v1.json below an explicit absolute, pre-existing, private, non-symlink directory. No default live path is selected. Caller must provide a stable external 32+ byte HMAC integrity key, never serialized to the file. Root and journal permissions are verified on POSIX (owner only); Windows ACLs must be configured and independently verified by the runtime integration. Files contain only SHA-256 token digests, not plaintext owner, member or invitation capabilities. Profile/tab identity, roles, invitations, revisions, times, and hashed capabilities are stored; no browser commands or pending operations are persisted.

## Integrator contract (Worker A / Core startup owner)

1. Obtain an authoritative private storage directory, stable external integrity key, and an independent previousEpochRetired(oldEpoch) witness from the Core lifecycle supervisor. Do not use PID guesswork, automatic stale-lock deletion or a hardcoded true callback in production.
2. Construct createDelegateLeaseJournal({directory, integrityKey, previousEpochRetired}). Only during explicit provisioning with known-absent state call journal.initialize() once. An existing journal is never implicitly overwritten. Missing/corrupt state is a hard denial, not "no claims".
3. Before allowing CDP commands, call configureDelegateLeaseJournal(journal). Persisted sessions are quarantined on reload: hasDelegateClaim prevents anonymous bypass and authorizeDelegateTarget fails until the original owner reclaims the same profile/tab with the original, unexpired token.
4. Call recoverDelegateTarget(clientId, tabId, agentId, originalToken) through an authenticated owner-specific operation, not a public unscoped endpoint. Recovery atomically verifies exact client/tab/owner/token + TTL, checks retirement evidence when changing epoch, raises the tab revision, and keeps other tabs quarantined. It never replays commands. Members still need their original tokens; observer/write and expected-revision policy remains enforced.
5. If all prior leases have expired, an operator-authorized retireExpiredDelegateLeases() can adopt a new epoch only after independent prior-Core retirement proof. It refuses any surviving active lease. After adoption, new claims can be issued. For live leases with lost owner token, do not delete/reinitialize the journal to break ownership.
6. Keep journal reads/writes and authorizations within the same trusted Core identity/security boundary; never grant a browser client journal write access or expose the HMAC key.

The runtime must not call these opt-in APIs against the live Core until Worker A wires lifecycle ownership, ACL/private key provisioning, recovery RPC authorization, and pre-command fencing. This worker did not edit cdpTransport.ts, chromeCdpTools.ts, chromeMcpTools.ts, or live services.

## Fail-closed policy and limits

- Integrity/schema failure, missing file, unknown version, malformed or duplicated target, unsafe path/permissions, oversized file, unverified epoch, stale CAS, and ambiguous lock all deny. A rejected checkpoint blocks subsequent coordinator operations; it does not silently fall back to process memory.
- Journal file payload limit: 512 KiB; at most 128 targets, 16 joined members and 24 invitations per target. Existing operation FIFO remains process-local with maximum 32 queued operations per target.
- Owner and member expiry remain 90 seconds; invites expire after 60 seconds. Expired identities are filtered on hydration. An expired owner cannot recover; a revoked or expired member cannot regain access using its old token.
- A crashed writer may leave a .lock file. This is intentionally not automatically reclaimed; a verified operator-led recovery is required after confirming there is no active writer. Unlinking live locks is forbidden.
- Atomic write consists of exclusive temporary file creation, file fsync, rename and POSIX directory fsync; Windows needs NTFS/ACL guarantees from the host. HMAC protects against accidental or unauthorized off-process modification only if the external key is kept confidential; it is not a defense against a compromised same-user process that has the key.
- A power failure can leave prior valid journal state. Restart recovery must be treated as an ambiguous action boundary, not evidence any prior CDP action ran, failed or is safe to retry.

## Critical outstanding integration gap: NO live durability claim

**The journal is not active in live CDP because default behavior intentionally stays in-memory for backward compatibility.** Worker A must wire journal initialization, exact owner identity principal, secure keystore and authoritative previous-epoch liveness proof into production. A separate authenticated MCP command is needed for recovery; owner token validation alone must not replace verified principal binding.

**The existing per-tab FIFO only serializes commands within one Core process.** Two simultaneously running Core generations could race a browser command between preflight authorization and RPC delivery, even though stale epochs fail on their next journal read. Durable journal CAS/epoch checks alone cannot atomically fence an already-dispatched browser RPC. Worker A must add an end-to-end command fence or enforce a supervisor-level single-active-generation handover. For ambiguous/in-flight commands, reject retry unless an idempotency/operation receipt proves the outcome. There is deliberately no replay queue in this journal.

A malicious caller with access to the trusted Core process, external HMAC key and journal API is outside this module's trust boundary. Filesystem locking is local-host scope; no network/distributed lease consensus is claimed.

## Verifications performed

Commands from registered project superagent, existing shared branch:

- bun --bun x vitest run tests/delegateDurableLeaseRecovery.test.ts tests/delegateCdpMultiAgentSessions.test.ts — PASS: 17/17 tests, 2 test files.
- bun --bun x tsc --noEmit — PASS (exit 0) at verification time.
- Tests cover: absence/explicit initialization; digests/no plaintext; role and revision; observer denial; invite join/expiry; owner/member expiry; revoke after restart; recovery with original owner capability; profile/tab isolation; unrecovered target quarantine; prior epoch liveness witness; fully-expired retirement; stale CAS and old-writer fencing; corrupt and missing journal; sticky fail-closed behavior; stale lock; weak key/unsafe path; and old in-memory multi-orchestrator API regression.

No commit, push, restart, daemon mutation, browser close, or live state access was performed. Orchestrator owns final integration and tab closure.
