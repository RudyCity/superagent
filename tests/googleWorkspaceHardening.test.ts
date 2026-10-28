import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { AddressInfo } from "net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlChromeCdpTool, _cdpTestHooks } from "../src/core/tools/chromeCdpTools.js";

describe("Google Workspace CDP Reader Hardening (P10–P18)", () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let httpPort = 0;
  let wsPort = 0;
  let savedPort: string | undefined;
  let savedTimeout: string | undefined;
  let savedSessionDir: string | undefined;
  let testSessionDir = "";

  const activePages = new Map<string, { id: string; title: string; url: string }>();
  const closedTargets: string[] = [];
  let iframeProbeAttempts = 0;
  let slowIframeReadyAfter = 0;

  beforeAll(async () => {
    savedSessionDir = process.env.SUPERAGENT_CDP_SESSION_DIR;
    testSessionDir = await mkdtemp(join(tmpdir(), "superagent-workspace-hardening-test-"));
    process.env.SUPERAGENT_CDP_SESSION_DIR = testSessionDir;

    // WebSocket server for mock CDP targets
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    wsPort = (wss.address() as AddressInfo).port;

    wss.on("connection", (ws: WebSocket, req) => {
      const url = req.url || "";
      const targetIdMatch = url.match(/\/devtools\/page\/(.+)$/);
      const targetId = targetIdMatch ? targetIdMatch[1] : "";

      ws.on("message", (data) => {
        let msg: any;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }

        const page = activePages.get(targetId);

        if (msg.method === "Page.enable" || msg.method === "Page.navigate") {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }

        if (msg.method === "Accessibility.enable") {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }

        if (msg.method === "Accessibility.getFullAXTree") {
          ws.send(JSON.stringify({
            id: msg.id,
            result: {
              nodes: [
                { role: { value: "heading" }, name: { value: "Section 1" } },
                { role: { value: "paragraph" }, name: { value: "Content page 1 of 1" } }
              ]
            }
          }));
          return;
        }

        if (msg.method === "Network.getCookies") {
          ws.send(JSON.stringify({
            id: msg.id,
            result: { cookies: [{ name: "SID", value: "mock_session_cookie" }] }
          }));
          return;
        }

        if (msg.method === "Runtime.evaluate") {
          const expr = String((msg.params && msg.params.expression) || "");

          // Ready state check
          if (expr.includes("readyState")) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: "complete" } } }));
            return;
          }

          // Probe check inside openTemporaryCdpReadTarget
          if (expr.includes("frames: document.querySelectorAll('iframe').length")) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { body: 500, frames: 1, tables: 1 } } } }));
            return;
          }

          // Screen reader support probe for Docs
          if (expr.includes("turn on screen reader support")) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: false } } }));
            return;
          }

          // Sheets iframe table readiness probe
          if (expr.includes("cdp-workspace-sheets") || expr.includes("f.contentDocument.querySelectorAll('tr').length > 1")) {
            if (slowIframeReadyAfter > 0) {
              iframeProbeAttempts++;
              if (iframeProbeAttempts < slowIframeReadyAfter) {
                ws.send(JSON.stringify({ id: msg.id, result: { result: { value: false } } }));
                return;
              }
            }
            if (expr.includes("f.contentDocument.querySelectorAll('tr').length > 1")) {
              ws.send(JSON.stringify({ id: msg.id, result: { result: { value: true } } }));
              return;
            }
          }



          // Sheets extractor
          if (expr.includes("/*cdp-workspace-sheets*/")) {
            const isAllSheets = expr.includes("shouldReadAllSheets = true");
            if (isAllSheets) {
              ws.send(JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    value: {
                      kind: "google_sheets",
                      source: "htmlview_iframe",
                      url: page?.url || "https://docs.google.com/spreadsheets/d/mock/htmlview",
                      title: "Mock Financial Plan",
                      verificationScope: "workbook",
                      totalSheets: 2,
                      sheetsRead: 2,
                      totalRows: 60,
                      totalCells: 180,
                      sheets: [
                        {
                          name: "Summary",
                          gid: "0",
                          rows: Array.from({ length: 30 }, (_, r) => ({ index: r, cells: [{ index: 0, text: `R${r}C0` }] })),
                          totalRows: 30,
                          totalCells: 90,
                          mergedRanges: [{ row: 0, col: 0, colspan: 2, rowspan: 1, text: "Header" }],
                          capabilities: { displayed_values: "verified", formulas_types: "unavailable", merged_ranges: "available" },
                          status: "verified"
                        },
                        {
                          name: "Details",
                          gid: "12345",
                          rows: Array.from({ length: 30 }, (_, r) => ({ index: r, cells: [{ index: 0, text: `Detail ${r}` }] })),
                          totalRows: 30,
                          totalCells: 90,
                          mergedRanges: [],
                          capabilities: { displayed_values: "verified", formulas_types: "unavailable", merged_ranges: "none_found" },
                          status: "verified"
                        }
                      ],
                      capabilities: {
                        displayed_values: "verified",
                        formulas_types: "unavailable",
                        hidden_rows_cols: "unknown",
                        frozen_panes: "unknown",
                        filters: "unknown",
                        merged_ranges: "available",
                        notes_comments: "unavailable"
                      },
                      completeCandidate: true,
                      warnings: []
                    }
                  }
                }
              }));
            } else {
              ws.send(JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    value: {
                      kind: "google_sheets",
                      source: "htmlview_iframe",
                      url: page?.url || "https://docs.google.com/spreadsheets/d/mock/htmlview",
                      title: "Mock Financial Plan",
                      verificationScope: "active_sheet",
                      activeSheet: "Summary",
                      activeGid: "0",
                      totalSheets: 2,
                      totalRows: 30,
                      totalCells: 90,
                      mergedRanges: [{ row: 0, col: 0, colspan: 2, rowspan: 1, text: "Header" }],
                      capabilities: {
                        displayed_values: "verified",
                        formulas_types: "unavailable",
                        hidden_rows_cols: "unknown",
                        frozen_panes: "unknown",
                        filters: "unknown",
                        merged_ranges: "available",
                        notes_comments: "unavailable"
                      },
                      sheetTabs: [{ name: "Summary", gid: "0", rows: 30 }, { name: "Details", gid: "12345", rows: 30 }],
                      rows: Array.from({ length: 30 }, (_, r) => ({ index: r, cells: [{ index: 0, text: `R${r}C0` }] })),
                      completeCandidate: true,
                      warnings: ["Workbook contains 2 sheets; this result verifies the active sheet only."]
                    }
                  }
                }
              }));
            }
            return;
          }

          // Slides extractor
          if (expr.includes("/*cdp-workspace-slides*/")) {
            ws.send(JSON.stringify({
              id: msg.id,
              result: {
                result: {
                  value: {
                    kind: "google_slides",
                    source: "htmlpresent",
                    url: page?.url || "https://docs.google.com/presentation/d/mock/htmlpresent",
                    title: "Architecture Pitch Deck",
                    totalSlides: 10,
                    slidesRead: 10,
                    slides: Array.from({ length: 10 }, (_, i) => ({ index: i + 1, text: `Slide ${i + 1} content` })),
                    links: [{ text: "Specs", href: "https://specs.test" }],
                    images: [{ src: "https://img.test/logo.png", alt: "Company Logo" }],
                    verificationScopes: {
                      slide_text: "verified",
                      speaker_notes: "not_read",
                      hyperlinks: "verified",
                      images_alt_text: "partial",
                      media_references: "unavailable"
                    },
                    completeCandidate: true,
                    warnings: ["Slide text and links verified via htmlpresent; speaker notes and media references are not exposed in htmlpresent and marked not_read."]
                  }
                }
              }
            }));
            return;
          }

          // Forms extractor
          if (expr.includes("/*cdp-workspace-forms*/")) {
            if (page && (page.url.includes("#responses") || page.url.includes("/edit#responses"))) {
              ws.send(JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    value: {
                      kind: "google_forms",
                      formMode: "responses",
                      source: "dom",
                      url: page.url,
                      title: "Customer Feedback Form",
                      bodyText: "12 responses recorded",
                      questions: [],
                      sections: [],
                      completeCandidate: false,
                      warnings: ["Form responses tab/view detected. Normal form reading extracts form structure and questions only; submitted user responses are not read as form questions."]
                    }
                  }
                }
              }));
              return;
            }

            ws.send(JSON.stringify({
              id: msg.id,
              result: {
                result: {
                  value: {
                    kind: "google_forms",
                    formMode: "public_form",
                    source: "dom",
                    url: page?.url || "https://docs.google.com/forms/d/e/mock/viewform",
                    title: "Customer Feedback Form",
                    description: "Please share your thoughts on our services",
                    sections: [{ index: 1, title: "General Feedback" }],
                    totalQuestions: 2,
                    questions: [
                      { index: 1, title: "Your Name", type: "short_answer", required: true },
                      { index: 2, title: "Satisfaction Rating", type: "multiple_choice", required: true, options: ["Great", "Average", "Poor"] }
                    ],
                    completeCandidate: true,
                    warnings: []
                  }
                }
              }
            }));
            return;
          }

          // Docs preview extractor
          if (expr.includes("/*cdp-workspace-docs*/")) {
            ws.send(JSON.stringify({
              id: msg.id,
              result: {
                result: {
                  value: {
                    kind: "google_docs",
                    source: "preview_dom",
                    url: page?.url || "https://docs.google.com/document/d/mock/preview",
                    title: page?.title || "Quarterly Financial Review",
                    bodyText: page?.bodyText || "Quarterly Financial Review. Net profit increased by 15% in Q3.",
                    headings: page?.headings || ["Quarterly Financial Review"],
                    pageCount: 1,
                    pageSignals: [{ current: 1, total: 1 }],
                    blocks: page?.blocks || undefined,
                    totalBlocks: page?.blocks ? page.blocks.length : undefined,
                    verificationScope: "text_content",
                    verificationScopes: page?.verificationScopes || {
                      text_content: "verified",
                      tables: "not_read",
                      images: "not_read",
                      comments: "not_read",
                      suggestions: "not_read",
                      drawings: "not_read",
                      footnotes: "not_read",
                      document_tabs: "unknown"
                    },
                    completeCandidate: true,
                    warnings: []
                  }
                }
              }
            }));
            return;
          }

          // Failure detection probe
          if (expr.includes("cdp-workspace-failure-detection")) {
            if (page && page.url.includes("accounts.google.com/ServiceLogin")) {
              ws.send(JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    value: { failed: true, reason: "login_required", message: "Google Workspace authentication required." }
                  }
                }
              }));
              return;
            }
            if (page && (page.title.includes("You need access") || page.url.includes("access-denied"))) {
              ws.send(JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    value: { failed: true, reason: "access_denied", message: "Google Workspace access denied." }
                  }
                }
              }));
              return;
            }
            if (page && page.url.includes("not-found-404")) {
              ws.send(JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    value: { failed: true, reason: "file_not_found", message: "Google Workspace file not found." }
                  }
                }
              }));
              return;
            }
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { failed: false } } } }));
            return;
          }

          // Generic evaluation fallback
          ws.send(JSON.stringify({ id: msg.id, result: { result: { value: "ok" } } }));
          return;
        }

        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      });
    });

    // Mock HTTP server
    httpServer = createServer((req, res) => {
      if (req.url === "/json/list") {
        const pages = Array.from(activePages.values()).map((p) => ({
          id: p.id,
          type: "page",
          title: p.title,
          url: p.url,
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/${p.id}`,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pages));
      } else if (req.url?.startsWith("/json/new")) {
        const targetUrl = decodeURIComponent(req.url.slice("/json/new?".length));
        const newId = `T_TEMP_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const docId = targetUrl.split("/d/")[1]?.split("/")[0] || "";
        const match = docId ? Array.from(activePages.values()).find((p) => p.url && p.url.includes(`/d/${docId}/`)) : undefined;
        activePages.set(newId, {
          id: newId,
          title: match?.title || "Temporary Read Tab",
          url: targetUrl,
          blocks: match?.blocks,
          verificationScopes: match?.verificationScopes,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: newId, url: targetUrl }));
      } else if (req.url?.startsWith("/json/close/")) {
        const closeId = req.url.slice("/json/close/".length);
        activePages.delete(closeId);
        closedTargets.push(closeId);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Target closed");
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
    httpPort = (httpServer.address() as AddressInfo).port;

    savedPort = process.env.SUPERAGENT_CDP_PORT;
    savedTimeout = process.env.SUPERAGENT_CDP_TIMEOUT_MS;
    process.env.SUPERAGENT_CDP_PORT = String(httpPort);
    process.env.SUPERAGENT_CDP_TIMEOUT_MS = "3000";
  });

  afterAll(async () => {
    if (savedPort === undefined) delete process.env.SUPERAGENT_CDP_PORT;
    else process.env.SUPERAGENT_CDP_PORT = savedPort;
    if (savedTimeout === undefined) delete process.env.SUPERAGENT_CDP_TIMEOUT_MS;
    else process.env.SUPERAGENT_CDP_TIMEOUT_MS = savedTimeout;
    _cdpTestHooks.closeAll();
    if (savedSessionDir === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
    else process.env.SUPERAGENT_CDP_SESSION_DIR = savedSessionDir;
    await rm(testSessionDir, { recursive: true, force: true });
    await new Promise<void>((r) => httpServer.close(() => r()));
    await new Promise<void>((r) => wss.close(() => r()));
  });

  test("rejects generic non-Workspace URLs from read_workspace with clear actionable guidance", async () => {
    activePages.set("T_GENERIC", { id: "T_GENERIC", title: "Example Domain", url: "https://example.com/" });
    const res = await controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_GENERIC" });
    expect(res).toContain("read_workspace supports Google Docs, Sheets, Slides, Drive, and Forms URLs");
    expect(res).toContain("Use read_page for generic websites");
  });

  // P12 failure handling tests
  test("P12: returns status failed and reason login_required when target is redirected to Google Sign-In", async () => {
    activePages.set("T_LOGIN", {
      id: "T_LOGIN",
      title: "Sign in - Google Accounts",
      url: "https://accounts.google.com/ServiceLogin?continue=https://docs.google.com/document/d/doc123/edit",
    });
    const res = await controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_LOGIN" });
    const parsed = JSON.parse(res as string);
    expect(parsed.status).toBe("failed");
    expect(parsed.failed).toBe(true);
    expect(parsed.complete).toBe(false);
    expect(parsed.reason).toBe("login_required");
  });

  test("P12: returns status failed and reason access_denied when target requires permission", async () => {
    activePages.set("T_DENIED", {
      id: "T_DENIED",
      title: "You need access",
      url: "https://docs.google.com/document/d/secret_doc/edit",
    });
    const res = await controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_DENIED" });
    const parsed = JSON.parse(res as string);
    expect(parsed.status).toBe("failed");
    expect(parsed.failed).toBe(true);
    expect(parsed.complete).toBe(false);
    expect(["access_denied", "permission_request"]).toContain(parsed.reason);
  });

  test("P12: returns status failed and reason file_not_found on 404/deleted documents", async () => {
    activePages.set("T_404", {
      id: "T_404",
      title: "File not found",
      url: "https://docs.google.com/document/d/missing_file/edit",
    });
    const res = await controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_404" });
    const parsed = JSON.parse(res as string);
    expect(parsed.status).toBe("failed");
    expect(parsed.failed).toBe(true);
    expect(parsed.complete).toBe(false);
    expect(parsed.reason).toBe("file_not_found");
  });

  // P10: Sheets all_sheets vs single sheet
  test("P10: read_workspace with all_sheets: true reads entire workbook with workbook scope and capabilities", async () => {
    activePages.set("T_SHEETS", {
      id: "T_SHEETS",
      title: "Mock Financial Plan",
      url: "https://docs.google.com/spreadsheets/d/finance123/edit",
    });
    const res = await controlChromeCdpTool.execute({
      command: "read_workspace",
      targetId: "T_SHEETS",
      all_sheets: true,
    });

    const parsed = JSON.parse(res as string);
    expect(parsed.kind).toBe("google_sheets");
    expect(parsed.verificationScope).toBe("workbook");
    expect(parsed.status).toBe("verified");
    expect(parsed.complete).toBe(true);
    expect(parsed.totalSheets).toBe(2);
    expect(parsed.sheetsRead).toBe(2);
    expect(parsed.sheets).toHaveLength(2);
    expect(parsed.sheets[0].name).toBe("Summary");
    expect(parsed.sheets[1].name).toBe("Details");
    expect(parsed.capabilities.displayed_values).toBe("verified");
    expect(parsed.capabilities.formulas_types).toBe("unavailable");
  });

  test("P10: read_workspace on Sheets defaults to active_sheet scope when all_sheets is false", async () => {
    activePages.set("T_SHEETS_SINGLE", {
      id: "T_SHEETS_SINGLE",
      title: "Mock Financial Plan",
      url: "https://docs.google.com/spreadsheets/d/finance123/edit?gid=0",
    });
    const res = await controlChromeCdpTool.execute({
      command: "read_workspace",
      targetId: "T_SHEETS_SINGLE",
    });
    const parsed = JSON.parse(res as string);
    expect(parsed.kind).toBe("google_sheets");
    expect(parsed.verificationScope).toBe("active_sheet");
    expect(parsed.status).toBe("verified");
    expect(parsed.activeSheet).toBe("Summary");
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.capabilities.merged_ranges).toBe("available");
  });

  // P13: Docs rich-content verification scopes
  test("P13: Docs reader returns explicit verificationScopes without false verified claims for rich media", async () => {
    activePages.set("T_DOCS", {
      id: "T_DOCS",
      title: "Quarterly Financial Review",
      url: "https://docs.google.com/document/d/doc_fin_123/edit",
    });
    const res = await controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_DOCS" });
    const parsed = JSON.parse(res as string);
    expect(parsed.kind).toBe("google_docs");
    expect(parsed.verificationScope).toBe("text_content");
    expect(parsed.verificationScopes).toBeDefined();
    expect(parsed.verificationScopes.text_content).toBe("verified");
    expect(parsed.verificationScopes.tables).toBe("not_read");
    expect(parsed.verificationScopes.images).toBe("not_read");
    expect(parsed.verificationScopes.comments).toBe("not_read");
    expect(parsed.verificationScopes.footnotes).toBe("not_read");
  });

  // P13B: Google Docs Rich Block + Image Position Preservation
  test("P13B: Docs reader with rich_blocks: true extracts ordered blocks and image positions", async () => {
    activePages.set("T_DOCS_RICH", {
      id: "T_DOCS_RICH",
      title: "Quarterly Engineering Review",
      url: "https://docs.google.com/document/d/doc_eng_456/edit",
      blocks: [
        { id: "heading-0", index: 0, type: "heading", level: 1, text: "Quarterly Engineering Review" },
        { id: "paragraph-1", index: 1, type: "paragraph", text: "Overview of platform metrics." },
        {
          id: "image-2",
          index: 2,
          type: "image",
          src: "https://lh3.googleusercontent.com/infra.png",
          alt: "Infrastructure Metrics",
          placement: "inline",
          anchorBlockId: "paragraph-1",
          anchorType: "inline_with_text",
          binaryReference: { type: "url", url: "https://lh3.googleusercontent.com/infra.png", recoverable: true },
        },
        { id: "paragraph-3", index: 3, type: "paragraph", text: "Latency improved across all services." },
      ],
      verificationScopes: {
        text_content: "verified",
        block_order: "verified",
        image_order: "verified",
        image_anchor: "verified",
        image_binary: "verified",
        tables: "none_found",
        headings: "verified",
        lists: "none_found",
        captions: "none_found",
        comments: "not_read",
        suggestions: "not_read",
        drawings: "not_read",
        footnotes: "not_read",
        document_tabs: "unknown",
        images: "verified",
      },
    });

    const res = await controlChromeCdpTool.execute({
      command: "read_workspace",
      targetId: "T_DOCS_RICH",
      rich_blocks: true,
    });
    const parsed = JSON.parse(res as string);
    expect(parsed.kind).toBe("google_docs");
    expect(parsed.verificationScope).toBe("rich_blocks");
    expect(parsed.blocks).toHaveLength(4);
    expect(parsed.blocks.map((b: any) => b.type)).toEqual(["heading", "paragraph", "image", "paragraph"]);
    expect(parsed.blocks[2].anchorBlockId).toBe("paragraph-1");
    expect(parsed.verificationScopes.image_order).toBe("verified");
    expect(parsed.verificationScopes.image_anchor).toBe("verified");
    expect(parsed.verificationScopes.block_order).toBe("verified");
  });

  // P15: Slides capabilities and verification scopes
  test("P15: Slides reader returns explicit verificationScopes and marks speaker notes not_read", async () => {
    activePages.set("T_SLIDES", {
      id: "T_SLIDES",
      title: "Architecture Pitch Deck",
      url: "https://docs.google.com/presentation/d/deck_pitch_123/edit",
    });
    const res = await controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_SLIDES" });
    const parsed = JSON.parse(res as string);
    expect(parsed.kind).toBe("google_slides");
    expect(parsed.totalSlides).toBe(10);
    expect(parsed.slidesRead).toBe(10);
    expect(parsed.status).toBe("verified");
    expect(parsed.verificationScopes.slide_text).toBe("verified");
    expect(parsed.verificationScopes.speaker_notes).toBe("not_read");
    expect(parsed.verificationScopes.media_references).toBe("unavailable");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0].alt).toBe("Company Logo");
  });

  // P11: Forms hardening & responses tab guard
  test("P11: Forms reader parses questions, types, and sections in public form", async () => {
    activePages.set("T_FORMS", {
      id: "T_FORMS",
      title: "Customer Feedback Form",
      url: "https://docs.google.com/forms/d/e/feedback_form/viewform",
    });
    const res = await controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_FORMS" });
    const parsed = JSON.parse(res as string);
    expect(parsed.kind).toBe("google_forms");
    expect(parsed.formMode).toBe("public_form");
    expect(parsed.status).toBe("verified");
    expect(parsed.questions).toHaveLength(2);
    expect(parsed.questions[0].title).toBe("Your Name");
    expect(parsed.questions[0].type).toBe("short_answer");
    expect(parsed.questions[1].type).toBe("multiple_choice");
    expect(parsed.questions[1].options).toContain("Great");
  });

  test("P11: Forms reader on responses tab rejects parsing responses as form questions and warns", async () => {
    activePages.set("T_FORMS_RESP", {
      id: "T_FORMS_RESP",
      title: "Customer Feedback Form",
      url: "https://docs.google.com/forms/d/feedback_form/edit#responses",
    });
    const res = await controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_FORMS_RESP" });
    const parsed = JSON.parse(res as string);
    expect(parsed.kind).toBe("google_forms");
    expect(parsed.formMode).toBe("responses");
    expect(parsed.questions).toHaveLength(0);
    expect(parsed.complete).toBe(false);
    expect(parsed.warnings[0]).toContain("submitted user responses are not read as form questions");
  });

  // P17: Recovery, concurrency, and temporary target cleanup
  test("P17: recovers gracefully when Sheets iframe table is slow to load", async () => {
    slowIframeReadyAfter = 3;
    iframeProbeAttempts = 0;
    activePages.set("T_SLOW_SHEET", {
      id: "T_SLOW_SHEET",
      title: "Slow Loading Sheet",
      url: "https://docs.google.com/spreadsheets/d/slow123/edit",
    });
    const res = await controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_SLOW_SHEET" });
    const parsed = JSON.parse(res as string);
    expect(parsed.kind).toBe("google_sheets");
    expect(parsed.status).toBe("verified");
    expect(iframeProbeAttempts).toBeGreaterThanOrEqual(3);
    slowIframeReadyAfter = 0;
  });

  test("P17: cleans up temporary read targets without leaking tabs", async () => {
    const closedCountBefore = closedTargets.length;
    activePages.set("T_CLEANUP", {
      id: "T_CLEANUP",
      title: "Temporary Tab Leak Test Deck",
      url: "https://docs.google.com/presentation/d/deck_cleanup/edit",
    });
    await controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_CLEANUP" });
    // Verify that a temporary tab was created and closed cleanly
    expect(closedTargets.length).toBeGreaterThan(closedCountBefore);
    const lastClosed = closedTargets[closedTargets.length - 1];
    expect(lastClosed).toContain("T_TEMP_");
  });

  test("P17: concurrent read_workspace invocations execute safely without cross-talk", async () => {
    activePages.set("T_CONCURRENT_1", {
      id: "T_CONCURRENT_1",
      title: "Slides Deck Concurrent 1",
      url: "https://docs.google.com/presentation/d/deck_c1/edit",
    });
    activePages.set("T_CONCURRENT_2", {
      id: "T_CONCURRENT_2",
      title: "Sheets Workbook Concurrent 2",
      url: "https://docs.google.com/spreadsheets/d/sheet_c2/edit",
    });

    const [res1, res2] = await Promise.all([
      controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_CONCURRENT_1" }),
      controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_CONCURRENT_2" }),
    ]);

    const parsed1 = JSON.parse(res1 as string);
    const parsed2 = JSON.parse(res2 as string);

    expect(parsed1.kind).toBe("google_slides");
    expect(parsed1.status).toBe("verified");
    expect(parsed2.kind).toBe("google_sheets");
    expect(parsed2.status).toBe("verified");
  });
});
