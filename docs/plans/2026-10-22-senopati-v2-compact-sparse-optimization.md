# Senopati V2 compact sparse shadow — typed-array memory optimization

**Date:** 2026-10-22. **Status:** Research / opt-in shadow only; active SuperAgent routing, ToolExecutor, release gate, Cika training weights, and production ONNX were **not modified**.

## Summary

The earlier `indexed` sparse engine stored a separately copied JavaScript feature object per training example **plus** the inverted index. The new `compact` engine uses **contiguous typed arrays** (Uint16 record IDs, Float64 posting weights, Float64 record norms, Uint8 categorical label IDs) and a feature→[start,end) offset map. It retains no per-record feature objects.

Its query loop accumulates feature dot-products *in query-feature insertion order*, then sorts touched record IDs to preserve original reference tie breaking. The result preserves the original five-head decisions, same scores and exactly the same independent tool-authorization policy.

## Performance — local developer benchmark, NOT production SLA

Same model registry with SHA-256 pins, same 146 synthetically authored prompts, single Windows/Bun machine.

| Measurement | Reference | Original indexed | New compact |
|---|---:|---:|---:|
| Mean isolated inference | ~3.84 ms | ~1.71 ms | **~0.138 ms** |
| p95 isolated inference | ~5.64 ms | ~2.36 ms | **~0.197 ms** |
| Single-process experimental load | ~22 ms | ~49 ms | ~52 ms |

Single-process non-reference benchmarks load **both candidate and reference** before measuring for parity, so **heap and cold start are not clean per-engine comparisons**. Treat their cold start numbers as illustrative, not conclusive.

Worker-thread comparison (4 Bun workers × 8 repeats × 146 prompts = **4,672 evaluations** per engine):

| Measurement | Original indexed | New compact |
|---|---:|---:|
| Worker wall time | 2500 ms | 353 ms |
| End-to-end worker throughput | ~1,869/s | **~13,249/s** |
| Approximate ending heap per worker | ~16.9 MB | **~12.1 MB** |
| Observed reduction in ending heap | — | **~28%** |
| Worker model load (range) | ~44–48 ms | ~46–55 ms |
| Non-abstaining automatic decisions | 0 | **0** |

Measured throughput improvement was **~7.1×** versus indexed on this particular run; ending heap was ~28% lower. Worker heap snapshots are not RSS/peak retained memory; no long-running leak/capacity claim. Results are affected by CPU scheduling, Bun GC and warm-up.

## Correctness and safety

`bun scripts/check-senopati-v2-indexed-parity.ts --compact ...` tested 4 existing Cika corpora (146 unlabeled review, 58 frozen development, 53 safety development, 864 training examples): **1,121 prompts × raw/guarded × five heads = 11,210/11,210 matching comparisons**, with **zero numerical score difference** on these corpora.

Unit tests cover raw and guarded agreement with both reference and older indexed engine, malformed model weights, mutated input model payload after construction, invalid/corrupt inputs, empty/OOV/unicode messages, and finite input budgets. TypeScript type check passes.

The compact engine imposes message length ≤8192 code units, context length ≤512 and total posting budget ≤1,000,000. Oversized inputs throw; they never produce an acceptance decision. Existing model registry validates file SHA-256, accepts only explicit `compact`, `indexed` or `reference` engine argument, and defaults to `reference`. Risk/approval acceptance, automatic routing and direct tool authorization remain disabled.

This is **implementation parity on previously inspected examples**, not an independent model-quality or safety benchmark. The original risk/approval model shortcomings and lack of independently verified human labels remain blockers.

## Reproduce

From the independent SuperAgent repository:

```powershell
# The candidate registry must already have been explicitly created as documented in
# docs/plans/2026-10-22-senopati-v2-p0-p3-selective-shadow.md
bun scripts/check-senopati-v2-indexed-parity.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --compact --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --dataset "G:/project/cika/data/senopati/v2/frozen_holdout.jsonl" --dataset "G:/project/cika/data/senopati/v2/safety_holdout.jsonl" --dataset "G:/project/cika/superagent/datasets/v2_training.jsonl"

bun scripts/bench-senopati-v2-shadow.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --engine compact --out build/superagent/benchmarks/compact.json

bun scripts/bench-senopati-v2-workers.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --engine compact --workers 4 --iterations 8 --out build/superagent/benchmarks/compact-workers.json

bun --bun x vitest run tests/senopatiV2CompactShadow.test.ts
bun --bun x tsc --noEmit
```

## Recommendation

For long-running **explicit shadow evaluation**, compact offers the best throughput of the three experimental sparse engines while reducing ending heap compared with indexed. Keep the original `reference` as default and fallback. No live routing switch, telemetry of private prompts, automatic permission decision, or model promotion has been made. Next prerequisite for improved model accuracy is independently reviewed consent/risk data and a genuinely blind benchmark; runtime speed does not remove those requirements.
