# Senopati AI System-1 Neural Decision Engine

**Creator & Lead Architect:** Rudy Hermawan ([hrudy715@gmail.com](mailto:hrudy715@gmail.com))  
**Organization:** RudyCity / Cika AI Ecosystem  
**Model Name:** `senopati_superagent.onnx`  
**Target Platform:** Superagent CLI & IDE System-1 Intent Router  
**License:** Proprietary / Copyright (c) Rudy Hermawan. All rights reserved.

---

## 🏛️ Architecture Overview

Senopati AI System-1 is an ultra-low-latency, non-autoregressive Transformer Encoder designed for real-time request classification, epistemic calibration, urgency scoring, and security guardrail enforcement.

Unlike conventional causal LLMs that require autoregressive token generation (~50–100ms per token) and heavy disk footprint (~66 MB to 7B parameters), Senopati achieves **sub-millisecond single-pass inference (<1 ms)** with a compact **673 KB** binary footprint.

### Key Specifications
- **Architecture:** Non-Autoregressive Transformer Encoder + Multi-Task RLCD
- **Embeddings:** Learned Token Embeddings + Learnable Positional Embeddings (d_model = 64)
- **Attention Mechanism:** Scaled Dot-Product Self-Attention with 4 heads
- **FeedForward Network:** Position-Wise GELU FFN (d_ff = 128)
- **Sequence Pooling:** Context-Rich Sequence Pooling with Residual LayerNorm
- **Calibration Engine:** Platt Temperature Scaling with 10-Bin Expected Calibration Error (ECE) minimization
- **Inference Runtime:** Native `onnxruntime-node` (CPU AVX2 SIMD / CUDA acceleration)
- **Memory Footprint:** ~673 KB (ONNX Graph) + 25 KB (Tokenizer Vocabulary)
- **Token Cost:** 0 LLM Tokens per decision

---

## 🎯 Multi-Task Decision Outputs

In a single forward pass, Senopati outputs:

1. **Choice Head (7 Categories):**
   - `conversation` — General chit-chat, greetings, acknowledgments
   - `question` — Technical questions, conceptual explanations, inquiries
   - `simple_edit` — Small targeted edits, renames, single-file adjustments
   - `research` — Deep codebase exploration, symbol searches, investigations
   - `complex_task` — Multi-file refactors, architecture designs, new feature suites
   - `debug` — Bug fixes, runtime error triage, stack trace resolution
   - `command` — Terminal execution, build commands, test runs

2. **Score Head (Urgency Scale 1–5):**
   - Continuously calibrated expected urgency score from Level 1 (background / casual) to Level 5 (critical production outage / immediate action).

3. **Noul Head (Destructive Guardrail):**
   - Binary safety classifier detecting destructive shell commands (`rm -rf /`, formatting, drop table, kill system processes) to protect the user environment before tool execution.

---

## 🌐 Multilingual Training Data

Trained on curated multilingual datasets across:
- **Indonesian** (formal, technical, and casual slang)
- **English** (engineering and everyday technical parlance)
- **Indo-English Code-Switching** (natural bilingual developer workflow)
- **Spanish (Español)**
- **French (Français)**
- **German (Deutsch)**

---

## 👤 Credits & Attribution

- **Architect & Author:** Rudy Hermawan (`hrudy715@gmail.com`)
- **Origin Ecosystem:** Cika / RudyLang (`G:\project\cika\senopati_system`)
- **Integration Target:** Superagent (`D:\backup from pc asus\Documents Development\superagent`)


---

## Modern mmBERT CPU precision selection (October 2026)

The compact ONNX model described above is **the original legacy Senopati**.
The newer multilingual encoder is an *optional, separate intent backend*
with a different six-category taxonomy. Its Noul head does NOT replace the
legacy destructive-shell guard, and neither model authorizes MCP tools.

The modern backend now supports locally verified, SHA256-pinned ONNX choices:

| Precision | ONNX size | Example Bun process RSS after load | FP32 Choice agreement |
|---|---:|---:|---:|
| FP32 original | 536.5 MiB | 1,147 MiB | reference |
| INT8 row-wise embedding | 256.2 MiB | 865 MiB | 99.75% |
| INT4 embedding (32-value groups) | 220.1 MiB | 819 MiB | 98.75% |

