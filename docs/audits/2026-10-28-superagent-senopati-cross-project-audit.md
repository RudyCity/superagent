# SuperAgent + Senopati Cross-Project Audit — October 28, 2026

> **Scope:** SuperAgent, Cika/Senopati, and directly related T-Line integration. Based on MCP s87 inspection, repository source code, configuration, prior test logs, and development documentation. This is **not** a production certification.

## Executive summary

SuperAgent and Cika/Senopati are real, accessible repositories with implemented model training, routing, shared inference, watchdog, fallback, and lifecycle components. Both passed limited repository health checks (root, boundary, Git, and manifest where applicable). An enabled backend configuration does **not** prove the inference service is currently running. Independent model quality and production release gates remain unverified.

## 1. Repository and connectivity inventory

| Item | Observed finding |
| --- | --- |
| Connector | MCP `s87` connected; status showed 108 visible tools |
| SuperAgent root | `D:\backup from pc asus\Documents Development\superagent` |
| SuperAgent branch | `main` according to workspace inspection |
| SuperAgent version/runtime | `1.14.55`; Bun-based build/test scripts |
| Cika/Senopati root | `G:\project\cika`; access confirmed through MCP |
| Repository health | Both projects reported `healthy` under limited checks; **not** runtime proof |
| Git worktrees | Both repositories contain pre-existing modified/untracked files; leave unrelated agent work untouched |

## 2. Senopati evolution and implementation

- **V4:** Dataset preparation, calibration, and RLCD-related experiments.
- **V5:** Shared encoder with `Choice`, `Score`, and `Noul` heads.
- **Legacy System-1 ONNX:** Compact classification, urgency scoring, and destructive-command safety.
- **Modern mmBERT:** Optional multilingual intent backend with six routing categories; does **not** replace the legacy destructive-command guard.
- **V6.7–V6.9 runtime:** Native tokenizer, local shared inference, bounded queue, watchdog, recovery, lifecycle CLI, and optional Windows login autostart.
- Relevant SuperAgent code includes `src/core/senopatiLifecycle.ts`, `src/core/senopatiSharedClient.ts`, `src/core/commands/senopatiCliHandler.ts`, and `src/core/assistantRouting.ts`.
- Cika source includes `senopati_system/model.rdy`, `tokenizer.rdy`, `dataset.rdy`, `inference.rdy`, `trainer.rdy`, `loss.rdy`, and `train_senopati_superagent.rdy`.

The presence of experimental training pipelines does not establish that their outputs are deployed.

## 3. Configured model, footprint, and precision

The SuperAgent file `models/senopati/active_backend.json` contains:

```json
{
  "backend": "mmbert-v64-seed73",
  "enabled": true,
  "minConfidence": 0.85,
  "precision": "int8_embedding",
  "inferenceMode": "shared_only",
  "preserveLegacySafety": true,
  "noAuthorizationFromModel": true
}
```

The model README reports the following *example measurements*:

| Variant | ONNX size | Example process RSS after loading |
| --- | ---: | ---: |
| FP32 | 536.5 MiB | 1,147 MiB |
| **INT8 embedding (configured)** | **256.2 MiB** | 865 MiB |
| INT4 embedding | 220.1 MiB | 819 MiB |
| Experimental full INT4 | 71.8 MiB | Not approved for active routing (86% Choice agreement) |

Other documented shared-inference trials measured approximately 568–576 MiB process RSS. On **400 inspected synthetic prompts**, INT8 and INT4 reported 99.75% and 98.75% Choice agreement with FP32 respectively. **Model agreement is not independently measured classification accuracy.** Process RSS is not equivalent to ONNX file size.

## 4. Integration architecture

```text
User / SuperAgent CLI / T-Line / Agent
                 |
                 v
SuperAgent routing and authorization policy
                 |
                 v
Senopati System-1
  |-- modern mmBERT INT8 shared intent backend
  |      |-- answer / artifact / delegate
  |      |   retrieve / tools / none
  |      `-- confidence gate and fallback
  `-- compact legacy destructive-command guard
                 |
                 v
Authorized SuperAgent tool execution
```

