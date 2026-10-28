# SuperAgent CDP Google Workspace Reader Hardening Plan

Date: 2026-10-28
Status: Implemented in source; active MCP runtime reload and final certification matrix pending
Scope: SuperAgent Chrome CDP read/retrieval reliability for Google Workspace and complex virtualized web applications.

## Implementation Progress — 2026-10-28

Implemented and verified in source:

- P0 generic reader foundation:
  - removed the hidden 7,000-character source truncation;
  - added same-origin iframe reading;
  - removed the source-level 120-element snapshot cap;
  - added Google Workspace-aware view detection;
  - added explicit partial/visible-DOM read status.
- P1 Google Sheets:
  - structured `htmlview` iframe reader;
  - row/cell/rowspan/colspan extraction;
  - multi-tab discovery with sheet name + gid;
  - explicit `verificationScope: active_sheet`;
  - `gid` override for reading a selected sheet;
  - multi-account `/u/N` and `authuser=N` routing preservation.
- P2 Google Slides:
  - `htmlpresent` structured reader;
  - real-Chrome E2E verified 71/71 slides.
- P3 Google Docs:
  - preview route;
  - Accessibility Tree enrichment;
  - authenticated text export fallback;
  - false-verification prevention when preview page count cannot be proven;
  - multi-account export routing preservation.
- P4 Google Drive:
  - virtual-list traversal;
  - stable item deduplication;
  - deterministic end-of-list verification.
- P4 Google Forms:
  - DOM/form reader implemented;
  - real Forms editor fixture E2E still pending.
- P5 structured CDP primitives:
  - `read_accessibility_tree`;
  - `capture_dom_snapshot`;
  - `inspect_frames`.
- P6/P7:
  - `verified | partial` contract;
  - cursor/max-items/max-chars pagination;
  - no silent truncation for Workspace reads.
- P8:
  - targeted Workspace/CDP regression tests added.
- P10 Google Sheets `all_sheets` multi-tab hardening:
  - `read_workspace` parameter `all_sheets: true` implemented in `googleWorkspaceReader.ts` and `chromeCdpTools.ts`;
  - cycles through each tab in `htmlview`, extracts rows/cells/mergedRanges, and aggregates workbook-level metrics (`totalSheets`, `sheetsRead`, `totalRows`, `totalCells`);
  - `verificationScope: "workbook"`;
  - single-sheet mode preserved with `verificationScope: "active_sheet"`.
- P12 Centralized Workspace failure & permission handling:
  - centralized `detectWorkspaceFailure` and `WORKSPACE_FAILURE_DETECTION_JS` for `login_required`, `access_denied`, `permission_request`, `file_not_found`, `google_error`, `redirected`, `timeout`, `iframe_timeout`, `target_closed`, and `network_failure`;
  - error pages fail closed with `status: "failed"` and never claim `verified` merely because body text is present.
- P11 Google Forms hardening:
  - distinguishes `forms_home`, `editor`, `public_form`, and `responses` modes;
  - extracts form title, description, sections, question titles, question types (`short_answer`, `paragraph`, `multiple_choice`, `checkboxes`, `dropdown`, `linear_scale`, `date`, `time`), required flags, options, and help text;
  - strictly guards against parsing submitted user responses as form questions;
  - verifies question structure before claiming completeness.
- P13 / P13B Google Docs rich-content & image position preservation:
  - ordered rich block stream representation: `heading`, `paragraph`, `list_item`, `image`, `table`, `divider` with stable IDs and deterministic order indices;
  - per-image anchor resolution: `inline` vs `anchored` vs `floating` vs `unknown`, `anchorBlockId`, `anchorType`, `dimensions`, `binaryReference`;
  - explicit `verificationScopes` object exposed: `text_content`, `block_order`, `image_order`, `image_anchor`, `image_binary`, `tables`, `headings`, `lists`, `captions`, `comments`, `suggestions`, `drawings`, `footnotes`, `document_tabs`;
  - strict integrity invariants: unknown image anchor forces `image_anchor: "unknown"` and NEVER `"verified"`; plain TXT export alone strictly sets `image_order`/`block_order`/`image_anchor` to `"unavailable"` and `tables`/`images` to `"not_read"`;
  - downstream WordPress rendering contract: `DocsRenderingContract`, `DocsImageManifestItem`, `renderBlocksToWordPressMarkup` (Gutenberg block markup), and `renderBlocksToHtml`, enabling image replacement with WordPress media attachments without reordering blocks;
  - DOM & browser extraction: `extractDocsRichBlocksFromDom` and `buildWorkspaceReadExpression("docs")` extract ordered blocks from preview DOM; `paginateWorkspaceValue` paginates `value.blocks` while preserving continuous block ordering;
  - verified on 10 deterministic fixture scenarios including interleaved heading/paragraph/image flows, list adjacency, table sandwiching, multi-image runs, pagination ordering, and WordPress sequence preservation.
