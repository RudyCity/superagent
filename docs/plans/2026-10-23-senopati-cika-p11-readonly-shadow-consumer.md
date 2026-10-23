# Cika P11 — read-only synthetic shadow consumer

Implemented `scripts/verify-senopati-cika-p11-shadow.ts` and `tests/senopatiCikaP11Shadow.test.ts`.

**Purpose:** Verify SHA-256-pinned Cika P11 research artifacts across repositories, without importing Cika's Rudy model into the SuperAgent runtime, activating ONNX, opening network connections, accessing live customer sessions, or authorizing tools. The Cika source data is **72 developer-created synthetic examples**, not authenticated human gold.

The external Cika experiment compared the fixed P10 synthetic research checkpoint with its **V2 research fallback**, not the active production model. It reported 3 destructive AI-labeled messages predicted `safe` by both; P10 risk macro-F1 0.643 and approval 0.561 on the 72-case synthetic stress set. P10 may not be deployed. The Cika Doctor now reports **14 release blockers**.

From the SuperAgent checkout:

```powershell
bun scripts/verify-senopati-cika-p11-shadow.ts --cika-root "G:\project\cika" --handoff "G:\project\cika\build\superagent\v3_p11_shadow_v2\cika_p11_shadow_handoff.json" --observations "G:\project\cika\build\superagent\v3_p11_shadow_v2\cika_p11_observations.jsonl"
bun --bun x vitest run tests/senopatiCikaP11Shadow.test.ts tests/senopatiCikaHandoff.test.ts
bun --bun x tsc --noEmit
```

The verifier rejects changed candidate/baseline files, altered observation bytes, forged authority booleans, noncanonical data source, bad per-language sample groups, mismatched per-head confusion matrices, inaccurate summary macro-F1 or risk/approval counts, missing guard constraints and extra observation fields. Tests use ephemeral mocked Cika-root fixtures with no real customer data. The success response keeps `liveProductionParityVerified:false`, `toolAuthorization:false`, `releaseAuthorized:false`.

The first Cika `v3_p11_shadow/` directory contains an **obsolete unverified** output with Windows newline SHA mismatch; use only `v3_p11_shadow_v2/`, which writes bytes without line-ending transformation. SHA-256 confirms **internal integrity, not trusted publisher identity or external consent**. No SuperAgent README or shared command files were changed because they are under active concurrent edits.

Canonical source explanation: `G:\project\cika\superagent\pipelines\PHASE_P11_V3_FORM_SHIFT_SHADOW.md`.
