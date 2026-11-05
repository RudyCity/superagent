# SuperAgent Global Lifecycle Recycle — Master Implementation Plan

Date: 2026-11-05  
Repository: RudyCity/superagent  
Workspace: `D:\backup from pc asus\Documents Development\superagent`  
Branch/worktree: **do not create a new branch or worktree**  
Commit/push: **not authorized by this plan**  
Status: design / implementation plan

## 1. Objective

Create one coherent **Global Lifecycle Recycle** system for SuperAgent that can migrate legacy or unverified service owners into the existing managed lifecycle without turning `recycle` into a dangerous synonym for `restart all`.

The target behavior is:

```
legacy / unverified owner
        │
        ▼
read-only evidence + owner verification
        │
        ▼
drain / graceful shutdown
        │
        ▼
managed owner startup
        │
        ▼
attestation + health verification
        │
        ▼
normal managed lifecycle from then on
```

After a successful recycle, future maintenance should use the ordinary operation for that service:

- Core → restart / rollback / drain
- MCP → reload
- Tray → restart / upgrade / rollback
- Vision → restart
- Transport / Channel Host / Muse / Telegram / Guardian / Daemon → their owner-specific start/stop/restart controls

**Recycle should normally be a one-time ownership migration, not a routine watchdog action.**

---

## 2. Current Baseline

Current runtime inspection on 2026-11-05:

| Service | Current state | Owner | Recommended lifecycle path |
|---|---|---:|---|
| Core :7888 | legacy / unverified | PID 13492 | **Recycle to supervised Core** |
| MCP :8857 | active + verified + reloadable | PID 29740 | **Keep owner; reload only** |
| Transport :7891 | inactive | — | Start after Core |
| Channel Host :7892 | inactive | — | Start when required |
| Muse | inactive | — | Start after Channel Host |
| Telegram | inactive | — | Start after Channel Host |
| Vision :8095 | alive but unverified | PID 24712 | **Add guarded recycle path** |
| Guardian | inactive | — | Start after supervised Core |
| Daemon | embedded but unavailable because Core is unsupervised | — | Verify/start after Core |
| Tray | unmanaged / legacy desktop process evidence exists | — | **Add guarded recycle path** |
| REST tunnel | inactive | — | Do not implicitly start |
| Muse tunnel | inactive | — | Do not implicitly start |
| Process Supervisor | embedded / healthy registry | — | Never directly recycle |

Existing Core recycle groundwork already implemented locally:
- distinct `recycle` operation;
- plan-first behavior;
- listener PID verification;
- process birth identity verification;
- legacy command digest verification;
- authenticated local Core probe;
- graceful `/api/shutdown`;
- build SHA-256 attestation;
- supervised Core startup;
- bearer preservation across migration;
- lifecycle timeline + operation ledger;
- native Tray lifecycle allowlist;
- tests/build currently passing.

---

## 3. Non-Negotiable Safety Invariants

1. **No arbitrary PID kill.** A PID alone never authorizes lifecycle mutation.
2. **No silent owner adoption.** Legacy → managed requires an explicit recycle plan.
3. **No recycle based only on port ownership.** Require service-specific identity and health evidence.
4. **No public tunnel rotation as a side effect.**
5. **No MCP OAuth/session migration by copying credentials between unrelated owners.**
6. **No task replay.** Started/unknown agent or Muse work is never replayed automatically.
7. **No auto-recycle from watchdog.** Watchdog may restart already-managed owners; recycle is operator-controlled.
8. **Plan and execution are separate.** Every recycle mutation uses a fresh owner-bound plan.
9. **Operation IDs are idempotency keys.** A timed-out operation is reconciled, never blindly retried using a new ID.
10. **Build identity is immutable during execution.** Build digest must match plan at mutation time.
11. **PID reuse protection is mandatory.** Persist and compare process birth identity.
12. **Graceful shutdown first.** If graceful stop is unavailable or unverified, fail closed unless that service has a separately designed authenticated native exit channel.
13. **Dependency failure stops forward rollout.**
14. **Existing managed healthy services are preserved.** Do not recycle merely because `recycle all` was requested.
15. **Quick Tunnel URLs remain untouched unless the user explicitly requests disruptive tunnel recreation.**

---

## 4. Lifecycle Vocabulary

### 4.1 Start

Use when no owner exists and a managed owner can safely be created.

### 4.2 Restart

