# Senopati V6.7 — Native tokenizer and shared local inference

Date: 25 October 2026
Workspace: SuperAgent (Windows/Bun) with Cika research checkpoint
Status: LOCAL GUARDED SEMANTIC ROUTING ACTIVE. Safety-head production release remains BLOCKED.

## Implementation

- Installed official Rust N-API tokenizer package tokenizers@0.23.2. The new src/core/senopatiTokenizer.ts loads a local tokenizer.json, validates BOS/EOS and 96-token masks, checks fixed Python golden samples, and has offline Transformers.js fallback on unsupported machines.
- Updated src/core/senopatiModernBert.ts with two modes: local and shared_only. Under shared_only, clients NEVER load their own large mmBERT encoder and instead query the private IPC service. If the service is missing or unresponsive, the existing lightweight Senopati classifier is used.
- Added src/core/senopatiSharedClient.ts, src/core/senopatiSharedServer.ts, scripts/senopati-shared.ts and five unit tests in tests/senopatiSharedInference.test.ts.
- The server is an independent Bun process with one ONNX Runtime CPU session and one native tokenizer instance. It listens on a local Windows named pipe (Unix domain socket on other OSs), not HTTP/TCP. Each service start generates a random bearer credential stored in the per-user SuperAgent config area. User input is neither logged nor written to disk.
- The only accepted inference output is a restricted semantic Choice/Score/Noul prediction. IPC does not run commands or tools, and never makes authorization decisions.
- Disabled hidden extra model loading in clients; requesting processes now only import small IPC code. Service concurrency and socket payload lengths are bounded.
- Modified scripts/senopati-model.ts to preserve shared_only when reactivating a particular INT8/INT4/FP32 precision, and kept FP32 and legacy rollback intact.

## Tokenization parity evidence

On 92 synthetic multilingual and long/padded examples, the native tokenizer matched canonical Python training tokenizer token IDs exactly (92/92). The prior Transformers.js implementation differed from Python on 3 inputs involving repeated whitespace or long text. This diagnostic does not establish natural-language intent accuracy.

Whole-process exploratory RSS samples:
- Native tokenizer loaded: 148 MiB.
- Process with BOTH native and Transformers.js tokenizer objects: 482 MiB.
- Previous modern INT8 encoder with Transformers.js tokenizer: 865 MiB.
- Native tokenizer with modern INT8 encoder in a fresh Bun process: 575 MiB.

## Cross-process shared benchmark

The shared ONNX service started successfully as an independent OS process, PID 10232 at initial activation. Warm server RSS stabilized around 567–568 MiB. The policy file models/senopati/active_backend.json reports:
- backend mmbert-v64-seed73
- precision int8_embedding
- inferenceMode shared_only
- preserveLegacySafety true
- noAuthorizationFromModel true.

Independent Bun callers tested:
- Source-code client: 42 MiB process RSS, no local mmBERT instance loaded.
- Compiled dist client: 41 MiB process RSS, no local mmBERT instance loaded.
- Client executing from G:/project/cika using the same SuperAgent compiled module: 42 MiB process RSS, no local mmBERT instance loaded.

These are entire process RSS measurements for minimal synthetic test clients, not the memory footprint of the whole SuperAgent application with active connectors and other services.

## Validation and protections

- After recompiling shared code, direct source and compiled IPC clients both returned predictions.
- Synthetic documentation lookup routed to research; destructive rm -rf / remained flagged as destructive in the compiled classifier.
- Deliberately absent IPC registry: no modern model load, no modern overlay, and legacy destructive guard persisted.
- Invalid bearer IPC request returned unauthorized; model service remained online.
- IPC response validation rejects unexpected capability keys and invalid probability or class values.
- Precision activation while service online preserved shared_only; no duplicate local model allocation.
- 48 out of 48 targeted Vitest cases passed over 6 suites: native/IPC validation, modern classifier mapping, host permissions, OAuth proxy, project access and YOLO/MCP.
- Full repository TypeScript checking was rerun at completion: bun --bun x tsc --noEmit --pretty false exited 0 (clean). An earlier transient type mismatch in a separately edited assistantTaskRuntime.ts was observed during concurrent workspace changes; it no longer appears in the final check. Emitted dist model code was independently smoke-tested.

## Local operator commands

Run from SuperAgent root:
- bun scripts/senopati-shared.ts start
- bun scripts/senopati-shared.ts enable
- bun scripts/senopati-shared.ts status
- bun scripts/senopati-model.ts smoke
- bun scripts/senopati-model.ts activate int8_embedding
- bun scripts/senopati-model.ts activate fp32
- bun scripts/senopati-shared.ts disable
- bun scripts/senopati-shared.ts stop
- bun scripts/senopati-model.ts rollback

The shared service is an independently managed process. The current session did NOT force-restart SuperAgent CLI, T-Line or tunnel processes. Previously loaded JS modules in old processes may require a safe reload before switching to the new IPC client code.

## Limitations

- Native tokenizer and shared inference are local performance improvements only, not proof of human-natural-gold accuracy or trusted authorization. The modern Noul safety-head release gate is still BLOCKED.
- This local pipe uses a bearer token in a per-user registry. On Windows, POSIX mode bits alone are insufficient; OS account/profile ACLs must protect the registry. Not hardened against malicious applications running under the same OS user.
- No new external network endpoint was opened; no private customer conversation was used.
- Model files remain excluded from Git and must be provisioned separately. No broad commit of this concurrently edited workspace was made.
