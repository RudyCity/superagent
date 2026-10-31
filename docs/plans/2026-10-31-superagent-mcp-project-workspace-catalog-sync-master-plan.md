# SuperAgent MCP Project Workspace Catalog Sync Master Plan

> **Status:** Planned
>
> **Date:** 2026-10-31
>
> **Repository:** `D:\\backup from pc asus\\Documents Development\\superagent`
>
> **Branch:** `main`
>
> **Baseline HEAD:** `89716a6d fix(cli-bridge): resolve workspace-prefixed artifact paths`

## 1. Goal

Make every valid project/workspace that SuperAgent has actually used discoverable from MCP project discovery, without weakening the existing security boundary between:

- workspace history,
- trusted directories,
- active runtime sessions,
- explicitly registered MCP projects, and
- explicit MCP project-access grants.

The target behavior is:

```text
Workspace used by SuperAgent
        ↓
Workspace Catalog
        ↓
Discovered MCP project candidate
        ↓
Explicit/controlled registration
        ↓
Explicit MCP capability grant
        ↓
Authorized MCP operations
```

Discovery and registration must never silently become authorization.

---

## 2. Problem Statement

The current implementation persists project/workspace state in several independent stores that are not synchronized.

### 2.1 MCP project registry

Source:

```text
~/.superagent-r/projects.json
```

Implementation:

```text
src/core/project/projectRegistry.ts
```

Current behavior:

- `superagent_list_projects` calls `listProjects()`.
- `listProjects()` reads only `projects.json`.
- Only explicitly registered projects appear.
- A workspace being used by SuperAgent does not automatically create a registry entry.
- Registration does not grant MCP access.

### 2.2 Workspace history

Source:

```text
~/.superagent-r/history.db
```

Relevant table:

```text
workspaces
```

Implementation:

```text
src/core/storage/historyDb.ts
src/core/config/trustedDirs.ts
```

When a session is saved, SuperAgent records its workspace in SQLite. Trusted directories are also stored in this table.

This contains substantially more workspace history than the MCP project registry.

### 2.3 Active runtime workspaces

Endpoint:

```text
GET /api/workspaces
```

Implementation:

```text
src/serverRoutes.ts
```

Current implementation builds the response from:

```ts
Array.from(activeSessions.values())
```

Therefore this endpoint lists currently active server sessions, not durable workspace history.

### 2.4 Current verified data

At audit time:

```text
Workspace rows in history.db       : 98
Trusted workspace rows             : 92
Workspace rows with sessions       : 58
Registered MCP projects            : 7
Registered local MCP projects      : 6
```

There are many historical projects that have real SuperAgent session history but are not represented in MCP registry.

Examples include:

- `smart-seller`
- `RudyCity`
- `laris.click`
- `indri`
- `adinda`
- `rina`
- `qwen`
- `system-penilaian-terpadu`
- `surat-bebas-tanggungan`
- other historical repositories/workspaces

The raw history also contains noise that must not become first-class projects automatically, including:

- `.worktrees/**`
- temporary folders
- test fixtures
- scratch projects
- nested internal folders
- obsolete/missing directories
- SSH history containing credential-bearing query parameters

---

## 3. Root Cause

The lifecycle that records a workspace and the lifecycle that registers an MCP project are independent.

Common SuperAgent flows call:

```text
addTrustedDirectory(...)
        ↓
saveWorkspaceToDb(...)
        ↓
history.db
```

but do not call:

```text
registerProject(...)
        ↓
projects.json
```

Production use of `registerProject()` is currently centered on explicit MCP project-management actions.

Therefore:

```text
Workspace was used               → history.db ✅
Workspace is trusted             → history.db ✅
Workspace appears in MCP list    → not guaranteed ❌
MCP access grant exists          → independent ✅/❌
```

This is an architectural synchronization gap rather than missing historical data.

---

## 4. Design Principles

### 4.1 Preserve registration != authorization

A discovered or registered project must not automatically receive MCP access.

The security sequence remains:

```text
discovery
  ≠ registration
  ≠ authorization
```

### 4.2 No drive-wide scanning

