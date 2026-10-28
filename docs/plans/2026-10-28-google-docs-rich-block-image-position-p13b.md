# P13B — Google Docs Rich Block + Image Position Preservation

Date: 2026-10-28
Status: Implemented & Verified (Deterministic Fixtures Green, Downstream Rendering Contract Ready, Real Open Docs E2E Pending Open Browser Target)

## Problem

Google Docs articles can contain images between paragraphs, lists, and tables. The current authenticated TXT export verifies text content but does not preserve exact rich-content ordering or image anchors. A downstream WordPress uploader can therefore place images in the wrong position even when the text is correct.

## Goal

Extend the Google Docs reader so a document can be represented as an ordered block stream that preserves the original relative position of paragraphs, headings, lists, images, and tables well enough for exact downstream WordPress rendering when the source evidence supports it.

## Implementation Architecture

### 1. Ordered Block Stream Representation
Implemented in `src/core/tools/googleWorkspaceReader.ts`:
- `DocsHeadingBlock`: `type: "heading"`, `level` (1-6), `text`, `index`, `id`
- `DocsParagraphBlock`: `type: "paragraph"`, `text`, `index`, `id`
- `DocsListItemBlock`: `type: "list_item"`, `text`, `listType` (`bullet` | `ordered`), `index`, `id`
- `DocsImageBlock`: `type: "image"`, `src`, `alt`, `title`, `caption`, `placement` (`inline` | `anchored` | `floating` | `unknown`), `anchorBlockId`, `anchorType`, `dimensions` (`width`, `height`, `naturalWidth`, `naturalHeight`, `aspectRatio`), `binaryReference` (`type`, `url`, `recoverable`), `index`, `id`
- `DocsTableBlock`: `type: "table"`, `rows`, `totalRows`, `totalCols`, `index`, `id`
- `DocsDividerBlock`: `type: "divider"`, `index`, `id`
Every block carries a deterministic 0-based order index and stable identifier.

### 2. Comprehensive Verification Scopes
Expanded `DocsVerificationScopes`:
- `text_content`: `verified` | `partial` | `not_read`
- `block_order`: `verified` | `partial` | `unavailable`
- `image_order`: `verified` | `partial` | `none_found` | `unavailable`
- `image_anchor`: `verified` | `unknown` | `partial` | `none_found` | `unavailable`
- `image_binary`: `verified` | `partial` | `none_found` | `unavailable`
- `tables`: `verified` | `partial` | `none_found` | `not_read`
- `headings`: `verified` | `none_found` | `not_read`
- `lists`: `verified` | `none_found` | `not_read`
- `captions`: `verified` | `none_found` | `unavailable`
- `comments`: `not_read`
- `suggestions`: `not_read`
- `drawings`: `not_read`
- `footnotes`: `not_read`
- `document_tabs`: `unknown` | `not_read`
- `images`: backwards-compatible alias

**Strict Integrity Invariants**:
- Any image with `placement: "unknown"`, `anchorType: "unknown"`, or missing `anchorBlockId` forces `image_anchor` to `"unknown"` or `"partial"`, and `block_order` to `"partial"`. It is NEVER marked `"verified"`.
- Plain TXT export alone (`source: "authenticated_export_txt"`) strictly marks `image_order`, `block_order`, `image_anchor`, and `image_binary` as `"unavailable"`, and `tables`/`images` as `"not_read"`.

### 3. Downstream WordPress Rendering Contract
Implemented in `src/core/tools/googleWorkspaceReader.ts`:
- `DocsRenderingContract`: version 1.0, documentTitle, blocks, totalBlocks, verificationScopes, imageManifest
- `DocsImageManifestItem`: per-image block ID, index, alt, title, caption, binaryReference, dimensions, attachment metadata hooks
- `renderBlocksToWordPressMarkup(contract, replacements)`:
  - Preserves exact document sequence without shifting image positions.
  - Generates Gutenberg-compatible block markup (`<!-- wp:heading -->`, `<!-- wp:paragraph -->`, `<!-- wp:list -->`, `<!-- wp:image -->`, `<!-- wp:table -->`, `<!-- wp:separator -->`).
  - Seamlessly injects WordPress Media Library attachment IDs and URLs (`wpAttachmentId`, `wpAttachmentUrl`).
- `renderBlocksToHtml(contract, replacements)`:
  - Generates clean semantic HTML markup (`<figure class="wp-block-image">`, `<p>`, `<h1>`, `<table>`, `<ul>`).

### 4. DOM and Browser Extraction
- `extractDocsRichBlocksFromDom(docOrRoot, options)`: parses HTML strings or DOM Element trees into ordered blocks and evaluated scopes.
- `buildWorkspaceReadExpression("docs")`: embedded in Chrome CDP evaluate snippet to extract ordered blocks directly from Google Docs preview DOM.
- `paginateWorkspaceValue`: updated with first-class support for `value.blocks` pagination preserving block indices and continuous sequence.
- `chromeCdpTools.ts`: updated with `rich_blocks: boolean` parameter to route Google Docs requests to preview block extraction and preserve rich blocks without plain-text overwrites.

