# General-purpose session-scoped assistant task domains — 2026-10-25

## Goal

T-Line is a desktop **general-purpose AI assistant**, not a coding-only agent. This stage makes the existing detached task queue domain-aware without duplicating SuperAgent Core or touching Muse/Telegram/remote channel owners.

## Shipped capabilities

The existing authenticated T-Line task endpoints now accept and persist a task `domain`. Core publishes a capability manifest in `GET /api/assistant/tasks` so the UI does not assume unsupported domains.

| Domain | Worker tool boundary | Expected work |
|---|---|---|
| general | No tools | Conversation, explanations, brainstorming |
| research | `web_search`, `fetch_url` | Source gathering, comparison, synthesis |
| analysis | Approved read-only file/document/Git inspection tools | Analysis of local project context |
| planning | No tools | Planning, outlining and decisions |
| files | Read-only file and document inspection tools | Local document exploration |
| coding | Read-only source/Git inspection; explicit isolated patch preview | Investigate code and propose changes |

All domains use the same bounded Core dispatcher, session/workspace owner scope, persistent CAS task journal, idempotency handling, cancellation, reviewable result storage and manual restart reconciliation.

The selected domain defines the tools exposed **both to the model and to the Core headless execution gate**. Unknown domains are rejected. An unsupported browser/automation task cannot claim higher permissions by putting names in a request. Code patch preparation is explicitly limited to `coding` and still requires a separate operator-approved action. Read-only detached tasks never get shell, file modification, browser-control, subagent spawning or privileged app-account actions.

## Compatibility and behavior

- Version 1 journal entries with no `domain` are read as `analysis`. Reads do not rewrite legacy journal data.
- Task idempotency includes the domain: a repeated key with a different domain is a conflict.
- Old T-Line clients can omit `domain`; Core defaults to `analysis`.
- Existing task status and event semantics remain unchanged; no duplicate background runtime is created.
- Windows transient lock-open `EPERM/EACCES` is retried within a bounded window, never bypassing unknown locks.
- Reconciliation remains explicit; workers cannot resume after Core OS-process exit.

## Remaining integration stages

1. Browser and computer-control task domains with native resource ownership, signed session capability grants and bounded approvals.
2. A domain-independent background service that can survive Core restarts; do not restart side-effectful interrupted operations automatically.
3. File authoring, automation scheduling and connected-app actions with narrow per-action approval and auditable effects.
4. Natural-language task delegation from the main conversation with explicit confirmation, instead of requiring all new tasks to be created from the task panel.
5. Real model/provider E2E, multi-session stress, packaged desktop validation.

The current tests verify contracts, persistence, UI and boundaries; they are not equivalent to a live provider/cross-process end-to-end test. No Muse code or deployment configuration is modified.
