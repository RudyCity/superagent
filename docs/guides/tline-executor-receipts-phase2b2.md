# Phase 2B-2 — Executor Receipts and Fail-Closed Manual Recovery

Date: 2026-10-26. Scope: T-Line detached assistant agents only. Existing Muse and ordinary Agent workflows are unchanged.

## What is implemented

Detached task tool calls now use the ordered, durable **started → prepared → receipted → finished** lifecycle, with the new `receipted` event persisted **after** the tool adapter and its post-tool hook return but **before** the executor returns success to the model. Preflight still persists before any pre-tool hook or adapter execution.

- Receipt writes contain an opaque random 96-bit `receiptRef`, a tool name from the domain allowlist, scope-specific hashed `callRef`, timestamp and a `receiptProof` classification: `local_adapter` for allowlisted local reads or `external_adapter` for approved external retrieval. Raw args, results, prompts, credentials, secrets and output hashes are not stored.
- A tool whose receipt cannot be written returns an error, **not** a successful tool result. An executor may already have performed an action, so that failure is marked *manual review required*, not replay-safe.
- Legacy journals with no receipt remain readable but become `missingReceipts` evidence. `receiptCount`, `missingReceipts`, `externalUnverified`, unfinished calls, corrupt lifecycle checks and missing history are included in scoped `GET /api/assistant/tasks/:taskId/checkpoint`.
- Receipts require a matching prepared call; duplicate receipt, duplicate started call, mismatched tool/owner or forged event schema is rejected by the journal. Its file lock and atomic file replacement preserve per-task ordering.
- T-Line Retry-as-New-Draft keeps its existing CAS, exact session ownership, idempotency key, and required acknowledgment of latest journal seq whenever manual review is required. It still does not run the new draft.

## Claims this **does not** establish

A `local_adapter` receipt is only evidence that the executor adapter returned. An `external_adapter` receipt is **not provider confirmation** of external side effects, transactions, browser writes, payments or API state. Remote tool outcomes are always unverified; no remote auto-replay or mid-turn model restoration exists.

The random receipt reference is a unique opaque event identifier, **not a digital signature**, external provider receipt, or proof that a file's contents have not been tampered with by a privileged local actor. True end-to-end verifiable side-effect receipts require a provider-specific idempotency contract, provider-generated transaction identifiers, verification/read-after-write, authenticated evidence binding and executor replay design. Do not label the current receipts as provider-verified in any UI.

## Validation

```sh
bun run build
bun --bun x vitest run tests/assistantExecutionSteps.test.ts tests/assistantToolPreflight.test.ts \
  tests/assistantTaskHttpRoutes.test.ts tests/assistantTaskStore.test.ts tests/assistantTaskDispatcher.test.ts
```

Tests cover ordered adapter invocation, persisted receipts and deduplication, failures before invocation, failure to persist a receipt after the adapter returned, legacy missing-receipt review, external unverified classification and isolation. Native Tauri/provider crash injection remains outstanding.
