# SuperAgent Brain Workspace — Core, MCP, CLI and T-Line (2026-10-22)

## Architecture and ownership
Brain is independent of Git repositories and RMemory. History SQLite remains the canonical chat history store; RMemory is the semantic memory layer. Brain holds session-scoped temporary files, artifacts and evidence:

```
~/.superagent-r/brain/<principal-sha256-prefix>/<session-id>/
  manifest.json
  scratch/
  artifacts/
  evidence/
```

Core files:
- `src/core/brain/brainWorkspace.ts`: owner/session-scoped directory lifecycle and bounded text files.
- `src/core/brain/brainStorageManager.ts`: storage scans, retention dry-run, one-use cleanup and publication challenges, bounded binary import, active-delegation checks, symlink/path guards. Its directory-oriented routines are reused by the MCP and CLI frontends.
- `src/core/mcp/tools/brainMcpTools.ts`: MCP argument validation, authenticated principal mapping, chunked binary export, and safe dispatch.
- `src/core/commands/brainCommand.ts`: local CLI interface.

T-Line currently has its own desktop backend adapter (`backend/src/brainStorageManager.ts` in the T-Line repository) with equivalent storage operations and extra local-workspace registration checks. The two implementations are not yet physically linked as a single distributed package. No MCP OAuth identity is silently remapped to T-Line's local operator.

## MCP tools
Both tools are classified **dangerous** and must be enabled by the server; OAuth callers need `mcp:tools:write`. All Brain actions remain scoped to the authenticated principal. If `sessionId` is omitted, the MCP connection-scoped Brain ID is used. Preserve that ID to resume across reconnects.

### `superagent_brain`
```json
{"action":"current"}
{"action":"storage","sessionId":"session_abc"}
{"action":"retention.preview","days":30}
{"action":"artifact.import","sessionId":"session_abc","filename":"report.pdf","base64":"JVBERi0..."}
{"action":"artifact.read","sessionId":"session_abc","filePath":"artifacts/report.pdf","offset":0}
{"action":"cleanup.prepare","sessionId":"session_abc"}
{"action":"cleanup.confirm","sessionId":"session_abc","challenge":"<token-from-prepare>"}
```
Also supports `create|list|inspect|files|read|write` and `delegate.start|get|tail|cancel|jobs`. Old MCP `cleanup` is rejected: it may not bypass the two-stage confirmation.

**Import** accepts canonical Base64 with a decoded size limit of 5 MiB and an extension allowlist. Upload is create-only and session storage is bounded to 50 MiB for binary imports. Large Base64 tool payloads can hit limits of a specific MCP transport; callers should keep requests smaller when possible.

**Binary read** returns Base64 chunks up to 256 KiB per call, with `offset`, `nextOffset`, `length`, `totalBytes` and `done`. Maximum artifact size is 20 MiB. Only artifacts/ and evidence/ are supported.

**Storage** returns per-area bytes and file counts. **Retention** is informational for 7, 30, or 90 days only. It never deletes in the background.

**Cleanup** uses a single-use challenge valid for 60 seconds, bound to the caller and session; scratch content must match the preview and no persisted CLI delegation may still be active. Only scratch is removed. Artifacts and evidence survive.

### `superagent_brain_publish`
```json
{"action":"prepare","projectId":"laris-app","sessionId":"session_abc","filePath":"artifacts/report.pdf","destinationPath":"docs/report.pdf"}
{"action":"confirm","projectId":"laris-app","sessionId":"session_abc","challenge":"<token-from-prepare>"}
```
Only enabled **registered local** projects can be selected. Existing workspace routing and project **write** grants are checked for both prepare and confirm, including OAuth write-scope constraints. The 60-second challenge binds caller, session, file hash, destination and canonical project root, and can only be used once. File size is capped at 20 MiB; existing destinations, symlinks, absolute paths and traversal are rejected. **The old single-step MCP publish call is retired.**

## CLI
```text
/brain create
/brain storage [sessionId]
/brain retention [7|30|90]
/brain clean <sessionId>                         # preview + one-time challenge
/brain clean.confirm <sessionId> <challenge>    # explicitly clean scratch
/brain delegate.start agy <prompt>
/brain jobs
```
`/scratch` is an alias. Background delegations use session Brain scratch as cwd, not the repository. A cwd is **not** a process sandbox.

## Verification
```sh
bun run build
bun --bun x vitest run tests/brainWorkspace.test.ts tests/brainStorageMcp.test.ts tests/brainMcp.test.ts tests/brainHistoryLifecycle.test.ts tests/mcpServer.test.ts
```
The T-Line repository has separate frontend/backend Brain Explorer and Storage Manager tests.

## Still outstanding
- Restart/reconnect the running SuperAgent MCP tunnel or process to expose the new action schemas; builds alone do not update a live connection.
- Desktop and real remote MCP end-to-end smoke tests with user identity grants have not yet been performed.
- Binary *upload streaming/chunks* is not available: import currently takes one Base64 payload, while downloads are chunked.
- T-Line and Core share contracts/semantics but are still separately deployed implementations; factor an independently versioned shared package or use an authenticated SuperAgent core service if single-source deployment is required.
