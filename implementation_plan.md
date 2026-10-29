# Implementation Plan: 2026-10-28 MCP Memory & Lifecycle Corrective Remediation

Following the authoritative independent manual audit, this plan implements corrective remediations for the 11 identified defects across the scoped MCP and CLI Bridge memory-remediation files:

## 1. High-Priority Defect Corrections

### 1.1 Finding 1 & Finding 5: True Hard 64 KB Serializer Cap & Unicode Byte-Safe Preview
- **Files**: `src/core/mcp/mcpLogSanitizer.ts`, `tests/mcpActivityPayloadBounds.test.ts`
- **Root Cause**:
  1. `serializeBoundedJournalEntry()` only checked specific known fields (`event.output`, `event.error`, `chatLine`) and failed to enforce a hard cap when arbitrary unknown metadata (e.g. huge `workspace`, `outputMeta.preview`, or custom metadata) exceeded 65,536 bytes.
  2. `sanitizeActivityOutput` and `sanitizeActivityError` used character slicing (`str.slice(0, 16384)`), which can produce ~32–65 KB UTF-8 bytes for multi-byte Unicode/emojis.
- **Remediation**:
  - Implement `truncateUtf8Bytes(str: string, maxBytes: number): string` ensuring clean code point boundaries without corrupt replacement characters.
  - In `sanitizeActivityOutput`, ensure the final preview (including truncation suffix) has UTF-8 byte length `<= MAX_ACTIVITY_OUTPUT_PREVIEW` (16,384 bytes).
  - In `sanitizeActivityError`, ensure the final error has UTF-8 byte length `<= MAX_ACTIVITY_ERROR_PREVIEW` (16,384 bytes).
  - In `summarizeArgs` and `sanitizeActivityArgs`, ensure stringified outputs respect configured byte limits.
  - In `serializeBoundedJournalEntry(entry, maxBytes = 65,536)`:
    - Multi-stage progressive reduction:
      - Pass 1: truncate known large fields (`outputMeta.preview`, `event.output`, `event.error`, `chatLine`, `workspace`, `args`).
      - Pass 2: prune any oversized string anywhere in `entry` (`> 128 bytes`), slice long arrays.
      - Pass 3: prune strings to 32 bytes, arrays to 2 items.
      - Pass 4: minimal structured fallback retaining only core identity fields (`timestamp`, `type`, `toolName`, `sessionId`, `_recordTruncated: true`), with all strings bounded.
      - Pass 5: absolute emergency fallback JSON (`{"timestamp":"...","type":"activity_truncated","_recordTruncated":true}`).
    - Guarantee returned string is ALWAYS valid JSON and `Buffer.byteLength(result, 'utf8') <= maxBytes`.
  - Add adversarial tests with arbitrary huge fields (400,000+ bytes) and multi-byte emojis.

### 1.2 Finding 2: BoundedChunkedJournalReader File Replacement Detection
- **Files**: `src/core/mcp/mcpActivityJournal.ts`, `tests/mcpActivityJournalReader.test.ts`
- **Root Cause**: `BoundedChunkedJournalReader` only checked `stat.size < this.lastOffset`, losing events when an active journal was replaced/rotated and the replacement file size was `>= previousOffset`.
- **Remediation**:
  - Track `lastFileIdentity: { ino: number; dev: number; birthtimeMs: number } | null`.
  - In `poll()`, detect file replacement when `!isSameFileIdentity(this.lastFileIdentity, currentIdentity)` OR `stat.size < this.lastOffset`.
  - On replacement or truncation, reset `this.lastOffset = 0`, clear `this.partialBuffer = ""`, update `this.lastFileIdentity`.
  - Add regression test matching the manual probe: old offset = 214, replacement file size > 214 (containing `new1\nnew2\nnew3\nnew4\n`); assert it reads all 4 new entries without skipping leading events.

### 1.3 Finding 3: Windows-Safe Cross-Process Rotation Lock
- **Files**: `src/core/mcp/mcpActivityJournal.ts`, `tests/mcpActivityJournalRotation.test.ts`
- **Root Cause**: `rotateJournal()` performed unchecked `exists`/`unlink`/`rename` archive shifts that could race when multiple processes rotate simultaneously.
- **Remediation**:
  - Implement `withRotationLock<T>(fn: () => T): T | null` using an exclusive atomic lock file (`${journalPath}.rotation.lock`) created with `wx` flag.
  - Include stale-lock recovery (5,000 ms timeout) to recover from abnormal process crashes.
  - In `rotateIfNeeded()`, acquire the lock, double-check `stat.size >= maxJournalBytes` inside the lock, shift archives safely, and release the lock.
  - If another process holds the lock, fail-safe and return `false`, allowing normal logging to continue without disruption.
  - Add concurrent rotation stress tests with multiple parallel writers.

