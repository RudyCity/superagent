# Senopati V2 indexed shadow inference — optimization report
Date: 2026-10-22

**Status:** opt-in, observational *shadow candidate*. No change to the live SuperAgent router, ToolExecutor, existing production ONNX or Senopati model weights.

## Why optimize

The existing experimental `SenopatiV2Shadow` compares every query with **every** candidate record, and recomputes part of query-vector normalization inside the per-record loop. On an 864-example sparse model this wastes computation when most records share no informative features with the query.

The new `src/core/senopatiV2IndexedShadow.ts` builds **inverted feature→record postings** at load time, computes query norm once, and visits only records sharing an observed query feature. It explicitly sorts candidate record IDs to preserve **the original corpus-order tie breaking** for best and second-best per class. Head label order, max-score formula, and safety guard match the reference implementation exactly.

**Bounded input:** max 8192 message code units and 512 context code units; at most 1,000,000 indexed feature postings. Invalid input rejects rather than silently treating oversized input as a valid prediction. The indexed engine reuses the original reference parser for schema/weight validation.

## Reproducible parity tests

```powershell
bun --bun x vitest run tests/senopatiV2IndexedShadow.test.ts
bun scripts/check-senopati-v2-indexed-parity.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --dataset "G:/project/cika/data/senopati/v2/frozen_holdout.jsonl" --dataset "G:/project/cika/data/senopati/v2/safety_holdout.jsonl" --dataset "G:/project/cika/superagent/datasets/v2_training.jsonl"
```

**Result:** **1121 independent input rows**, each evaluated as raw and guarded, across 5 heads = **11,210/11,210 output-head comparisons identical**, including *zero* difference in similarity shares on this corpus. **This is cross-implementation parity, not model accuracy.** The corpora were previously used for training/development and are not independent blind safety tests.

## Single-process local benchmark (146 prompts)

```powershell
bun scripts/bench-senopati-v2-shadow.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --engine reference --out build/superagent/benchmarks/reference.json
bun scripts/bench-senopati-v2-shadow.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --engine indexed --out build/superagent/benchmarks/indexed.json
```

| Metric | Original/reference | Indexed |
|---|---:|---:|
| Mean inference | 3.84 ms | 1.71 ms |
| p95 inference | 5.64 ms | 2.36 ms |
| Candidate load / cold start | 21.66 ms | 48.53 ms |
| Inference speedup | baseline | ~2.25× |

The indexed benchmark validates both *raw head labels and similarity scores* against the hash-pinned reference before timing. For this reason its reported heap measurement includes an additional reference model and **should not be compared as indexed-only heap usage**. Fast repeated inferences benefit from the index; one-off short-lived processes may prefer reference engine because indexed startup is slower.

## Worker-thread throughput (4 workers, 4 repeats each, 2336 total prompts)

```powershell
bun scripts/bench-senopati-v2-workers.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --engine reference --workers 4 --iterations 4
bun scripts/bench-senopati-v2-workers.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --engine indexed --workers 4 --iterations 4
```

| Metric | Original/reference | Indexed |
|---|---:|---:|
| Worker-thread wall time | 3757 ms | 1574 ms |
| Aggregate wall-clock throughput | 622 cases/sec | 1484 cases/sec |
| Approx. heap per worker (endpoint) | ~9.1 MB | ~16.8 MB |
| Startup / build overhead | lower | higher |
| Unsafe automatic decisions | 0 | 0 |

The indexed implementation achieved **~2.39×** measured throughput on this specific four-thread run; its larger in-memory inverted index costs roughly **~1.8× per-worker heap**, depending on the V8/Bun heap sampling point. All **2336/2336** cases abstained from automatic routing, including all risk and approval.

This is a single local machine benchmark with **synthetic/repeated development prompts**. It is not production service SLA, does not measure true network queueing or heterogeneous real user traffic, and is not proof of safety.

## Model registry and release restrictions

The existing `src/core/senopatiV2CandidateRegistry.ts` now accepts an explicit **`reference` (default) or `indexed`** engine when loading the same hash-pinned experimental model and profile. The registry hash policy and `SHADOW_ONLY` constraints remain unchanged.

- No new model weights or calibration thresholds were trained in this optimization.
- Risk and approval remain unconditional abstain for automation; the experimental model can never grant tool permission.
- Existing ToolExecutor/routing code is **untouched**. Production still uses its original model and permission mechanisms.
- Independent human review and independent multilingual blind evaluation remain prerequisites to any production use.

**Recommendation:** keep `reference` as default/fallback. Use `--engine indexed` explicitly in shadow evaluation when throughput justifies the increased memory and cold-start cost. Further improvements require representative varied-load and process-level memory benchmarks, independent evaluation, and reviewer-verified labels.
