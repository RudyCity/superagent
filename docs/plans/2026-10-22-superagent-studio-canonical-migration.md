# SuperAgent Studio — canonical namespace migration

Date: 2026-10-22
State: implementation and regression verified. **Workspace data migration is optional and never automatic.**

## Canonical public surface

- Interactive: `/studio` and `/studio ...`.
- CLI: `superagent studio ...`; `superagent studio migrate --workspace PATH` returns a *read-only dry run* and `--apply` performs an explicit guarded migration.
- HTTP: `/api/studio` and `/api/studio/... ` are canonical, preserving existing authentication and workspace authorization.
- MCP: `superagent_studio_*` (16 low-level scoped tools) and native agent `studio_generate`, `studio_revise`, `studio_status`; `studioId` is accepted by canonical MCP tools.
- New project IDs: `studio-<20 hexadecimal characters>`; new render job IDs: `studiojob-<24 hex characters>`.
- New workspace data: `<workspace>/.superagent/studio/{projects,assets,audio,jobs,renders,previews,...}`. Brand kit, history and recovery remain under that same root.

## Backward compatibility (intentional)

The following technical names are **aliases for existing data and clients**, not the marketed product name:
- Old `/api/motion` still reads/edits/exports authorized project data.
- Existing `motion-*` project IDs and `motionjob-*` job IDs are accepted by all relevant validators, job queues and T-Line API/proxy.
- Old MCP `superagent_motion_*` and native `motion_*` tools remain functional while new names are available; both use the same project capability and dangerous execution gates.
- Existing `<workspace>/.superagent/motion` content is accessed transparently *only when no Studio directory exists*.
- A workspace containing **both** `.superagent/motion` and `.superagent/studio` is blocked unless an explicit, verified-copy cutover marker records successful byte-for-byte migration; otherwise it fails closed.
- Preexisting completed-render manifest absolute paths are remapped to Studio render paths in memory after guarded migration. Job/project ID references never change.
- The underlying TypeScript implementation symbols and some `motion` field names that describe animation concepts remain internal compatibility contracts; they are not new product brands. Do not bulk-replace field names in stored schema v1.

## Explicit workspace migration

1. Stop CLI/T-Line renderers, supervisors and any other processes that may be writing to the target workspace; do not force-kill live sessions from within this command.
2. Back up the complete `.superagent/motion` workspace directory with its file permissions and hashes.
3. Run `superagent studio migrate --workspace <workspace> --json`. Check `state`, `blockers`, `from` and `to`.
4. When state is `legacy` and `blockers: []`, run `superagent studio migrate --workspace <workspace> --apply --json` for atomic same-volume rename. If Windows denies the rename because Explorer/IDE holds directory handles, use explicit `superagent studio migrate --workspace <workspace> --apply --verified-copy --json` only when no old Studio runtime is writing: the source and target file sets are SHA-256 verified before cutover, and a strict marker allows the canonical Studio namespace to coexist with a retained legacy rollback copy.
5. Confirm projects, asset images/audio, histories, brand kit and historical video downloads from the new Studio root after refreshing *upgraded* clients. With verified-copy, do not delete the legacy tree while it is locked or while clients may still use the old implementation. Never create a parallel Studio directory manually without the validated migration marker.

The migration **refuses active queued/preparing/rendering records, lock/claim files, suspicious metadata, symlinks, or mixed old/new namespace directories**. It does not silently perform data conversion, mutate project IDs, delete old assets, restart workers or recreate failed renders. Re-running the migration after success is a no-op. Before applying to important production data, perform a controlled backup/restore rehearsal.

## Tests and validation

- `bun run build`
- `bun x vitest run motion --maxWorkers=2`
- `bun x vitest run tests/studioApiMigration.test.ts tests/studioStorageMigration.test.ts tests/motionMcpIntegration.test.ts`
- For workspace-local CLI: `superagent studio doctor --json`.
- Production release still requires graphical Tauri smoke, new package build and other release gates.
