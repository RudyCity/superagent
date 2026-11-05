# Advanced PDF operations in SuperAgent

Date: 2026-11-04
Status: **Implemented/tested in source, not activated in the running primary @s1000 owner.**
Follow the base guide in docs/guides/pdf-workflows.md.

## New dynamic Agent tools / MCP tools

| Agent tool | MCP tool | Permissions | Scope |
|---|---|---|---|
| pdf_edit_vector_exact | superagent_pdf_edit_vector_exact | Write + OAuth write + YOLO + project grant | Restricted original text replacement / vector redaction |
| pdf_sign | superagent_pdf_sign | Write + OAuth write + YOLO + project grant | PKCS#12 detached CMS signature |
| pdf_verify_signature | superagent_pdf_verify_signature | Read + project read grant | OpenSSL verification of one CMS signature |
| pdf_ocr_searchable | superagent_pdf_ocr_searchable | Write + OAuth write + YOLO + project grant | Add validated invisible pretrained OCR text layer to new scanned PDF |

The source now registers **12 PDF tools**, including `pdf_ocr` as a read-only OCR inference operation and `pdf_ocr_searchable` as a separate write operation. The live MCP catalog still requires authenticated owner activation.

The currently connected @s1000 MCP process must have its verified owner activated/reloaded with the new build before these are discoverable through the *live* gateway. Do not run a second persistent MCP server to work around the current owner.

## Restricted original text editing and vector redaction

This is **not** a general PDF layout engine. pdf-lib cannot ordinarily replace original non-form text. The optional backend uses pikepdf 10.17.0 (MPL-2.0, no AGPL), pdfminer.six 20250506 (MIT), and a strict content-stream gate. By default, `fontPolicy=standard14` supports **one unique printable ASCII /Tj, simple fragmented /TJ with bounded kerning, or a strictly consecutive multi-/Tj sequence inside one BT object** on one unrotated, uncropped page using an unembedded standard font. Multi-Tj support requires no positioning, text-state, marked-content or other operator between fragments; otherwise it fails closed rather than guessing layout. A TJ array is accepted only when all fragments map to the same independent extracted line, there is exactly one text show in its BT object, and every numeric kerning offset is within ±100.

The **opt-in `fontPolicy=embedded_subset`** supports *original-content replacement only* for one unique Type0 /Identity-H `Tj` **or bounded fragmented `TJ`** text run with an embedded CID subset. It reverses the document's one-to-one `/ToUnicode` mapping to rewrite the actual text-show, not an overlay. Both `bfchar` and **simple sequential `bfrange`** mappings are supported; inherited, array-valued or ambiguous CMaps fail closed. Multiple page font resources are allowed, but the target's active font is selected from the actual `Tf` operator and every replacement glyph must already exist in that subset. `TJ` numeric kerning remains bounded to ±100.

For replacement only, unrelated **Image XObjects**, existing graphics-state invocations and normal `Tr=0` text rendering may be preserved verbatim and independently checked after serialization; Form/PS/unknown XObjects still fail closed. Default behavior remains strict: a replacement that exceeds the original text bbox is rejected. The caller may explicitly provide `fitBounds={x0,y0,x1,y1}` in bottom-left PDF points to approve a larger visible region. The source line must already lie inside that box, the baseline must stay fixed, the verified output must remain inside it, and automatic horizontal scaling may never fall below 65%. This is bounded fitting, **not paragraph reflow**. The path still refuses missing glyphs, new glyph embedding, RTL/CJK shaping, duplicate targets, crop/rotation, arbitrary layout changes and embedded-font redaction.

