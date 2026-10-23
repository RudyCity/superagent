# SuperAgent Senopati V2 — candidate shadow integration

Date: 2026-10-22. Implementation based on `G:\\project\\cika` (Rudy).

This work deliberately does **not** replace SuperAgent's Senopati ONNX classifier or alter existing routing, approval, and tool execution policies.

## New SuperAgent modules
- `src/core/senopatiV2Shadow.ts`: strict candidate JSON manifest validator and Bun read-only sparse five-head inference.
- `src/core/senopatiV2Safety.ts`: observational, contextual approval and high-risk action postprocessing. It cannot grant execution permission.
- `scripts/run-senopati-v2-shadow.ts`: manual candidate inference command.
- `scripts/check-senopati-v2-parity.ts`: cross-Rudy/Bun comparison with a minimum 50-example oracle.
- `tests/senopatiV2Shadow.test.ts` and `tests/senopatiV2Safety.test.ts`: schema, safety, and isolation tests.

## Run the candidate manually

```powershell
bun scripts/run-senopati-v2-shadow.ts --model "G:/project/cika/build/senopati_v2_candidate/sparse_baseline.json" --text "Buat caption tentang kopi"
bun scripts/check-senopati-v2-parity.ts "G:/project/cika/build/senopati_v2_candidate/sparse_baseline.json" "G:/project/cika/build/senopati_v2_candidate/shadow_oracle.jsonl"
```

The model path must be explicit; no hardcoded private developer folder, auto-launch or cloud call occurs in normal classification. Inference is observational only: `authorizesExecution: false` remains immutable in both raw and guard views.

## Results and limitations

- Rudy/Bun guarded output parity: **555/555 labels** on 111 development messages.
- Senopati V2 neural candidate trained 45 epochs but has insufficient generalization and is NOT suitable for production.
- Sparse V2 guard-enhanced head macro-F1, on the development holdout: domain 0.598, intent 0.618, action 0.699, risk 0.867, approval 0.976. False negative destructive and false affirmative approval were 0 for this limited set only; this is **not** a guarantee.
- Original V1 Senopati ONNX remains active. Neither path may authorize side-effect tools or approve plans without the normal runtime consent and authorization gate.
- Training CUDA driver/autograd crash persists; Cika defaults to Rudy CPU. ONNX V2 export has not been validated. An expanded independent benchmark and genuine teacher-distillation dataset are still needed before promotion.

For dataset schema and training commands see `G:\\project\\cika\\docs\\SENOPATI_V2.md`. Preserve concurrent unrelated working tree edits; do not blanket-stage changes.
