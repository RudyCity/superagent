# Brain Commands, Suggestions and Nested Subcommand Parity
Date: 2026-10-23.

## Status
SuperAgent CLI's `/brain` command and `/scratch` alias share the canonical Brain catalog in `src/core/commands/commandCatalog.ts`. Dashboard suggestions, inline descriptions, `/brain help` and `/help` all refer to that discoverable set.

The generated `frontend/src/generated/brainCommandSuggestions.json` in T-Line comes from `bun scripts/sync-brain-runtime.ts`; the checksum is pinned in `backend/src/brain-runtime-manifest.json`. Both the upstream `--check` and T-Line `bun scripts/check-brain-runtime.cjs` fail if the generated file drifts. No silent duplicated list must be maintained.

## User-facing behavior
- Start typing `/brain ` or `/scratch ` in the SuperAgent CLI dashboard for 31 completion templates. Type `/brain task.` to narrow to task actions, `/brain delegate.start ` for AGY/Claude/Codex examples, or `/brain artifact.rec` for recovery.
- `/brain help` prints every advertised option and parameter grammar. Global `/help` refers readers to it and highlights tasks, guarded cleanup and recovery.
- CLI actions include `task.create`, `task.list`, `task.claim`, `task.resume`, `task.checkpoint`, `task.transfer`, `task.complete`, `task.reconcile`, `artifact.recover`, `delegate.start`, `jobs`, `get`, `tail`, `cancel`, `promote`, `remember` plus session metadata and cleanup.
- `task.credential.rotate`, `task.credential.revoke`, `delegate.promote.batch` and `task.reconcile.all` are MCP API actions, **not** slash subcommands. They are documented in help, but deliberately not included in slash autocomplete.

## T-Line Desktop behavior
- Typing and executing bare `/brain` or `/scratch` opens native Brain Explorer.
- The subcommand autocomplete is populated from the pinned canonical JSON (including `/scratch` aliases) and has contextual descriptions.
- Nested slash subcommands are **CLI-only** on T-Line and are never secretly forwarded to a model or invoked through a guessed route. Entering one reports the limitation; use the SuperAgent CLI terminal or native Brain Explorer controls for supported operations.
- Credential rotation/revocation and task storage actions continue to use the explicitly authorized native T-Line Brain Explorer API; they are not faux terminal commands.

## Verification
```sh
# in SuperAgent repository
bun scripts/sync-brain-runtime.ts --check
bun --bun x vitest run tests/brainCommandDiscovery.test.ts
bun scripts/verify-brain-release.ts --with-tline

# in T-Line repository
bun scripts/check-brain-runtime.cjs
cd frontend && bun --bun x vitest run --config vite.config.ts src/components/__tests__/SuperAgentCliParity.test.ts
```
Completion parity checks are part of the Brain release workflows. Installed T-Line desktop and running MCP tunnel instances still require separate restart/live acceptance before displaying these updated menus in their existing processes.