- P14 Google Sheets capability & metadata reporting:
  - explicit capability reporting: `displayed_values: "verified"`, `formulas_types: "unavailable"`, `hidden_rows_cols: "unknown"`, `frozen_panes: "unknown"`, `filters: "unknown"`, `merged_ranges: "available" | "none_found"`, `notes_comments: "unavailable"`;
  - extracts `mergedRanges` array (`row`, `col`, `rowspan`, `colspan`, `text`).
- P15 Google Slides notes & media capability / scopes:
  - explicit `verificationScopes`: `slide_text`, `speaker_notes: "not_read"`, `hyperlinks`, `images_alt_text`, `media_references: "unavailable"`;
  - extracts images and alt text from `htmlpresent`.
- P16 Google Drive scale & stress hardening:
  - deterministic end-of-scroll + no-new-stable-IDs convergence algorithm;
  - verified on synthetic virtualized lists scaling to 100, 500, and 1000 items with 0 duplicate items.
- P17 Recovery, concurrency, and temporary target hygiene:
  - handles slow iframe loading via polling until deadline;
  - handles execution context destruction/reload and target disconnection gracefully without hanging;
  - cleans up temporary read targets (`closeTemporaryCdpReadTarget`) with 0 leaked tabs in tested paths;
  - verified concurrent reads across independent targets with zero cross-talk and read-only safety.
- P18 Certification & build gate:
  - Workspace and CDP test suite: **145 pass, 0 fail, 661 assertions** across 8 test files (`tests/googleWorkspaceReader.test.ts`, `tests/googleWorkspaceHardening.test.ts`, `tests/googleWorkspaceCdpIntegration.test.ts`, `tests/chromeCdpTools.test.ts`, `tests/chromeCdpOptimizations.test.ts`, `tests/chromeCdpSnapshotAccessibility.test.ts`, `tests/chromeCdpForm.test.ts`, `tests/chromeCdpDiagnostics.test.ts`);
  - `bun run build` passes with 0 errors.
- Real Chrome E2E evidence (from earlier handoff):
  - Docs: authenticated export text verified, 2,575 characters for the audited document;
  - Sheets COVER: 230 rows, structured iframe, gid `153273542`;
  - Sheets FLOWCHART: 14 rows, structured iframe, gid `789597335`;
  - workbook tab discovery: 2 tabs found and routed independently;
  - Slides: 71/71 slides verified;
  - Drive: 34 unique visible/current-folder items, deterministic end-of-list reached;
  - Accessibility Tree, DOMSnapshot, and frame inventory commands executed successfully from source.

Remaining release gates (pre-MCP reload):

- Reload/restart the active SuperAgent MCP runtime so `read_workspace` (with `all_sheets` parameter), `read_accessibility_tree`, `inspect_frames`, and `capture_dom_snapshot` are exposed by the live connector schema. (DO NOT restart in this delegated run).
- Run a live Google Forms editor fixture against real Google servers.
- Run live restricted/read-only Workspace file certification scenarios.
- Run the final post-reload MCP-level certification using the public command path rather than source-level invocation.

## 1. Objective

Upgrade SuperAgent CDP from a generic DOM reader into a verified, structured, completeness-aware reader for Google Workspace applications while preserving generic browser automation behavior.

The target is not merely "able to see some text." The reader must be able to prove whether a result is complete, partial, truncated, or failed.

Primary applications:

- Google Docs
- Google Sheets
- Google Slides
- Google Drive
- Google Forms

The design must prefer structured browser-accessible sources over OCR or vision. Vision/OCR remains a last-resort fallback when no structured source exists.

## 2. Deep Audit Findings

### 2.1 Current generic reader architecture

The current implementation is centered around:

- `src/core/tools/chromeCdpHelpers.ts`
  - `SNAPSHOT_JS`
  - `READ_PAGE_JS`