### 1.4 Finding 4: Legacy Oversized Journal Migration Retention
- **Files**: `src/core/mcp/mcpActivityJournal.ts`, `tests/mcpActivityJournalRotation.test.ts`
- **Root Cause**: `migrateLegacyOversizedJournal()` renamed files to `.legacy-<timestamp>.jsonl` without retention caps, leaving multi-GB legacy archives outside the retention budget forever.
- **Remediation**:
  - Add `DEFAULT_MAX_LEGACY_ARCHIVES = 2` and `cleanLegacyArchives()` to prune legacy archives beyond the cap.
  - Keep migration zero-copy (`fs.renameSync`).
  - Update `getJournalStats()` to report `legacyArchiveCount`, `legacySizeBytes`, and `legacyArchives` separately, while including legacy size in `totalSizeBytes`.
  - Add tests proving legacy archive retention and cleanup.

### 1.5 Finding 6: M8 Memory-Pressure Guardrail Wiring
- **Files**: `src/core/runtime/runtimeMemoryDiagnostics.ts`, `src/core/mcp/mcpActivityBus.ts`, `tests/mcpMemoryLifecycle.test.ts`
- **Root Cause**: `shouldThrottleLargeObservability()` had no production call sites.
- **Remediation**:
  - Add rate-limited warning helper `warnMemoryPressureThrottling()` (rate-limited to once per 60s).
  - In `emitMcpActivity()` / `sanitizeActivityOutput`:
    - When `shouldThrottleLargeObservability()` returns true, skip nonessential payload enrichment (skip heavy string hashing and SHA-256 computation; emit minimal preview).
    - NEVER truncate actual MCP tool client responses (which go through the MCP transport, not the activity bus).
    - NEVER alter mutating-tool semantics.
  - Add targeted tests.

### 1.6 Finding 7: Stateless MCP Optimization & Two-Identity Concurrency
- **Files**: `src/core/mcp/superagentMcpServer.ts`, `tests/mcpStatelessConcurrency.test.ts`, plan doc
- **Root Cause**: Plan claimed full server reuse when only resource/prompt skipping was implemented; test only used a single bearer token.
- **Remediation**:
  - Precompute and memoize static tool annotations and security schemes.
  - Maintain request-local identity and per-request Server/Transport lifecycle to guarantee zero identity bleed.
  - Update plan language to accurately describe the architecture.
  - Implement a two-identity concurrency test in `tests/mcpStatelessConcurrency.test.ts` using two distinct identities/scopes running concurrently, asserting zero cross-talk or scope elevation.

### 1.7 Findings 8, 9, 10: Evidence, Default Values & Doc Corrections
- **Files**: `src/core/mcp/mcpActivityJournal.ts`, `src/core/tools/cliBridgeJobStore.ts`, `tests/cliBridgeSessionLifecycle.test.ts`, `tests/cliBridgeDelegateRetention.test.ts`, `docs/plans/2026-10-28-superagent-mcp-memory-lifecycle-remediation-plan.md`
- **Remediation**:
  - Consistent journal default: 16 MB (`DEFAULT_MAX_JOURNAL_BYTES = 16 * 1024 * 1024`) across code and documentation.
  - Clarify `pruneJobRevisions()` in `cliBridgeJobStore.ts`: it only prunes the in-memory `revisions` Map; on-disk snapshot retention is handled by `MAX_JOB_SNAPSHOTS_PER_JOB = 8`.
  - Correct plan claims: reflect exact tested cycles (e.g. 50/100 session cycles, in-memory 1,000-job synthetic pruning, bounded memory stability instead of unperformed 2–4 hour soaks).
  - Add in-memory 1,000-job pruning test in `tests/cliBridgeDelegateRetention.test.ts`.

---


