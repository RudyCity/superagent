# Studio to Code Interaction Rules v1 — implementation audit (2026-10-25)

Status: **Implemented in source and tested; packaged T-Line v1.3.703 predates these changes. Production not approved.**

## Delivered

- Backward-compatible optional `composition.interactionGraph` persisted inside version-1 Studio project schema. `{ version:1, bindings:[...] }`, maximum 12 rules, validation of IDs, permitted events/actions, referenced layers, and required seek progress. No script bodies, arbitrary URLs or network operations.
- `set-interaction-graph` transaction through the existing optimistic revision/locking/historical snapshot mechanism. Removes dangling references fail closed; effect-stack recompilation keeps source and compiled graph.
- Supported events: `ready`, `click`, `mouseenter`, `mouseleave`, `focus`, `scroll`; actions: `play`, `pause`, `replay`, `seek`. Stage/layer targeting is explicit; scroll is stage seek only.
- Offline native HTML engine attaches graph-specific handlers to the stage/layer and cleans listeners on pagehide. A saved graph overrides the single `--trigger` export option; older projects without graphs keep existing behavior.
- T-Line Studio editor has a native Interaction Graph rules panel with event, target, action, seek percentage, add/remove and clear controls; reads/writes revisioned Studio composition. Capability flag `studioInteractionRules=declarative-bindings-v1` gates visibility.
- MP4 renderer and audio/video asset features unaffected; no tunnel or live session was restarted.

## Validation

- `bun run build` on SuperAgent passed and `bun run build:frontend` on T-Line passed.
- Backend Studio/Motion suite: **329 / 329 tests**, 63 suites, passed.
- T-Line Studio suite: **128 / 128 tests**, 26 suites, passed.
- New backend graph tests: persisted readback, stale edit guard, removal, HTML parsing and graph serialization, fail-closed malformed/oversized graphs, reference validation, preserving rules through effect stacks (4/4).
- New T-Line rules panel tests: stage vs layer rule creation, scroll/seek guard, removal, disabled while busy (3/3).
- Real Chrome (Playwright, temporary workspace, offline): after saving and reloading a graph, exported HTML started at 0.0 seconds (no legacy autoplay), stage click advanced to 0.4 seconds and scroll seek reached 10.0 seconds. No JavaScript errors.

## Remaining roadmap gap

This is **Interaction Rules v1**, not a full graph editor with nodes/edges and transitions. Lacks `reverse`, `toggleState`, `timelineEnd`, breakpoint-based state machines, interactive timeline inspector, cross-browser parity and production-installed Tauri UI E2E. Full video-to-code reconstruction P3 and production readiness P4 remain pending.

## Sources

- `src/core/motion/schema/types.ts`, `schema/validation.ts`, `project/revisions.ts`
- `src/core/motion/code/studioNativeCodeExporter.ts`, `motionCapabilities.ts`
- `frontend/src/components/StudioInteractionPanel.tsx`, `StudioTab.tsx`
- `tests/studioInteractionGraph.test.ts`, `frontend/src/components/__tests__/StudioInteractionPanel.test.tsx`
