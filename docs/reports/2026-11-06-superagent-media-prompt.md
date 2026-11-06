# SuperAgent media system prompt — Worker B audit (2026-11-06)

## Scope and actual runtime injection

- Edited only `src/core/prompts.ts` and added `tests/mediaPromptRouting.test.ts` plus this report, with no branch/worktree, commit, push, restart, PID kill, or live configuration change.
- `src/cliMain.tsx:584-639` and `:870-879` instantiate Master `Agent` with `MASTER_AGENT_SYSTEM_PROMPT` for multi-agent CLI. `src/core/mcp/tools/executionTools.ts:75-101` uses the same prompt for headless MCP multi mode.
- `src/core/agent/ContextBuilder.ts:38-39` chooses the real Agent custom system prompt; `:467-471` assembles it and `:681-702` returns `finalSystemPrompt`. `src/core/agent/LoopIterationProcessor.ts` passes this field as the LLM `system` input.
- Added shared `MEDIA_WORKFLOW_RULE` to `AESTHETIC_AND_GATEWAY_RULES`, which is interpolated by Master, Superagent, Chrome extension and applicable subagent prompt exports. Research subagent (read-only) deliberately does not inherit media write instructions.

## Routing policy

- Discover authorized media tools by actual schema, then inspect source signature and run `media_capabilities` / `media_plan` preflight; capability listing alone does not prove a backend is installed.
- Image compression: choose `operation:'compress'` only where exposed; JPEG/WebP/AVIF quality and schema-supported `targetKB` or `targetBytes`; PNG lossless optimization where available. Target size is best-effort; report real input/output bytes, savings and missed targets, without misreporting exact-size guarantees or claiming a no-op larger artifact is an improvement.
- Removal: transparent PNG with provisioned `rembg`/model. AI upscale: verified Real-ESRGAN backend, no invented recovered detail. Also route resize, crop, rotate, watermark with bounded arguments.
- Image ↔ PDF/Office conversion: select backend from the route plan, distinguish raster visual output vs editable Office content, note possible loss of font, table, pagination and slide fidelity.
- Validate workspace-scoped paths, format, geometry, permission, output create-only/no overwrite, approvals; preserve source. Verify actual file, bytes, hashes and backend from tool evidence. Never hardcode user response or claim completion when operation failed.

## Tests / verification

- `bun --bun x tsc --noEmit`: **PASS**, exit 0 (executed through AGY CLI Bridge, read-only instructions).
- `bun --bun x vitest run tests/mediaPromptRouting.test.ts`: **FAIL at runner bootstrap** before collecting tests; Vitest 4.1.10 reports `Vitest failed to find the runner` at `tests/setup.ts:72`. No product assertion was reached. Investigate runner/Bun incompatibility separately; fixing shared Vitest setup was outside this worker's assigned scope.
- `node ./node_modules/vitest/vitest.mjs run tests/mediaPromptRouting.test.ts --maxWorkers=1`: **PASS**, 3 tests, exit 0 (AGY CLI Bridge report). Verified static tier inheritance, researcher isolation and real `ContextBuilder.buildContext` assembled Master prompt.
- A nonfatal warning reports missing native `better-sqlite3` bindings during RMemory initialization and Node's experimental SQLite warning; tests still passed.

## Integration gap (unassigned owner)

- The **single-agent** prompt is produced by `src/core/config/base.ts:getSystemPrompt()` and passed by `getConfig():systemPrompt` to Agent, rather than importing `src/core/prompts.ts`. `src/cliMain.tsx:888-895` and `src/core/mcp/tools/executionTools.ts:96-101` enter that path for single mode. This Worker **did not edit** `src/core/config/base.ts`, as it is outside assigned scope. An orchestrator/authorized owner must inject equivalent media policy there or through a central task-specific prompt module to cover normal single-mode sessions. Until that integration, only the inspected multi-agent path is proven to carry this rule.
- `targetKB`/`targetBytes` must not be emitted unless Worker A's actual runtime tool schema exposes them. This prompt does not grant capabilities or implement any backend; no live availability claim is made.
- These are source edits only; existing running Core/Tray/MCP processes were not reloaded, so live prompt uptake has not been claimed.
