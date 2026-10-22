# SuperAgent Phase 6 — Bun dependency vulnerability remediation

Date: 2026-10-22. Source: Bun 1.4.2 advisory audit on the resolved Bun lockfile.

## Change and verification

- Direct MCP SDK updated from 1.29.0 to 1.32.1; MCP transport OAuth and process tests passed.
- Transitive versions selectively pinned to fixed versions: xmldom 0.9.12, fast-uri 3.1.7, proxy-addr 2.0.8, source-map-js 1.2.2, tar 7.5.22, ip-address 10.7.4, nanoid 3.3.18 and vite 8.3.5.
- Obsolete Xenova/Transformers v2 replaced by Transformers.js v3, removing the older onnxruntime-web/protobufjs v6 chain.
- RMemory's legacy xlsx dependency aliased to compatible maintained @e965/xlsx 0.20.3; patched JSON diff/patch to 0.7.6.
- Sharp native image processing updated to 0.35.5; 16x16 PNG creation/decode smoke passed on Windows Bun.
- Mammoth 1.12.0 requires a small tracked patch to call xmldom 0.9.x with a MIME type and the new onError callback; DOCX parsing smoke caught and validated this compatibility regression.
- `bun run security:bun` must remain a fail-closed release gate. Security advisory counts can change over time.

## Remaining high advisory and acceptance

One high advisory remains: `braces@3.0.3` (stack exhaustion for deeply nested glob patterns). This was the latest registry version observed at audit time and has no known fixed version available. Do **not** silence the release gate or claim production approval based on the reduced count. Audit upstream fixes or replace/vet glob dependency usage in a separate targeted security review.

Other gates: complete Windows installed GUI tray/WebView2 and live integration for port 7888 require authorized E2E testing. No unknown process was killed or overwritten. Changes to Motion Studio that land concurrently must not be mixed into this commit.

Repeat checks: `bun run build`, `bun run compat:bun`, `bun run runtime:acceptance`, `bun run integration:tline`, `bun run security:bun`.