Use only when the current owner is already authenticated / managed.

### 4.3 Reload

Use for owner-preserving backend/code reload where identity and external endpoint must stay stable. Current primary example: Reloadable MCP.

### 4.4 Recycle

Use only for:

```
legacy | unverified-but-provable owner
                 ↓
           managed owner
```

A successful recycle changes the ownership contract, not merely the PID.

### 4.5 Reconcile

Use after uncertain mutation outcome. It must never execute the mutation again.

---

## 5. Global Orchestrator Design

Add a plan-only global operation:

```
manage_services
action=plan
service=all
targetAction=recycle
```

and an explicit mutation:

```
manage_services
action=recycle
service=all
confirm=true
operationId=<global-plan-id>
...
```

The global plan must contain **per-service child plans**, each with a selected disposition:

- `KEEP`
- `START`
- `RESTART`
- `RELOAD`
- `RECYCLE`
- `VERIFY_ONLY`
- `SKIP_INACTIVE`
- `BLOCKED`

The global orchestrator itself must not infer a mutation from a simple state string. Each service adapter decides its disposition using owner evidence.

Example:

```
Core          RECYCLE       legacy verified
MCP           KEEP          verified reloadable owner
Transport     START         absent; Core dependency satisfied after Phase Core
Channel Host  SKIP_INACTIVE no configured requirement
Muse          SKIP_INACTIVE no requested remote channel
Telegram      SKIP_INACTIVE no requested remote channel
Vision        RECYCLE       legacy owner provable
Guardian      START         after Core
Daemon        VERIFY_ONLY   embedded in Core
Tray          RECYCLE       legacy native binary provable
REST tunnel   KEEP/SKIP     no implicit public ingress
Muse tunnel   KEEP/SKIP     no implicit public ingress
Supervisor    VERIFY_ONLY   embedded registry
```

---

## 6. Global Transaction State Machine

Create a durable global recycle operation record:

```
PLANNED
  ↓
PRECHECK
  ↓
DRAINING
  ↓
MIGRATING
  ↓
VERIFYING
  ↓
COMPLETED

Failure branches:
PRECHECK_FAILED
DRAIN_BLOCKED
MIGRATION_UNCERTAIN
VERIFY_FAILED
PARTIAL
RECONCILED
```

Global operation record should contain only safe metadata:

- operation hash;
- started/updated timestamps;
- selected service sequence;
- per-service disposition;
- child operation hash;
- expected owner PID;
- owner identity hash/prefix, not sensitive raw credentials;
- build digest prefix;
- result state;
- failure code;
- rollback/recovery recommendation.

Do not persist bearer tokens, OAuth tokens, public setup codes, prompts, agent output, or chat text.

---

## 7. Dependency Order

Default ordered graph:

```
Core
 ├─ Daemon
 ├─ Guardian
 └─ Transport

Channel Host
 ├─ Muse
 └─ Telegram

Vision

Tray

MCP ─ independent verified owner
Tunnels ─ preserve independently
Process Supervisor ─ embedded verification only
```

Recommended migration sequence:

1. Core
2. Daemon verification
3. Guardian
4. Transport
5. Channel Host
6. Muse / Telegram
7. Vision
8. Tray
9. final MCP continuity check
10. final tunnel continuity check
11. global Process Supervisor reconciliation

Do **not** force-start optional services. A service that was inactive before recycle stays inactive unless:
- explicitly configured `startOnBoot`; or
- it is a required dependency for another selected service.

---

## 8. Phase A — Core Recycle Completion

### A1. Finish current implementation

Modules:
- `src/core/runtime/coreLegacyRecycle.ts`
- `src/core/runtime/serviceManager.ts`
- `src/core/runtime/coreSupervisor.ts`
- `src/core/runtime/nativeTrayLifecycleBridge.ts`
- `src/core/runtime/lifecycleProfiles.ts`
- service manager MCP/agent schemas
- Tray lifecycle UI/native validator

### A2. Required behaviors

- Preserve existing Core bearer.
- Verify server-info PID equals actual listener PID.
- Verify process birth identity at plan and execution.
- Verify command is an actual SuperAgent Core direct server.
- Verify `--server <port>`.
- Verify authenticated `/api/status`.
- Refuse if a Core Supervisor checkpoint already exists; use recovery instead.
- Graceful `/api/shutdown`.
- Wait for old PID disappearance and port release.
- Start supervised Core from exact fresh build.
- Verify new public listener is owned by Core Supervisor.
- Verify active worker exists and passes authenticated readiness.
- Verify current build digest equals planned digest.
- Verify bearer continuity using a pre/post authenticated probe.
- Record lifecycle event + ledger receipt.