1. **P0 DEEP-02**: Delegated `fileScope` shell escape (absolute paths, redirection, file operations, cmd/pwsh/sh, script invocation, nested shells).
2. **P1 DEEP-04**: Classifier progress isolation wired through production preprocessing (`RequestProcessor` -> `classifyRequest` -> model loading).
3. **P2 NEW-01**: Concurrency limiter waiter hygiene (remove expired timeout waiters, eliminate stale queue growth).
4. **P1/P2 DEEP-07**: No-progress helper completeness (wire `isRepetitiveNarration` into `LoopIterationProcessor`).

## Detailed Technical Design

### 1. P0 DEEP-02: Delegated fileScope Shell Boundary
- File: `src/core/agent/fileScopeGuard.ts`
- Enhance `validateToolCallAgainstFileScope`:
  - Support all shell tool names: `bash`, `run_command`, `run_background_process`, `shell`, `exec`, `terminal`, `cmd`, `sh`, `superagent_exec_command`, `superagent_office_cli`.
  - Validate effective cwd:
    - If `args.cwd` is provided, resolve and verify within `fileScope`.
    - If `args.cwd` is omitted, resolve against workspaceRoot.
  - Fail-closed on obfuscated/encoded commands:
    - Check for `-(?:e|enc|encodedcommand)\b` in PowerShell/pwsh invocations.
  - Recursively unpack nested shells:
    - `bash -c "..."`, `sh -c "..."`, `cmd /c "..."`, `powershell -Command "..."`, `eval "..."`.
  - Directory changes:
    - `cd`, `chdir`, `pushd`, `Set-Location`, `sl`. Verify target directory is within `fileScope`.
  - Shell redirections:
    - `>` , `>>`, `<`, `2>`, `&>`, PowerShell `| Out-File`, `| Set-Content`, `| Add-Content`, `| tee`.
    - Allow standard null sinks (`/dev/null`, `nul`, `&1`, `&2`); verify all file targets against `fileScope`.
  - Path extraction across platforms:
    - Windows absolute paths: `C:\...`, `D:/...`, quoted `"D:\..."`, UNC `\\...`.
    - MSYS2 / Git Bash paths: `/c/...`, `/d/...`.
    - Unix absolute paths: `/[a-zA-Z0-9_\-\.\/]+` (filtered for Windows flags).
    - Traversal tokens: `..`.
    - File manipulation command arguments (`cat`, `type`, `Get-Content`, `cp`, `mv`, `rm`, etc.).
    - Script arguments for `node`, `python`, `powershell`, `bash`, `sh`.
  - Enforce realpath symlink/reparse checks on all resolved paths via `canonicalizeTarget`.
- Tests:
  - Direct probe: `fileScope = ['src/core/agent/**']`, `cwd = 'src/core/agent'`, command referencing absolute workspace root `package.json` -> must return `{ allowed: false }`.
  - Shell variants: cmd `type`, PowerShell `Get-Content`, POSIX `cat`.
  - Redirections (`>`, `>>`).
  - Script executions (`node <outside>`).
  - Integration test through `ToolExecutor.executeTools`.

### 2. P1 DEEP-04: Classifier Progress Isolation
- Files: `src/core/agent.ts`, `src/core/agent/RequestProcessor.ts`, `src/core/requestClassifier.ts`, `src/core/tools/state.ts`
- Changes:
  - In `src/core/agent.ts`:
    - Wrap `RequestProcessor.processRequest(this, userInput)` with `agentLocalStorage.run(this, ...)` and `runWithProgressCallback((ev) => this.onEvent(ev), ...)`.
  - In `src/core/agent/RequestProcessor.ts`:
    - Pass `onProgress: (event: any) => agent.onEvent(event)` into `classifyRequest(userInput, classifierModel, { ..., onProgress: ... })`.
  - In `src/core/requestClassifier.ts`:
    - In `classifyRequest`: fallback to `getProgressCallback()` if `options?.onProgress` is not explicitly passed.
    - Pass `progressCb` into `classifyWithSenopatiONNX(text, undefined, progressCb)`.
    - In `getSenopatiSession`: fallback to `getProgressCallback()` if `onProgress` is not provided.
- Tests:
  - Concurrent `RequestProcessor.processRequest` calls for two agents with separate event collectors; assert zero cross-contamination.

