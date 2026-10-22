# Senopati V2 — compiled compact shadow cache
Date: 2026-10-23. **Read-only experimental candidate. No production routing, ONNX replacement, or tool authorization.**

## Problem and implementation

The compact typed-array engine achieves high warm-throughput, but every fresh Bun process must parse the full JSON model and reconstruct the feature dictionary and postings. The new cache stores **only** a versioned compiled compact snapshot, rather than the original JSON record objects.

- `src/core/senopatiV2CompactSnapshot.ts`: typed-array snapshot schema.
- `src/core/senopatiV2CompactShadow.ts`: explicit snapshot export and *trusted-after-validation* reconstruction.
- `src/core/senopatiV2CompactCache.ts`: deterministic binary encoding and bounded decoder, format magic `SNPV2C01`, version 1, model/policy SHA-256 pair, UTF-8 feature dictionary, LE-encoded typed arrays, and SHA-256 integrity trailer.
- `src/core/senopatiV2CandidateRegistry.ts`: opt-in engine `compact-cached`. It **always reads and checks the pinned original model and policy SHA-256 first**. The policy JSON is validated each time. A missing cache falls back to the independently validated **reference** engine (`cacheStatus: miss_fallback_reference`); a malformed/corrupted cache also falls back to reference (`cacheStatus: invalid_fallback_reference`). No cache is silently written/repaired by runtime.
- `scripts/compile-senopati-v2-cache.ts`: explicit offline compiler; only it creates/rebuilds a binary under ignored `build/superagent/cache/`. The filename contains the source model hash, policy hash, and cache version, providing deterministic invalidation when a new candidate is registered.
- `scripts/check-senopati-v2-indexed-parity.ts --all --cached`: verifies **actual cache hit**, disallowing fallback masquerading as compiled-engine parity.
- `scripts/profile-senopati-v2-lifecycle.ts`: isolated four-engine cold-load/GC/RSS profiling with cacheStatus recorded.

The decoder checks the integrity checksum, binary magic/version, pinned model and policy hashes, strict section lengths and upper bounds, feature uniqueness, posting row bounds and ascending order, valid floating weights/norms, norm/weight consistency, and five-head label indexes. Cache arrays are copied into their owning model object. If any check fails, the cache is discarded. The cached engine is never an independent authorization authority.

**Security scope:** SHA-256 checksums detect ordinary tampering/corruption and allow source-artifact binding. They do **not** provide a cryptographic signature or prove the cache came from an authenticated publisher: anyone with write access to the cache could construct a different cache and recompute its checksum. For this reason the compiled format remains **research/shadow only** and never grants routing/ToolExecutor permissions. Production use would require controlled file permissions, signed trusted artifact attestation, offline provenance and independent audits.

## Usage

From the SuperAgent project root, assuming Cika has already generated the original hash-pinned registry and experimental policy:

```powershell
bun scripts/compile-senopati-v2-cache.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json
bun scripts/check-senopati-v2-indexed-parity.ts --all --cached --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --dataset "G:/project/cika/data/senopati/v2/frozen_holdout.jsonl" --dataset "G:/project/cika/data/senopati/v2/safety_holdout.jsonl" --dataset "G:/project/cika/superagent/datasets/v2_training.jsonl"
bun scripts/profile-senopati-v2-lifecycle.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --runs 3 --iterations 8 --heterogeneous --gc --out build/superagent/benchmarks/senopati_v2_cached_heterogeneous_lifecycle.json
bun --bun x vitest run tests/senopatiV2CompactCache.test.ts
```

If the hash-bound cache is absent, a call to `loadShadowRegistry(registryPath,"compact-cached")` transparently returns a **reference** model and non-hit cache status; neither the regular `reference` default nor live app routing changes.

## Local results — 2026-10-23

A compiled snapshot for 756 training records, 4,656 unique features and 40,403 postings occupied **488,746 bytes** (about 477 KiB). It was created explicitly under ignored `build/superagent/cache/`. The original model and calibration policy were not modified.

From **three isolated Bun child processes per engine**, 146 development prompts repeated eight times, with deterministic perturbations (mixed case, punctuation, Unicode and planning context) and explicit GC:

| Median metric | Reference | Indexed | Compact, fresh | Compact, cache hit |
|---|---:|---:|---:|---:|
| Model loading | 24.87 ms | 46.27 ms | 44.55 ms | **9.41 ms** |
| Inferences/sec (warm) | 126 | 424 | 7,006 | **7,400** |
| Sampled RSS | 92.29 MiB | 111.69 MiB | 95.61 MiB | **74.88 MiB** |
| Heap at load completion | 7.24 MiB | 8.03 MiB | 7.81 MiB | **2.30 MiB** |

Compiled-cache cold loading was roughly **4.7× faster** than fresh compact loading on this local run, and sampled RSS was around **22% lower**. Some run-to-run variation is inevitable; comparisons are **not production SLAs**, and sampled RSS can miss transient peaks.

Across 1,121 previously inspected/development prompts × 2 (raw and guarded) × 5 heads × 3 candidate engines, the compiled cache, fresh compact, and indexed engines all matched the reference **33,630/33,630** labels, with **zero** similarity-score difference. This establishes implementation parity on this corpus, **not** independent safety/accuracy certification.

Runtime fails closed for tool routing: risk/approval do not independently grant permissions, global abstention remains enabled, and no release gate was promoted.

## Remaining constraints

1. Cache format integrity is *not a signed model provenance system*; signed publisher attestation and protected cache storage remain required if stronger threat-model guarantees are needed.
2. No real authenticated human review or independent multilingual benchmark exists yet. The classifier's production release gate remains **blocked**.
3. Long-running service benchmarks should test cache update races, repeated builds, shutdowns, process RSS peaks, file permissions, and sustained multi-tenant load before considering a separately reviewed canary.
