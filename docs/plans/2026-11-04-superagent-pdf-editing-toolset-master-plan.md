# SuperAgent PDF Editing Toolset — Master Plan

> **Dokumen historis (MVP/source milestone).** Untuk target penyelesaian kemampuan PDF penuh, security/quality gates, aktivasi MCP produksi dan status DONE, gunakan master plan kanonis: `docs/plans/2026-11-04-superagent-pdf-full-completion-production-master-plan.md` dan tracker eksekusi: `docs/plans/2026-11-04-superagent-pdf-completion-execution-tracker.md`. Keduanya mempertahankan batas kemampuan yang terverifikasi dan tidak mengklaim seluruh PDF sudah didukung.

Date: 2026-11-04
Status: PARTIALLY IMPLEMENTED IN SOURCE — PDF engine, Agent tools, local CLI and isolated stdio MCP implemented and tested; primary MCP/T-Line activation and release certification pending; no commit/push/restart
Repository: superagent (registered MCP project ID: superagent)
Priority: safe, verifiable, workspace-scoped PDF edits through Agent, MCP, and CLI; optional T-Line UI later.

## 1. Goal and scope

Build a native `pdf` capability inside SuperAgent: read/inspect, render/preview, reorder/split/merge, annotate/stamp, fill forms, redact securely, OCR scanned documents, compare before/after, and save edited PDF files. The same operation contract must be callable by a regular agent and by the connected MCP bridge. Start local-first, with optional authorized transfer through the existing Muse file-transfer channel later. Do not create a parallel service or hardcode text answers.

**Core rule:** an edit is successful only when the resulting PDF file exists, parses, passes validation, and the result's verification scope is reported. Generating a message that says "edited" is not completion.

Non-goals for MVP: turning an arbitrary PDF into a perfect Word-like rich-text editor; silently rebuilding complex layouts; bypassing passwords or DRM; changing digitally signed PDFs without explicit warning; adding an always-on PDF daemon; automatically uploading sensitive PDFs to third-party OCR/cloud services.

## 2. Verified baseline (source inspection, 2026-11-04)

- `src/core/tools/documentReadTools.ts`: `read_document` parses PDF via OfficeCLI, falls back to `pdf-parse`, then to local PaddleOCR when available. Existing reader uses a 100 MiB file-size ceiling. OCR runtime availability and fidelity have NOT been validated by this planning audit.
- `src/core/tools/officeCliTools.ts`: `office_cli` handles DOCX/XLSX/PPTX commands, not a dedicated verified PDF-edit API.
- `src/core/tools/toolsets.ts`: Master/Superagent/Subagent and extension toolsets, plus tool discovery. New PDF tools must respect tier-specific exposure and permission boundaries.
- `src/core/mcp/superagentMcpServer.ts` and `src/core/mcp/tools/networkContentMcpTools.ts`: MCP registration and current `read_document` workspace-scoped handler are integration points.
- `package.json`: TypeScript + Bun, `pdf-parse@^2.4.5`, `execa`, Vitest; no dedicated PDF editor dependency observed in the inspected dependency list.
- `.agents/AGENTS.md`: mandatory git preflight, protection of concurrent edits, existing Core/MCP owner isolation, OAuth/YOLO hard gates, no unapproved restart.
- Working tree currently has unrelated modified/untracked Muse, tray, MCP, and desktop files. This plan is an additive document only. DO NOT overwrite or stage those files.

### Technical distinction that MUST be preserved

1. **Structural editing**: page management, stamping, annotations, form fields — achievable with PDF editing libraries.
2. **Visual overlay**: draw new text or cover an old appearance — not equivalent to securely deleting or truly replacing original PDF text.
3. **True text replacement**: requires identifying all original glyph drawing operators, fonts, content streams and layout constraints, then rewriting content and validating. Support only where proven; otherwise return `unsupported_exact_edit` with a previewable alternative.
4. **True redaction**: irreversibly remove source content, not black-box overlay; validate text, images, annotations and metadata as applicable.

The upstream `pdf-lib` limitations explicitly say it cannot remove or edit ordinary existing page text outside form fields. `pypdf` likewise does not claim reliable arbitrary word replacement. Do NOT advertise a fake general-purpose `replace_text` operation.

## 3. Architecture decision (proposed)