### 3. P2 NEW-01: Concurrency Waiter Hygiene
- File: `src/core/rateLimiter.ts`
- Changes:
  - In `SharedConcurrencyLimiter.acquire`:
    - Implement cancellable waiter callback.
    - When the 100ms timeout fires, splice the waiter callback out of `this.processQueue`.
    - When `release()` pops and invokes `next()`, ensure the waiter is removed and the timer is cleared.
  - Expose `getQueueLength(): number` for diagnostic/testing purposes.
- Tests:
  - Test sustained contention with multiple waiting promises; assert `processQueue.length` remains bounded by active waiter count (does not grow over time) and all slots are acquired cleanly without lost wakeups.

### 4. P1/P2 DEEP-07: No-Progress Helper Completeness
- Files: `src/core/agent/LoopIterationProcessor.ts`, `tests/checklistContinuationGuard.test.ts`
- Changes:
  - In `LoopIterationProcessor.ts`:
    - Collect previous assistant message contents from conversation.
    - Import and call `isRepetitiveNarration(textContent, previousAssistantTexts)`.
    - Suppress action/planning continuation nudge if repetitive narration is detected.
    - In checklist enforcement, stop auto-continuation if repetitive narration is detected.
- Tests:
  - Test verifying repetitive assistant text halts continuation nudges.

## Verification
- Run `bun run build`.
- Run focused and regression test suites with `bun test`.
- Verify the direct independent probe returns `{ allowed: false }`.

---

# Implementation Plan: AI Token Quota Exhaustion UX Remediation

## 1. Problem Statement & Root Cause
- When an AI process is triggered in the Smart Seller web app (especially Copilot draft or inbox suggestion generation) and the tenant's AI token quota is exhausted:
  1. Backend `handleChatPreview` (`/ai/chat/preview`, `/ai/copilot/draft`, `/copilot/suggestions`) completely lacks `checkTenantTokenQuota` verification.
  2. Frontend `CopilotPanel.tsx` in `handleGenerateInboxDraft` catches failures silently with `.catch(() => ({ content: ... }))`, displaying fake placeholder responses and claiming success via toast (`'Draf AI berhasil dibuat, silakan tinjau dan sesuaikan'`).
  3. In `handleGenerateDraft`, when an error occurs, it catches the error and issues a generic error toast (`'Gagal membuat draf AI'`) rather than alerting the user that the AI token quota is exhausted.
  4. In `useAssistantChat.ts` and `StoreAssistantScreen.tsx`, quota exhaustion either sets a local component error state or an alert modal without triggering the immediate Indonesian toast notification required by user UX standards.
  5. `browserFetch` in `api-client/core.ts` converts server errors to plain `Error` objects without standardizing typed error codes (`AI_TOKEN_QUOTA_EXHAUSTED`).

## 2. Proposed Architecture & Remediation
### 2.1 Centralized Error & Toast Infrastructure
- Create `apps/frontend/src/components/usage/aiQuotaToast.ts`:
  - `AI_TOKEN_QUOTA_EXHAUSTED = 'AI_TOKEN_QUOTA_EXHAUSTED'`
  - `AI_TOKEN_QUOTA_TOAST_MESSAGE = 'Kuota AI Token Telah Habis. Silakan top-up atau upgrade paket di menu Billing.'`
  - `isQuotaExceededError(err: unknown): boolean`: resilient checker matching:
    - `err.code === 'AI_TOKEN_QUOTA_EXHAUSTED'`
    - `err.code === 'TOKEN_QUOTA_EXCEEDED'`
    - `err.code === 'ASSISTANT_TOKEN_QUOTA_EXCEEDED'`
    - `err.tokenQuotaExceeded === true`
    - `err.status === 402` or `err.statusCode === 402`
    - `err.status === 403` with quota error indicators
    - String message matches for Indonesian or English quota phrases.
  - `handleAiQuotaError(err: unknown, addToast?: (msg: string, type?: 'success' | 'error' | 'info') => void, fallbackMsg?: string): boolean`:
    - Checks `isQuotaExceededError(err)`.
    - Deduplicates using `err._quotaToastShown = true` and a 2.5-second cooldown window to prevent duplicate toasts from nested error handling layers.
    - Dispatches `'ai:token-quota-exhausted'` window event.
    - Calls `addToast(AI_TOKEN_QUOTA_TOAST_MESSAGE, 'error')`.
    - If not a quota error and `fallbackMsg` is provided, calls `addToast(fallbackMsg, 'error')`.