- Replace: retain original operator placement, image/vector resources, graphics state and unrelated content; change only the uniquely matched text-show. Repeated whitespace may be normalized only to identify one unique visible replacement line. With `fitBounds`, wider text may use bounded horizontal fitting while retaining the original baseline; visual review remains mandatory.
- Redact: remove the text-show instruction itself before creating a new PDF, and add an opaque **vector** rectangle over its measured bbox. The source text is not merely covered. Re-parse with pdfminer + PDF.js, scan remaining literal/hex ASCII bytes, compare vector stroke counts, and validate SHA-256 before creating the output.
- Fail closed on duplicate targets, unsupported/ambiguous font mappings, Form/unknown XObjects, annotations/form fields, unsupported text rendering state, PDF signatures, ambiguous geometry, malformed content streams, encrypted PDFs, or absent backend. The **2026-11-05 redaction hardening** additionally refuses PDFs with `/Prev` incremental history, attachment/name trees, XMP metadata, actions, optional layers, tagged structures or the selected literal sensitive text also in document Info metadata. Two negative tests prove no output is published when a secret is duplicated in metadata or attachments. These conservative refusals prevent some false successes but do not amount to full-PDF sanitization.
- **Privacy limitation**: this is validated for the single selected Tj operator. It cannot certify that all sensitive content (metadata, other hidden objects, embedded files, unselected text) is absent. Do not treat it as a full-document certified privacy scrubber.
- Existing pdf_redact_raster remains available as a destructive full-page raster fallback when independently appropriate; it loses all selectable text, interactivity and vector fidelity.

### Isolated Python setup (one-time operator action)

Use an independent venv under the operator profile; **do not change global Python**:

On Windows:

    uv venv "%USERPROFILE%\.superagent-r\venvs\pdf-advanced" --python 3.12
    uv pip install --python "%USERPROFILE%\.superagent-r\venvs\pdf-advanced\Scripts\python.exe" -r scripts/pdf-vector-requirements.txt

On Linux/macOS:

    uv venv "$HOME/.superagent-r/venvs/pdf-advanced" --python 3.12
    uv pip install --python "$HOME/.superagent-r/venvs/pdf-advanced/bin/python" -r scripts/pdf-vector-requirements.txt

The operator can alternatively configure SUPERAGENT_PDF_PYTHON_BIN for a trusted, preinstalled environment. It is never accepted from an untrusted tool argument. The backend script is scripts/pdf_vector_backend.py and receives a bounded JSON request via stdin; it does not call shells or write the original file.

A source-verified edit request (the hash comes from pdf_inspect):

    {
      "inputPath": "docs/source.pdf",
      "outputPath": "docs/source.corrected.pdf",
      "expectedInputSha256": "SOURCE_SHA256",
      "page": 1,
      "mode": "replace_exact",
      "targetText": "OLD LABEL",
      "replacementText": "NEW LABEL"
    }

A secure *scoped* vector redaction request:

    {
      "inputPath": "docs/source.pdf",
      "outputPath": "docs/source.vector-redacted.pdf",
      "expectedInputSha256": "SOURCE_SHA256",
      "page": 1,
      "mode": "redact_exact",
      "targetText": "SECRET LABEL",
      "confirmRedact": true
    }

Run from an authorized project root, with the operation JSON already inside that project:

    bun scripts/pdf-cli.ts vector docs/pdf-vector-request.json

The output path is always create-only and cannot overwrite the source. The agent tool is pdf_edit_vector_exact. Run pdf_verify and render/compare affected pages after every operation.

## Detached PKCS#12 cryptographic signing

Signing is a deliberate, authenticated, **nonreversible** action. The sign tool requires an explicit confirmSign flag and a PKCS#12 bundle (.p12/.pfx) **inside the authorized workspace**. The operator, not the agent, must configure SUPERAGENT_PDF_P12_PASSWORD in the private runtime environment. NEVER pass signing passwords in prompts, JSON arguments or Git files; treat a certificate file as a sensitive credential and keep it ignored by Git, access-controlled and encrypted.

The implementation uses @signpdf/signpdf 4.0.0, @signpdf/signer-p12 4.0.0, @signpdf/placeholder-pdf-lib 4.0.0. It preserves the original PDF, creates a fresh signed PDF, and independently runs local OpenSSL cms -verify on the extracted detached CMS and signed ByteRange. The tool refuses a signed source, stale source SHA-256, missing password, and existing target.

A request (source hash supplied by pdf_inspect):

    {
      "inputPath": "docs/approved.pdf",
      "outputPath": "docs/approved.signed.pdf",
      "certificatePath": "private/signing-bundle.p12",
      "expectedInputSha256": "SOURCE_SHA256",
      "confirmSign": true,
      "signerName": "Authorized operator",
      "reason": "Document approval"
    }