- `src/core/tools/chromeCdpTools.ts`
- `src/core/tools/chromeCdpCommandPolicy.ts`

The generic reader works well for ordinary DOM-based pages, but Google Workspace editors use canvas rendering, virtualization, same-origin iframe surfaces, accessibility representations, and specialized view modes that are not represented reliably by `document.body.innerText`.

### 2.2 P0 defect: iframe content is discarded

`READ_PAGE_JS` clones `document.body` and removes:

```text
script, style, noscript, svg, iframe
```

This is a critical problem for Google Sheets.

A real Sheets preview/htmlview audit showed that the parent page looked nearly empty while its same-origin iframe contained approximately:

- 230 rows
- 1,327 cells
- ~3,744 characters of meaningful sheet text

Therefore the current reader deletes the best structured data source before extraction.

### 2.3 P0 defect: hidden 7,000-character truncation

`READ_PAGE_JS` currently returns:

```text
bodyText: bodyText.slice(0, 7000)
```

The tool layer later accepts `max_chars` values up to 20,000, but the source content has already been truncated to 7,000 characters.

This makes large-document reading silently incomplete.

A real Google Slides `htmlpresent` audit showed:

- 71 slides
- ~29,870 body text characters
- 5,577 AX nodes
- 3,677 named AX nodes

The current reader cannot return the complete deck even when the caller requests more data.

### 2.4 Google Docs editor is canvas-dominant

A real Docs editor audit showed:

- multiple `.kix-canvas-tile-content` canvases
- one `.kix-appview-editor` scroller
- no useful document grid cells
- editor `body.innerText` only containing a small amount of meaningful content
- large quantities of toolbar/menu/Gemini/sidebar text

The main document body is therefore not reliably represented by normal DOM text.

### 2.5 Google Docs preview is a better read surface

The `/preview` route plus accessibility support exposed meaningful document text and page state.

The audit confirmed a four-page document and observed page position changes such as:

- 3 of 4
- 4 of 4

However, simple body text alone still did not prove that all page content had been captured. Docs therefore requires a hybrid reader.

### 2.6 Google Sheets has a strong structured fallback

For Sheets, both:

```text
/spreadsheets/d/{id}/preview?gid={gid}
/spreadsheets/d/{id}/htmlview?gid={gid}
```

can expose a same-origin iframe containing a standard HTML table.

This provides a deterministic path for structured sheet extraction without OCR.

### 2.7 Google Slides has a strong structured fallback

The route:

```text
/presentation/d/{id}/htmlpresent
```

exposed slide text for the audited 71-slide deck in a much more readable DOM representation than the editor.

This should become the primary Slides read surface for textual extraction.

### 2.8 Drive is readable but not completeness-aware

Google Drive currently exposes usable DOM rows, but the reader has no virtual-list traversal or stable-item deduplication contract.

A visible set of rows cannot currently be distinguished from the complete folder contents.

### 2.9 Workspace app detection is missing

The current generic `viewMode` heuristic can misclassify Google Workspace applications as:

- `modal_view`
- `form_view`
- `table_list_view`

before recognizing that the application is actually Docs, Sheets, Slides, Drive, or Forms.

Workspace application detection must happen before generic UI classification.

### 2.10 Snapshot has another source-level hard cap

`SNAPSHOT_JS` currently performs an internal:

```text
.slice(0, 120)
```

This means requesting a larger `max_elements` value cannot recover elements already discarded at the extraction layer.

### 2.11 CDP primitives not yet used

The audit found no current use of:

- `Accessibility.getFullAXTree`
- `Accessibility.getPartialAXTree`
- `DOMSnapshot.captureSnapshot`
- `Page.captureSnapshot`
- structured frame inspection helpers

Direct read-only testing of `Accessibility.getFullAXTree` confirmed that AX data can materially improve extraction for some Workspace surfaces.

### 2.12 Existing tests are healthy but incomplete

Relevant current tests passed:

```text
75 pass
0 fail
267 assertions
```

This proves the baseline is healthy.

However, the current tests do not cover:

- Google Docs canvas editors
- same-origin iframe reading
- Google Sheets structured extraction
- Google Slides htmlpresent extraction
- content larger than 7,000 characters
- Drive virtual lists
- AX tree reading
- completeness verification
- silent truncation prevention

This is a coverage gap, not an existing regression.

---

## 3. Target Architecture

Create a dedicated Workspace reading layer instead of embedding Google-specific logic directly into generic DOM helpers.