Use one library-neutral PDF service with narrow, typed backends. Avoid routing ordinary PDF editing through arbitrary shell strings:

    Agent tool / MCP / CLI / (later) T-Line
               |
         PDF tool contract
               |
    permission + project scope + preflight
               |
      PDF operation coordinator
       |       |        |       |
      core    forms   render   OCR/redact adapter
       |       |        |       |
      verify + audit + atomic output publish

New planned modules (additive, adjust actual placement after implementation preflight):

- `src/core/pdf/pdfTypes.ts`: typed operations, capability/verification status, errors.
- `src/core/pdf/pdfPreflight.ts`: magic bytes, PDF version, page count, encryption/signature/XFA detection, bounds and limits.
- `src/core/pdf/pdfOperationEngine.ts`: structural page edits, annotation/stamp/form dispatch.
- `src/core/pdf/pdfCoordinates.ts`: PDF points (72 pt/in), bottom-left coordinates, rotation/crop transformations and normalized rectangles.
- `src/core/pdf/pdfTransaction.ts`: input SHA-256 and expected hash, exclusive output lock, temp staging, fsync/atomic rename where supported, rollback, and output naming.
- `src/core/pdf/pdfVerify.ts`: reopen, page order/content check, render and visual diffs, semantic checks.
- `src/core/pdf/pdfRender.ts`, `pdfOcr.ts`, `pdfRedact.ts`: optional backend adapters with explicit capability checks.
- `src/core/tools/pdfTools.ts`: normal agent tool wrappers.
- `src/core/mcp/tools/pdfMcpTools.ts`: matching MCP definitions, typed result, access control and audit.
- `src/core/commands/pdfCommand.ts`: proposed CLI parity.
- `tests/pdf*.test.ts` and `tests/fixtures/pdf/`: fixture corpus and regression suite.
- `docs/guides/pdf-workflows.md`: examples, limitations, error interpretation and setup.

**Backend spike before dependency addition:** Evaluate `pdf-lib` (TypeScript-first for page operations, overlays and forms) against `pypdf` (optional isolated Python adapter), `qpdf` (optional integrity/encryption/page backend), `pdf.js`/PDFium or existing render path, and the existing PaddleOCR. Choose per operation based on correctness, license and supply-chain audit, Windows/Linux support, Bun compatibility, and deployment footprint. Prefer bundled/local engines and permissive licensing; do not introduce AGPL obligations unnoticed. Document binary requirements and fallbacks. No external API key should be required for basic editing.

## 4. Proposed tools and callable contracts

Expose a compact namespace to the AI, with direct MCP equivalents and predictable discovery rather than hardcoded action detection:

| Agent name | MCP name | Access | Purpose |
| --- | --- | --- | --- |
| `pdf.inspect` | `superagent_pdf_inspect` | read | PDF capabilities, pages, fonts/metadata, signatures, encryption, forms |
| `pdf.extract` | `superagent_pdf_extract` | read | page-scoped text/layout/field extraction, existing OCR integration |
| `pdf.render` | `superagent_pdf_render` | read + temp artifacts | selected pages to preview PNG, page size and coordinate map |
| `pdf.edit` | `superagent_pdf_edit` | dangerous/write | ordered structural, annotation, watermark and overlay operations |
| `pdf.forms` | `superagent_pdf_forms` | inspect=read; fill/flatten=write | list/validate/fill supported AcroForms |
| `pdf.redact` | `superagent_pdf_redact` | dangerous/write | reviewed destructive redaction with content-removal verification |
| `pdf.ocr` | `superagent_pdf_ocr` | read or write | read OCR; optional searchable output copy |
| `pdf.verify` | `superagent_pdf_verify` | read | inspect input/output, semantic/visual diff, evidence |
| `pdf.batch` | `superagent_pdf_batch` | per-operation authorization | bounded multi-file edits with per-file outcomes |

Keep the internal operation schema declarative, not an arbitrary command string. Example edit request:

    {
      "inputPath": "docs/input.pdf",
      "outputPath": "docs/output.edited.pdf",
      "expectedInputSha256": "<hex>",
      "dryRun": false,
      "operations": [
        {"op": "rotate_pages", "pages": [2], "degrees": 90},
        {"op": "add_text", "page": 1, "text": "REVIEWED", "position": {"x": 40, "y": 40}, "fontSize": 12}
      ]
    }