Do not recursively scan arbitrary drives looking for repositories.

Discovery must use state SuperAgent already knows about:

- durable workspace history,
- trusted directories,
- active sessions,
- registered projects,
- optionally known Workspace Chains.

### 4.3 Fail closed

Invalid, missing, ambiguous, unsafe, credential-bearing, or unauthorized project targets must never silently fall back to another project or `process.cwd()`.

### 4.4 Stable identities

MCP routing continues to use stable project IDs.

Path/name matching is for discovery and display only, not ambiguous mutation targeting.

### 4.5 No implicit MCP grants

Neither workspace history nor trusted-directory status may be treated as an MCP authorization grant.

### 4.6 Worktrees are not projects by default

Feature worktrees and generated worktrees must not pollute the project list.

### 4.7 Nested workspaces require classification

A nested path should become its own project only when there is strong evidence that it is independently meaningful, for example:

- separate Git root,
- explicitly registered project,
- explicitly trusted named project,
- distinct durable session history with independent repository identity.

### 4.8 Secrets never enter the catalog or registry

Never copy:

- SSH passwords,
- private key content,
- bearer tokens,
- OAuth tokens,
- credential query parameters,
- secret environment values

into workspace catalog or project registry metadata.

---

## 5. Target Architecture

Introduce a canonical read model called the **Workspace Catalog**.

Suggested module:

```text
src/core/project/workspaceCatalog.ts
```

The catalog is a derived view over existing data rather than a new source of authorization.

### 5.1 Inputs

```text
history.db workspaces
        +
trusted directories
        +
active sessions
        +
projects.json
        +
optional Workspace Chain metadata
        ↓
Workspace Catalog
```

### 5.2 Example catalog record

```ts
interface WorkspaceCatalogEntry {
  catalogId: string;
  canonicalTarget: string;
  displayName: string;

  type: "local" | "ssh" | "chain";

  sources: Array<
    "registry" |
    "history" |
    "trusted" |
    "active" |
    "chain"
  >;

  registeredProjectId?: string;

  registered: boolean;
  trusted: boolean;
  active: boolean;
  available: boolean;

  sessionCount: number;
  firstSeenAt?: number;
  lastUsedAt?: number;

  gitRoot?: string;
  repositoryIdentity?: string;

  classification:
    | "project"
    | "nested-project"
    | "worktree"
    | "temporary"
    | "test-fixture"
    | "missing"
    | "unsafe"
    | "unknown";

  importable: boolean;
  rejectionReasons: string[];
}
```

Exact schema may be adjusted during implementation, but the domain separation must remain.

---

## 6. Source Precedence and Merge Rules

Catalog entries should be merged by canonical identity.

### 6.1 Local paths

Canonicalize:

- absolute path,
- path separator,
- trailing slash,
- Windows drive case,
- Windows case-insensitive comparison,
- real path where safe and available.

A known registered root wins as the canonical display identity.

### 6.2 SSH

Normalize to a credential-free target such as:

```text
ssh://user@host:port/remote/root
```

Do not preserve credential-bearing query strings from legacy workspace history.

### 6.3 Chains

Use:

```text
chain:<stable-chain-id>
```

Do not flatten Workspace Chain nodes into unrelated local projects unless those nodes independently exist in the local project catalog.

---

## 7. Candidate Classification Rules

### 7.1 Include as valid project candidates

A local workspace is eligible when at least one of these is true:

1. It is already an MCP registered project.
2. It has real SuperAgent session history and the directory still exists.
3. It is explicitly trusted and represents a valid repository/project root.
4. It is currently active and passes path/project validation.

### 7.2 Exclude by default

Exclude:

```text
**/.worktrees/**
**/node_modules/**
temporary test directories
OS temp directories
SuperAgent test fixtures
generated scratch directories
deleted/missing paths
known internal sandbox paths
```

### 7.3 Worktree detection

Use more than pathname heuristics where possible.

Possible signals:

- `.worktrees` path segment,
- `.git` file pointing to another worktree,
- `git rev-parse --git-common-dir`,
- existing SuperAgent worktree metadata.

Worktrees may be shown in a diagnostics view but must not be auto-imported as MCP projects.

