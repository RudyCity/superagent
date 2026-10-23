# Cika → SuperAgent Senopati shadow handoff verification
Date: 2026-10-23.

Canonical training and model packaging repository: **Cika** (`G:\project\cika`). The SuperAgent application remains inference-only for experimental model packages. The Cika pipeline report and validation rules are in `superagent/pipelines/ROADMAP_V3_P0_P3.md` and `AGENTS.md` in Cika.

This tool **does not install, stage, replace, activate, or roll back runtime model artifacts**. An invalid handoff simply fails; the active model is untouched. Cika's V3 learned intent candidate failed minority-class checks, so the only handoff generated at this stage is the pre-existing **sparse V2 candidate** with shadow-only policy. There is no V3 binary for production.

From SuperAgent:

```powershell
bun scripts/verify-senopati-cika-handoff.ts --handoff "G:/project/cika/build/superagent/v3_handoff/handoff_manifest_v1.json" --registry "G:/project/cika/build/superagent/v3_handoff/cika_shadow_registry_v1.json"
bun --bun x vitest run tests/senopatiCikaHandoff.test.ts
bun --bun x tsc --noEmit
```

Checks: bounded regular metadata/registry files, registry SHA-256 of **written file bytes**, original source/model and policy SHA-256 hashes, schema-1 shadow-only registry, validated label-head/source format and selective risk/approval abstention. A single guarded development prediction is evaluated to ensure no automatic tool authorization. Negative tests reject modified model bytes, policy bytes, registry and forged promotion flags.

The Cika producer is `rudy superagent/pipelines/shadow_handoff_v3.rdy prepare` followed by `verify`, which refuses changed pinned artifacts. Handoff manifest pins source artifact digests and model version, **not publisher signatures**. A sufficiently privileged attacker who can modify the producer and all manifests can still forge a checksum. Signed attestation/secured release-control and actual independent blind gold evaluation remain blockers.

No copies of live ONNX models, ToolExecutor policies, user tokens, credentials, or training sets are written. All source data remains in the ignored Cika build tree. The original SuperAgent model files and launcher are left unchanged; the default engine remains the existing production classifier. This is a research shadow inspection, **not a production rollout**.
