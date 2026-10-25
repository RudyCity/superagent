# SuperAgent Senopati — guarded mmBERT V6.4 seed73 activation

Date: 2026-10-25
Workspace: D:\backup from pc asus\Documents Development\superagent
Status: local guarded semantic intent routing ACTIVE.
Full safety model production approval: BLOCKED.

## Model selection

Selected mmBERT V6.4 seed73 hard replay as the strongest Choice/intent candidate on the exploratory V6 evaluation (86.46% Choice accuracy). This is not established as universally best: all research evaluations are synthetic and repeatedly inspected. Its safety Noul head on V6.4 synthetic OOD falsely held 66/240 safe requests; on reused V6.2 OOD it missed 46/350 risky requests. Therefore its Noul output cannot grant authorization or replace the original destructive-command guard.

Original Senopati supports seven request categories and legacy destructive/urgency semantics. The newer model supports six Choice labels: answer, artifact, delegate, none, retrieve, tools. There is no safe 1:1 mapping of Noul/Score semantics or ONNX I/O. The replacement preserves legacy safety and applies new semantic Choice conservatively.

## Installed in SuperAgent

- src/core/senopatiModernBert.ts: lazy offline CPU model with SHA256-pinned assets, cached prediction, conservative Choice mapping, failed-load fallback.
- src/core/requestClassifier.ts: default classification now checks guarded policy and optional mmBERT Choice overlay, retaining original Senopati as baseline and fallback.
- scripts/senopati-model.ts: status, activate, rollback, smoke.
- models/senopati/active_backend.json: backend mmbert-v64-seed73, enabled true, minConfidence 0.85, preserveLegacySafety true, noAuthorizationFromModel true.
- models/senopati/mmbert-v64-seed73/: locally copied model and tokenizer (SHA256 verified).
- models/senopati/.gitignore: excludes the 536 MiB ONNX asset folder to prevent accidental Git commits.
- tests/senopatiModernBertRouting.test.ts: regression of safe mappings and no privilege expansion.

Old models/senopati/senopati_superagent.onnx was not overwritten.

## Verification

Cika exported ONNX via G:\project\cika\superagent\evaluation\v65_export_modernbert_onnx.py.
The result was checked using G:\project\cika\superagent\evaluation\v65_onnx_parity_cpu.py:
- ONNX SHA256: 3f2df66500342b57866301ea7f594646e3e6b608f6d9c785603f9206c95a6e43.
- ONNX model file: 536.48 MiB. Tokenizer JSON: 16.71 MiB.
- PyTorch and ONNX match on 12 English/Indonesian samples, maximum absolute logit error 0.000021.
- Short local ONNX CPU median: 52.372ms, excluding initialization and tokenization.
- Python and Bun/JS tokenizer IDs and attention mask matched exactly on an Indonesian text example.
- Bun local inference was successful for document retrieval, Choice retrieve confidence 97.33%.
- Activation command completed successfully, persisting guarded policy.
- Bun source smoke classified five cases; destructive rm -rf / remained marked destructive.
- Compiled dist/core/requestClassifier.js and dist/core/senopatiModernBert.js include and successfully execute the new backend.
- TypeScript noEmit check passed.
- 42/42 Vitest tests passed in targeted five suites for model mapping and MCP authorization boundaries.
- Broader requestClassifier.test.ts had one unrelated workspace AGENTS.md content assertion failure; it is not falsely counted as a green test run.

## Commands

From the SuperAgent project root:

    bun scripts/senopati-model.ts status
    bun scripts/senopati-model.ts smoke
    bun scripts/senopati-model.ts activate
    bun scripts/senopati-model.ts rollback

Rollback atomically disables only the new semantic overlay. Previous ONNX remains unchanged. Config read occurs at request time in updated runtime.

## Live process limitations

A supervised API core was not registered on standard port 7888 when checked. Therefore no rolling core restart was attempted. Existing unsupervised T-Line/MCP/Muse/Telegram processes may still use previously imported code until their own safe reload. No currently running process or tunnel was force-killed. The new compiled/runtime path was validated in an independent fresh process.

The experimental model must not be considered a permission grant. The host MCP permission, scope and project ACLs remain separate. For a full independent production-grade safety replacement, human-natural gold, real authenticated permission E2E, monitored shadow and rollbacks are still needed.

This 536 MiB local model bundle is excluded from Git; a separate binary provisioning step is needed on another machine. Check upstream mmBERT and data license terms before redistributing or relicensing model weights. The current workspace was already dirty with unrelated changes, so no automatic broad git commit was attempted.

## Measured Bun CPU process footprint

Isolated compiled Bun process (one candidate model instance):
- RSS before model initialization: 39 MiB.
- RSS after initialization/inference: 1,200 MiB.
- Cold load plus first inference: 2,763 ms.
- Distinct warmed request latency: 49.79 ms.

These are single-process local measurements, not a service-wide SLA. Additional independent SuperAgent processes may each allocate another model instance and increase total RAM. An eventual shared local inference service could avoid that duplication; this migration did not implement one.
