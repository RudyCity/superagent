# Four-engine OCR evaluation on real Indonesian and English documents

Date: 2026-11-05. Public Apache-2.0 MDPBench; 20 unique original documents
(10 Indonesian + 10 English). Human-reviewed layout transcriptions.

| Engine | ID annotated token recall | EN annotated token recall | ID token F1 | EN token F1 |
|---|---:|---:|---:|---:|
| tiny | 97.03% | 95.39% | 88.56% | 89.13% |
| small | 97.40% | 95.67% | 88.78% | 88.99% |
| medium | 97.74% | 95.46% | 88.98% | 88.70% |
| tesseract | 92.21% | 89.43% | 85.27% | 77.94% |

## Metric warnings
- These are word-overlap results against layout annotations, not full-page CER/WER.
- Reading order ignored; detection bounding-box ground truth not measured.
- Missing annotations or visible text outside annotated layout may lower precision.
- This is a 20-document pilot, not 200 independent adjudicated real scans.
- No model training, fine-tuning or custom OCR weights.
- Source JSON and images are cached privately outside Git; repo holds only hashed statistical results.
- Use scripts/bench_pdf_ocr_mdpbench.py to reproduce on the pinned corpus.