### A3. Core failure policy

Before legacy shutdown:
- any mismatch → abort without mutation.

After legacy shutdown but before new supervisor readiness:
- global operation becomes `MIGRATION_UNCERTAIN`;
- do not repeatedly start more supervisors;
- inspect listener + checkpoint;
- use explicit reconcile/recovery command.

### A4. Acceptance gates

- legacy Core plan succeeds on actual PID;
- fake PID rejected;
- birth mismatch rejected;
- command mismatch rejected;
- build change after plan rejected;
- stale build rejected;
- graceful-shutdown rejection leaves old Core intact;
- new supervisor attestation required;
- bearer remains usable;
- repeated same operation ID returns prior result;
- no MCP/tunnel process touched.

---

## 9. Phase B — Tray Recycle

Tray is special because a legacy GUI binary may not expose the new authenticated lifecycle endpoint.

### B1. Add legacy Tray evidence collector

New module suggestion:
`src/core/runtime/trayLegacyRecycle.ts`

Collect:
- exact executable path;
- SHA-256 digest;
- signer/product metadata if available;
- PID;
- process creation identity;
- singleton mutex/window identity;
- expected app/product name;
- whether managed Tray owner record already exists.

### B2. Graceful legacy exit channel

Preferred order:

1. authenticated lifecycle IPC if the running binary supports it;
2. native Windows window-close request to the exact verified Tray process/window;
3. if no safe graceful channel exists → **BLOCKED_USER_QUIT_REQUIRED**.

Do not downgrade to `taskkill /F`.

### B3. Binary transition

Use existing content-addressed Tray release store:

- identify trusted current project build;
- verify digest;
- stage binary;
- preserve previous digest for rollback;
- install per-user binary atomically;
- launch managed Tray;
- verify owner record, PID birth identity and executable digest;
- verify single-instance behavior.

### B4. Tray-specific continuity

Recycle Tray must not:
- restart Core;
- restart MCP;
- stop Muse;
- rotate tunnels;
- modify scheduler state;
- duplicate reminder pollers.

### B5. Acceptance gates

- legacy binary detected;
- unrelated `superagent-tray.exe` lookalike rejected by digest/product evidence;
- graceful exit verified;
- install atomic;
- new owner identity verified;
- rollback to previous digest works;
- repeated launch produces one Tray instance;
- Core/MCP PID unchanged.

---

## 10. Phase C — Vision Recycle

Current Vision is alive but unverified, so it requires a dedicated migration path.

### C1. Evidence contract

Require:
- listener PID on configured Vision port;
- process birth identity;
- command/script fingerprint;
- expected SuperAgent Vision server entry;
- authenticated or service-specific health response;
- model/runtime state;
- active request count if available;
- parent/provenance evidence where applicable.

### C2. Drain

Before recycle:

- reject new requests if server supports drain mode;
- wait for `activeRequests == 0`;
- bounded timeout;
- if request count cannot be verified → block recycle by default.

### C3. Stop

Use a service-specific authenticated shutdown endpoint.

If legacy Vision lacks one:
- add graceful local shutdown protocol first;
- do not use PID kill as the migration mechanism.

### C4. Start managed Vision

Reuse `managedVisionControl.ts` ownership contract.

Verify:
- same configured port;
- correct instance ID;
- expected build/script digest;
- health status;
- model readiness state;
- listener PID belongs to managed owner.

### C5. Acceptance gates

- active-request protection;
- stale PID rejection;
- wrong script rejection;
- graceful shutdown;
- new owner attestation;
- failed new startup leaves auditable recoverable state.

---

## 11. Phase D — Transport / Channel Host / Muse / Telegram

These services already have or are moving toward owner-specific lifecycle contracts.

### D1. Disposition rules

If inactive:
- normally `SKIP_INACTIVE`;
- `START` only if required or explicitly configured.

If managed:
- `KEEP` when healthy;
- ordinary `RESTART` only when user explicitly requests restart/repair.

If alive but legacy/unverified:
- create service-specific recycle adapter only if identity and graceful-stop protocol can be proven.

### D2. Channel Host

