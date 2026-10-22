# Brain P0/P1 reliability closure & release acceptance (2026-10-22)

## Implemented
- **Crash recovery**: an uncommitted partially written upload is truncated back to its durable metadata offset on inspect/append/finish. Clients must retry from the returned offset.
- **Session-wide writer lock**: begin, append, finish, abort, read/write text, binary import, cleanup and publication confirm use a common per-session lock to protect quota and mutations. A stale lock is reclaimed only after a grace interval and when the recorded owner PID is provably dead. Uncertain/active locks fail closed.
- **Expired transfers**: uploads older than 24 hours, incomplete orphan staging files and temporary metadata can be reclaimed safely; `transfer.begin` runs garbage collection and MCP offers `transfer.gc`. Final artifacts are never deleted by transfer GC.
- **Quota**: new reservations account for active uploads; binary imports account for pending reservations; finalization rechecks the session's current usage before promotion.
- **Legacy destructive APIs**: one-step `cleanBrainScratch()` and `publishBrainArtifact()` reject; use two-stage cleanup/publish and authorized project grants.
- **RMemory provenance**: single/master sessions bind to the enabled registered local project at creation/resume. `/brain remember` refuses detached sessions, disabled/relocated projects, and a changed active workspace. RMemory saves use the bound canonical root rather than incidental cwd.
- **Search I/O**: incremental bounded file hashing, a small 30-second verification cache tied to ctime/mtime/size, and a per-search hash-work budget avoid unbounded repeated whole-file reads.
- **Core–T-Line drift detection**: generated modules have a versioned SHA-256 manifest. `scripts/check-brain-runtime.cjs` checks the T-Line release tree. SuperAgent's `scripts/sync-brain-runtime.ts --check` also compares canonical source directly when both repositories are available.
- **Release check**: `bun scripts/verify-brain-release.ts --with-tline` builds and tests SuperAgent, checks generated source and builds/tests T-Line. A Brain Core workflow file is prepared in SuperAgent.

## Verified
```sh
# Run from SuperAgent repo; needs adjacent T-Line repo
bun scripts/verify-brain-release.ts --with-tline

# Optional T-Line standalone pin verification
bun scripts/check-brain-runtime.cjs
```
Acceptance includes crash recovery, stale and active locks, expired and orphan staging, cumulative quotas, project provenance, identity and OAuth scope separation, publish approval and replays, local HTTP MCP, T-Line backend routes and UI component tests.

## Deployment still requiring operator access
1. Check which MCP tunnels are owned by SuperAgent before restart; do not restart unrelated tunnels.
2. Restart/reconnect the intended SuperAgent MCP server to load the new MCP tool definitions; verify `superagent_brain` supports `transfer.gc`.
3. Exercise one small authenticated upload/status/finish cycle and denied read from a separate OAuth identity through the **actual configured tunnel**.
4. Restart T-Line and run a desktop Brain Explorer smoke test with a local test artifact and the correct operator login.
5. Run a real AGY/Claude delegation with cwd under a fresh Brain scratch, validate verified evidence and promote to artifacts. Do not execute untrusted CLI jobs without an OS sandbox.
6. Attach the T-Line local integrity script to the organization's release workflow. The checksum checks prove pinned copies have not drifted; upstream SuperAgent source drift additionally requires a two-repository `--check` run.

**Not yet a deployed-production signoff:** active tunnel metadata, unauthenticated 401 probe and CLI version checks are not equivalent to an authenticated live-tunnel or packaged desktop acceptance test.

## Follow-up operational guardrails
- Orphan lock files with unverifiable owners fail closed and may need a documented manual operator recovery after checking processes.
- Even with path validation and create-only writes, the user's host process is not a container sandbox. OS-level filesystem races require deployment-specific isolation where untrusted users share a machine.
- Generated T-Line files must never be hand edited; change Core then rerun sync.
