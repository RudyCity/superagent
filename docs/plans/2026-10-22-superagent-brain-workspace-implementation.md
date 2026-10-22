# SuperAgent Unified Brain Runtime — P0–P3 implementation (2026-10-22)

## Architecture
**Canonical source:** SuperAgent Core `src/core/brain/`. This owns scoped sessions, scratch, artifact storage/retention, chunk transfer, metadata and verified delegation promotion. Chat history remains in SQLite and memory remains in RMemory; neither is duplicated in Brain.

```text
~/.superagent-r/brain/<sha256-principal-prefix>/<session-id>/
  manifest.json
  scratch/{scripts,experiments,temporary}/
  artifacts/
  evidence/
  .transfers/           # non-public resumable upload state
  artifact-index.json   # explicit verified annotations
```

Adapters:
- MCP: `superagent_brain` and `superagent_brain_publish` use authorized OAuth/static-bearer namespace and project grants.
- CLI: `/brain` and `/scratch` use local-cli principal with explicit operations.
- T-Line: backend has a local-cli **compatibility adapter**; generated Brain storage, transfer and index modules are built from the canonical SuperAgent source. It never exposes OAuth namespace or grants MCP permissions to a desktop account.

## P0: security and integration
- HTTP MCP OAuth end-to-end tests validate read-only denial, separate OAuth identities, session persistence.
- No implicit project mutations: 2-stage cleanup and publish, 60-second one-time challenge, checksum verification, no-overwrite semantics, symlink/path checks, dangerous-tool OAuth write scope, registered local project write capabilities. CLI has matching cleanup guard.
- Persisted CLI Bridge running status blocks scratch cleanup.
- Source bytes are verified then written create-only; destinations cannot overwrite files. Paths are rechecked and unsafe special filesystem entries rejected.
- Workspace cwd is **not a sandbox**; delegation still uses the host OS and normal CLI permission modes.
- This suite tests temporary loopback HTTP servers. It does **not** prove that a pre-existing ChatGPT tunnel or installed desktop binary has been restarted.

## P1: shared Brain modules
`bun scripts/sync-brain-runtime.ts` generates:
- `../t-line/backend/src/brainStorageManager.ts`
- `../t-line/backend/src/brainTransfers.ts`
- `../t-line/backend/src/brainIndex.ts`

`bun scripts/sync-brain-runtime.ts --check` fails on drift. T-Line's `backend/src/brainRuntimeCompat.ts` provides local-cli session resolution. This is **build-time source unification**, not a runtime network proxy or a single deployment instance. Release pipelines must run the check and regenerate after core changes. Never hand-edit generated copies.

## P2: streamed artifacts and promotion
MCP `superagent_brain` accepts:
```json
{"action":"transfer.begin","sessionId":"sess_abc","filename":"movie.mp4","totalBytes":350000,"sha256":"<64-digit lowercase SHA256>"}
{"action":"transfer.append","sessionId":"sess_abc","transferId":"btx_...","offset":0,"base64":"..."}
{"action":"transfer.status","sessionId":"sess_abc","transferId":"btx_..."}
{"action":"transfer.finish","sessionId":"sess_abc","transferId":"btx_..."}
{"action":"transfer.abort","sessionId":"sess_abc","transferId":"btx_..."}
```
- Up to 20 MiB, chunks no larger than 256 KiB, ten pending transfers per session and 50 MiB reserved storage quota. Transfers survive process/connection restarts through `.transfers` metadata and file offsets.
- The final file becomes visible only after SHA256 verification. In-progress files do not appear as artifacts or get published.
- Existing `artifact.import` (single 5 MiB Base64) and `artifact.read` (256 KiB paginated Base64) remain supported.
- `delegate.promote` promotes one CLI Bridge verified artifact into Brain `artifacts/` only after matching the job's scratch cwd and SHA-256 evidence, without overwrites. A successful process exit alone is insufficient.
- T-Line implements equivalent chunk upload APIs and browser resume via a per-session upload ID stored in browser localStorage. For interrupted transfers, reselect the same original file after restarting T-Line.

## P3: index, resume and RMemory handoff
MCP:
```json
{"action":"artifact.annotate","sessionId":"sess_abc","filePath":"artifacts/report.pdf","summary":"Validated market report","tags":["report"]}
{"action":"artifact.search","query":"market"}
{"action":"session.resume","sessionId":"sess_abc"}
{"action":"memory.candidate","sessionId":"sess_abc","filePath":"artifacts/report.pdf"}
```
- Index and search are confined to the current principal; checksums must match before search or memory-candidate export.
- ContextBuilder uses at most a handful of untrusted, bounded metadata references on resumed sessions. It does not adopt artifact summaries as instructions.
- CLI `/brain annotate`, `/brain search`, `/brain resume`, `/brain promote` and **explicit** `/brain remember <artifacts/file>` (project-scoped RMemory write using the existing `rmemory_save` tool contract).
- MCP does *not* automatically push summaries to global RMemory. The `memory.candidate` response can be explicitly submitted through the caller's separately authorized memory tool. No cross-principal memories are merged.
- T-Line exposes metadata search/annotation/resume and a candidate-only endpoint. It does not silently save a memory to RMemory.

## Validation
```sh
# SuperAgent
bun run build
bun --bun x vitest run tests/brainWorkspace.test.ts tests/brainStorageMcp.test.ts tests/brainStreamingIndex.test.ts tests/brainDelegationPromotion.test.ts tests/brainMcp.test.ts tests/mcpOAuthHttpE2E.test.ts
bun scripts/sync-brain-runtime.ts --check

# T-Line
bun run build:backend
bun run build:frontend
bun --bun x vitest run backend/tests/brainExplorerRoutes.test.ts
cd frontend && bun --bun x vitest run --config vite.config.ts src/components/__tests__/SuperAgentBrainExplorer.test.tsx
```

## Remaining operational checks
- Restart/reconnect the deployed MCP tunnel and T-Line application to load the new tool schemas/bundles. An existing long-lived connection may still expose old actions.
- A live, already-running tunnel, real AGY/Claude binary and packaged T-Line desktop interaction should be smoke-tested before declaring production deploy complete. These are not implied by successful unit/integration tests.
- Broken/stale transfer lock files deliberately block writes; operator recovery must first verify no active writer, then clear the lock. There is no unsafe automatic lock stealing.
- CLI commands remain interactive; real terminal and remote OAuth identity workflows should be acceptance-tested on the user's host after deployment.
