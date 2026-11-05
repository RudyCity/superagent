# SuperAgent PDF Editing — User Guide

Date: 2026-11-04
Status: Implemented in source (Agent + CLI + isolated stdio MCP + PRIMARY MCP registry/dispatch + T-Line viewer handoff); active MCP owner/installed desktop restart not performed.

For newer **restricted exact original-text edits**, **vector text redaction**, **PKCS#12 signatures**, **cryptographic signature verification**, and **measured OCR**, follow `docs/guides/pdf-advanced.md`. There are **12 PDF tools** in the Agent and primary MCP **source**, including `pdf_ocr_searchable`. Do not confuse source registration with the live @s1000 owner's deployed tool catalog.

## Capability overview

- **Read**: `pdf_inspect`, `pdf_extract`, `pdf_ocr`, `pdf_verify`.
- **Create files (write permission)**: `pdf_render`, `pdf_edit`, `pdf_split`, `pdf_redact_raster`.
- `pdf_edit` supports: `rotate_pages`, `delete_pages`, `extract_pages`, `reorder_pages`, `merge_pdf`, `insert_pdf`, `crop_pages`, `add_text`, `watermark`, `page_numbers`, `add_rectangle`, `highlight_overlay`, `add_image`, `set_metadata`, `fill_form`, `flatten_forms`.
- **Not generally supported**: arbitrary modification of original page text, general vector-preserving redaction, qualified/signature trust certification, native PDF comments, reliable form preservation across copy/merge. **Restricted ASCII Tj content stream edits and vector redaction and basic PKCS#12 CMS signing** are now available separately; see advanced guide and mandatory safeguards.
- A visual highlight is a **visible overlay**, not a native editable highlight annotation or secure redaction. Never claim it hides underlying text.

The normal agent tools appear through SuperAgent's existing tool discovery. All 12 PDF tools are registered in the primary MCP server **source**, using its existing gateway, OAuth write-scope, YOLO, project-grant and workspace authorization checks; this was tested with instantiated primary MCP servers. The already-running `@s1000` process may still be using older code until an operator-approved reload. Do not assume live availability from a successful source build; first check `superagent_tool_search({query:"pdf"})`.

## Local CLI examples

From a local project root whose PDF files you are authorized to read/write:

```bash
# Repository layout: run these commands from the SuperAgent repository root
bun scripts/pdf-cli.ts inspect docs/input.pdf
bun scripts/pdf-cli.ts extract docs/input.pdf 1,3
bun scripts/pdf-cli.ts render docs/input.pdf docs/preview 1,2
bun scripts/pdf-cli.ts verify docs/input.pdf

# Declarative editing JSON
bun scripts/pdf-cli.ts edit docs/pdf-edit-request.json
bun scripts/pdf-cli.ts split docs/pdf-split-request.json
bun scripts/pdf-cli.ts redact docs/pdf-raster-redaction-request.json
```

**Edit request** `docs/pdf-edit-request.json`:

```json
{
  "inputPath": "docs/input.pdf",
  "outputPath": "docs/output.edited.pdf",
  "dryRun": false,
  "operations": [
    { "op": "rotate_pages", "pages": [2], "degrees": 90 },
    { "op": "add_text", "pages": [1], "text": "Diperiksa", "x": 45, "y": 50, "fontSize": 12 },
    { "op": "page_numbers" },
    { "op": "set_metadata", "title": "Versi Direvisi" }
  ]
}
```

`docs` is illustrative. The input file and **output directory** must already exist. Output files must **not exist** at call time; writing over or modifying the source is prohibited.

**Split request**:

```json
{
  "inputPath": "docs/input.pdf",
  "outputPrefix": "docs/chapter",
  "groups": [[1, 2], [3, 4]]
}
```

This creates `docs/chapter-part-1.pdf` and `docs/chapter-part-2.pdf`.

## PDF coordinates and form filling

Page numbers are **1-based**. `add_text`, `add_image` and PDF overlays use *PDF points* (72 points per inch), with origin at **bottom-left**. Rendering to PNG uses the PDF parser and supports scale 0.5–2.5, max 20 pages per operation.

Fill form example:

```json
{
  "inputPath": "docs/form.pdf",
  "outputPath": "docs/form-completed.pdf",
  "operations": [
    { "op": "fill_form", "field": "fullName", "value": "Nama Pengguna" },
    { "op": "fill_form", "field": "approved", "value": true },
    { "op": "flatten_forms" }
  ]
}
```

**Strict AcroForm behavior (2026-11-05):** `pdf_inspect` now exposes field name, type, readonly/required flags and bounded allowed options. `fill_form` refuses read-only fields, XFA, signature fields, unlisted dropdown/radio/list choices and implicit conversions (text must be a string, checkbox must be a boolean). `flatten_forms` refuses XFA and signature fields. After saving a filled form, each changed interactive field is independently reopened and its value checked; flattening verifies fields are gone and filled text can be independently extracted. Flattened checkbox/radio **visual appearance is not independently certified**; inspect the resulting page. The original PDF is never overwritten. T-Line offers typed text, choice and checkbox fields, with optional explicit flattening.

For text outside the built-in Helvetica character set, `add_text` and `watermark` support optional `fontPath` pointing to an existing TTF/OTF file **inside the authorized workspace**. SuperAgent embeds the font with `@pdf-lib/fontkit`; it does not download fonts, ship proprietary font files, or allow font file reads outside the workspace. Example: `{"op":"add_text","pages":[1],"text":"Pendidikan – Revisi","fontPath":"assets/fonts/document.ttf","x":45,"y":50}`. Form field appearance fonts and full CJK/RTL shaping are not yet independently certified.

## Secure raster redaction

General vector-preserving redaction is **not** provided by pdf-lib. To remove original text streams without introducing AGPL-licensed dependencies, SuperAgent offers a deliberately destructive alternative: re-render *every page* to a fresh image-only PDF, cover specified pixels with opaque black, validate that no original text layers/form fields remain, and save as a new PDF.

**Irreversible tradeoffs**: all selectable text, original vector objects, links, form fields, bookmarks and some accessibility information are lost. PDF signatures cannot be preserved. The tool refuses rotated/cropped pages instead of guessing coordinate transforms. It supports at most 20 pages per call.

Steps:

1. Run `pdf_inspect` and keep `sha256`.
2. Render previews at `scale: 1` with `pdf_render` and examine the resulting PNG images.
3. Choose exact rectangular locations of sensitive information in **pixel coordinates, origin top-left**. **MUST supply `expectedPreviewHashes` for every page**, copied from visually reviewed `pdf_render` at scale=1; otherwise the operation fails closed.
4. Supply `confirmDestructiveRasterization: true` with the source hash.
5. Verify the generated PDF and visually inspect every affected page.

```json
{
  "inputPath": "docs/input.pdf",
  "outputPath": "docs/redacted-raster.pdf",
  "expectedInputSha256": "SHA256_FROM_INSPECT",
  "confirmDestructiveRasterization": true,
  "expectedPreviewHashes": {
    "1": "SHA256_OF_RENDERED_PAGE_1_PNG"
  },
  "regions": [
    { "page": 1, "x": 100, "y": 150, "width": 220, "height": 35 }
  ]
}
```

**Important**: `expectedPreviewHashes` is **mandatory** and must contain a valid SHA-256 for *every page* in the document, not just changed pages, because the operation reconstructs the entire PDF. Do not run the destructive command until every page has been rendered at scale=1 and reviewed. If even one preview hash is missing or differs, the operation refuses to publish. The tool now independently re-renders the **serialized output PDF** and tests every approved rectangle for opaque black pixels and every pixel *outside* those rectangles against its original render. This is stronger visual QA, but does **not** establish that all sensitive content was selected or independently certify every possible PDF object or old version as irrecoverable. OCR, screenshots and external image analysis must still be reviewed by a human for sensitive/high-stakes use.

## Local MCP protocol

This optional isolated stdio process works independently of the live primary MCP process and does not restart or replace SuperAgent Core, MCP or OAuth owners. For a managed remote MCP client prefer the built-in `superagent_pdf_*` tools after the primary MCP owner has been updated. MCP PDF definitions also accept optional `projectId` and `workspace` selectors; explicit cross-project calls require the appropriate independent project read/write grants.