**Security boundary:** A model prediction does not authorize MCP access or tool execution. Permission checks and destructive-operation controls remain separate from model classification.

## 5. Previous test evidence (not rerun during this audit)

| Evidence | Reported result | Interpretation |
| --- | --- | --- |
| `.tmp-senopati-v69-final-tests.log` | **80/80 tests passed**, 11 files, 5.35 seconds | Unit/regression success, not AI accuracy |
| `.tmp-senopati-v69-regression.log` | 76/76 tests passed | Earlier regression log |
| V6.8 concurrent burst | 48/48 requests | Synthetic workload |
| V6.8 multiprocess | 192/192 requests across four processes | Synthetic workload |
| V6.7 tokenizer verification | 92/92 matching token IDs | Synthetic multilingual samples |
| V6.6 INT8 vs FP32 | 99.75% Choice agreement | Reference agreement, not human gold |
| V6.6 INT4 vs FP32 | 98.75% Choice agreement | Reference agreement, not human gold |

The V6.9 documentation also reports recovery after force-killing a model-only process in approximately 4.85 seconds and request draining under a 48-request load. These prior results were **not independently reproduced in this inspection**. Actual Windows reboot behavior, packaged T-Line upgrades, and independent natural human-gold evaluations are still unverified.

## 6. RLCD methodological note

The examined Cika `senopati_system/loss.rdy` implements Cross-Entropy and Brier/MSE-based calibrated objectives for Choice, Score, and Noul. This establishes a calibrated supervised-learning objective in that file; **the loss implementation alone does not demonstrate an explicit reinforcement-learning reward/feedback loop**. Additional RLCD-related training experiments exist in Cika and require separate inspection of their actual training loops and evaluations.

## 7. Prioritized remaining work

| Priority | Task | Status |
| --- | --- | --- |
| P0 | Verify live shared inference, model owner, watchdog, IPC, hash, memory, and fallback via status/doctor | Not executed |
| P0 | Inspect Git changes and protect concurrent agent work | Inspected; both repos dirty |
| P0 | Independent human-gold, holdout, OOD, macro-F1, ECE, safety error analysis | Not sufficiently verified |
| P1 | Rerun end-to-end intent routing → authorization → tools, including fallback and fail-closed behavior | Not rerun |
| P1 | Validate actual Windows reboot, watchdog startup, packaged T-Line, and single-owner recovery | Not verified |
| P2 | Clarify version nomenclature: mmBERT V6.4 model vs V6.9 lifecycle vs legacy classifier | Needs documentation |
| P2 | Audit RLCD training methodology, reward/feedback, dataset splitting, and leakage risks | Pending |

### Release acceptance criteria

1. `superagent senopati status/doctor` confirms the intended model, a unique shared owner, operational watchdog/IPC, validated hash, memory, and fallback.
2. Reproducible end-to-end routing tests show no permissions gained from model predictions.
3. Independent gold evaluation reports a confusion matrix, macro-F1, per-class recall, calibration/ECE, and OOD errors separately from software test pass rates.
4. Crash/reboot and packaged-desktop tests show bounded recovery without duplicate inference owners or unauthorized disruption to CLI/T-Line sessions.
5. Production-ready status is withheld until applicable release gates are evidenced.

## 8. Conclusion

Both projects contain substantive implementations and passed limited repository-level health checks. SuperAgent is **configured** to use mmBERT V6.4 seed73 INT8 in `shared_only` mode with V6.9 lifecycle support. **80/80 regression tests passing does not imply 100% model accuracy.** Live runtime health, independently evaluated model quality, reboot resilience, and packaged desktop integration still require verification.

**Inspection method:** Read-only examination of MCP-visible source files, configuration, prior logs, project health, and Git status. No model training or runtime test suite was rerun, and no unrelated agent modifications were changed.
