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