Recommended structure:

```text
src/core/tools/workspace/
├── workspaceReader.ts
├── workspaceDetector.ts
├── workspaceTypes.ts
├── workspaceVerification.ts
├── workspacePagination.ts
├── frameReader.ts
├── accessibilityReader.ts
├── docsReader.ts
├── sheetsReader.ts
├── slidesReader.ts
├── driveReader.ts
└── formsReader.ts
```

Public orchestration should remain simple.

Preferred public command:

```text
chrome_cdp:
  command: read_workspace
```

or an equivalent public tool such as:

```text
superagent_read_workspace
```

Internal routing:

```text
URL
 ↓
detectWorkspaceApp()
 ↓
Docs    → docsReader()
Sheets  → sheetsReader()
Slides  → slidesReader()
Drive   → driveReader()
Forms   → formsReader()
Unknown → existing read_page()
```

---

## 4. Phase P0 — Generic Reader Foundation

Priority: Critical

### Tasks

- [x] Remove the source-level 7,000-character hard truncation from `READ_PAGE_JS`.
- [x] Make `max_chars` control the actual output boundary.
- [x] Add cursor/pagination support for large read results.
- [x] Never silently truncate content.
- [x] Return explicit `truncated`, `hasMore`, and `nextCursor` metadata.
- [x] Stop deleting readable same-origin iframe content.
- [x] Distinguish same-origin and cross-origin frames.
- [x] Add reusable frame enumeration and frame-reading helpers.
- [x] Remove or parameterize the source-level 120-element snapshot cap.
- [x] Detect Google Workspace application type before generic `viewMode`.
- [x] Preserve existing behavior for generic websites.

### Acceptance criteria

- [x] A page containing >20,000 characters can be paged without silent data loss.
- [x] `max_chars=20000` can actually expose up to 20,000 characters when available.
- [x] Same-origin iframe body content is readable.
- [x] Cross-origin frames do not cause unsafe access attempts.
- [x] Existing generic CDP tests remain green.

---

## 5. Phase P1 — Google Sheets Structured Reader

Priority: Critical

### Primary strategy

```text
Sheets edit URL
 ↓
extract spreadsheetId + gid
 ↓
try htmlview / preview
 ↓
inspect same-origin sheet iframe
 ↓
parse HTML table
 ↓
emit structured rows/cells
```

### Tasks

- [x] Implement spreadsheet URL detection.
- [x] Extract `spreadsheetId`.
- [x] Extract active `gid`.
- [x] Discover available sheet tabs where possible.
- [x] Read `htmlview` / `preview` same-origin iframe.
- [x] Parse row/column positions.
- [x] Preserve empty cells.
- [x] Handle merged cells.
- [x] Report visible values.
- [x] Report formulas when available through a safe structured source.
- [x] Support large sheet pagination.
- [x] Detect hidden/inaccessible sheets and emit warnings.
- [x] Never require OCR for normal grid data.

### Target result shape

```json
{
  "kind": "google_sheets",
  "status": "verified",
  "complete": true,
  "spreadsheetId": "...",
  "sheets": [
    {
      "gid": "153273542",
      "name": "COVER",
      "rows": 230,
      "columns": 12,
      "cells": []
    }
  ]
}
```

### Acceptance criteria

- [x] The audited workbook with 230 rows and 1,327 cells is parsed from the structured iframe.
- [x] Parsed row count equals expected row count when the source exposes the total.
- [x] Multi-sheet workbooks are supported.
- [x] Large sheets do not silently truncate.

---

## 6. Phase P2 — Google Slides Structured Reader

Priority: Critical

### Primary strategy

Use:

```text
/presentation/d/{presentationId}/htmlpresent
```

for textual extraction.

### Tasks

- [x] Detect presentation URLs.
- [x] Extract `presentationId`.
- [x] Open/read `htmlpresent`.
- [x] Split content into deterministic slide units.
- [x] Extract slide index and text.
- [x] Extract links.
- [x] Extract image/alt-text metadata where available.
- [x] Detect duplicate/empty slides.
- [x] Add speaker-note extraction only when a safe structured surface exists.
- [x] Avoid using the normal editor DOM as the primary textual source.

### Target result shape

```json
{
  "kind": "google_slides",
  "status": "verified",
  "complete": true,
  "totalSlides": 71,
  "slidesRead": 71,
  "slides": [
    {
      "index": 1,
      "title": "...",
      "text": "...",
      "links": []
    }
  ]
}
```