- Export `aiQuotaToast` helpers through `apps/frontend/src/components/usage/index.ts`.
- Update `browserFetch` in `apps/frontend/src/api-client/core.ts`:
  - On 402, 403 with `tokenQuotaExceeded` or quota code, attach `.code = 'AI_TOKEN_QUOTA_EXHAUSTED'`, `.status = res.status`, and `.tokenQuotaExceeded = true` to the thrown error.

### 2.2 Backend Quota Enforcement & Standardization
- In `apps/api/src/routes/ai/chat-stream.ts`:
  - In `handleChatPreview`: Add `checkTenantTokenQuota(pgDriver, reqTenantId)`. If `!quotaCheck.hasQuota`, return status 403 with `{ ok: false, code: 'AI_TOKEN_QUOTA_EXHAUSTED', error: quotaCheck.reason, tokenQuotaExceeded: true }`.
  - In `/ai/chat/generate`: Standardize response on quota failure with `code: 'AI_TOKEN_QUOTA_EXHAUSTED'`.
  - In `/ai/chat`: Add upfront quota check before `triggerAutoReply`.
  - In `/ai/chat/stream`: Standardize error response with `code: 'AI_TOKEN_QUOTA_EXHAUSTED'`.
- In `apps/api/src/routes/assistant/routes/files.ts`:
  - Add quota check to `extract-entities` before invoking provider generation.
- In `apps/api/src/routes/assistant/routes/chat.ts` and `apps/api/src/routes/store-assistant.ts`:
  - Ensure error responses return `code: 'AI_TOKEN_QUOTA_EXHAUSTED'` and `tokenQuotaExceeded: true`.

### 2.3 Copilot & Trigger Surface Remediation
- In `apps/frontend/src/screens/inbox/components/CopilotPanel.tsx`:
  - `handleGenerateDraft`: Use `handleAiQuotaError(err, addToast, 'Gagal membuat draf AI')`.
  - `handleGenerateInboxDraft`: Remove silent `.catch` fallback; use `handleAiQuotaError(err, addToast)`.
- In `apps/frontend/src/screens/assistant/hooks/useAssistantChat.ts`:
  - Call `handleAiQuotaError(err, addToast)` when quota stream error occurs or when sending message while quota is exhausted.
- In `apps/frontend/src/screens/StoreAssistantScreen.tsx`:
  - Wire `handleAiQuotaError(err, addToast)` in chat submission catch block.
- In `apps/frontend/src/hooks/useAiChatStream.ts`:
  - In SSE and fetch error handling, route through `handleAiQuotaError(err, addToast, 'Error: ...')`.

### 2.4 Test Strategy & Verification
- Unit test suite: `apps/frontend/src/components/usage/aiQuotaToast.test.ts`:
  - Test all error shapes (status 402/403, codes, flags, messages) recognized by `isQuotaExceededError`.
  - Test `handleAiQuotaError` shows `'Kuota AI Token Telah Habis. Silakan top-up atau upgrade paket di menu Billing.'`.
  - Test deduplication via `_quotaToastShown` and temporal threshold.
  - Test non-quota errors fall back cleanly.
- Unit test for Copilot error handling.
- Backend test for `handleChatPreview` quota rejection.
- Run tests via Vitest in `laris-app/apps/smart-seller`.


---

# Implementation Plan: Google Workspace CDP Reader Hardening (P10–P18)

## 1. P10: Sheets `all_sheets` Multi-Tab Hardening
- Implement `all_sheets: true` support:
  - If `all_sheets: false` or omitted, preserve single-sheet `active_sheet` scope and `gid` override routing.
  - If `all_sheets: true`, discover all sheet tabs via `.switcherItemActive, .switcherItem` in htmlview.
  - Cycle through each sheet tab, wait for the same-origin iframe table to render, and extract `{ gid, name, rows, totalRows, totalCells, mergedRanges, capabilities, status }`.
  - Aggregate metrics across the entire workbook: `totalSheets`, `sheetsRead`, `totalRows`, `totalCells`.
  - Set `verificationScope: "workbook"`.
  - Verify every sheet independently: if any sheet fails to load its table or rows, the overall workbook state must be `partial`, preventing false `verified` claims.
  - Update `paginateWorkspaceValue` to support `value.sheets` array pagination and per-sheet row bounding.