```bash
bun scripts/pdf-mcp.ts                # safe-only inspect/extract/ocr/verify
bun scripts/pdf-mcp.ts --allow-write  # explicit opt-in for edit/render/split/redact
```

The process implements stdio MCP with names:

`superagent_pdf_inspect`, `superagent_pdf_extract`, `superagent_pdf_ocr`,
`superagent_pdf_render`, `superagent_pdf_edit`, `superagent_pdf_split`,
`superagent_pdf_redact_raster`, `superagent_pdf_verify`.

This isolated stdio endpoint scopes file paths to its working directory. It has no built-in OAuth or registered-project grant handler and **must not be exposed as an unauthenticated network endpoint**. The primary MCP integration uses the server's existing allowlist, per-call OAuth scopes, YOLO mode, project access policy and workspace context. Its source behavior was tested with read-only OAuth, YOLO OFF, scope revocation and cross-project grants.

## OCR behavior

`pdf_ocr` reuses the existing `read_document` implementation: for PDFs, `pdf-parse` runs first, then the local OCR backend (PaddleOCR and/or Tesseract via the existing fallback) when no actual selectable text exists. This avoids mistaking `pdf-parse` page-header delimiters for PDF text and avoids an incompatible OfficeCLI PDF command. The result reports `backend: "local_ocr_fallback" | "pdf-parse"` and `ocrPerformed` without fabricating which underlying OCR model succeeded. Flow tests use a simulated OCR backend, NOT a real accuracy benchmark. No cloud upload is performed.

## Security guarantees and operational limits

- Every input is constrained to the **current workspace root** with real-path checks; symlink escapes are rejected. Existing PDF input is never opened for write.
- Outputs are **create-only**. Content is staged and published atomically by hard link (requires a filesystem that supports hard links, typically NTFS/ext4). A failed create does not overwrite an existing target.
- Validate `expectedInputSha256` when supplied; destructive raster redaction *requires* it and explicit confirmation.
- Detect likely signed PDFs and deny mutation rather than silently invalidating signatures. This detection remains conservative/heuristic, not a cryptographic signature verifier.
- Existing encrypted PDFs cannot be edited with pdf-lib.
- PDF file input limit 100 MiB, page cap 500; render max 20 pages per call, scale max 2.5; raster redaction max 20 pages.
- Complex page copying can lose interactive structures; copying pages with AcroForms is rejected. Run visual review and cross-viewer checks on high-value documents.
- Multi-output split/render operations publish one file at a time, attempting checksum-verified rollback if a later publication fails; output files might remain if cleanup fails. Inspect the directory after an error.
- No automatic upload to external providers. If sending PDF through Muse, use the existing verified binary file transfer, not raw base64/envelope text.

## Verification

Focused local tests:

```bash
bun --bun x vitest run tests/pdfTools.test.ts tests/pdfMcp.test.ts
bun run build
```

As of 2026-11-04, the test suite covers structural PDF transforms, form fill, PNG render, sampled Unicode overlay, destructive raster redaction, scoped permissions, primary MCP OAuth/YOLO/grant/gateway dispatch, live local stdio MCP, and OCR fallback selection. T-Line frontend source builds and targeted UI tests also pass. Tests do **not** certify installed-native desktop rollout, actual scanned OCR accuracy, independent PDF compatibility corpus or production activation.

## Deferred work

1. **Primary MCP activation** remains pending: reload the current MCP owner only after coordinating the concurrent Muse changes and obtaining operator approval. Source registration and auth tests are complete.
2. Rich native PDF annotations, advanced form XFA/widgets, vector-preserving redaction, original content stream editing, digital signatures, lossless rich-layout editing and extensive multilingual shaping still require dedicated engines and independent validation.
3. **T-Line FileViewerTab** now has a PDF edit side panel that sends typed operations to the *existing* SuperAgent Assistant (not a duplicate backend); installed Tauri/Windows UI end-to-end acceptance remains pending.
4. Extend fixture coverage to malicious PDFs, password/signed real samples, large PDFs, Linux and independently verified OCR, plus an installed desktop acceptance test.