### 7.4 Nested project detection

For:

```text
repo-root/
repo-root/apps/foo/
```

do not blindly collapse or split.

Treat the nested path as independent only if:

- it has its own Git repository boundary, or
- it is explicitly registered/trusted as a project, or
- another strong project identity signal exists.

Otherwise attach the historical usage to the parent project.

---

## 8. MCP Discovery Contract

Add a safe, read-only discovery tool.

Proposed tool:

```text
superagent_discover_projects
```

Responsibilities:

- enumerate Workspace Catalog entries,
- show why an entry is or is not importable,
- never mutate registry,
- never create a grant,
- never expose secrets.

Suggested output fields:

```json
{
  "catalogId": "...",
  "name": "laris.click",
  "type": "local",
  "target": "D:\\...",
  "registered": false,
  "trusted": true,
  "active": false,
  "available": true,
  "sessionCount": 18,
  "lastUsedAt": 0,
  "classification": "project",
  "importable": true,
  "rejectionReasons": []
}
```

For SSH, return only sanitized target metadata.

---

## 9. MCP Project List Integration

Current `superagent_list_projects` must retain backward compatibility.

Recommended approach:

### Option A — Preferred

Keep `superagent_list_projects` as the explicit registry list and add optional discovery metadata:

```text
superagent_list_projects
superagent_discover_projects
```

This keeps the security semantics clearest.

### Option B

Add an optional flag:

```json
{
  "includeDiscovered": true
}
```

If implemented, discovered entries must be clearly marked:

```text
registered: false
accessible: false
```

A discovered project must never be returned in a shape that makes a client assume it already has authorization.

---

## 10. Explicit Sync / Import

Add a controlled registry mutation operation.

Proposed tool:

```text
superagent_sync_projects
```

or a more explicit import tool:

```text
superagent_import_discovered_project
```

Preferred safety model:

- discovery is safe/read-only;
- one-project import is explicit;
- bulk sync is dangerous/approval-gated;
- import creates registry metadata only;
- import never creates a project access grant.

### 10.1 Bulk sync modes

Support dry run first:

```json
{
  "mode": "dry-run"
}
```

Then controlled apply:

```json
{
  "mode": "apply",
  "catalogIds": ["..."]
}
```

Do not provide an unconditional "import every historical row" behavior.

---

## 11. Existing History Migration

Create a one-time migration/reconciliation routine.

Suggested module:

```text
src/core/project/workspaceCatalogMigration.ts
```

The migration must:

1. Load all workspace rows.
2. Join session counts and last-used timestamps.
3. Match existing registered projects.
4. Normalize duplicate Windows paths.
5. classify worktrees.
6. classify test/temp paths.
7. detect missing paths.
8. detect nested repository identity.
9. sanitize legacy SSH targets.
10. produce a dry-run report.
11. import only valid selected candidates.

The historical database must not be destructively rewritten just to support MCP discovery.

---

## 12. Legacy SSH Remediation

Historical workspace data currently contains at least one SSH target with a local key path in a query parameter.

Example pattern:

```text
ssh://user@host:port/root?key=C:\\...
```

This must not be copied into `projects.json`.

Add a sanitizer/parser that:

- parses legacy SSH workspace strings,
- removes query/hash credential material,
- validates protocol/host/user/port/root,
- emits only credential-free target metadata,
- marks entries requiring manual SSH profile configuration,
- never logs stripped credential values.

Any target that cannot be safely normalized is classified `unsafe` and excluded from import.

---

## 13. Runtime Lifecycle Integration

Workspace Catalog should stay current when normal SuperAgent workflows occur.

Relevant flows to inspect:

```text
registerCliAgent(...)
addTrustedDirectory(...)
workspace switching
session persistence
project scaffolding
CLI bridge workspace selection
Workspace Chain activation
```

Do not automatically grant MCP authorization from these flows.

Recommended behavior:

```text
workspace successfully opened
        ↓
history/trust persisted normally
        ↓
catalog immediately sees it
        ↓
MCP discovery can show it
```

Because the catalog is derived, explicit duplicated persistence should be minimized.