Use:

    bun scripts/pdf-cli.ts sign docs/pdf-sign-request.json
    bun scripts/pdf-cli.ts verify-signature docs/approved.signed.pdf

or dynamic tools pdf_sign and pdf_verify_signature.

**Critical distinction:** independent OpenSSL CMS verification does not alone establish certificate-chain trust, revocation, an RFC 3161 trusted timestamp, PAdES profile conformance or qualified legal identity. `pdf_verify_signature` therefore exposes separate, operator-controlled validation paths:

- `verifyTrustedChain:true` checks the signer against only `SUPERAGENT_PDF_CA_BUNDLE`.
- `verifyOfflineCrl:true` additionally checks `SUPERAGENT_PDF_CA_CRL_BUNDLE` with OpenSSL `cms -verify -crl_check`. No certificate-supplied AIA/OCSP/CRL URL is fetched.
- `verifyIndependentPades:true` invokes the pinned **pyHanko 0.38.1** validator in an isolated local environment. It uses `SUPERAGENT_PDF_CA_BUNDLE`, optional `SUPERAGENT_PDF_TSA_CA_BUNDLE`, and optional operator-controlled **DER OCSP response** from `SUPERAGENT_PDF_OCSP_RESPONSE`, with network fetching disabled. It evaluates PDF/CMS integrity, signer trust, embedded DSS OCSP/CRL material when present, operator OCSP evidence when configured, RFC3161 signature/content timestamps and formal ETSI EN 319 102-1 AdES Basic (§5.3), With-Time (§5.5) and LTA (§5.6.3) results.

Revocation is deliberately conservative: a trusted chain without revocation evidence is reported as `not_available`, not “validated”. Embedded DSS evidence and operator OCSP evidence are tracked separately; only a second validation pass with revocation information **required** can report `valid_by_revocation_evidence`. The operator OCSP response must be a bounded local regular file; certificate-advertised URLs are never fetched. Real local fixtures prove both OCSP `good` and `revoked` outcomes, plus RFC3161 trusted timestamp and wrong-TSA-root downgrade while CMS integrity remains valid. The LTA result separately reports whether a later document-timestamp Evidence Record exists. **Even a formal AdES LTA `PASSED` result is not advertised as PAdES B-LTA structural certification when that structural evidence is absent.** `padesProfile` remains `not_structurally_certified`; B-B/B-T/B-LT/B-LTA profile certification and qualified legal identity are separate release gates. No certificate/private key is checked into Git; test keys, OCSP credentials and TSA credentials are ephemeral.

## Pretrained-only four-way OCR and searchable PDF (new source milestone)

The real local OCR worker now uses **pretrained PP-OCRv6 Tiny/Small/Medium through RapidOCR 3.9.2 + ONNX Runtime 1.23.2**, or **Tesseract eng+ind**. No custom training or fine-tuning. All three pairs of detector/recognizer weights and dictionaries were provisioned under `~/.superagent-r/models/pdf-ocr-v6/` and validated using the pinned `scripts/pdf-ocr-v6-lock.json`. The isolated Python environment is `~/.superagent-r/venvs/pdf-ocr-rapid`, not global Python.

Provision explicitly (one time, from SuperAgent repo):

    uv venv "%USERPROFILE%\.superagent-r\venvs\pdf-ocr-rapid" --python 3.12
    uv pip install --python "%USERPROFILE%\.superagent-r\venvs\pdf-ocr-rapid\Scripts\python.exe" rapidocr==3.9.2 onnxruntime==1.23.2 pillow==12.0.0 psutil==7.1.0
    "%USERPROFILE%\.superagent-r\venvs\pdf-ocr-rapid\Scripts\python.exe" scripts/pdf_ocr_models.py --install --tiers tiny,small,medium --tessdata --font

`--font` explicitly provisions SHA-256-pinned Noto Sans Regular locally for Unicode searchable PDF layers (for example `Pendidikan – Café`). The font is licensed under **SIL Open Font License 1.1**, with source, checksum and license URL recorded in `scripts/pdf-ocr-v6-lock.json`. **No font binary is checked into the repository or attached to user responses.** PDF outputs use font subsetting; all OCR lines must pass independent extraction and page pixel parity. If a glyph is not supported by the pinned font, publication fails closed. The font does not make every world script or PDF/UA automatically supported.

