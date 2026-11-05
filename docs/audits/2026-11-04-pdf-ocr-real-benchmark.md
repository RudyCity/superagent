# Measured OCR benchmark — synthetic scanned PDFs

Actual Tesseract executed after PDF rendering through SuperAgent; no mock OCR.

Engine: tesseract v5.5.0.20241111; available languages: eng; samples: 12.
Mean CER **1.19%**; mean WER **3.65%**.

| Language | N | Mean CER | Mean WER |
|---|---:|---:|---:|
| ID | 6 | 1.14% | 3.37% |
| EN | 6 | 1.25% | 3.94% |

The JSON companion contains each gold transcript, OCR prediction, SHA-256 evidence and runtime.
This is synthetic holdout material, not a representative real-world independent gold.
Indonesian traineddata is unavailable unless the engine model list explicitly includes ind.
Next: benchmark 100+ independent annotated real ID/EN scans and the full PDF OCR wrapper.
