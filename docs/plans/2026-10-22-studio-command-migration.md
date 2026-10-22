# SuperAgent Studio — Command domain migration

Date: 2026-10-22
Status: implemented and validated.

## Canonical commands

**Interactive SuperAgent**
- `/studio` or `/studio help` — documented studio command entry.
- `/studio new "My scene"`, `/studio generate <brief>`, `/studio list`, `/studio inspect <project-id>`.
- `/studio edit`, `/studio render`, `/studio jobs`, `/studio status`, `/studio effects`, `/studio presets`, `/studio doctor`.
- The existing workspace authorization, render queue, action semantics, permission gates and validation are unchanged.

**Scriptable CLI**
- `superagent studio help`
- `superagent studio doctor --json`
- `superagent studio generate --prompt "A short product launch animation" --workspace . --json`
- `superagent studio render MOTION_ID --detach --workspace . --json`

The pre-existing noninteractive `superagent motion` invocation remains accepted temporarily as a compatibility alias for existing scripts but is not advertised in the new help. The old interactive `/motion` command is no longer registered/discoverable, replaced by `/studio`.

## Why only the command surface changes

- API `/api/motion`, project IDs `motion-*`, job IDs `motionjob-*`, storage `.superagent/motion`, database schema and TypeScript implementation names remain unchanged. These are internal contracts, not product names.
- Desktop T-Line `/studio` opens the native Studio panel; `/studio help` describes desktop vs CLI behavior. Subcommands that are CLI-only are not silently executed in T-Line.
- The new `STUDIO_SUGGESTIONS` catalog drives terminal dashboard autocomplete; only `/studio` is advertised.

## Tests

- `tests/studioCommandMigration.test.ts`: registry uniqueness, help naming, capabilities and CLI help.
- `tests/motionSlashCommand.test.ts`: current project operations through the new handler.
- `bun src/cli.tsx studio help`, `bun src/cli.tsx studio doctor --json`.
- Run `bun run build` and relevant Motion integration tests.

This is a UI/command rebrand only, not final trademark clearance. License checks for third-party dependencies remain required even with 100% original SuperAgent templates.
