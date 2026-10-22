# Senopati V2 shadow cache — restart, concurrency and explicit repair

Date: 2026-10-23. **Status: development / shadow-only**. The active tool router and ToolExecutor do not import or use this cache.

## Changes

The cache compiler now uses a cross-process exclusive directory lock `<cache>.compile.lock`. It writes a private temporary file, flushes it, then atomically publishes with a same-directory hard link (NTFS support required). Valid identical caches are reused without touching their modification timestamps.

An existing differing/corrupted cache **does not get silently replaced**. `--repair` is an explicit opt-in: under the compiler lock the previous cache is moved out of the well-known path, then the newly flushed cache is atomically linked into place. During the short missing-path interval, readers use the independently validated reference classifier. This prevents readers from observing a partially written target and avoids authorizing tools. If the publish fails, restoration of the previous file is attempted. Unexpected interrupted writes may leave `.previous-...` files and/or a stale `.compile.lock`; neither is trusted by the runtime.

The registry loader continues verifying SHA-256 of the original model and policy, validates the shadow-only policy and cache sections, then reports `hit`, `miss_fallback_reference`, or `invalid_fallback_reference`. It **never rebuilds or repairs on inference**. SHA-256 alone is not a signature or proof of publisher identity; do not deploy this artifact as a production trust source.

Directory permissions `0700` and temporary cache mode `0600` are requested where supported; Windows ACLs are managed by Windows and should be reviewed separately. No credentials, training labels, customer messages or source JSON are written into the compiled cache or these reports.

Added scoped `.gitignore` entries for `build/superagent/cache/`, `build/superagent/benchmarks/`, and `build/superagent/registry/`; unrelated `build/` assets remain visible to Git.

## Commands

Build/reuse the exact pinned candidate:

```powershell
bun scripts/compile-senopati-v2-cache.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json
```

Only after investigating a corrupt cache, explicitly rebuild it:

```powershell
bun scripts/compile-senopati-v2-cache.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --repair
```

If a crash left `<cache>.compile.lock`, the compiler intentionally refuses to delete it automatically. First **confirm no compiler process is still running**. Manually remove that specific stale lock directory in the ignored shadow cache tree; retry the explicit compiler command. Do not clear locks in a running process. If a `.previous-...` backup remains, inspect it offline; it is never automatically trusted as an active cache.

Run concurrent-compiler regression and full model parity:

```powershell
bun --bun x vitest run tests/senopatiV2CompactCache.test.ts
bun scripts/check-senopati-v2-indexed-parity.ts --all --cached --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --dataset "G:/project/cika/data/senopati/v2/frozen_holdout.jsonl" --dataset "G:/project/cika/data/senopati/v2/safety_holdout.jsonl" --dataset "G:/project/cika/superagent/datasets/v2_training.jsonl"
```

The test suite launches **four separate Bun compiler processes** targeting one temporary candidate cache. It checks atomic publication, lock contention, lack of stray tmp/lock files, unchanged cache reusability, deliberate repair, and safe fallback for corrupt caches. Existing cross-engine tests ensure head label and score parity.

Run an isolated restart, registry-switch and corruption/recovery simulation:

```powershell
bun scripts/stress-senopati-v2-cache.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --restarts 3 --iterations 4 --out build/superagent/benchmarks/senopati_v2_cache_restart_stress.json
```

This script creates **temporary copies** of the original hash-pinned registry/model/policy, modifies only the temporary B candidate for hash invalidation, and deletes all temporary fixtures at exit. The source files and normal cache are untouched. No user messages are retained in the aggregate report.

## Local example results

Six scenarios, three independent Bun process restarts each, 146 development prompts repeated four times per child (total **18 processes / 10,512 observational classifications**):

| Scenario | Cache status | Median loading |
|---|---|---:|
| A active | hit | 7.62 ms |
| Switch to B before compile | miss_fallback_reference | 21.69 ms |
| B after explicit compile | hit | 7.97 ms |
| Return to A | hit | 7.73 ms |
| Corrupt A on disk | invalid_fallback_reference | 22.86 ms |
| A after explicit repair | hit | 8.25 ms |

All child predictions remained **abstained and unauthorized**, no production release. These numbers are from one Windows/Bun machine, small synthetic/development prompts, no real multi-tenant traffic, and are not production SLAs.

## Blockers

- A distinct **signed attestation/authorized publisher** is required to protect against attackers who can rewrite both a cache and its checksum.
- Long-duration high-concurrency service stress, Windows ACL review, crash fault-injection and crash-recovery procedure testing are still needed for broader confidence.
- No human-verified blind multilingual evaluation has been completed. Production Senopati V2 release gate remains **blocked**; no changes to automatic tool authorization, original ONNX or live router.