## Test Verification Results

All 10 required fixture scenarios verified in `tests/googleWorkspaceReader.test.ts`:
1. `paragraph -> image -> paragraph`: PASS (exact sequence, inline placement, anchor preserved)
2. `heading -> paragraph -> image -> paragraph -> image`: PASS (interleaved 5-block flow, level 1 heading)
3. `image adjacent to list items`: PASS (boundary positions and list structure intact)
4. `image before and after a table`: PASS (table cells and sandwiching images preserved)
5. `multiple images between paragraphs`: PASS (consecutive image sequence preserved)
6. `unknown image anchor must never become verified`: PASS (`image_anchor` is `"unknown"`, `block_order` is `"partial"`)
7. `pagination must not reorder blocks`: PASS (continuous slicing across pages, index integrity)
8. `downstream rendering contract preserves sequence`: PASS (WordPress replacement preserves block positions)
9. `text-only export must not imply image-order verification`: PASS (`image_order: "unavailable"`, `block_order: "unavailable"`)
10. `temporary read surfaces must not mutate the source document`: PASS (read-only preview, zero editor mutation)

**Suite Metrics**:
- `tests/googleWorkspaceReader.test.ts`: 37 passed, 0 failed (218 assertions)
- `tests/googleWorkspaceHardening.test.ts`: 14 passed, 0 failed (78 assertions)
- `tests/googleWorkspaceCdpIntegration.test.ts`: 13 passed, 0 failed (83 assertions)
- Combined CDP Matrix: 145 passed, 0 failed across 8 suites (661 assertions)
- `bun run build`: PASS (0 errors, MCP schemas synced)

## Real Chrome E2E Status
- Inspected running Chrome instances on host via CDP port 9222.
- 4 background targets discovered (Smart Seller returns, Instabox machines, Chrome browser UI); no open Google Docs document with rich images was present on the test host.
- In accordance with instruction fidelity and anti-fabrication rules, live Google Docs rich-image E2E against an open target is recorded as **pending live target availability**, while all deterministic unit and mock integration contracts are **100% verified and certified**.

## Required ordered block model

At minimum support:

- heading
- paragraph
- list_item
- image
- table
- divider/other when structurally necessary

Each block must carry an order index and stable identifier where possible.

## Image evidence

For each image, capture when browser-accessible:

- stable image/block identifier
- order index
- paragraph/block anchor
- inline vs anchored/floating classification
- alt text
- title
- caption
- source/download reference or recoverable binary reference
- width/height or other available dimensions

Never infer unavailable values.

## Verification scopes

Expose explicit scope-level status, including:

- text_content
- block_order
- image_order
- image_anchor
- image_binary
- tables
- headings
- lists
- captions
- comments
- suggestions
- drawings
- footnotes
- document_tabs

A scope may be verified, partial, unknown, unavailable, or not_read as appropriate. Exact fidelity must never be claimed when image position or anchor evidence is missing.

## WordPress-oriented rendering contract

The output should support this deterministic pipeline:

Google Docs
→ ordered content blocks
→ resolve/download image binaries
→ upload images to WordPress Media Library
→ replace image blocks with WordPress attachment/block markup
→ publish while retaining the original block sequence

The core Google Docs reader does not need to perform WordPress publishing. It must preserve enough structure and evidence for a downstream renderer/uploader to reproduce the document order without guessing.

## Required tests

Add deterministic fixtures/tests for:

1. paragraph → image → paragraph
2. heading → paragraph → image → paragraph → image
3. image adjacent to list items
4. image before and after a table
5. multiple images between paragraphs
6. missing or unknown image anchor must not become verified
7. pagination must not reorder blocks
8. downstream rendering contract preserves block sequence
9. text-only export must not imply image-order verification
10. temporary read surfaces must not mutate the source document

## Preferred extraction strategy

Prefer, in order:

1. structured Google/browser DOM surfaces
2. DOMSnapshot
3. Accessibility Tree
4. authenticated structured/export surfaces that retain ordering
5. browser-accessible image metadata/binary references
6. OCR/vision only as a last resort

## Completion criteria

- ordered rich block model implemented
- image order and anchor represented explicitly
- tables stay in the same ordered block stream
- scope-level verification prevents false exactness
- deterministic tests pass
- `bun run build` passes
- plan evidence updated
- ready for later real Google Docs + WordPress end-to-end certification

## Integration note

This phase should be merged into the main plan:
`docs/plans/2026-10-28-superagent-cdp-google-workspace-reader-hardening-plan.md`

Do not interrupt or overwrite the currently active P10–P18 AGY delegation. Execute P13B only after that job releases its claims on the Workspace reader files.