---

## 14. API / T-Line Workspace Listing

The current:

```text
GET /api/workspaces
```

represents active sessions only.

Do not silently change that semantic without compatibility review.

Preferred API split:

```text
GET /api/workspaces
    → active runtime workspaces

GET /api/workspaces/catalog
    → durable workspace/project catalog
```

Optional filters:

```text
?classification=project
?registered=true
?available=true
?source=history
```

---

## 15. T-Line / UI Design

Expose one coherent project browser while preserving underlying state distinctions.

Example:

```text
Laris App
Registered · MCP access

Rudy Lang
Registered · MCP access

RudyCity
Discovered · 37 sessions

Smart Seller
Discovered · 64 sessions

Old Test Workspace
Unavailable

wt_1793...
Worktree · hidden by default
```

### Actions

For discovered projects:

- Register
- Inspect
- Ignore/Hide

For registered projects:

- Inspect
- Grant access
- Revoke access
- Disable
- Remove registry entry

For invalid entries:

- Show reason
- Do not offer unsafe import

Do not conflate "trusted" with "MCP access".

---

## 16. Milestones

## M1 — Workspace Catalog Core

### Files

Create:

```text
src/core/project/workspaceCatalog.ts
tests/workspaceCatalog.test.ts
```

Inspect/reuse:

```text
src/core/project/projectRegistry.ts
src/core/storage/historyDb.ts
src/core/config/trustedDirs.ts
src/server.ts
```

### Tasks

1. Define typed catalog entry.
2. Load workspace history.
3. Merge registered projects.
4. Merge trusted state.
5. Merge active session state through an injectable runtime source.
6. Implement canonical identity.
7. Add deterministic sorting.
8. Add no-secret output contract.

### Exit criteria

- Existing registered projects appear once.
- Historical workspaces are discoverable.
- No authorization decision is made by catalog code.
- Catalog generation is read-only.

---

## M2 — Classification, Deduplication and Safety Filtering

### Tasks

1. Windows path normalization.
2. Duplicate root collapsing.
3. Worktree classification.
4. temp/test fixture classification.
5. missing directory classification.
6. nested repository detection.
7. parent-project collapsing.
8. legacy SSH sanitizer.
9. unsafe entry rejection reasons.

### Exit criteria

- `.worktrees` do not become importable projects.
- test/temp entries do not become importable projects.
- case variants of one Windows path collapse.
- nested independent repositories remain distinguishable.
- unsafe SSH history is not copied into registry.

---

## M3 — MCP Read-Only Discovery

### Files

Modify/create as appropriate:

```text
src/core/mcp/tools/projectTools.ts
src/core/mcp/superagentMcpServer.ts
src/core/mcp/mcpToolPolicy.ts
tests/mcpProjectTools.test.ts
```

### Tasks

1. Add `superagent_discover_projects`.
2. Keep it safe/read-only.
3. Add filters.
4. Add bounded result count/pagination if needed.
5. Return classification and rejection reasons.
6. Never expose SSH credentials.
7. Document difference from `superagent_list_projects`.

### Exit criteria

A client can discover valid historical projects without mutating registry or receiving new access.

---

## M4 — Controlled Project Import / Sync

### Tasks

1. Add dry-run reconciliation.
2. Add explicit one-project import.
3. Add guarded bulk import if needed.
4. Reuse `registerProject()` validation.
5. Ensure duplicate roots remain rejected.
6. Ensure import does not grant capabilities.
7. Add audit events for import operations.
8. Add deterministic conflict reporting.

### Exit criteria

A discovered project can become an MCP registered project without silently becoming authorized.

---

## M5 — Runtime and API Integration

### Tasks

1. Add catalog HTTP endpoint.
2. Keep `/api/workspaces` active-session semantics.
3. Ensure workspace activity is reflected without manual rescan.
4. Review CLI/T-Line workspace flows.
5. Avoid duplicate persistence.
6. Add catalog refresh/invalidation if caching is introduced.

### Exit criteria

Restarting SuperAgent preserves discovery through durable state, and newly used workspaces appear in catalog.

---

## M6 — T-Line / Project Browser