Recycle must preserve configured mode:
- idle;
- muse-ws;
- telegram-fallback.

Verify channel ownership independently from Core.

### D3. Muse

Before any recycle:
- no active task batch;
- no queued task batch unless explicit policy says wait;
- no task replay;
- token rotation prohibited as an implicit side effect;
- tunnel kept separate.

### D4. Telegram

Preserve credentials; never serialize token through recycle plan/UI.

No message replay or polling offset reset unless the owner-specific implementation explicitly proves continuity.

---

## 12. Phase E — MCP Policy

### E1. Verified Reloadable MCP

Current verified MCP should not be recycled by global recycle.

Disposition: `KEEP`.

Optional maintenance action: `RELOAD`, but only when explicitly requested or required by code rollout.

Verify:
- same owner identity contract;
- public URL unchanged;
- OAuth issuer/session state preserved according to current owner design;
- active sessions handled by existing reload contract.

### E2. Legacy MCP

A future `recycle legacy MCP` must be a separate project because OAuth/public endpoint continuity has different constraints.

Hard rule:
- never copy OAuth session/token state into a new unrelated owner and claim continuity;
- never restart Cloudflare Quick Tunnel as an implicit recycle step.

If continuity cannot be proven, mark:
`BLOCKED_REAUTHORIZATION_REQUIRED`.

---

## 13. Phase F — Daemon and Guardian

### Daemon

Daemon is embedded in supervised Core.

Global recycle behavior:
- before Core migration: snapshot only safe scheduler metadata;
- verify no active scheduled jobs where required;
- after Core supervised: query daemon status;
- preserve job definitions/ledger;
- do not replay an interrupted unknown run;
- explicitly classify interrupted runs.

### Guardian

Guardian must never be used to adopt a legacy Core automatically.

After Core becomes supervised:
- optionally start Guardian according to existing policy;
- verify Guardian PID and supervisor PID binding;
- watchdog restart budget applies only to managed Core failure.

---

## 14. Phase G — Process Supervisor Integration

Process Supervisor itself is embedded and should never receive generic `restart/recycle`.

Global final verification should run:

- registry parse/corruption check;
- active-owned record count;
- process birth identity mismatches;
- terminal execution reconciliation;
- stale registered/running records;
- owner/workspace boundaries.

For a process that disappeared during recycle:
- mark its record terminal/reconciled;
- never silently mutate a foreign workspace record.

---

## 15. Phase H — Global Plan Object

Add a strict type, for example:

`src/core/runtime/globalLifecycleRecycle.ts`

Plan shape:

```ts
type RecycleDisposition =
  | "keep"
  | "start"
  | "restart"
  | "reload"
  | "recycle"
  | "verify_only"
  | "skip_inactive"
  | "blocked";

type GlobalRecycleChildPlan = {
  service: ManagedServiceName;
  disposition: RecycleDisposition;
  reasonCode: string;
  operationId?: string;
  expectedOwnerPid?: number;
  expectedBuildDigest?: string;
  dependencyState: string[];
};

type GlobalRecyclePlan = {
  version: 1;
  operationId: string;
  createdAt: number;
  expiresAt: number;
  dependencyOrder: ManagedServiceName[];
  children: GlobalRecycleChildPlan[];
  publicTunnelMutationAllowed: false;
  arbitraryPidKillAllowed: false;
};
```

Plan should expire after a short bounded period, e.g. five minutes.

Execution must revalidate every child immediately before mutation.

---

## 16. Phase I — Global Execution Semantics

For every child:

### PRECHECK

- re-read listener;
- re-read owner record;
- re-read process identity;
- verify build/config digest;
- verify dependencies;
- verify no disallowed in-flight work.

### APPLY

Run exactly one owner-specific lifecycle operation.

### VERIFY

Require service-specific positive evidence.

### CHECKPOINT

Persist child result to global ledger.

### CONTINUE OR STOP

Continue only if:
- child success; or
- disposition was safe no-op such as `KEEP`, `VERIFY_ONLY`, `SKIP_INACTIVE`.

Stop global recycle on:
- ownership mismatch;
- uncertain mutation;
- health failure;
- dependency loss;
- public endpoint change;
- build mismatch;
- active-work drain timeout.

---

## 17. Rollback Strategy

There is no universal rollback command. Rollback is service-specific.

### Core