## 2. P12: Centralized Workspace Failure & Permission Detection
- Implement `detectWorkspaceFailure(page)` and `WORKSPACE_FAILURE_DETECTION_JS` for the browser runtime.
- Reason codes:
  - `login_required`: Google Accounts sign-in URL, AccountChooser, "Sign in to continue", "Gunakan Akun Google Anda".
  - `access_denied` / `permission_request`: "You need access", "You need permission", "Request access" button, 403.
  - `file_not_found`: "File not found", "Document look-up failed", "Page not found", "Sorry, the file you have requested does not exist", 404.
  - `google_error`: "Google Docs has encountered an error", 500/server crash page, "Something went wrong".
  - `redirected`: Unintended navigation away from Google Workspace.
  - `timeout` / `iframe_timeout`: Structured table/element wait deadline expired.
  - `target_closed` / `network_failure`: CDP target closed or network unreachable.
- Enforce contract: error pages must return `status: "failed"` and never become `verified` simply because text was returned.

## 3. P11: Forms Hardening
- Distinguish form modes:
  - `forms_home`: Google Forms landing/dashboard (`/forms/u/N/` or `/forms/` without document ID).
  - `editor`: `/forms/d/.../edit` (questions tab).
  - `public_form`: `/forms/d/e/.../viewform` or `/viewform` or `/formResponse`.
  - `responses`: `/forms/d/.../edit#responses` or active tab is "Responses".
- Guard: Responses tab is explicitly reported as `responses` mode with a warning; responses are NOT parsed as form questions.
- Structured question extraction:
  - Question index, id, title, type (`short_answer`, `paragraph`, `multiple_choice`, `checkboxes`, `dropdown`, `linear_scale`, `date`, `time`, etc.), `required` flag, `options` array, `helpText`.
  - Form title and description.
  - Multi-section detection: section index, title, description.

## 4. P13: Docs Rich-Content Verification Scopes
- Expose explicit `verificationScopes`:
  - `text_content`: `verified` (via authenticated text export or complete AX/page traversal) or `partial`.
  - `tables`: `not_read` (for TXT export) or `partial`/`verified` (if extracted via preview DOM/AX).
  - `images`: `not_read` or `partial`.
  - `comments`: `not_read`.
  - `suggestions`: `not_read`.
  - `drawings`: `not_read`.
  - `footnotes`: `not_read`.
  - `document_tabs`: `not_read` / `unknown`.
- Never claim full document verification when only TXT export was used.

## 4B. P13B: Google Docs Rich Block + Image Position Preservation
- **Problem**: TXT export verifies text content but strips rich formatting, tables, and images. Image placements are lost, causing downstream WordPress publishing to guess image positions or drop them.
- **Ordered Block Stream Representation**:
  - `heading`: level, text, block index, stable ID.
  - `paragraph`: text, block index, stable ID.
  - `list_item`: text, listType (`bullet` | `ordered`), level, block index, stable ID.
  - `image`: src, alt, title, caption, placement (`inline` | `anchored` | `floating` | `unknown`), `anchorBlockId`, `anchorType`, `dimensions`, `binaryReference`.
  - `table`: rows, cells (with colspan/rowspan), dimensions, block index, stable ID.
  - `divider`: block index, stable ID.
- **Comprehensive Verification Scopes**:
  - `text_content`, `block_order`, `image_order`, `image_anchor`, `image_binary`, `tables`, `headings`, `lists`, `captions`, `comments`, `suggestions`, `drawings`, `footnotes`, `document_tabs`.
  - Strict classification: `verified`, `partial`, `unknown`, `unavailable`, `not_read`.
  - Rule: unknown/missing image anchor must NEVER be marked `verified`.
  - Rule: TXT export alone must NEVER mark `image_order` or `block_order` as `verified`.
- **Downstream Rendering Contract (WordPress Publishing Pipeline)**:
  - `DocsRenderingContract`: version, documentTitle, blocks, totalBlocks, verificationScopes, imageManifest.
  - `renderBlocksToWordPressMarkup`: replaces image blocks with WordPress media attachments/blocks without reordering any content.
- **DOM Extraction & Pagination**:
  - Deterministic traversal of Google Docs preview DOM.
  - Pagination support via `paginateWorkspaceValue` for `value.blocks`.