Contract:
- Pages are **1-based** in public APIs; return validated original page count and output page count.
- Every operation has an explicit typed schema, per-action permission, and target page/range validation.
- `dryRun` supplies expected effects and incompatibility warnings, NEVER claims output written.
- Input defaults read-only; `outputPath` is a new file by default. Overwriting the input requires `overwrite:true`, separate privilege/confirmation, and backup/version safeguards.
- Return `status: verified | partial | failed | unsupported`, `operationResults[]`, `inputSha256`, `outputSha256`, `outputPath`, page counts, warnings, `verificationScopes`, and `artifactRef` if transfer is enabled.
- Avoid pasting raw PDF/base64 into tool output or a 3500-character envelope. Files remain on disk; Muse delivery (if requested and authorized) must use the binary file-transfer pipeline and transfer receipt, not inline chat text.
- Expose only relevant tools through the existing dynamic tool discovery/tier gates: no write tools to read-only researcher/reviewer; Master delegates mutations; MCP rechecks auth at execution even when tool schema was discovered earlier.

## 5. Delivery phases (execute in order)

### P0 — Dependency, permission and fixture preflight
- Confirm source/test runtime, license decisions, file-size/page-count limits and OS matrix (Windows and Linux).
- Build fixture corpus: selectable-text Indonesian/English, Unicode, embedded fonts, vector and image-only scans, mixed pages, annotations, AcroForm, password-protected, signed PDF, damaged/truncated PDF, unusual crop/rotation, large PDFs, and malicious-looking embedded actions.
- Lock behavioral contracts, structured errors, output naming and expected-hash/concurrency protocol.
- **Gate:** design review signed off; no claimed support for unproven engines.

### P1 — Safe structure editing (MVP)
- Implement `inspect`, `render`, `verify` plus core `edit` operations: merge, split, extract/delete/insert/reorder/rotate pages, crop, watermark, page numbers, metadata edits.
- Reuse `read_document` rather than cloning text parsing.
- Atomic write-to-new-file + strict workspace access + hash guard.
- **Gate:** valid PDF output, correct page order/count, no source mutation, deterministic artifact hashes for identical frozen inputs where metadata policy permits.

### P2 — Precise annotations and overlays
- Add text/image placement, highlight, rectangle, arrows, comments/annotations, visible stamp and graphics.
- Use explicit PDF-coordinate geometry and rendered preview; do not imply adding an overlay removes existing text.
- Support embedded fonts for Unicode Indonesian and test rotated/cropped pages.
- **Gate:** overlays visibly land on intended page and rectangle, with no unintended page alteration.

### P3 — Forms and document metadata
- Inspect AcroForm fields and types; fill text, checkbox, dropdown and radio; appearance-stream verification; optional flatten to new output.
- Handle duplicate field names during merging and detect XFA/unsupported widgets.
- **Gate:** values persist after reopen and render correctly in at least two independent viewers/renderers for critical fixtures.

### P4 — Advanced editing, OCR and secure redaction
- OCR scans via existing local capability when available; provide page confidence, language and positional mapping; searchable-copy output separately.
- Add visually verified region-based redaction using a backend that **removes** underlying content; scrub relevant metadata/attachments by explicit policy; re-extract and inspect image pixels afterward. Never treat black overlay as redaction.
- Text edits: provide a strict `edit_form_field` or `add_text/replace_region_with_verified_redaction_then_overlay` path. Arbitrary existing text replacement remains unsupported unless an independently validated engine can preserve layout and remove old content. No fake success.
- Signatures: detect digital signatures/DocMDP and block modifications by default with clear invalidation warning; no silent re-signing.
- **Gate:** no recoverable redacted target in page text or expected content streams/metadata, visual validation, documented residual risks on raster/vector cases.

### P5 — Agent, MCP, CLI, desktop and file delivery integration
- Register typed tools in `toolsets.ts` and `superagentMcpServer.ts`; update tool discovery, prompts/help suggestions and alias tests; preserve current Chrome extension toolset behavior.
- Add CLI `superagent pdf inspect|edit|render|verify|...` with parity to MCP; ensure non-interactive scripting and meaningful exit codes.
- Optional T-Line preview/editor after agent+MCP gate: page sidebar, canvas preview, layers/annotation controls, property inspector, before/after and Save As. Follow existing T-Line visual tokens/components; no duplicate desktop implementation inside superagent-tray.
- Integrate explicit file download or Muse transfer through existing authorized transfer stack after independent file-delivery certification.
- **Gate:** actual end-to-end agent tool-call and remote MCP invocation modify an on-disk fixture, with verified output path/hash. No restart of primary Core/MCP without operator approval.

