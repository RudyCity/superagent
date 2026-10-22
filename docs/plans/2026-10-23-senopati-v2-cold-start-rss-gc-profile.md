# Senopati V2 — cold-start and RSS/GC lifecycle optimization
Date: 2026-10-23. Branch: `main` of SuperAgent. **Read-only research/shadow candidate only.**

## Scope / engineering changes

The compact sparse shadow engine previously instantiated a full `SenopatiV2Shadow` instance just to validate the candidate schema during startup, then discarded it. The new `src/core/senopatiV2CandidateValidation.ts` checks the same core reference rules without allocating a temporary reference model: candidate-only manifest, record count (1–10,000), five-head ordering, per-record feature count (at most 600), valid feature prefix/weight (finite 0–10) and class IDs.

`src/core/senopatiV2CompactShadow.ts` now invokes this lightweight validator prior to allocating compact arrays. This removes temporary model-object construction, but is **not proof that loading is faster**: compact still needs to parse JSON, hash both registry files and build its postings.

A new CLI `scripts/profile-senopati-v2-lifecycle.ts` runs each engine in a **separate Bun child process**, with 3 repetitions by default and round-robin engine order to reduce scheduling bias. It captures model load time, phase-specific heap/RSS/external/arrayBuffer usage, maximum **sampled** process RSS, and optionally the duration and post-GC heap after `Bun.gc(true)`. It stores only aggregate measurements and the engine name, never raw prompts. Inputs can be deterministically perturbed with `--heterogeneous`; these transformations are *benchmark-only* and are not labels, training data or an independent accuracy test.

```powershell
bun scripts/profile-senopati-v2-lifecycle.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --runs 3 --iterations 8 --gc --out build/superagent/benchmarks/senopati_v2_isolated_lifecycle.json
bun scripts/profile-senopati-v2-lifecycle.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --runs 3 --iterations 8 --gc --heterogeneous --out build/superagent/benchmarks/senopati_v2_heterogeneous_lifecycle.json
```

Every child verifies the hash-pinned candidate and profile through `loadShadowRegistry` and refuses any output that could authorize tools. The worker startup and GC measurements are isolated by engine.

## Heterogeneous-input benchmark (3 runs per engine)

146 development prompts were perturbed deterministically with uppercase, punctuation, Unicode and contextual variants. Each process classified the 146-prompt set eight times. Results below are **medians from one local Windows/Bun 1.4.2 machine**, not audited production SLA:

| Metric | Reference | Indexed | Compact |
|---|---:|---:|---:|
| Cold model load, median | 26.55 ms | 41.65 ms | **41.33 ms** |
| Inferences/sec median | 178 | 507 | **9,550** |
| Sampled process RSS median | **92.52 MiB** | 117.31 MiB | 98.73 MiB |
| Heap after load median | 7.26 MiB | 9.47 MiB | 9.16 MiB |
| Heap after explicit GC median | 7.15 MiB | 7.48 MiB | **2.55 MiB** |
| Explicit GC duration median | 5.01 ms | 4.90 ms | 4.00 ms |
| Automatically authorized tool actions | 0 | 0 | **0** |

The first round with unchanged input recorded compact load ~46.35 ms, throughput ~9,418/sec and sampled RSS ~97.86 MiB. This variation reinforces that **the cold-start optimization is not yet proven to be a consistent improvement**. Compared with indexed, compact demonstrates substantially higher warm throughput with lower RSS in these particular tests; compared with reference, compact still uses somewhat more sampled RSS and starts slower.

RSS is **sampled**, not continuously measured by an external profiler, so transient peaks can be missed. The CLI retains `resourceMaxRssRaw` separately from sampled RSS because `process.resourceUsage().maxRSS` has platform-specific units. Heap and external buffers are distinct accounting fields; `arrayBuffers` may already be counted in `external` and should never be double counted. The explicit GC measurement is a diagnostic operation; no automatic GC calls were added to production or the inference engine.

## QA / correctness

- `tests/senopatiV2CandidateValidation.test.ts` compares the new validator with reference for malformed schemas, invalid class order, malformed vectors, bad weights, excessive features, empty candidates and candidate-only restrictions; checks that validation does not mutate the model.
- Existing compact, indexed, selective, approval and safety tests are preserved.
- Prior full cross-engine parity: **22,420/22,420 class-head comparisons equal**, including guarded and raw predictions on 1,121 previously seen development rows and zero score delta. This is implementation parity, not independent model accuracy.
- No edits to SuperAgent live router/ToolExecutor, no ONNX changes, and no replacement of the reference engine default.

## Remaining blockers

1. Independent, blinded, human-verified multilingual risk/approval labels are not available, so the production release gate remains blocked.
2. A representative service-level benchmark should measure real process RSS peaks, sustained concurrent requests, allocations, GC pause distribution and varied prompt lengths on deployment hardware.
3. A compiled, hash-bound compact model cache could potentially reduce repeated JSON parsing and startup cost, but should only be attempted after its integrity, versioning and rollback rules are specified and independently reviewed.

The existing reference engine remains default; compact can be opted into only for shadow profiling and research.
