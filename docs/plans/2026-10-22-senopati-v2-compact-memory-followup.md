# Senopati V2 compact sparse shadow — memory optimization follow-up

Date: 2026-10-22. This report covers the **isolated experimental** SuperAgent shadow classifier. There is **no promotion** to live routing, no ONNX replacement, and no permission changes in ToolExecutor.

## What changed

The compact model is stored in typed arrays rather than retaining record-feature JavaScript objects. This optimization follow-up further compresses the feature dictionary: instead of a Map with a separate JS tuple/span for every text feature, the runtime stores `Map<string, number>` feature IDs plus an indexed `Uint32Array` of posting offsets. `Uint16Array` record IDs and `Float64Array` weights/norms preserve numeric behavior. `Uint8Array` stores five-head class IDs. Temporary construction cursors are dropped after model loading.

The reference engine remains the default: users must specify `--engine compact` to opt into the new implementation in the **shadow-only** benchmarking tools. The registry is SHA-256 hash pinned, refuses modified candidates, and independently checks that the profile is marked experimental. Oversized messages/contexts are rejected before generating large sparse query vectors. The compact engine exposes its prior `numericBytes` stats field for backward compatibility.

## Cross-engine exact parity

```powershell
bun scripts/check-senopati-v2-indexed-parity.ts --all --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --dataset "G:/project/cika/data/senopati/v2/frozen_holdout.jsonl" --dataset "G:/project/cika/data/senopati/v2/safety_holdout.jsonl" --dataset "G:/project/cika/superagent/datasets/v2_training.jsonl"
```

Result: **22,420 / 22,420** `reference vs indexed` and `reference vs compact` class-head comparisons, from **1,121 previously inspected/development input rows × 2 guarded/raw modes × 5 heads × 2 candidate engines**. Maximum relative similarity-score difference **zero** on this corpus. This is implementation parity, **not unbiased accuracy validation**.

## Memory-aware worker benchmark

`scripts/bench-senopati-v2-workers.ts` now reports worker-local `heapUsedBytes`, `externalBytes`, and `arrayBuffersBytes` along with wall-clock throughput and in-process loading times. The external value may already include typed-array memory, so **never sum external and arrayBuffers a second time**. Values represent endpoints of bounded, local worker runs and are **not process-total RSS nor peak memory**.

Run each engine explicitly from the separate SuperAgent repository:

```powershell
bun scripts/bench-senopati-v2-workers.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --engine reference --workers 4 --iterations 4
bun scripts/bench-senopati-v2-workers.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --engine indexed --workers 4 --iterations 4
bun scripts/bench-senopati-v2-workers.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --engine compact --workers 4 --iterations 4
```

Sample measurement on a **single Windows/Bun machine**, 4 workers × 4 repetitions × 146 synthetic/development prompts = **2,336 inferences per engine**:

| Metric | Reference | Indexed | Compact (after offset packing) |
|---|---:|---:|---:|
| Aggregate cases/sec | 716 | 1,554 | 14,576 |
| Avg worker heap, MiB | 8.67 | 15.98 | **11.48** |
| Avg worker external, MiB | 0.79 | 2.89 | **3.33** |
| Approx. heap+external, MiB | 9.46 | 18.87 | **14.81** |
| Unsafe automatic authorizations | 0 | 0 | **0** |
| Global abstentions | 2,336 | 2,336 | **2,336** |

The optimized compact engine uses approximately **28% less JavaScript heap** than indexed in these runs; heap plus external is approximately **21% lower**, though this is **not a full RSS measurement**. Compact still uses **more total memory than reference** due to indexed postings and typed buffers. Engine startup and memory costs vary by garbage collection and workload. In a previous compact benchmark before feature-offset packing, mean worker heap was ~11.64 MiB and aggregate throughput ~10,483 cases/sec; comparing those single runs does not establish a stable speedup caused by offset packing. Longer load tests and true process-level profiling are still necessary.

`bun scripts/bench-senopati-v2-shadow.ts --engine compact` also verified all 146 guarded labels and similarity values before reporting warm inference. It intentionally holds a separate reference model in the same process during this benchmark, so its heap/cold-start figures should **not** be interpreted as compact-only measurements.

## Safety, source isolation and next steps

- All classifier outputs remain observational; `approval` and `risk` always abstain from **automatic tool routing**, and no model output can give permission to execute.
- Independent human adjudication and a genuinely blind multilingual benchmark remain unavailable. The Senopati V2 production release gate stays **blocked**.
- Changes are isolated to the optional compact engine and benchmarking/parity scripts. Concurrent changes to browser/CDP, terminal, MCP and main agent routing were neither overwritten nor included in this optimization.
- Suggested next engineering work: process-RSS/GC-peak measurement, repeated multi-run and heterogeneous-input benchmarking, handling large vocabularies, and only thereafter evaluating potential runtime integration under separately reviewed shadow feature flags.

For the earlier baseline/inverted-posting analysis, see `docs/plans/2026-10-22-senopati-v2-indexed-shadow-optimization.md`.