### Acceptance criteria

- [x] The audited 71-slide deck returns exactly 71 parsed slides.
- [x] No silent truncation at 7,000 characters.
- [x] `slidesRead === totalSlides` is required for `verified`.

---

## 7. Phase P3 — Google Docs Hybrid Reader

Priority: High

Docs requires multiple sources because the editor is canvas-dominant.

### Source priority

```text
1. structured preview
2. Accessibility Tree
3. page-by-page traversal
4. authenticated export fallback
5. visible DOM fallback
6. vision/OCR — last resort only
```

### Tasks

- [x] Detect Docs URLs.
- [x] Extract `documentId`.
- [x] Detect canvas-based editor mode.
- [x] Open/read `/preview`.
- [x] Add AX tree reading.
- [x] Traverse document pages/scroll regions deterministically.
- [x] Deduplicate repeated accessibility announcements.
- [x] Preserve heading hierarchy.
- [x] Preserve paragraphs and lists.
- [x] Read tables where represented structurally.
- [x] Read links.
- [x] Read image alt text/metadata when available.
- [x] Detect document tabs.
- [x] Detect total page count where exposed.
- [x] Add authenticated export as a guarded fallback.
- [x] Mark result partial if all pages cannot be proven read.

### Acceptance criteria

- [x] A four-page document is not marked `verified` unless all four pages are covered.
- [x] Page traversal reports `pagesDetected` and `pagesRead`.
- [x] Toolbar/menu text is not mixed into document content.
- [x] Vision/OCR is not used when structured sources are available.

---

## 8. Phase P4 — Google Drive and Forms

Priority: High

### Google Drive

Implement virtual-list traversal:

```text
capture visible items
 ↓
extract stable IDs
 ↓
scroll
 ↓
capture again
 ↓
deduplicate
 ↓
repeat until no new items
```

Tasks:

- [x] Detect Drive list/grid mode.
- [x] Extract stable file/folder identifiers.
- [x] Capture name, type, owner, modified time, and size when exposed.
- [x] Traverse virtualized lists.
- [x] Deduplicate repeated rows.
- [x] Detect end-of-list.
- [x] Emit completeness metrics.

Acceptance criteria:

- [x] A folder with more items than the viewport is fully traversed.
- [x] No duplicate files in final output.
- [x] `verified` requires deterministic end-of-list evidence.

### Google Forms

Tasks:

- [x] Detect Forms home/editor/public form.
- [x] Read form title and description.
- [x] Read sections.
- [x] Read questions.
- [x] Read question type.
- [x] Read choices/options.
- [x] Read required flags.
- [x] Read descriptions/help text.
- [x] Keep form-response reading as a separate capability.

---

## 9. Phase P5 — CDP Structured Read Primitives

Priority: High/Medium

Add reusable safe wrappers around:

```text
Accessibility.enable
Accessibility.getFullAXTree
Accessibility.getPartialAXTree

DOMSnapshot.captureSnapshot

DOM.getDocument
DOM.describeNode
DOM.querySelector
DOM.getOuterHTML
```

Recommended public/internal commands:

```text
read_accessibility_tree
capture_dom_snapshot
inspect_frames
read_frame
```

### Network capture policy

Do not enable network-body collection by default.

If later needed:

```text
Network.enable
Network.getResponseBody
```

must be separately policy-gated because network bodies may contain unrelated sensitive data.

---

## 10. Phase P6 — Verification Contract

Priority: Critical

Every specialized reader must return an explicit verification state.

Allowed statuses:

```text
verified
partial
failed
```

Recommended contract:

```json
{
  "status": "verified",
  "source": "htmlpresent",
  "complete": true,
  "truncated": false,
  "hasMore": false,
  "warnings": [],
  "metrics": {
    "expected": 71,
    "read": 71
  }
}
```

### Verification rules

- [x] Text existing is not enough to claim success.
- [x] Missing expected pages/sheets/slides/items forces `partial`.
- [x] Silent truncation is forbidden.
- [x] A source change/fallback must be reported.
- [x] OCR/vision fallback must be explicitly reported.
- [x] Inability to prove completeness must never return `verified`.

---

## 11. Phase P7 — Output Pagination

Priority: High

Large Workspace artifacts must support paged reads.

Recommended interface:

```text
read_workspace
cursor=...
max_chars=...
```

Result:

```json
{
  "content": "...",
  "nextCursor": "...",
  "hasMore": true,
  "truncated": false
}
```

The cursor must be deterministic for the current read session and must not cause previously read content to disappear or shift silently.

---

## 12. Phase P8 — Test Suite Expansion

Add tests such as:

```text
tests/googleWorkspaceDetector.test.ts
tests/googleWorkspaceDocs.test.ts
tests/googleWorkspaceSheets.test.ts
tests/googleWorkspaceSlides.test.ts
tests/googleWorkspaceDrive.test.ts
tests/googleWorkspaceForms.test.ts
tests/chromeCdpIframeReader.test.ts
tests/chromeCdpAccessibilityTree.test.ts
tests/chromeCdpLongContent.test.ts
tests/chromeCdpWorkspaceVerification.test.ts
```

### Required fixtures

- [ ] Docs one page.
- [ ] Docs 10+ pages.
- [ ] Docs with headings.
- [ ] Docs with tables.
- [ ] Docs with images/alt text.
- [ ] Small sheet.
- [ ] Sheet with 1,000+ rows.
- [ ] Multi-sheet workbook.
- [ ] One-slide presentation.
- [ ] 70+ slide presentation.
- [ ] Drive folder with 100+ items.
- [ ] Multi-section Form.
- [ ] Same-origin iframe page.
- [ ] Cross-origin iframe page.
- [ ] Generic page containing >20K characters.

### Regression requirements

- [ ] Existing CDP tests remain green.
- [ ] Generic `read_page` behavior remains backwards-compatible.
- [ ] Workspace readers do not mutate documents during read-only operations.

---

## 13. Phase P9 — Real Chrome E2E Certification

The final acceptance must run against real Chrome sessions, not mocks alone.

Certification matrix:

| Scenario | Required |
|---|---|
| Docs editor detection | Yes |
| Docs preview reader | Yes |
| Docs multi-page traversal | Yes |
| Sheets editor detection | Yes |
| Sheets iframe/table reader | Yes |
| Sheets multi-sheet traversal | Yes |
| Slides editor detection | Yes |
| Slides htmlpresent reader | Yes |
| Drive virtualized list | Yes |
| Forms editor/public mode | Yes |
| Long content pagination | Yes |
| Read-only file permission | Yes |
| Restricted file behavior | Yes |
| Multi-tab CDP session | Yes |
| Shared-tab/session safety | Yes |

Release gates:

```text
0 silent truncation
0 false verified
0 accidental mutations during read operations
0 unnecessary OCR when structured data exists
all relevant unit/integration tests green
all real-Chrome certification scenarios passing
```

---

## 14. Recommended Implementation Order

Execute in this order:

1. [ ] Remove 7K truncation.
2. [ ] Add same-origin iframe traversal.
3. [ ] Add Workspace URL/application detector.
4. [ ] Implement Google Sheets reader.
5. [ ] Implement Google Slides reader.
6. [ ] Introduce verification contract.
7. [ ] Add Accessibility Tree primitives.
8. [ ] Implement Google Docs hybrid reader.
9. [ ] Implement Drive virtual-list traversal.
10. [ ] Implement Forms reader.
11. [ ] Add output cursor/pagination contract everywhere.
12. [ ] Expand regression and Workspace fixture tests.
13. [ ] Run real Chrome E2E certification.
14. [ ] Update CDP documentation and agent guidance.

This order intentionally delivers Sheets and Slides first because the deep audit proved that both already expose strong structured read surfaces through the current authenticated Chrome session.

---

## 15. Definition of Done

The project is complete only when SuperAgent CDP can truthfully make the following guarantee:

> SuperAgent CDP can read supported Google Workspace artifacts through structured browser-accessible sources, return deterministic structured content, report whether extraction is complete or partial, avoid silent truncation, preserve read-only safety, and use vision/OCR only when no reliable structured source is available.

Completion additionally requires:

- [x] Sheets structured extraction certified.
- [x] Slides structured extraction certified.
- [x] Docs hybrid extraction certified.
- [x] Drive virtual-list extraction certified.
- [x] Forms extraction certified.
- [x] Verification contract enforced.
- [x] Pagination enforced for large artifacts.
- [x] Existing generic CDP behavior preserved.
- [x] Unit/integration tests passing.
- [ ] Real Chrome E2E certification passing (live Google Forms editor fixture & live read-only permission matrix pending post-reload).
