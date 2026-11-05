# Muse file transfer: SuperAgent -> Muse

Status: SuperAgent sender implemented. External Muse receiver deployment not yet verified. This is an opt-in feature separate from the existing text chat, task batches, MUSEBUS, and 3,500-character tool-result limit.

## Ways to send

Telegram:
- CLI: /telegram file <path>
- MCP: superagent_telegram_send_file({filePath, caption?, projectId?})
- Implements real Bot API POST /sendDocument using multipart FormData and Blob. Returns Telegram message ID, optional file ID, byte count and SHA-256. Telegram acceptance does NOT prove Muse received or downloaded it. Bots may not see other bots' messages.

Muse WebSocket:
- CLI: /muse tunnel file <path>
- MCP: superagent_muse_send_file({filePath, port?, projectId?})
- MuseWatcher.sendFile -> FileTransferSender -> authenticated WebSocket sendEnvelope.
- Requires a connected remote Muse peer that implements the below protocol and sends ACKs.
- Only regular, non-symlink files inside the **authorized active/selected local workspace** can be sent; MCP accepts optional registered `projectId` and applies the existing project routing. Sensitive configuration filenames are denied. Maximum 8 MiB, 64 KiB binary slices encoded as base64 in JSON. Each frame is under 90 KiB, comfortably below the existing 10 MiB WebSocket payload maximum.
- ACK timeout 5 seconds with up to 3 retries; stop-and-wait per frame. One sender transfer active per watcher.
- Both new MCP tools are classified dangerous and workspace-scoped and require **write** project access when targeting an explicitly registered project. Read-only grants cannot export files. No automatic transmission.

## File protocol v1 (JSON envelope)

All transfer envelopes carry v:1, id (unique frame UUID) and transfer_id (stable UUID). This does not change normal chat or task envelope behavior.

1. file_offer: fields name, size, sha256 (64 lowercase hex), chunk_bytes:65536, total_chunks. Receiver validates and responds file_ack with phase:"offer", ok:true.
2. file_chunk: index (zero-based), offset (index * 65536), data_base64 (canonical base64). Receiver validates order, exact lengths and duplicate bytes, responding file_ack with phase:"chunk", index and ok:true.
3. file_complete: indicates that the sender has sent all chunks. Receiver checks assembled length and SHA-256, safely persists the file, then responds file_ack with phase:"complete", ok:true. A failed validation or persistence returns ok:false and an error string; the sender fails closed.
4. Lost ACKs result in bounded retransmission. Receiver ACKs identical duplicates, keeps completed receipts for five minutes, and times out abandoned partial transfers. Four simultaneous incoming transfers are supported by the reference receiver.

The reference receiver is FileTransferReceiver in src/core/remoteAgent/museFileTransfer.ts. It only writes to an explicitly selected receive directory and uses <UUID>-<sanitized filename> with exclusive create (wx) and 0600 file permissions. It does not accept a remote destination path or execute file contents.

## Required in external Muse

- Register handlers for file_offer, file_chunk, file_complete on Muse's authenticated WebSocket client. Port FileTransferReceiver into Muse's runtime if it does not consume SuperAgent TypeScript modules.
- Send each generated file_ack back through the same socket. ACK completion only AFTER a durable write and verified SHA-256.
- Configure a private receiving directory with space limits, expiry and cleanup, then expose the validated local file path and manifest to the Muse brain for CSV analysis.
- Run live deployed tunnel verification and confirm that Muse can open the written file. Local mocked/loopback tests do not establish remote deployment.
- Telegram document delivery is a separate user-facing attachment path, not an automatic Muse file ingestion path. The Muse Telegram listener must handle `message.document`, invoke Bot API `getFile`/download with authorization and integrity checks, and save the file; existing text-only polling ignores document updates.

## Durable receiver integration, reconnect, and progress

- The repo now contains a crash-tolerant receiver in src/core/remoteAgent/museFileReceiverPersistent.ts. It uses private, size-limited storage with a persisted .part and .state.json manifest, fsync before acknowledging each chunk, SHA-256 verification, an exclusive destination filename, and cleanup for expired transfers.
- MuseWsClientTransport supports this receiver **only when opted in**: set SUPERAGENT_MUSE_FILE_RECEIVE_DIR to an absolute, private directory in the Muse-side process, or instantiate MuseWsClientTransport with receiveOptions.directory and receiveOptions.onReceived. File receipt notifications are available through the callback; the external Muse application still has to consume them.
- An offer ACK can now return next_index, the first missing chunk. On restart the sender reuses its transfer ID from the SuperAgent configuration directory muse-file-outbox (keyed by path and SHA-256), obtains next_index from the receiver, and resumes without resending the acknowledged prefix. Checkpoints are cleared only after the final verified ACK.
- The socket sender retries after lost ACK and transient disconnection. Reconnect itself is owned by the authenticated Muse WebSocket transport. Retries are finite; if recovery takes too long, explicitly send the unchanged file again to resume from its checkpoint.
- The watcher provides status, percent and bytes, and cancel via /muse tunnel file status and /muse tunnel file cancel. MCP tools superagent_muse_file_status (safe) and superagent_muse_file_cancel (dangerous) expose equivalent controls. The existing tray screens were deliberately not modified because they contain concurrent uncommitted work.
- MuseTelegramDocumentReceiver in src/core/remoteAgent/museTelegramDocumentReceiver.ts handles sender-authorized Telegram document updates using getFile/download with strict size, path and digest checks. It is a helper for the **existing Muse-owned update poller**, not another getUpdates poller. Bots generally cannot receive updates representing their own outgoing group messages, so Telegram sendDocument acceptance cannot be equated with Muse ingestion.
- The external Muse application's implementation/deployment is not accessible in the registered SuperAgent projects. A compatible Muse client needs to instantiate the opt-in receiver, forward verified receipt paths to Muse's task context, and complete a real deployed-tunnel test.

## Benchmark and operational acceptance

Run bun scripts/bench-muse-file-transfer.ts to measure local 0.5 MiB and 6 MiB transfers, including throughput and peak memory. These are **local disk/in-process measurements**, not internet tunnel performance. Tests include resume after a process restart (12 acknowledged chunks before interruption), actual authenticated SuperAgent server to MuseWsClientTransport 6 MiB delivery, Telegram getFile mocks, retention/quota, and cancellation.

The full build remains blocked by three TypeScript errors in an unrelated file, src/serverRoutes.ts (lines 1044, 1067 and 1104 at time of audit). That file contains concurrent pre-existing modifications and is deliberately left untouched. The new MCP tools require a safe build and supervised reload before they appear on the running connector; this is not yet verified.

## Tests

- tests/museTelegramDocument.test.ts: multipart bytes, 0.5 MiB CSV, SHA-256, old sendMessage unaffected.
- tests/museFileTransfer.test.ts: 0.5 MiB / 6 MiB (96 chunks), reconstructed bytes, SHA-256, lost-ACK retry, corrupted digest, traversal and symlink denial.
- tests/museFileTransferWebSocket.test.ts: real local authenticated WebSocket and receiver ACKs for 0.5 and 6 MiB.
- Command: bun --bun x vitest run tests/museFileTransfer.test.ts tests/museTelegramDocument.test.ts tests/museFileTransferWebSocket.test.ts
