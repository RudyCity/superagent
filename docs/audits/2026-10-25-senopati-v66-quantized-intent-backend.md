# Senopati V6.6: CPU ONNX INT8 / INT4 precision investigation

Date: 25 October 2026
Workspaces: Cika and SuperAgent on Windows, Bun CPU runtime.
Status: INT8 embedding is ACTIVE for guarded intent routing only. Safety research gate is NOT approved.

## What was quantized

Original mmBERT-small V6.4 seed73 model FP32 uses a 375 MiB token-embedding table (256,000 rows x 384 dimensions). Standard INT8 MatMul conversion damaged Choice predictions. A sparse per-row signed INT8 embedding Gather implementation keeps attention, feed-forward blocks and classifier heads in FP32. No tool permissions or live customer data are changed.

## Actual comparison

| Quantization | ONNX MiB | Bun process RSS after model load MiB | Warm Bun median ms | Choice agreement with FP32 |
|---|---:|---:|---:|---:|
| fp32 | 536.5 | 1147 | 71.25 | reference |
| int8_embedding_rowwise | 256.2 | 865 | 49.43 | 99.75% |
| int4_gather_b32 | 220.1 | 819 | 41.53 | 98.75% |
| int4_matmul_gather | 71.8 | 525 | 43.56 | 86.00% |
| int8_u8 | 416.1 | not measured | not measured | 89.25% |
| int8_s8 | 416.1 | not measured | not measured | 10.00% |

## INT8 selected and exact experiment limits

INT8 rowwise file: 256.210 MiB vs FP32 536.483 MiB.
Bun RSS after load: 1147 MiB FP32 -> 865 MiB INT8.
Bun median warm single inference: 71.25 ms FP32 -> 49.43 ms INT8.
INT8 Choice: 99.75% agreement, 1 of 400 category changes.
INT8 confidence threshold agreement: 99.50%, 2 gate changes.
INT8 Score class: 99.75% match.
INT8 semantic risk threshold agreement: 100.00%, but that is NOT a security permission.

These 400 data points come from previously inspected synthetic V6.2 diagnostic and V6.4 OOD splits, not untouched natural human-reviewed gold. Bun benchmark is an isolated single process per variant (24 short fixed prompts), not a service SLO or shared model stress test. RSS includes tokenizer, Bun VM, ONNX Runtime, graph buffers and model weights. More than 400 MiB remains used just after tokenizer initialization.

## Runtime integration and rollback

Active policy: models/senopati/active_backend.json with enabled=true, precision=int8_embedding, minConfidence=0.85, preserveLegacySafety=true, noAuthorizationFromModel=true.
Native Bun implementation: src/core/senopatiModernBert.ts; semantic routing overlay in src/core/requestClassifier.ts.
Model binaries are SHA256 pinned in models/senopati/mmbert-v64-seed73/local_integration_manifest.json and excluded from Git via models/senopati/.gitignore.
FP32 model.onnx stays available; model_int8_embedding.onnx and model_int4_embedding.onnx are additional files, not overwrites. The full INT4 71.8 MiB variant is rejected from selectable CLI due to 86% Choice agreement.

Commands from SuperAgent root:

    bun scripts/senopati-model.ts status
    bun scripts/senopati-model.ts smoke
    bun scripts/senopati-model.ts activate int8_embedding
    bun scripts/senopati-model.ts activate fp32
    bun scripts/senopati-model.ts activate int4_embedding
    bun scripts/senopati-model.ts rollback

Activation attempts an inference smoke and atomically restores prior precision if it fails. A corrupted quantized model SHA256 causes fallback to the original local legacy Senopati. Tool authorization, project access and the legacy destructive guardrail are unchanged.

## Verification, limitations

- Quant experiments, fixed sample data, manifests: Cika build/senopati_v4_research/mmbert_small_v6/interop_v65/quantized_v66.
- Quantization Python scripts: Cika superagent/evaluation/v66_embedding_rowwise_int8.py, v66_embedding_quantize.py, v66_int4_quantize.py and v66_quant_parity_benchmark.py.
- Independent Bun process benchmark: scripts/benchmark-senopati-quant.ts.
- Local runtime smoke after INT8 activation: passed, including destructive rm -rf / remaining destructive.
- The compiled dist/core/senopatiModernBert.js was checked to load configured INT8, not FP32.
- 43 targeted Vitest cases in 5 suites passed after new precision policy tests, and TypeScript build/check passed.
- Human gold unavailable; semantic risk head remains NOT production approved and cannot grant any tool, delegation, tenant or privacy access.
- Previously running processes importing older JavaScript may need a safe reload; no forced restart of active tunnel/agent sessions.
- No broad Git commit or binary upload performed; other unrelated working tree changes left intact.