Recheck offline without redownloading:

    "%USERPROFILE%\.superagent-r\venvs\pdf-ocr-rapid\Scripts\python.exe" scripts/pdf_ocr_models.py --tiers tiny,small,medium

After installation, `pdf_ocr` selects a page with a native text layer for extraction (no pretrained inference unless forced); image-only pages call the actual offline pretrained worker. Every OCR page identifies engine, model SHA-256, image-pixel quadrilaterals, uncalibrated confidence and bounded metrics. Use the CLI on the local project:

    bun scripts/pdf-cli.ts ocr docs/scan.pdf tiny id 1,2

`pdf_ocr_searchable` requires source inspection and authorization. Its typed request:

    {
      "inputPath": "docs/scan.pdf",
      "outputPath": "docs/scan.searchable.pdf",
      "expectedInputSha256": "EXACT_SHA256_FROM_INSPECT",
      "pages": [1],
      "engine": "tiny",
      "language": "id"
    }

Call via authorized dynamic tool or the CLI with a **project-local JSON specification**:

    bun scripts/pdf-cli.ts searchable docs/searchable-request.json

It creates a new copy with invisible selectable text, preserves the original visible page pixels (independently compared), rejects signed documents, unsupported crop/rotation and unrepresentable font characters. **Never call this privacy redaction, arbitrary original-text replacement, fully validated search-position accuracy or PDF/UA conformance.**

Four-way synthetic benchmark on 12 common PDF-rendered fixtures: `docs/audits/2026-11-04-pretrained-ocr-fourway-synthetic.json` and `.md`. Measured CER/WER: tiny 0.00%/0.00%, small 0.15%/2.08%, medium 33.33%/33.33% (empty text on four noisy/small-font cases), Tesseract eng+ind 3.12%/8.14%. These reflect **synthetic PDF scans only**, not independent real ID/EN documents. RSS is a process sample rather than a guaranteed peak. Medium must NOT be promoted as the quality fallback without further evaluation. Do not choose a final default until independent human-gold evaluation is complete.

## Measured OCR benchmark (actual engine, historical Tesseract-only baseline)

Measured synthetic scanned PDFs, not mocked. Reproduction command:

    python scripts/bench-pdf-ocr-real.py --json docs/audits/YOUR-NEW-RESULT.json --markdown docs/audits/YOUR-NEW-RESULT.md

The script creates 12 frozen ID/EN synthetic text fixtures using the local OS font, rasterizes to PDF, renders using SuperAgent's PDF.js/pdf-parse renderer at scale=2, and invokes actual Tesseract 5.5.0 on the rendered PNG, comparing recognized text against explicit gold using CER and WER.

Latest reproducible fixture/report: docs/audits/2026-11-04-pdf-ocr-real-benchmark-v2.json and matching -v2.md.
Mean CER **1.19%**, mean WER **3.65%**; Indonesian fixture CER **1.14%** and WER **3.37%** (English traineddata only); English CER **1.25%**, WER **3.94%**. No Indonesian language model was installed. Sample-level SHA-256 and raw OCR predictions are preserved in the JSON audit.

**Do not generalize these synthetic results to natural scans**; real human-gold, mixed fonts, long forms, low-DPI fax, handwriting, tables, corrupted scans, and installed T-Line / live MCP acceptance are still release gates. The previous baseline used only English traineddata; newer four-way benchmark uses both official English and Indonesian traineddata.

## Test commands & release gates

- Core build: bun run build
- Focused regression: bun --bun x vitest run tests/pdfSigning.test.ts tests/pdfVector.test.ts tests/pdfTools.test.ts tests/pdfMcp.test.ts tests/pdfPrimaryMcpIntegration.test.ts
- T-Line frontend: bun run build:frontend
- T-Line UI tests: cd frontend && bun --bun x vitest run --config vite.config.ts src/components/__tests__/PdfEditorPanel.test.tsx

Source tests prove these constrained capabilities, not installed-desktop acceptance or production readiness. Do not restart/replace the active MCP owner without coordinating the concurrent Muse/T-Line work and verifying the owner's authenticated lifecycle.