The agreement comparison uses **400 previously inspected synthetic prompts**.
It is not independently reviewed human gold and does not authorize use as a
standalone production security guard. The separate full-INT4 71.8 MiB research
variant is rejected for active intent routing: only 86% Choice agreement.

From the SuperAgent repository root:

```bash
bun scripts/senopati-model.ts status
bun scripts/senopati-model.ts smoke
bun scripts/senopati-model.ts activate int8_embedding
bun scripts/senopati-model.ts activate int4_embedding
bun scripts/senopati-model.ts activate fp32
bun scripts/senopati-model.ts rollback
```

- **Active precision:** INT8 embedding (guarded intent only).
- **Rollback to FP32:** `activate fp32` keeps the modern intent backend but
  returns to original uncompressed mmBERT weights.
- **Rollback to legacy only:** `rollback` disables the modern overlay entirely.
- **Fallback:** Missing, corrupted, mismatched SHA256, unsupported or failing
  ONNX assets return to the original legacy Senopati classifier.
- **Reload:** Current code reads the precision policy per call; sessions on
  old processes that never loaded the updated code need a safe reload. Do
  not interrupt a live tunnel/agent to force a restart.
- **Memory:** RSS is the entire Bun process, not just the ONNX file.
  A short, independent per-variant process benchmark is not a service SLA.
- **Distribution:** The binary model bundle under
  `models/senopati/mmbert-v64-seed73/` is ignored by Git; new installations
  must provision and hash-verify it separately. Review upstream licenses
  before redistribution.

Audit: `docs/audits/2026-10-25-senopati-v66-quantized-intent-backend.md`.


---

## Native tokenizer and shared inference (V6.7)

The modern mmBERT INT8 semantic model can now run **once per local SuperAgent
installation/user profile**, shared by independent CLI, T-Line or other agent
processes. The original compact Senopati ONNX remains the always-present
fallback and destructive-shell checker; neither classifier grants MCP access.

### Local lifecycle commands

Run from the SuperAgent repository root:

```bash
bun scripts/senopati-shared.ts start      # start dedicated local ONNX owner
bun scripts/senopati-shared.ts enable     # switch callers to shared_only
bun scripts/senopati-shared.ts status     # PID, precision, RAM, requests
bun scripts/senopati-model.ts smoke      # test standard classification
bun scripts/senopati-shared.ts disable   # use per-process local ONNX again
bun scripts/senopati-shared.ts stop       # stop ONLY this inference daemon
bun scripts/senopati-model.ts rollback   # disable new semantic overlay
```

Currently enabled: `precision=int8_embedding`,
`inferenceMode=shared_only`. The shared model process uses the native Rust
`tokenizers@0.23.2` Node binding for local `tokenizer.json`, with a
Transformers.js fallback if that native module cannot load. It does not
fetch models or tokenizer data from a network endpoint.

On the Windows development machine, the isolated native tokenizer test used
~148 MiB total process RSS instead of ~482 MiB after loading both the native
and Transformers.js tokenizers. Token IDs matched Python's training tokenizer
on **92 of 92 synthetic multilingual examples**. A separate local INT8 model
process was ~575 MiB RSS; when shared it stabilized near ~568 MiB. Fresh Bun
clients in the originating and another workspace used only ~41–42 MiB RSS
for model IPC with `localModelLoaded=false`. These are local measurements, not
system-wide production resource guarantees.

The service exposes **only a local Windows named pipe / Unix socket** and uses
an ephemeral random bearer credential kept in the per-user SuperAgent config
directory. Requests and model outputs are not persisted or logged. Protect the
per-user directory with appropriate OS ACLs (Windows 0600 is best effort).
Never proxy the inference pipe to an internet endpoint or tunnel. It does not
accept tool calls, shell commands, file operations, or authorization requests.

When `shared_only` is configured and the service is unavailable, a caller
**falls back to legacy Senopati** without allocating its own mmBERT instance.
A precision switch through `senopati-model.ts activate` retains shared mode;
model binaries remain SHA256 pinned and are excluded from Git. Processes
started before this code was loaded may need a safe reload; no live tunnels
or agent sessions are force-restarted by these scripts.

For diagnostics and verification, see
`docs/audits/2026-10-25-senopati-v67-native-tokenizer-shared-inference.md`.