### P6 — Hardening, accessibility, performance and release
- Enforce strict parser/output timeouts, cancellation, decompression/page count/memory caps, path traversal and symlink protections, content-type checks, zip/PDF-bomb resistance, no remote fetch from embedded PDF objects, and no execution of PDF JavaScript/actions.
- Enforce per-project OAuth/YOLO/write/grant matrix, audit logs with hashes and sanitized file paths, no sensitive document body in logs, temp-file cleanup, output locks and crash recovery.
- Run tests under Windows and Linux, then a bounded isolated end-to-end flow; keep primary owner untouched.
- Update README/help/documentation and record any unsupported formats. Production acceptance requires R0–R7 safety gates relevant to its activation, not just passing unit tests.
- **Gate:** all release-blocking fixtures PASS; unresolved advanced limitations disclosed; rollback path verified.

## 6. Security and transactional invariants

1. Source remains unchanged by default, including failure and cancellation.
2. Every input and output path stays inside an authorized registered project. Revalidate realpaths/symlinks, ownership, expected SHA-256 and permissions immediately before publish.
3. Create temp outputs under authorized staging; never use a shared temp path with predictable names or leave sensitive files indefinitely. Clean them on cancellation/failure.
4. A document requiring a password is never "opened" with bypass flags. Return `password_required` and use an explicit authorized workflow if backend supports it.
5. A signed PDF reports `signed_document`; mutation fails closed unless policy allows creation of an explicitly marked unsigned derivative.
6. No external document upload or network OCR by default.
7. Redaction requires a reviewed target/region, irreversible warning and independent post-save verification.
8. Original images/attachments/bookmarks/links/metadata are preserved **only where supported and verified**; represent any lost/unknown property as `partial`, not `verified`.
9. Do not log document content, passwords, PII, OCR text, or raw PDF bytes.
10. Per-operation permissions are mandatory for every tool path: CLI, normal agent, subagent, MCP, and optional UI. Never assume an allowed read implies permission to write.

## 7. Verification / acceptance matrix

| Test | Requirement | Release result |
| --- | --- | --- |
| Existing `read_document` regression | identical or explicitly documented behavior | PASS required |
| Inspect/render/extract | page counts, metadata, content and orientation correct | PASS required |
| Merge/split/reorder/rotate | correct page mapping and original byte hash unchanged | PASS required |
| Watermark/annotation/text stamp | no clipping, font corruption, accidental overlap | PASS required |
| Unicode + scanned PDF | Indonesian, mixed Latin/non-Latin, scan OCR conditional availability | PASS or declared unsupported |
| Form fill + flatten | values and appearance valid across viewers | PASS required for supported forms |
| Redaction | removal proven, not just covered | PASS required before feature exposure |
| Arbitrary text replacement | unsupported error until correctness proven | PASS required |
| Signed/password PDF | explicit warning/block, no silent corruption | PASS required |
| Input race/hash mismatch | abort with no published artifact | PASS required |
| Path traversal/symlink/unauthorized scope | denied on CLI, agent, MCP | PASS required |
| No permissions / YOLO OFF | dangerous MCP edits refused | PASS required |
| Cancellation/concurrency/large files | no source corruption, no leaks, bounded limits | PASS required |
| Tool discovery + real MCP + CLI | correct schemas, action execution, clear errors | PASS required |
| Visual regression | before/after raster diff restricted to intentional change regions | PASS required |

For page/render verification follow: **render input → inspect → operate → render output → compare visually + semantic checks**. Record input/output checksums, engine versions, exact fixtures, test commands, passes/failures and residual risks.

## 8. Proposed implementation backlog / ownership

| Milestone | Primary code surface | Main deliverable |
| --- | --- | --- |
| M0 | `docs/plans`, `tests/fixtures/pdf` | frozen contracts + fixture and backend decision |
| M1 | `src/core/pdf/*`, `tests/pdfCore*.test.ts` | structural editing and atomic outputs |
| M2 | `src/core/pdf/*`, `tests/pdfAnnotations*.test.ts` | visual overlays and geometry |
| M3 | `src/core/pdf/*`, `tests/pdfForms*.test.ts` | form support |
| M4 | `src/core/pdf/*`, `tests/pdfOcr*.test.ts`, `tests/pdfRedact*.test.ts` | advanced guarded operations |
| M5 | `src/core/tools/pdfTools.ts`, `src/core/mcp/tools/pdfMcpTools.ts`, CLI + discovery tests | agent/MCP/CLI parity |
| M6 | docs, E2E fixtures, optional T-Line integration | release evidence and UX |

