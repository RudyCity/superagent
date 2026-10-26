# R0 — Runtime Ownership Contract v1 and audit acceptance

**Status (2026-10-26):** first implementation of the revised master plan, read-only. Source: `src/core/runtime/runtimeOwnershipContract.ts`. Existing audit: `src/core/runtime/coreMcpOwnershipAudit.ts`.

## Architecture decision R0-001

Separate **observation** from **control authority**. A stored PID, a live TCP listener and even two matching samples do not grant authority to stop or adopt that process. A Core supervisor must also answer through its authenticated control channel; the kernel listening PID must match the authenticated supervisor PID. MCP states have no equivalent proven authenticated control identity yet, so their state can only be described as `os_pid_correlated_only` and **never** as a verified authority. All R0 inventory output explicitly denies process restart, OAuth transfer, session migration and tool replay.

Do not serialize raw bearer tokens, issuer URLs, workspace paths, command lines, OAuth client IDs, external tunnel URLs or chat/tool payloads in topology reports. These belong only in separately permissioned source systems. There is no implied live OAuth connectivity proof from local state.

R0 intentionally **does not** install a service manager, infer process birth time, migrate an issuer, drain active sessions, rebind an endpoint or adopt unknown legacy owners. Those require R1–R7 acceptance criteria.

## Local read-only command

    superagent core ownership-inventory --port 7888

This:
1. Takes a first Windows kernel TCP LISTENING snapshot.
2. Reads only numeric MCP state records from the existing user metadata directory. Distinguishes absent/unreadable directory and malformed candidate server records. Non-server settings such as `mcp-tool-exposure.json` are not classified as broken listener records.
3. Queries Core's existing authenticated supervisor control `GET /status`, if available. Does not perform POST or a new session initialization.
4. Takes a second kernel snapshot and compares only the tracked Core/MCP ports, detecting process churn/PID replacement.
5. Applies the existing `auditCoreMcpOwnership()` policy plus strict additional blockers.
6. Emits JSON `schemaVersion:1`, `mode:"read_only_inventory"`, individual evidence classifications, explicit blockers, and **all action authorization booleans set false**.

### Contract semantics

| Field | Meaning | NOT a guarantee of |
|---|---|---|
| `core.state=verified_supervisor` | Two stable OS listener snapshots + authenticated status, with matching PID and port | A right to stop or hand over it |
| `mcp.state=os_pid_correlated_only` | Saved MCP PID matches the kernel listener PID | OAuth issuer identity, authority to stop, drain completion |
| `listenerSamplesStable=false` | Listener evidence missing, not supported, or changed | That no listener exists |
| `stateFiles.rejected>0` | Malformed/unreadable numeric MCP server candidate metadata | That the corresponding port can be claimed |
| `ownershipTopology=shared_owner_do_not_cutover` | Existing API and MCP are associated with the same OS process | A recoverable client session elsewhere |
| `blockers` | Reasons to halt automation and require operator investigation | Clearance after being manually dismissed |

`readListenerOwners()` is implemented for Windows netstat only. Other operating systems report unknown rather than hallucinating a verified PID. The R0 contract is not the service-control API.

## Validated baseline and rollout blockers

At this audit, Core 7888 and MCP OAuth 6789 share OS PID 13424. MCP OAuth 9877 is owned by PID 10060. No authenticated supervisor controls Core 7888. The correct result is **shared_owner_do_not_cutover** with `CORE_OWNER_NOT_AUTHENTICATED` and `CORE_AND_MCP_SHARE_KERNEL_PID` blockers. No production listener is restarted.

The R0 inventory also shows that a saved OAuth MCP server state does not prove the validity or activity of its external OAuth sessions or tunnel. R1 must add an authenticated host health/capability contract and actual drain observability, separate from public OAuth endpoints.

## Unit and regression acceptance

    bun run build
    bun --bun x vitest run --maxWorkers=2 tests/runtimeOwnershipContract.test.ts tests/coreMcpOwnershipAudit.test.ts
    bun dist/cli.js core ownership-inventory --port 7888

Tests inject synthetic Windows kernel samples, stale/corrupt metadata, malformed IDs, changing PIDs and injected authenticated Core statuses; they never signal or modify production processes. The actual local CLI inventory also runs without modifying files. Windows and Linux CI run the policy tests, with unsupported OS listener introspection remaining unknown by design.

## Remaining R0 work leading to R1

- Add per-owner process birth identity and start-time evidence rather than trusting reused PIDs (R1).
- Document the exact Core and MCP HTTP capability/identity handshake in a shared, versioned protocol (R1).
- Distinguish tunnel process ownership from MCP HTTP owner; report publisher/issuer/resource without disclosing URLs or secrets (R3).
- Obtain actual drain/in-flight operation counts and authenticated MCP owner identity before any production cutover (R1/R3).
- Test installed T-Line runtime versions, not only source mode (R4).
- Maintain production listener and credential state unchanged until R7 manual rollout.

**Master plan:** `docs/plans/2026-10-26-runtime-ownership-and-safe-recovery-master-plan.md`.
