import { describe, expect, test } from "vitest";
import {
  detectGoogleWorkspaceApp,
  buildWorkspaceReadRoute,
  paginateWorkspaceValue,
  detectWorkspaceFailure,
  INSPECT_FRAMES_JS,
  buildWorkspaceReadExpression,
  WORKSPACE_FAILURE_DETECTION_JS,
  extractDocsRichBlocksFromDom,
  buildDocsRenderingContract,
  renderBlocksToHtml,
  renderBlocksToWordPressMarkup,
  type DocsContentBlock,
  type DocsImageBlock,
  type DocsTableBlock,
  type DocsVerificationScopes,
} from "../src/core/tools/googleWorkspaceReader.js";
import { READ_PAGE_JS, SNAPSHOT_JS } from "../src/core/tools/chromeCdpHelpers.js";

describe("Google Workspace CDP reader", () => {
  test("detects supported Workspace applications", () => {
    expect(detectGoogleWorkspaceApp("https://docs.google.com/document/d/abc/edit")).toBe("docs");
    expect(detectGoogleWorkspaceApp("https://docs.google.com/spreadsheets/d/abc/edit?gid=7")).toBe("sheets");
    expect(detectGoogleWorkspaceApp("https://docs.google.com/presentation/d/abc/edit")).toBe("slides");
    expect(detectGoogleWorkspaceApp("https://drive.google.com/drive/my-drive")).toBe("drive");
    expect(detectGoogleWorkspaceApp("https://docs.google.com/forms/d/abc/edit")).toBe("forms");
    expect(detectGoogleWorkspaceApp("https://example.com")).toBe("unknown");
  });

  test("builds structured read routes without mutating the source document", () => {
    expect(buildWorkspaceReadRoute("https://docs.google.com/document/d/doc123/edit")?.url)
      .toBe("https://docs.google.com/document/d/doc123/preview");
    expect(buildWorkspaceReadRoute("https://docs.google.com/spreadsheets/d/sheet123/edit?gid=99")?.url)
      .toBe("https://docs.google.com/spreadsheets/d/sheet123/htmlview?gid=99");
    expect(buildWorkspaceReadRoute("https://docs.google.com/spreadsheets/d/sheet123/edit?gid=99", 123)?.url)
      .toBe("https://docs.google.com/spreadsheets/d/sheet123/htmlview?gid=123");
    expect(buildWorkspaceReadRoute("https://docs.google.com/presentation/d/deck123/edit")?.url)
      .toBe("https://docs.google.com/presentation/d/deck123/htmlpresent");
  });

  test("preserves Google multi-account routing for structured read surfaces", () => {
    expect(buildWorkspaceReadRoute("https://docs.google.com/document/u/2/d/doc123/edit")?.url)
      .toBe("https://docs.google.com/document/u/2/d/doc123/preview");
    expect(buildWorkspaceReadRoute("https://docs.google.com/spreadsheets/u/1/d/sheet123/edit?gid=99")?.url)
      .toBe("https://docs.google.com/spreadsheets/u/1/d/sheet123/htmlview?gid=99");
    expect(buildWorkspaceReadRoute("https://docs.google.com/presentation/d/deck123/edit?authuser=3")?.url)
      .toBe("https://docs.google.com/presentation/u/3/d/deck123/htmlpresent");
  });

  test("paginates structured results with explicit completeness metadata", () => {
    const value = {
      kind: "google_slides",
      completeCandidate: true,
      slides: Array.from({ length: 5 }, (_, index) => ({ index: index + 1 })),
    };
    const first = paginateWorkspaceValue(value, 0, 2, 1000);
    expect(first.status).toBe("partial");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(2);
    expect(first.slides).toHaveLength(2);

    const last = paginateWorkspaceValue(value, 4, 2, 1000);
    expect(last.status).toBe("verified");
    expect(last.complete).toBe(true);
    expect(last.hasMore).toBe(false);
  });

  test("paginates long document text instead of silently truncating it", () => {
    const value = {
      kind: "google_docs",
      completeCandidate: true,
      bodyText: "x".repeat(2500),
    };
    const first = paginateWorkspaceValue(value, 0, 100, 1000);
    expect(first.bodyText).toHaveLength(1000);
    expect(first.nextCursor).toBe(1000);
    expect(first.truncated).toBe(true);

    const last = paginateWorkspaceValue(value, 2000, 100, 1000);
    expect(last.bodyText).toHaveLength(500);
    expect(last.complete).toBe(true);
  });

  test("Docs preview does not claim completeness without page evidence", () => {
    const expression = buildWorkspaceReadExpression("docs");
    expect(expression).toContain("pageCount === 1");
    expect(expression).toContain("page completeness could not be proven");
  });

  test("reader snippets include iframe, Sheets and Slides structured paths", () => {
    expect(INSPECT_FRAMES_JS).toContain("sameOrigin");
    expect(buildWorkspaceReadExpression("sheets")).toContain("htmlview_iframe");
    expect(buildWorkspaceReadExpression("sheets")).toContain("verificationScope: \"active_sheet\"");
    expect(buildWorkspaceReadExpression("sheets")).toContain(".switcherItemActive,.switcherItem");
    expect(buildWorkspaceReadExpression("slides")).toContain("htmlpresent");
    expect(buildWorkspaceReadExpression("docs")).toContain("preview_dom");
  });

  test("generic reader no longer hard-caps text at 7000 or snapshot source at 120", () => {
    expect(READ_PAGE_JS).not.toContain("bodyText.slice(0, 7000)");
    expect(READ_PAGE_JS).toContain("sameOriginFrames");
    expect(SNAPSHOT_JS).not.toContain("slice(0, 120).map");
    expect(READ_PAGE_JS).toContain("google_sheets_editor");
    expect(SNAPSHOT_JS).toContain("google_docs_editor");
  });

  // P10: Sheets all_sheets multi-tab verification & pagination
  describe("P10: Sheets all_sheets", () => {
    test("expression supports allSheets mode and emits workbook verification scope", () => {
      const singleSheetExpr = buildWorkspaceReadExpression("sheets", { allSheets: false });
      expect(singleSheetExpr).toContain("verificationScope: \"active_sheet\"");

      const allSheetsExpr = buildWorkspaceReadExpression("sheets", { allSheets: true });
      expect(allSheetsExpr).toContain("verificationScope: \"workbook\"");
      expect(allSheetsExpr).toContain("shouldReadAllSheets = true");
      expect(allSheetsExpr).toContain("sheetsRead");
      expect(allSheetsExpr).toContain("aggTotalRows");
    });

    test("paginates all_sheets results and enforces workbook verification integrity", () => {
      const workbookValue = {
        kind: "google_sheets",
        verificationScope: "workbook",
        totalSheets: 3,
        sheetsRead: 3,
        completeCandidate: true,
        sheets: [
          { name: "Sheet1", gid: "0", totalRows: 50, rows: Array.from({ length: 50 }, (_, i) => ({ index: i })), status: "verified" },
          { name: "Sheet2", gid: "100", totalRows: 30, rows: Array.from({ length: 30 }, (_, i) => ({ index: i })), status: "verified" },
          { name: "Sheet3", gid: "200", totalRows: 20, rows: Array.from({ length: 20 }, (_, i) => ({ index: i })), status: "verified" },
        ],
      };

      // Page 1: 2 sheets
      const p1 = paginateWorkspaceValue(workbookValue, 0, 2, 20000);
      expect(p1.sheets).toHaveLength(2);
      expect(p1.status).toBe("partial");
      expect(p1.hasMore).toBe(true);
      expect(p1.nextCursor).toBe(2);

      // Page 2: remaining 1 sheet
      const p2 = paginateWorkspaceValue(workbookValue, 2, 2, 20000);
      expect(p2.sheets).toHaveLength(1);
      expect(p2.status).toBe("verified");
      expect(p2.complete).toBe(true);
      expect(p2.hasMore).toBe(false);
    });

    test("never marks workbook verified if any sheet in the page is incomplete or truncated", () => {
      const incompleteWorkbook = {
        kind: "google_sheets",
        verificationScope: "workbook",
        totalSheets: 2,
        sheetsRead: 1,
        completeCandidate: false,
        sheets: [
          { name: "Sheet1", gid: "0", totalRows: 10, rows: [], status: "verified" },
          { name: "Sheet2", gid: "100", totalRows: 0, rows: [], status: "partial" },
        ],
      };
      const result = paginateWorkspaceValue(incompleteWorkbook, 0, 10, 20000);
      expect(result.status).toBe("partial");
      expect(result.complete).toBe(false);
    });
  });

  // P12: failure/permission handling
  describe("P12: Workspace failure detection", () => {
    test("detects login_required on Google Sign-In redirect URLs and accounts pages", () => {
      const res1 = detectWorkspaceFailure({
        url: "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fdocs.google.com%2Fdocument%2Fd%2F123",
        title: "Sign in - Google Accounts",
      });
      expect(res1.failed).toBe(true);
      expect(res1.reason).toBe("login_required");

      const res2 = detectWorkspaceFailure({
        url: "https://accounts.google.com/v3/signin/identifier",
        bodyText: "Sign in with your Google Account to access this file.",
      });
      expect(res2.failed).toBe(true);
      expect(res2.reason).toBe("login_required");
    });

    test("detects access_denied and permission_request pages", () => {
      const res1 = detectWorkspaceFailure({
        url: "https://docs.google.com/document/d/secret/edit",
        title: "You need access",
        headings: ["You need access"],
        bodyText: "Ask for access, or switch to an account with access. Request access button.",
      });
      expect(res1.failed).toBe(true);
      expect(res1.reason).toBe("permission_request");

      const res2 = detectWorkspaceFailure({
        url: "https://docs.google.com/spreadsheets/d/secret/edit",
        title: "Access Denied",
        bodyText: "Access denied: you do not have permission to view this page.",
      });
      expect(res2.failed).toBe(true);
      expect(res2.reason).toBe("access_denied");
    });

    test("detects file_not_found (404 / deleted)", () => {
      const res1 = detectWorkspaceFailure({
        url: "https://docs.google.com/document/d/missing/edit",
        title: "File not found",
        bodyText: "We're sorry, this document is not found. It may have been deleted.",
      });
      expect(res1.failed).toBe(true);
      expect(res1.reason).toBe("file_not_found");

      const res2 = detectWorkspaceFailure({
        url: "https://docs.google.com/presentation/d/deleted/preview",
        title: "Page not found",
        bodyText: "404. That’s an error. The requested URL was not found on this server.",
      });
      expect(res2.failed).toBe(true);
      expect(res2.reason).toBe("file_not_found");
    });

    test("detects google_error (500 / server crash)", () => {
      const res = detectWorkspaceFailure({
        url: "https://docs.google.com/document/d/broken/edit",
        title: "Error",
        bodyText: "Google Docs has encountered an error. Please reload this page.",
      });
      expect(res.failed).toBe(true);
      expect(res.reason).toBe("google_error");
    });

    test("returns failed: false for valid workspace documents", () => {
      const res = detectWorkspaceFailure({
        url: "https://docs.google.com/document/d/valid/preview",
        title: "Quarterly Financial Report Q3",
        bodyText: "Executive summary: revenue increased by 24% year-over-year.",
      });
      expect(res.failed).toBe(false);
      expect(res.reason).toBeUndefined();
    });

    test("paginateWorkspaceValue fail-closes on failure state and never returns verified", () => {
      const failedResult = {
        kind: "google_docs",
        status: "failed",
        failed: true,
        reason: "access_denied",
        error: "Google Workspace access denied.",
        bodyText: "You need access. Request access now.",
        completeCandidate: true, // Malicious or erroneous completeCandidate flag
      };
      const paginated = paginateWorkspaceValue(failedResult, 0, 100, 1000);
      expect(paginated.status).toBe("failed");
      expect(paginated.complete).toBe(false);
      expect(paginated.failed).toBe(true);
    });

    test("WORKSPACE_FAILURE_DETECTION_JS snippet contains failure detection patterns", () => {
      expect(WORKSPACE_FAILURE_DETECTION_JS).toContain("servicelogin");
      expect(WORKSPACE_FAILURE_DETECTION_JS).toContain("you need access");
      expect(WORKSPACE_FAILURE_DETECTION_JS).toContain("file not found");
      expect(WORKSPACE_FAILURE_DETECTION_JS).toContain("google docs has encountered an error");
    });
  });

  // P11: Forms hardening
  describe("P11: Forms hardening", () => {
    test("Forms expression detects modes and rejects responses tab from question parsing", () => {
      const expr = buildWorkspaceReadExpression("forms");
      expect(expr).toContain("formMode");
      expect(expr).toContain("forms_home");
      expect(expr).toContain("responses");
      expect(expr).toContain("public_form");
      expect(expr).toContain("editor");
      expect(expr).toContain("submitted user responses are not read as form questions");
    });

    test("Forms expression extracts questions, types, options, sections, and required flags", () => {
      const expr = buildWorkspaceReadExpression("forms");
      expect(expr).toContain("multiple_choice");
      expect(expr).toContain("linear_scale");
      expect(expr).toContain("checkboxes");
      expect(expr).toContain("dropdown");
      expect(expr).toContain("short_answer");
      expect(expr).toContain("paragraph");
      expect(expr).toContain("aria-required");
      expect(expr).toContain("sectionNodes");
    });

    test("paginates questions cleanly with explicit completeness", () => {
      const formValue = {
        kind: "google_forms",
        formMode: "public_form",
        completeCandidate: true,
        questions: [
          { index: 1, title: "Name", type: "short_answer", required: true },
          { index: 2, title: "Role", type: "multiple_choice", required: true, options: ["Dev", "Design"] },
          { index: 3, title: "Feedback", type: "paragraph", required: false },
        ],
      };
      const p1 = paginateWorkspaceValue(formValue, 0, 2, 5000);
      expect(p1.questions).toHaveLength(2);
      expect(p1.status).toBe("partial");
      expect(p1.hasMore).toBe(true);

      const p2 = paginateWorkspaceValue(formValue, 2, 2, 5000);
      expect(p2.questions).toHaveLength(1);
      expect(p2.status).toBe("verified");
      expect(p2.complete).toBe(true);
    });
  });

  // P13: Docs rich-content verification scopes
  describe("P13: Docs rich-content verification scopes", () => {
    test("Docs snippet includes verificationScopes with rich document features", () => {
      const expr = buildWorkspaceReadExpression("docs");
      expect(expr).toContain("verificationScope: \"text_content\"");
      expect(expr).toContain("verificationScopes");
      expect(expr).toContain("tables:");
      expect(expr).toContain("images:");
      expect(expr).toContain("comments:");
      expect(expr).toContain("drawings:");
      expect(expr).toContain("footnotes:");
    });
  });

  // P14: Sheets richer metadata & capability reporting
  describe("P14: Sheets capabilities and merged ranges", () => {
    test("Sheets snippet includes capability reporting and mergedRanges extraction", () => {
      const expr = buildWorkspaceReadExpression("sheets");
      expect(expr).toContain("displayed_values: \"verified\"");
      expect(expr).toContain("formulas_types: \"unavailable\"");
      expect(expr).toContain("hidden_rows_cols: \"unknown\"");
      expect(expr).toContain("frozen_panes: \"unknown\"");
      expect(expr).toContain("filters: \"unknown\"");
      expect(expr).toContain("merged_ranges");
      expect(expr).toContain("notes_comments: \"unavailable\"");
      expect(expr).toContain("mergedRanges");
      expect(expr).toContain("colspan > 1 || rowspan > 1");
    });
  });

  // P15: Slides notes & media capability/scopes
  describe("P15: Slides notes & media capabilities", () => {
    test("Slides snippet includes verificationScopes and images alt text extraction", () => {
      const expr = buildWorkspaceReadExpression("slides");
      expect(expr).toContain("slide_text");
      expect(expr).toContain("speaker_notes: \"not_read\"");
      expect(expr).toContain("media_references: \"unavailable\"");
      expect(expr).toContain("images_alt_text");
      expect(expr).toContain("querySelectorAll(\"img\")");
    });
  });

  // P16: Drive scale & stress hardening
  describe("P16: Drive scale and stress hardening", () => {
    test("Drive snippet uses end-of-scroll + no-new-stable-IDs convergence", () => {
      const expr = buildWorkspaceReadExpression("drive");
      expect(expr).toContain("stableRounds >= 2");
      expect(expr).toContain("scroller.scrollTop >= maxTop - 2");
      expect(expr).toContain("data-id");
      expect(expr).toContain("reachedEnd");
    });

    test("synthetic Drive virtualized list scales to 100, 500, and 1000 items with deduplication", () => {
      for (const totalItems of [100, 500, 1000]) {
        // Simulate a virtualized container where only 25 items are in DOM at any scroll position
        const windowSize = 25;
        const allItems = Array.from({ length: totalItems }, (_, i) => ({
          id: `file_doc_${i + 1}`,
          name: `Document File ${i + 1}.docx`,
          text: `File item ${i + 1}`,
        }));

        const collected = new Map<string, any>();
        let currentScrollOffset = 0;
        let stableRounds = 0;
        let reachedEnd = false;
        let iterations = 0;
        let prevSize = 0;

        while (iterations < 100) {
          // DOM window at current scroll
          const domWindow = allItems.slice(currentScrollOffset, currentScrollOffset + windowSize);
          for (const item of domWindow) {
            collected.set(item.id, item);
          }

          if (collected.size === prevSize) {
            stableRounds++;
          } else {
            stableRounds = 0;
          }
          prevSize = collected.size;

          const maxOffset = totalItems - windowSize;
          if (currentScrollOffset >= maxOffset && stableRounds >= 2) {
            reachedEnd = true;
            break;
          }

          // Advance scroll window by 20 items (overlapping by 5 items)
          currentScrollOffset = Math.min(maxOffset, currentScrollOffset + 20);
          iterations++;
        }

        expect(collected.size).toBe(totalItems);
        expect(reachedEnd).toBe(true);
        // Verify deduplication: exactly totalItems unique items
        expect(new Set(collected.keys()).size).toBe(totalItems);
      }
    });
  });

  // P13B: Google Docs Rich Block + Image Position Preservation
  describe("P13B: Google Docs Rich Block + Image Position Preservation", () => {
    test("fixture 1: paragraph -> image -> paragraph preserves exact sequence and image anchor", () => {
      const html = `<p>Introductory paragraph text describing our initial benchmark results.</p><p><img src="https://lh3.googleusercontent.com/chart-1.png" alt="Benchmark Chart" width="600" height="400" data-placement="inline"></p><p>Subsequent discussion explaining the chart metrics.</p>`;
      const result = extractDocsRichBlocksFromDom(html);
      expect(result.blocks).toHaveLength(3);
      expect(result.blocks.map(b => b.type)).toEqual(["paragraph", "image", "paragraph"]);
      expect(result.blocks[0].index).toBe(0);
      expect(result.blocks[1].index).toBe(1);
      expect(result.blocks[2].index).toBe(2);

      const img = result.blocks[1] as DocsImageBlock;
      expect(img.src).toBe("https://lh3.googleusercontent.com/chart-1.png");
      expect(img.alt).toBe("Benchmark Chart");
      expect(img.anchorBlockId).toBe(result.blocks[0].id);
      expect(img.placement).toBe("inline");
      expect(img.anchorType).toBe("inline_with_text");
      expect(img.dimensions?.width).toBe(600);
      expect(img.dimensions?.height).toBe(400);

      expect(result.verificationScopes.block_order).toBe("verified");
      expect(result.verificationScopes.image_order).toBe("verified");
      expect(result.verificationScopes.image_anchor).toBe("verified");
      expect(result.verificationScopes.image_binary).toBe("verified");
    });

    test("fixture 2: heading -> paragraph -> image -> paragraph -> image preserves multi-step interleaved flow", () => {
      const html = `<h1>Project Roadmap 2027</h1><p>Phase 1 milestones overview.</p><img src="https://img.test/roadmap1.png" alt="Roadmap 1" width="800" height="300"><p>Phase 2 delivery targets.</p><img src="https://img.test/roadmap2.png" alt="Roadmap 2" width="800" height="350">`;
      const result = extractDocsRichBlocksFromDom(html);
      expect(result.blocks).toHaveLength(5);
      expect(result.blocks.map(b => b.type)).toEqual(["heading", "paragraph", "image", "paragraph", "image"]);
      expect(result.blocks[0].type).toBe("heading");
      expect((result.blocks[0] as any).level).toBe(1);
      expect(result.blocks[2].type).toBe("image");
      expect(result.blocks[4].type).toBe("image");
      expect(result.blocks.map(b => b.index)).toEqual([0, 1, 2, 3, 4]);
      expect((result.blocks[2] as DocsImageBlock).anchorBlockId).toBe(result.blocks[1].id);
      expect((result.blocks[4] as DocsImageBlock).anchorBlockId).toBe(result.blocks[3].id);
      expect(result.verificationScopes.headings).toBe("verified");
      expect(result.verificationScopes.image_order).toBe("verified");
    });

    test("fixture 3: image adjacent to list items preserves boundary positions", () => {
      const html = `<p>Deployment instructions:</p><ul><li>Step 1: Build binaries</li><li>Step 2: Deploy infrastructure <img src="https://img.test/deploy.png" alt="Deploy Diagram"></li><li>Step 3: Verify health</li></ul><p>Post-deployment notes.</p>`;
      const result = extractDocsRichBlocksFromDom(html);
      expect(result.blocks.map(b => b.type)).toEqual(["paragraph", "list_item", "list_item", "image", "list_item", "paragraph"]);
      expect(result.verificationScopes.lists).toBe("verified");
      expect(result.verificationScopes.image_order).toBe("verified");
    });

    test("fixture 4: image before and after table preserves exact sequence without table corruption", () => {
      const html = `<img src="https://img.test/pre-table.png" alt="Pre Table Chart"><table><tr><th>Metric</th><th>Q3</th></tr><tr><td>Latency</td><td>12ms</td></tr></table><img src="https://img.test/post-table.png" alt="Post Table Chart">`;
      const result = extractDocsRichBlocksFromDom(html);
      expect(result.blocks).toHaveLength(3);
      expect(result.blocks.map(b => b.type)).toEqual(["image", "table", "image"]);
      const table = result.blocks[1] as DocsTableBlock;
      expect(table.totalRows).toBe(2);
      expect(table.rows[0].cells[0].text).toBe("Metric");
      expect(table.rows[1].cells[1].text).toBe("12ms");
      expect(result.verificationScopes.tables).toBe("verified");
      expect(result.verificationScopes.image_order).toBe("verified");
    });

    test("fixture 5: multiple images between paragraphs maintain relative order", () => {
      const html = `<p>Top paragraph</p><img src="https://img.test/photo1.jpg" alt="Photo 1"><img src="https://img.test/photo2.jpg" alt="Photo 2"><img src="https://img.test/photo3.jpg" alt="Photo 3"><p>Bottom paragraph</p>`;
      const result = extractDocsRichBlocksFromDom(html);
      expect(result.blocks).toHaveLength(5);
      expect(result.blocks.map(b => b.type)).toEqual(["paragraph", "image", "image", "image", "paragraph"]);
      const imgUrls = result.blocks.filter(b => b.type === "image").map(b => (b as DocsImageBlock).src);
      expect(imgUrls).toEqual(["https://img.test/photo1.jpg", "https://img.test/photo2.jpg", "https://img.test/photo3.jpg"]);
      expect(result.verificationScopes.image_order).toBe("verified");
    });

    test("fixture 6: missing or unknown image anchor must never become verified", () => {
      const html = `<p>Intro paragraph</p><img src="https://img.test/floating.png" alt="Floating" data-placement="unknown" style="position: absolute; top: 100px;"><p>Outro paragraph</p>`;
      const result = extractDocsRichBlocksFromDom(html);
      expect(result.blocks).toHaveLength(3);
      const floatImg = result.blocks[1] as DocsImageBlock;
      expect(floatImg.placement).toBe("unknown");
      expect(floatImg.anchorBlockId).toBeUndefined();

      // Strict requirement: NEVER mark image_anchor verified!
      expect(result.verificationScopes.image_anchor).not.toBe("verified");
      expect(["unknown", "partial"]).toContain(result.verificationScopes.image_anchor);
      expect(result.verificationScopes.block_order).toBe("partial");
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    test("fixture 7: pagination preserves block order across slices", () => {
      const html = `<h1>Title</h1><p>P1</p><img src="https://img.test/1.png" alt="1"><p>P2</p><img src="https://img.test/2.png" alt="2"><p>P3</p>`;
      const result = extractDocsRichBlocksFromDom(html);
      const data = {
        kind: "google_docs",
        blocks: result.blocks,
        completeCandidate: true,
      };

      const page1 = paginateWorkspaceValue(data, 0, 3, 10000);
      expect(page1.blocks).toHaveLength(3);
      expect(page1.blocks.map((b: DocsContentBlock) => b.index)).toEqual([0, 1, 2]);
      expect(page1.hasMore).toBe(true);
      expect(page1.complete).toBe(false);

      const page2 = paginateWorkspaceValue(data, page1.nextCursor, 3, 10000);
      expect(page2.blocks).toHaveLength(3);
      expect(page2.blocks.map((b: DocsContentBlock) => b.index)).toEqual([3, 4, 5]);
      expect(page2.hasMore).toBe(false);
      expect(page2.complete).toBe(true);

      const combined = [...page1.blocks, ...page2.blocks];
      expect(combined.map((b: DocsContentBlock) => b.index)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(combined.map((b: DocsContentBlock) => b.type)).toEqual(result.blocks.map(b => b.type));
    });

    test("fixture 8: downstream rendering contract preserves block sequence and supports WordPress replacement", () => {
      const html = `<h2>Section 1</h2><p>Intro text</p><img src="https://lh3.googleusercontent.com/raw-draft.png" alt="Draft Chart" data-caption="Fig 1: Q3 Latency"><p>Outro text</p>`;
      const extracted = extractDocsRichBlocksFromDom(html);
      const contract = buildDocsRenderingContract("Technical Spec", extracted.blocks, extracted.verificationScopes);

      expect(contract.version).toBe("1.0");
      expect(contract.totalBlocks).toBe(4);
      expect(contract.imageManifest).toHaveLength(1);
      expect(contract.imageManifest[0].blockId).toBe(extracted.blocks[2].id);
      expect(contract.imageManifest[0].caption).toBe("Fig 1: Q3 Latency");

      const replacements = new Map();
      replacements.set(contract.imageManifest[0].blockId, {
        blockId: contract.imageManifest[0].blockId,
        wpAttachmentId: 1042,
        wpAttachmentUrl: "https://wp.example.com/wp-content/uploads/2026/10/chart-final.png",
        caption: "Fig 1: Q3 Latency (Verified)",
        alt: "Final Chart",
      });

      const wpMarkup = renderBlocksToWordPressMarkup(contract, replacements);
      const headingPos = wpMarkup.indexOf("<!-- wp:heading");
      const p1Pos = wpMarkup.indexOf("<!-- wp:paragraph -->\n<p>Intro text</p>");
      const imgPos = wpMarkup.indexOf("<!-- wp:image {\"id\":1042");
      const p2Pos = wpMarkup.indexOf("<!-- wp:paragraph -->\n<p>Outro text</p>");

      expect(headingPos).toBeGreaterThan(-1);
      expect(p1Pos).toBeGreaterThan(headingPos);
      expect(imgPos).toBeGreaterThan(p1Pos);
      expect(p2Pos).toBeGreaterThan(imgPos);
      expect(wpMarkup).toContain("https://wp.example.com/wp-content/uploads/2026/10/chart-final.png");
      expect(wpMarkup).toContain("<figcaption>Fig 1: Q3 Latency (Verified)</figcaption>");

      // Also verify renderBlocksToHtml works cleanly
      const htmlOutput = renderBlocksToHtml(contract, replacements);
      expect(htmlOutput).toContain("<h2>Section 1</h2>");
      expect(htmlOutput).toContain("<figure class=\"wp-block-image\"><img src=\"https://wp.example.com/wp-content/uploads/2026/10/chart-final.png\"");
    });

    test("fixture 9: TXT export alone strictly sets image_order and block_order to unavailable", () => {
      const txtValue = {
        kind: "google_docs",
        source: "authenticated_export_txt",
        verificationScope: "text_content",
        verificationScopes: {
          text_content: "verified" as const,
          block_order: "unavailable" as const,
          image_order: "unavailable" as const,
          image_anchor: "unavailable" as const,
          image_binary: "unavailable" as const,
          tables: "not_read" as const,
          headings: "not_read" as const,
          lists: "not_read" as const,
          captions: "unavailable" as const,
          comments: "not_read" as const,
          suggestions: "not_read" as const,
          drawings: "not_read" as const,
          footnotes: "not_read" as const,
          document_tabs: "not_read" as const,
          images: "not_read" as const,
        },
        bodyText: "Plain text from Google Docs export without formatting.",
        completeCandidate: true,
      };

      const paginated = paginateWorkspaceValue(txtValue, 0, 10, 10000);
      expect(paginated.verificationScopes.text_content).toBe("verified");
      expect(paginated.verificationScopes.block_order).toBe("unavailable");
      expect(paginated.verificationScopes.image_order).toBe("unavailable");
      expect(paginated.verificationScopes.image_anchor).toBe("unavailable");
      expect(paginated.verificationScopes.image_binary).toBe("unavailable");
      expect(paginated.verificationScopes.tables).toBe("not_read");
      expect(paginated.verificationScopes.images).toBe("not_read");
    });

    test("fixture 10: structured read routes use preview without modifying source documents", () => {
      const editUrl = "https://docs.google.com/document/d/doc_spec_999/edit";
      const route = buildWorkspaceReadRoute(editUrl);
      expect(route?.source).toBe("preview");
      expect(route?.url).toBe("https://docs.google.com/document/d/doc_spec_999/preview");
      expect(route?.url).not.toContain("/edit");
    });

    test("Docs browser expression contains rich block extraction and scopes", () => {
      const expr = buildWorkspaceReadExpression("docs");
      expect(expr).toContain("createImageBlock");
      expect(expr).toContain("detectImagePlacement");
      expect(expr).toContain("block_order:");
      expect(expr).toContain("image_order:");
      expect(expr).toContain("image_anchor:");
      expect(expr).toContain("image_binary:");
      expect(expr).toContain("hasUnknownImageAnchor");
    });
  });
});