Suggested order: **M0 → M1 → M2 → M3 → M5 → M4 → M6**, except do not expose OCR/redact names as operational until M4 gates pass. Keep milestones separable and minimize MCP/runtime edits while the existing Muse/tray changes are active.

## 9. First implementation checklist (historical baseline; advanced source implemented)

> 2026-11-04 update: isolated pikepdf vector exact Tj edits/redaction, PKCS#12 signing, detached CMS verification via OpenSSL, actual 12-fixture Tesseract benchmark and T-Line advanced handoff were added after this original checklist. Source tests/QA in `docs/audits/2026-11-04-pdf-advanced-signatures-vector-ocr.md`. General-purpose lossless text reflow, all-objects vector redaction, qualified signature trust and independent real-document OCR certification remain incomplete.

- [ ] Verify `git status --short --branch` again immediately before editing and preserve concurrent work.
- [ ] Approve backend licensing and binary dependency audit.
- [ ] Add immutable fixtures and baseline PDF preflight tests.
- [ ] Add types and transactional writer with input hash guard.
- [x] Implement page operations, renderer and verify.
- [x] Agent bindings, isolated stdio MCP, primary MCP registration and dispatch implemented; OAuth read/write, YOLO OFF, scope revocation and cross-project grant tests pass. Live owner activation pending.
- [x] Add form fill, visual overlays, conditional OCR wrapper and explicitly destructive raster redaction behind validation and confirmation gates. Native PDF annotations and vector redaction deferred.
- [x] Targeted Vitest, TypeScript build and MCP E2E tests verified: **94/94 tests PASS across 11 SuperAgent suites**, including Unicode overlay; `bun run build` PASS. T-Line frontend build PASS and UI tests **6/6 PASS**.
- [x] Detailed user guide published at `docs/guides/pdf-workflows.md`; PDF edit side panel added to existing T-Line FileViewerTab, routed through the existing Assistant. README and CLI/help examples remain pending.
- [ ] Request operator authorization before active Core/MCP restart or production cutover.

## 10. Current execution ledger

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| PLAN-01 | Inspect repo architecture and PDF read support | PASS | source files inspected via registered `superagent` project |
| PLAN-02 | Preserve concurrent work | PASS | preflight `git status`; no existing source files intentionally modified |
| PLAN-03 | Save this standalone plan | PASS | Confirmed present and read back from repo via connector |
| CODE-01 | Implement PDF editor | PARTIAL | `pdfEngine.ts` with structure edits, form operations, overlays, PNG renders, create-only publication, and raster-redaction fallback; true text rewrite deferred |
| QA-01 | Run PDF editing tests | PASS (source) | 94 tests in 11 SuperAgent suites PASS, 6 T-Line UI tests PASS, Core + frontend builds PASS. Installed desktop/live MCP not certified |
| RELEASE-01 | Commit/push/restart | NOT STARTED | not requested |

## 11. References and known limitations

Current implementation QA: `docs/audits/2026-11-04-pdf-primary-mcp-tline-integration-qa.md`. T-Line UI guide: `t-line/docs/guides/pdf-editing-assistant-handoff.md`. **Current live @s1000 gateway search still returns no PDF tools**; coordinated operator-approved owner reload remains pending.

- Current SuperAgent source: `src/core/tools/documentReadTools.ts`, `officeCliTools.ts`, `toolsets.ts`, `src/core/mcp/superagentMcpServer.ts`, `networkContentMcpTools.ts`, `package.json`, `.agents/AGENTS.md`.
- `pdf-lib` official README: https://github.com/Hopding/pdf-lib — supports modification, page operations and forms; does not provide ordinary page-text replacement or decrypted editing.
- `pypdf` official docs: https://pypdf.readthedocs.io/ — supports page manipulation, text/metadata, forms; arbitrary replace-word is not a reliable promise.
- PDF rendering and semantic/visual verification must be part of every editing pipeline.

**Implementation conclusion (2026-11-04):** PDF source code, Agent tools, CLI, isolated stdio MCP, primary MCP source registrations and OAuth/YOLO/project-grant integration tests, T-Line PDF edit panel, and workspace-scoped Unicode text overlays were completed and tested. Live @s1000 MCP owner activation, installed desktop certification, real OCR accuracy benchmark, native annotations and lossless original-text editing remain pending. Concurrent Muse changes were preserved; no owner restart or production rollout performed.