After successful migration:
- ordinary supervised rollback can move between retained generations.
- if initial recycle fails after shutdown and before supervisor verification, use explicit recovery/reconcile, not automatic repeated recycle.

### Tray

- content-addressed previous binary digest;
- transactional install rollback.

### Vision

- if new managed instance never becomes ready, do not force-start arbitrary previous PID;
- allow a well-defined previous verified build startup only if its artifact is trusted.

### MCP

- owner-preserving reload rollback only; do not rotate public tunnel.

### Channel/Muse/Telegram

- restore only through their verified owner protocol;
- never replay external tasks/messages automatically.

---

## 18. UI — SuperAgent Tray Lifecycle Console

Add a top-level mode:

**Recycle System**

UX:

1. `Analyze Recycle`
2. display a per-service table:
   - service;
   - current state;
   - owner state;
   - proposed disposition;
   - dependency;
   - risk/blocker.
3. explicit `Prepare Recycle Plan`
4. display:
   - global operation ID;
   - number of mutations;
   - number of no-ops;
   - blocked services;
   - statement that tunnels are preserved.
5. `Confirm Recycle`
6. progress timeline:
   - Precheck
   - Draining
   - Migrating
   - Verifying
   - Done / Paused
7. post-operation summary.

Never expose:
- bearer;
- OAuth token;
- command line containing secrets;
- full local sensitive paths where unnecessary.

---

## 19. CLI

Add:

```
superagent lifecycle recycle-plan
superagent lifecycle recycle
superagent lifecycle recycle-status --operation-id ...
superagent lifecycle reconcile --operation-id ...
```

Optional service-scoped variants:

```
superagent lifecycle recycle-plan --service core
superagent lifecycle recycle --service tray
```

No `--force` flag.

If an override is ever needed, it must be a specific evidence override, not a generic force switch.

---

## 20. MCP / Agent Surface

Extend `superagent_manage_services` and `manage_services` with:

- `action=plan service=all targetAction=recycle`
- `action=recycle service=all`

Plan response should be safe to inspect.

Mutation requires:
- `confirm=true`;
- global operation ID;
- plan fingerprint/revision;
- all required child attestations.

The agent must never synthesize missing child identities itself.

---

## 21. Watchdog Policy

Do not add recycle to automatic watchdog actions.

Recommended policy:

```
managed + unhealthy
    → restart using existing owner

legacy / unverified
    → report "recycle available"
    → operator action required
```

After all critical services are migrated, watchdog can handle ordinary managed failures without needing recycle.

---

## 22. Observability

Add lifecycle timeline events:

- `global_recycle_plan`
- `global_recycle_started`
- `child_precheck`
- `child_drain_started`
- `child_migration_started`
- `child_verified`
- `child_blocked`
- `global_recycle_partial`
- `global_recycle_completed`
- `global_recycle_reconciled`

Metrics:
- recycle attempts by service;
- verified success;
- blocked before mutation;
- uncertain after mutation;
- average drain time;
- average migration time;
- identity mismatches;
- build mismatches;
- public endpoint continuity violations.

No raw secrets in telemetry.

---

## 23. Testing Plan

### Unit tests

- disposition planner;
- dependency ordering;
- plan expiration;
- identity mismatch;
- build mismatch;
- operation ID idempotency;
- child failure stops graph;
- no auto-start of optional inactive service;
- MCP `KEEP` when verified;
- tunnels never implicitly mutate;
- Process Supervisor never receives recycle.

### Service integration tests

Core:
- direct legacy → supervised.

Tray:
- legacy binary → managed binary.

Vision:
- legacy listener → managed Vision.

Channel services:
- inactive skip;
- managed keep;
- busy Muse recycle rejection.

### Fault injection

At each transition:
- process exits before shutdown request;
- PID reused;
- port changes owner;
- build changes;
- server stops but port remains occupied;
- new owner starts but health fails;
- owner is healthy but attestation endpoint fails;
- operation response times out after successful mutation;
- lifecycle ledger lock remains;
- machine/process crash during child migration.

### Security tests

- forged server-info;
- symlinked owner files;
- malicious command-line lookalike;
- fake `superagent-tray.exe`;
- non-loopback lifecycle request;
- forwarded/browser-origin request;
- arbitrary service/action fields;
- malformed identities;
- old operation ID against changed owner;
- injected URL/path/command through MCP schema.

### Regression gates