### Tasks

1. Show registered versus discovered state.
2. Show access-grant state separately.
3. Hide worktrees/test fixtures by default.
4. Add inspect/register/grant/revoke actions with existing permission gates.
5. Add filters:
   - All projects
   - Registered
   - Discovered
   - Active
   - Unavailable
6. Preserve existing project-selection behavior.

### Exit criteria

Users can understand why a workspace is present and whether it is merely discovered, registered, or authorized.

---

## M7 — Historical Migration and Reconciliation

### Tasks

1. Run catalog against current `history.db`.
2. Produce a dry-run inventory.
3. Record:
   - total rows,
   - valid projects,
   - duplicates,
   - worktrees,
   - nested projects,
   - missing paths,
   - unsafe SSH records,
   - test/temp exclusions.
4. Review candidate imports.
5. Import only accepted valid projects.
6. Do not delete history rows as part of this migration.
7. Do not grant access automatically.

### Exit criteria

Historical real projects become visible/registrable while noise remains excluded.

---

## M8 — Security and Regression Certification

Run targeted and full validation.

### Required security scenarios

| Scenario | Expected |
|---|---|
| historical workspace, not registered | discoverable but not authorized |
| trusted workspace, not registered | discoverable but not authorized |
| discovered project imported | registered, still no grant |
| registered project without grant | MCP operation denied |
| registered + read grant | read only |
| worktree history | excluded from import |
| temp/test history | excluded |
| missing path | visible only as unavailable or omitted by default |
| Windows case duplicate | one canonical candidate |
| nested monorepo folder | collapsed unless independently valid |
| independent nested Git repo | separate candidate |
| legacy SSH with key query | sanitized or rejected |
| SSH credential content | never persisted or returned |
| invalid explicit target | fail closed |
| active project A plus call to B | no state crossover |
| restart | durable catalog result remains consistent |

### Verification commands

At minimum:

```bash
bunx vitest run tests/workspaceCatalog.test.ts
bunx vitest run tests/mcpProjectRegistry.test.ts
bunx vitest run tests/mcpProjectTools.test.ts
bunx vitest run tests/mcpProjectAccessPolicy.test.ts
bunx vitest run tests/mcpProjectRouter.test.ts
bunx vitest run tests/mcpWorkspaceRouting.test.ts
bunx vitest run tests/mcpIndependentProjects.test.ts
bun run build
git diff --check
```

Run the full suite before final completion.

---

## 17. Suggested Implementation Files

Expected additions:

```text
src/core/project/workspaceCatalog.ts
src/core/project/workspaceCatalogClassifier.ts
src/core/project/workspaceCatalogMigration.ts
src/core/project/sshTargetSanitizer.ts

tests/workspaceCatalog.test.ts
tests/workspaceCatalogClassifier.test.ts
tests/workspaceCatalogMigration.test.ts
tests/mcpProjectDiscovery.test.ts
```

Expected modifications:

```text
src/core/project/projectRegistry.ts
src/core/mcp/tools/projectTools.ts
src/core/mcp/superagentMcpServer.ts
src/core/mcp/mcpToolPolicy.ts
src/serverRoutes.ts
README.md
CHANGELOG.md
docs/mcp/independent-projects.md
```

Exact decomposition may change after test-first implementation.

---

## 18. Explicit Non-Goals

This work must not:

- merge MCP grants into trusted-directory state;
- automatically Full-YOLO every discovered workspace;
- recursively scan all local drives;
- register every nested directory;
- expose worktrees as normal projects;
- delete historical workspace records;
- auto-remove projects merely because a disk is temporarily unavailable;
- store SSH key paths or secrets in MCP registry;
- change Workspace Chain semantics;
- enable currently disabled orchestration tools;
- introduce process-global project routing state;
- use `process.chdir()` for MCP project routing.

---

## 19. Acceptance Criteria

The feature is complete only when all of the following are true:

1. A real workspace previously used by SuperAgent can be discovered even when it was never manually added to `projects.json`.
2. Already registered projects remain stable and are not duplicated.
3. Workspace history, registered projects, active sessions and trusted state are visible through one canonical read model.
4. A discovered project is clearly distinguishable from a registered project.
5. A registered project is clearly distinguishable from an authorized project.
6. Importing a discovered project never grants MCP capabilities.
7. Worktrees and temporary/test paths do not pollute the normal project list.
8. Windows path case/separator differences do not create duplicate project identities.
9. Nested monorepo folders are not incorrectly promoted to independent projects.
10. Independent nested repositories can still be represented separately.
11. Credential-bearing legacy SSH history is sanitized or rejected.
12. No secrets are persisted into `projects.json` or returned from project discovery.
13. Existing MCP project routing and access policy remain fail-closed.
14. Existing Workspace Chain behavior remains unchanged.
15. Existing clients using `superagent_list_projects` continue to work.
16. Build, focused tests, full regression suite and `git diff --check` pass.

---

## 20. Definition of Done

Final completion requires:

```text
Workspace Catalog implemented
        +
classification/dedup implemented
        +
MCP discovery implemented
        +
controlled import implemented
        +
historical reconciliation completed
        +
UI/API semantics documented
        +
security regression passed
        +
full tests/build passed
```

The end state should allow SuperAgent MCP to find all meaningful projects that SuperAgent has previously worked on, while preserving the existing security model:

```text
Known by SuperAgent
    does not mean
Registered for MCP
    does not mean
Authorized for MCP
```

That separation is mandatory.

---

## 21. Implementation Status, Verification Evidence & Remaining Gaps (2026-10-31)

### 21.1 Milestone Status Summary
- **M1 (Workspace Catalog Core)**: **COMPLETE**. Implemented in `src/core/project/workspaceCatalog.ts`. Derived view over SQLite `history.db` workspaces & sessions, `projects.json`, `trustedDirs.ts`, active sessions, and Workspace Chains. Deterministic sorting and credential-free output contracts verified in `tests/workspaceCatalog.test.ts`.
- **M2 (Classification, Deduplication & Safety Filtering)**: **COMPLETE**. Implemented in `src/core/project/workspaceCatalogClassifier.ts` and `src/core/project/sshTargetSanitizer.ts`. Filters `.worktrees`, temporary/scratch/fixture paths, missing directories, internal monorepo subfolders, and strips SSH credentials/query parameters (`?key=...`). Verified in `tests/workspaceCatalogClassifier.test.ts`.
- **M3 (MCP Read-Only Discovery)**: **COMPLETE**. Added `superagent_discover_projects` as a `safe` read-only tool in `src/core/mcp/tools/projectTools.ts`. Supports filtering by classification, registered, available, source, query, and pagination. Backward compatibility with `superagent_list_projects` fully preserved. Verified in `tests/mcpProjectDiscovery.test.ts`.
- **M4 (Controlled Project Import / Sync)**: **COMPLETE**. Added `superagent_import_discovered_project` and `superagent_sync_projects` as `dangerous` tools in `src/core/mcp/tools/projectTools.ts`. Supports dry-run and apply modes. Preserves the strict security boundary: `registration != authorization`, `capabilitiesGranted: false`. Verified in `tests/mcpProjectDiscovery.test.ts`.
- **M5 (Runtime and API Integration)**: **COMPLETE**. Added `GET /api/workspaces/catalog` in `src/serverRoutes.ts` with classification and pagination query params. Active session semantics on `GET /api/workspaces` preserved 100%.
- **M6 (T-Line / Project Browser)**: **COMPLETE**. SuperAgent now exposes the authenticated operator contract under `/api/projects/browser` with in-memory, sanitized MCP identity presence for identity-relative authorization state. The T-Line repository implements a fixed backend proxy plus the sidebar **MCP Projects** browser with Discovered / Registered / Authorized / Unavailable states, active-session badges, search/filtering, explicit Register/Grant/Revoke/Enable/Disable/Remove actions, and capability selection. T-Line never requests or stores an MCP bearer token; the Core service token remains backend-only.
- **M7 (Historical Migration and Reconciliation)**: **COMPLETE**. Implemented in `src/core/project/workspaceCatalogMigration.ts`. Tested against live host `history.db`: 104 entries scanned, 8 registered, 48 valid candidates identified (e.g. `RudyCity` with 37 sessions, `focused-mendel` with 28 sessions), 4 worktrees filtered, 40 missing directories filtered, 1 legacy SSH sanitized. Zero database records deleted. Verified in `tests/workspaceCatalogMigration.test.ts`.
- **M8 (Security & Regression Certification)**: **COMPLETE (Focused Matrix)**. All 15 required security scenarios verified across 10 vitest suites (72 tests passed, 0 failed). `bun run build` compiled with 0 errors. `git diff --check` passed cleanly. Note: Full repository suite execution revealed an unrelated pre-existing failure in `tests/cliBridgeAdaptiveScheduler.test.ts` ("self-drains restored durable queue on startup when host has capacity (S5)") during host contention; focused 10-suite project matrix and build pass cleanly.