## 5. P14: Sheets Richer Metadata & Capability Reporting
- Add `capabilities` object:
  - `displayed_values`: `"verified"` or `"available"`.
  - `formulas_types`: `"unavailable"` (htmlview renders calculated display strings; raw formulas unavailable).
  - `hidden_rows_cols`: `"unknown"`.
  - `frozen_panes`: `"unknown"`.
  - `filters`: `"unknown"`.
  - `merged_ranges`: `"available"` (detected via `rowspan > 1` or `colspan > 1`) or `"none_found"`.
  - `notes_comments`: `"unavailable"`.
- Extract `mergedRanges` list: `{ row, col, rowspan, colspan, text }`.

## 6. P15: Slides Notes & Media Capability / Scopes
- Add `verificationScopes`:
  - `slide_text`: `"verified"` or `"partial"`.
  - `speaker_notes`: `"not_read"` / `"unavailable"`.
  - `hyperlinks`: `"verified"` or `"partial"`.
  - `images_alt_text`: `"partial"` or `"not_read"`.
  - `media_references`: `"unavailable"`.
- Extract `images` array with `src` and `alt` text.

## 7. P16: Drive Scale & Stress Hardening
- Implement end-of-scroll + no-new-stable-IDs convergence algorithm.
- Add comprehensive synthetic tests covering 100, 500, and 1000+ items, virtual DOM windowing, dynamically growing scrollHeight, deduplication, and grid vs list mode.

## 8. P17: Recovery & Concurrency Tests
- Add integration tests for slow iframe, execution context reload during evaluate, target detachment/close, redirect to login, temporary target cleanup verification (0 leaked targets), and concurrent reads.

## 9. P18: Verification & Certification
- Run full suite of targeted tests via `bun test`.
- Run `bun run build`.
- Update documentation and checklist.

---

## 10. WordPress Bilingual Translation & Verification Plan (10 Posts on tab.ub.ac.id)

### 10.1 Architecture & Security Rules
- Target posts: `[37798, 37797, 37795, 37794, 37792, 37791, 37789, 37787, 37785, 37783]`.
- Chrome CDP connection on `localhost:9222` to the active `tab.ub.ac.id/wp-admin` tab (`DD9BB37C5E031C7798C91F7877981C56`).
- Secure REST API Nonce retrieval without logging nonce/credentials to stdout or disk.
- Fetch each post with `GET /wp-json/wp/v2/posts/<id>?context=edit`.
- Extract Indonesian raw title and content (`raw` or qTranslate parsed).
- If existing content has qTranslate tags `[:id]...[:en]...[:]`, preserve exact Indonesian section and replace/add English section.
- If no tags, wrap original content as Indonesian: `[:id]<original>[:en]<translation>[:]`.
- Preserve exact Indonesian title, body, date, slug, categories, metadata, tags, images/captions/links and inline ordering.
- Faithful English translation: no hallucinations, accurate names, titles, affiliations, and numbers.
- PUT update via `/wp-json/wp/v2/posts/<id>`.
- Verify public rendering at `https://tab.ub.ac.id/en/<slug>/`:
  - Check that the title in English appears in `<h1>`.
  - Check that the body in English appears, without Indonesian fallback.
  - Check that images and captions remain intact.
- Record comprehensive execution details in `walkthrough.md` and report table.


---

## 11. 50 Most Recent WordPress News Articles English Translation (tab.ub.ac.id)

### 11.1 Execution Protocol & Safety Constraints
- **Target Category & Sorting**: Category `Berita` (ID `1`), ordered by `date desc`.
- **Manual Skip Rules**: Posts `37847, 37825, 37822, 37820, 37818` already translated manually are strictly preserved from overwriting and verified live on public `/en/<slug>/`.
- **45 Target Untranslated Posts**: Selected in exact chronological descending order across 9 batches (5 posts per batch).
- **Format & Syntax**: Strict qTranslate syntax `[:id]<indonesian>[:en]<english>[:]` for title and content.
- **Structural Integrity**: 100% preservation of Indonesian text, inline media (`<img>`, `<figure>`, `<figcaption>`), external document/cloud drive links, formatting classes, and publication dates.
- **REST Robustness**: Sanitize unescaped attributes in WP REST responses (`loading="lazy"`, `decoding="async"`) before parsing.
- **Verification Gate**: 100% public `/en/<slug>/` DOM verification for HTTP 200, English H1 title, non-empty English body, `hasFallback == False`, and matching image counts.
- **Audit Deliverable**: `docs/audits/2026-10-28-wp-latest-50-english-translation-report.md`.
