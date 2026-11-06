# SuperAgent CDP Delegate — Multi-Tab Orchestrator

Applies to the SuperAgent shared repository, branch main. Chrome Delegate extension v1.9.0 is needed for live per-tab status. This does not start a second Chrome listener, tunnel or browser daemon.

## Operator workflow

1. Start a verified supervised Core and Delegate listener. In chrome://extensions reload the unpacked Chrome Delegate v1.9.0 extension, and reconnect/pair through the popup if needed.
2. Open SuperAgent Tray → Chrome Delegate → Multi-Tab Orchestrator. Profiles and tabs are listed separately with exact clientId and tabId, title and observed idle/generating state.
3. Open multiple ChatGPT tabs. Select one, enter worker ID, and optionally claim the tab. Queue one task to one tab; it is never sent to a randomly selected tab.
4. Launch parallel across 2–8 ready tabs in the same profile. One shared goal is assigned distinct Implementation, Testing, Security, Review, Documentation, Integration, Performance and QA roles. A configurable concurrency limit (1–8, default 3) controls dispatch.
5. Read history and status. Forward a completed result to another selected tab only on explicit approval. Aggregate up to 16 completed result excerpts locally; the aggregate operation sends no ChatGPT message.
6. Cancel monitoring separately from Stop generation. Cancelling a queued task prevents Send; cancelling a running task merely detaches monitoring and does not click Stop. Stop generation is a distinct explicit browser action and requires confirmation.
7. After Core restart, previous sending/monitoring tasks become uncertain, queued tasks become interrupted. The dashboard triggers bounded read-only reconciliation; no ambiguous message is automatically replayed.

## Native Tray protocol

Existing Core-bearer-authenticated loopback endpoint: /api/desktop/delegate/orchestrator. Only GET and POST are accepted; nonlocal peer/Host is refused. Native Tauri command delegate_action restricts operations via a fixed allowlist.

POST actions:
- new-tab: clientId.
- claim/release: clientId, tabId, workerId.
- enqueue: requestId, clientId, tabId, workerId, message, optional priority/title/chatId/maxRuntimeMs.
- parallel: requestId, clientId, tabIds, goal; bounded to 2–8 distinct tabs and 5,000 characters.
- cancel/reconcile/stop-generation: taskId.
- forward: sourceTaskId, requestId, clientId, tabId, workerId.
- aggregate: taskIds; 1–16 distinct IDs.
- set-concurrency: maxConcurrent; integer 1–8.

There are no arbitrary URL, raw CDP, shell command, or general delegate RPC arguments accepted by this endpoint. Cross-origin requests are rejected even on the loopback interface. Task requestId is idempotent for identical target and prompt; conflicting reuse fails closed. Every task uses a unique completion marker.

## Persistence, ownership and recovery

The local ledger is normally in ~/.superagent-r/delegate-multi-tab-tasks.json (or configured SuperAgent root), written atomically with restrictive POSIX file permissions where supported. Stores task IDs, client/tab/worker ownership, SHA-256 prompt fingerprint, timestamps and up to 5,000 characters of assistant output. ORIGINAL PROMPT TEXT IS NOT PERSISTED. The output excerpt may contain private content; protect the local SuperAgent config directory.

Task receipts are written before Send. After disconnection or timeout, the outcome cannot be assumed and an automatic resend would risk duplicate instructions. Reconciliation uses a dedicated, read-only delegate.peek_chat path that disables the legacy delivery-timeout auto-continuation on the current tab before inspecting the exact chat. It checks the original unique marker and chat ID (if known); it does not send, click, retry or close tabs. An actual browser page reload resets content-script state, so a timeout outcome still requires manual verification after reload. At most two uncertain/needs-review tasks are inspected per dashboard recovery cycle, no more frequently than every 30 seconds per task.

CDP and direct Delegate tools honor orchestrator tab claims and in-flight reservations; direct competing mutations are blocked. A manual browser action or another extension is outside SuperAgent's process-level locking and may still modify the tab.

Boundaries: 250 retained task receipts, 100 explicit claims, max 40 inspected tabs per profile, concurrency 1–8, max message 20,000 characters, monitoring deadline 30–900 seconds. A model that ignores the completion marker receives needs_review, not a false completion. Neither the model name nor DOM state is guessed.

## Verification

Run in the registered SuperAgent repository:

    bun --bun x tsc --noEmit
    bun run verify:extension-js
    bun --bun x vitest run tests/delegateMultiTabOrchestrator.test.ts tests/delegateMultiTabHostRoute.test.ts tests/desktopDelegateMultiTabUi.test.ts tests/delegateStatus.test.ts
    cargo check --manifest-path apps/superagent-tray/src-tauri/Cargo.toml -q

A live logged-in ChatGPT browser E2E requires the updated extension to be installed/reloaded and a verified supervised Core owner. Do not kill foreign processes, bypass owner verification, or modify sidecar journals to enable the feature. A passing test or build is distinct from activating a live Tray binary and Chrome extension.