- complete TypeScript build;
- focused lifecycle Vitest;
- Process Supervisor tests;
- MCP reload tests;
- Tray native Rust tests;
- Tauri debug build;
- existing Core supervisor suite;
- daemon scheduler tests;
- Muse lifecycle tests.

---

## 24. Live Acceptance Sequence

Use a development workstation with current services.

### Gate 1 — read-only

Run global recycle plan and verify:
- Core = recycle;
- MCP = keep;
- Vision = recycle or blocked with specific reason;
- inactive optional services = skip;
- Tray = recycle or blocked-user-quit;
- tunnels unchanged.

No PID changes in this gate.

### Gate 2 — Core only

Recycle Core.

Verify:
- old PID gone;
- new Supervisor listener verified;
- worker ready;
- same Core bearer accepted;
- MCP PID unchanged;
- MCP public URL unchanged;
- no tunnel PID changed.

### Gate 3 — dependent services

Verify daemon and start/verify Guardian/Transport only according to desired config.

### Gate 4 — Vision

Recycle once identity contract is complete.

### Gate 5 — Tray

Recycle/install managed Tray.

### Gate 6 — global dry run again

Expected result after migration:
- Core = KEEP / managed;
- MCP = KEEP;
- Vision = KEEP / managed;
- Tray = KEEP / managed;
- all legacy migration dispositions disappear.

That second plan is the strongest proof that recycle achieved ownership convergence.

---

## 25. Implementation Order

### P0 — Stabilize Core recycle

- finish full Core tests;
- add continuity test for auth bearer;
- add operation reconciliation test;
- live Core recycle acceptance.

### P0 — Tray recycle

- owner evidence;
- graceful exit;
- trusted binary staging;
- managed owner verification;
- rollback.

### P0 — Vision recycle

- legacy identity;
- active-request drain;
- graceful endpoint;
- managed launch + attestation.

### P1 — Global planner

- disposition engine;
- dependency graph;
- global plan object;
- dry-run output.

### P1 — Global executor

- durable ledger;
- child sequencing;
- stop-on-uncertain behavior;
- reconciliation.

### P1 — Tray Lifecycle UI

- Analyze Recycle;
- per-service disposition;
- plan review;
- progress/timeline;
- partial failure UI.

### P1 — CLI / MCP parity

- CLI commands;
- MCP schema;
- agent tool schema;
- help/docs.

### P2 — Fault injection and recovery

- crash windows;
- PID reuse;
- stale locks;
- post-mutation timeout;
- machine restart evidence.

### P2 — Production release gate

- full regression suite;
- packaged Tray test;
- installed Windows smoke;
- documentation;
- rollback drill.

---

## 26. Definition of Done

Global Lifecycle Recycle is complete only when all are true:

1. Core legacy can be safely recycled into a supervised owner.
2. Tray legacy can be safely recycled into a managed owner without user taskkill.
3. Vision legacy can be recycled with drain + identity verification.
4. Verified MCP is preserved and never unnecessarily recycled.
5. Tunnel public URLs are never changed by global recycle.
6. Optional inactive services remain inactive by default.
7. Global planner returns deterministic dispositions.
8. Global executor stops on uncertain outcome.
9. Every mutation is plan-bound and idempotent.
10. Same operation ID cannot perform a second mutation.
11. PID reuse and owner change are detected.
12. Build change after plan is detected.
13. Global timeline supports postmortem/reconciliation.
14. Native Tray, CLI, MCP and agent management surfaces share the same backend contract.
15. Watchdog does not auto-recycle legacy owners.
16. After migration, a second global plan reports critical services as managed `KEEP`, not `RECYCLE`.
17. Focused tests, TypeScript build, Rust tests and Tauri build pass.
18. Live Windows acceptance proves Core/MCP/tunnel continuity.
19. No unrelated existing user work is reverted.
20. No new branch/worktree is required.

---

## 27. Immediate Next Work

Recommended next implementation sequence from the current working tree:

1. Complete and live-test the already implemented Core recycle.
2. Implement **Tray legacy recycle**, eliminating `TRAY_LEGACY_PROCESS_REQUIRES_USER_QUIT` where identity can be safely proven.
3. Implement **Vision legacy recycle** for current unverified Vision owner.
4. Add the global disposition planner and dry-run.
5. Add global durable orchestration/reconciliation.
6. Add Recycle System UI in SuperAgent Tray.
7. Run complete lifecycle regression + live acceptance.