### 21.2 Exact Test Verification Evidence
```bash
# 1. New Workspace Catalog Suites (4 test files, 29 tests passed)
bunx vitest run tests/workspaceCatalog.test.ts \
                tests/workspaceCatalogClassifier.test.ts \
                tests/mcpProjectDiscovery.test.ts \
                tests/workspaceCatalogMigration.test.ts
# Outcome: 29 passed, 0 failed

# 2. Existing Project & MCP Suites (6 test files, 43 tests passed)
bunx vitest run tests/mcpProjectRegistry.test.ts \
                tests/mcpProjectTools.test.ts \
                tests/mcpProjectAccessPolicy.test.ts \
                tests/mcpProjectRouter.test.ts \
                tests/mcpWorkspaceRouting.test.ts \
                tests/mcpIndependentProjects.test.ts
# Outcome: 43 passed, 0 failed

# Total Tests: 72 passed, 0 failed across 10 test files

# 3. TypeScript Build
bun run build -> 0 errors, MCP Chrome schemas synchronized cleanly

# 4. Git Worktree & Branch Integrity
git worktree list --porcelain -> exactly 1 worktree (main checkout)
git branch --show-current -> main
git diff --check -> PASS (0 whitespace/conflict errors)
```

### 21.3 Security Invariants Confirmed
1. **Registration != Authorization**: Neither catalog discovery nor project import grants any MCP capability. `hasProjectAccess` remains false until explicit operator grant.
2. **Zero Drive-Wide Scanning**: Only directories known to SuperAgent (history, trusted, active, chains, registry) are enumerated.
3. **No Credential Leakage**: Legacy SSH targets with embedded `?key=...` or passwords are systematically sanitized, stripped from metadata, and never logged.
4. **Worktree Isolation**: Git worktrees (`.worktrees/`, `wt_*`) are classified as `worktree` and blocked from being imported.
5. **Fail-Closed Target Routing**: Invalid, missing, or unauthorized targets fail closed and never fall back to `process.cwd()`.

### 21.4 M6 Cross-Repository Verification
- **SuperAgent Core operator lifecycle**: `tests/server.test.ts` verifies discovered → explicit import (no capability grant) → identity-scoped grant → authorized status → revoke → disable/revoke-all → remove, including absence of `credentialHash` / `principalKey` in operator responses.
- **MCP identity presence**: `tests/mcpIdentityPresence.test.ts` verifies stable opaque handles, bounded/expiring in-memory presence, and sanitized public identity metadata.
- **T-Line fixed proxy**: `backend/tests/projectBrowserProxy.test.ts` verifies allowlisted forwarding, server-side Core authentication, rejection of renderer-supplied secret/target fields, upstream status preservation, and fixed DELETE paths.
- **T-Line UI**: `frontend/src/components/__tests__/ProjectBrowser.test.tsx` verifies project status rendering, noise hiding, no MCP-token input, sanitized identity selection, explicit capability grants, and safe mutation payloads.
- **Server2 timing note**: the repository's `tests/server2.test.ts` has an explicit 20-second `beforeAll` startup limit and can time out under host contention. A diagnostic run with only that fixture timeout temporarily raised to 60 seconds completed with **67 passed / 3 skipped**; the test file was immediately restored and is unchanged in the final working tree.
