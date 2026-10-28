import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { AddressInfo } from "net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlChromeCdpTool, _cdpTestHooks } from "../src/core/tools/chromeCdpTools.js";
import { detectWorkspaceFailure } from "../src/core/tools/googleWorkspaceReader.js";

describe("Google Workspace CDP Integration & Hardening (P10–P18)", () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let httpPort = 0;
  let wsPort = 0;
  let savedPort: string | undefined;
  let savedTimeout: string | undefined;
  let savedSessionDir: string | undefined;
  let testSessionDir = "";
  let tempTabCounter = 0;

  // Active targets in mock Chrome
  interface MockPage {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
  }
  let pages: MockPage[] = [];

  // Configurable mock behaviors
  let mockSheetsAllSheets = false;
  let mockSheetsIncomplete = false;
  let mockFormsMode: "editor" | "public_form" | "responses" | "forms_home" = "editor";
  let simulateSlowIframe = false;
  let slowIframeProbeCount = 0;
  let simulateTargetCloseDuringRead = false;
  let simulateFailure: { failed: boolean; reason?: string; message?: string } | null = null;

  beforeAll(async () => {
    savedSessionDir = process.env.SUPERAGENT_CDP_SESSION_DIR;
    testSessionDir = await mkdtemp(join(tmpdir(), "superagent-workspace-integration-"));
    process.env.SUPERAGENT_CDP_SESSION_DIR = testSessionDir;

    // 1. Mock CDP WebSocket Server
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    wsPort = (wss.address() as AddressInfo).port;

    wss.on("connection", (ws: WebSocket, req) => {
      ws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }

        if (simulateTargetCloseDuringRead && msg.method === "Runtime.evaluate" && String(msg.params?.expression || "").includes("cdp-workspace")) {
          ws.close(1001, "Target detached / tab closed during read");
          return;
        }

        if (msg.method === "Runtime.evaluate") {
          const expr = String(msg.params?.expression || "");

          if (simulateFailure && simulateFailure.failed) {
            ws.send(JSON.stringify({
              id: msg.id,
              result: {
                result: {
                  value: {
                    failed: true,
                    status: "failed",
                    complete: false,
                    reason: simulateFailure.reason || "access_denied",
                    error: simulateFailure.message || "Access denied",
                    message: simulateFailure.message || "Access denied",
                    url: "https://docs.google.com/document/d/fail/edit",
                    title: "Error",
                    warnings: [simulateFailure.message || "Access denied"],
                  },
                },
              },
            }));
            return;
          }

          // Ready state
          if (expr.includes("readyState")) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: "complete" } } }));
            return;
          }

          // Content probe for temporary tabs
          if (expr.includes("document.querySelectorAll('iframe').length")) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { body: 500, frames: 1, tables: 1 } } } }));
            return;
          }

          // Sheets iframe table readiness probe
          if (expr.includes("querySelectorAll('tr').length > 1")) {
            if (simulateSlowIframe) {
              slowIframeProbeCount++;
              if (slowIframeProbeCount < 3) {
                ws.send(JSON.stringify({ id: msg.id, result: { result: { value: false } } }));
                return;
              }
            }
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: true } } }));
            return;
          }

          // Screen reader support probe for Docs
          if (expr.includes("turn on screen reader support")) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: false } } }));
            return;
          }

          // Google Sheets structured reader
          if (expr.includes("cdp-workspace-sheets")) {
            if (mockSheetsAllSheets) {
              if (mockSheetsIncomplete) {
                ws.send(JSON.stringify({
                  id: msg.id,
                  result: {
                    result: {
                      value: {
                        kind: "google_sheets",
                        source: "htmlview_iframe",
                        url: "https://docs.google.com/spreadsheets/d/wb1/htmlview",
                        title: "Multi-Tab Budget",
                        verificationScope: "workbook",
                        totalSheets: 3,
                        sheetsRead: 2,
                        totalRows: 40,
                        totalCells: 160,
                        sheets: [
                          { name: "Q1", gid: "0", totalRows: 20, totalCells: 80, rows: Array.from({ length: 20 }, (_, i) => ({ index: i })), mergedRanges: [], status: "verified" },
                          { name: "Q2", gid: "10", totalRows: 20, totalCells: 80, rows: Array.from({ length: 20 }, (_, i) => ({ index: i })), mergedRanges: [], status: "verified" },
                          { name: "Q3", gid: "20", totalRows: 0, totalCells: 0, rows: [], mergedRanges: [], status: "partial" },
                        ],
                        capabilities: {
                          displayed_values: "available",
                          formulas_types: "unavailable",
                          hidden_rows_cols: "unknown",
                          frozen_panes: "unknown",
                          filters: "unknown",
                          merged_ranges: "none_found",
                          notes_comments: "unavailable",
                        },
                        completeCandidate: false,
                        warnings: ["Workbook contains 3 sheets; only 2 were successfully verified."],
                      },
                    },
                  },
                }));
                return;
              }

              // Complete all_sheets
              ws.send(JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    value: {
                      kind: "google_sheets",
                      source: "htmlview_iframe",
                      url: "https://docs.google.com/spreadsheets/d/wb1/htmlview",
                      title: "Multi-Tab Budget",
                      verificationScope: "workbook",
                      totalSheets: 2,
                      sheetsRead: 2,
                      totalRows: 45,
                      totalCells: 180,
                      sheets: [
                        {
                          name: "Revenue",
                          gid: "0",
                          totalRows: 25,
                          totalCells: 100,
                          rows: Array.from({ length: 25 }, (_, i) => ({ index: i })),
                          mergedRanges: [{ row: 0, col: 0, rowspan: 1, colspan: 4, text: "Q1-Q4 Overview" }],
                          capabilities: { displayed_values: "verified", formulas_types: "unavailable", hidden_rows_cols: "unknown", frozen_panes: "unknown", filters: "unknown", merged_ranges: "available", notes_comments: "unavailable" },
                          status: "verified",
                        },
                        {
                          name: "Expenses",
                          gid: "101",
                          totalRows: 20,
                          totalCells: 80,
                          rows: Array.from({ length: 20 }, (_, i) => ({ index: i })),
                          mergedRanges: [],
                          capabilities: { displayed_values: "verified", formulas_types: "unavailable", hidden_rows_cols: "unknown", frozen_panes: "unknown", filters: "unknown", merged_ranges: "none_found", notes_comments: "unavailable" },
                          status: "verified",
                        },
                      ],
                      capabilities: {
                        displayed_values: "verified",
                        formulas_types: "unavailable",
                        hidden_rows_cols: "unknown",
                        frozen_panes: "unknown",
                        filters: "unknown",
                        merged_ranges: "available",
                        notes_comments: "unavailable",
                      },
                      completeCandidate: true,
                      warnings: [],
                    },
                  },
                },
              }));
              return;
            }

            // Single sheet default
            ws.send(JSON.stringify({
              id: msg.id,
              result: {
                result: {
                  value: {
                    kind: "google_sheets",
                    source: "htmlview_iframe",
                    url: "https://docs.google.com/spreadsheets/d/wb1/htmlview?gid=0",
                    title: "Active Sheet Report",
                    verificationScope: "active_sheet",
                    activeSheet: "Revenue",
                    activeGid: "0",
                    totalSheets: 2,
                    totalRows: 25,
                    totalCells: 100,
                    mergedRanges: [{ row: 0, col: 0, rowspan: 1, colspan: 4, text: "Q1 Overview" }],
                    sheetTabs: [
                      { name: "Revenue", gid: "0", rows: 25, url: "https://docs.google.com/spreadsheets/d/wb1/htmlview/sheet?gid=0" },
                      { name: "Expenses", gid: "101", rows: 20, url: "https://docs.google.com/spreadsheets/d/wb1/htmlview/sheet?gid=101" },
                    ],
                    rows: Array.from({ length: 25 }, (_, i) => ({ index: i })),
                    capabilities: {
                      displayed_values: "verified",
                      formulas_types: "unavailable",
                      hidden_rows_cols: "unknown",
                      frozen_panes: "unknown",
                      filters: "unknown",
                      merged_ranges: "available",
                      notes_comments: "unavailable",
                    },
                    completeCandidate: true,
                    warnings: ["Workbook contains 2 sheets; this result verifies the active sheet only. Use read_workspace with all_sheets:true or a specific gid from sheetTabs to read another sheet."],
                  },
                },
              },
            }));
            return;
          }

          // Google Slides structured reader
          if (expr.includes("cdp-workspace-slides")) {
            ws.send(JSON.stringify({
              id: msg.id,
              result: {
                result: {
                  value: {
                    kind: "google_slides",
                    source: "htmlpresent",
                    url: "https://docs.google.com/presentation/d/deck1/htmlpresent",
                    title: "Architecture Strategy 2027",
                    totalSlides: 10,
                    slidesRead: 10,
                    slides: Array.from({ length: 10 }, (_, i) => ({
                      index: i + 1,
                      text: `Slide ${i + 1} content outlining key metrics and system topology.`,
                    })),
                    links: [{ text: "RFC 401", href: "https://example.com/rfc/401" }],
                    images: [{ src: "https://example.com/diagram.png", alt: "Architecture Diagram" }],
                    verificationScopes: {
                      slide_text: "verified",
                      speaker_notes: "not_read",
                      hyperlinks: "verified",
                      images_alt_text: "partial",
                      media_references: "unavailable",
                    },
                    completeCandidate: true,
                    warnings: [
                      "Slide text and links verified via htmlpresent; speaker notes and media references are not exposed in htmlpresent and marked not_read.",
                    ],
                  },
                },
              },
            }));
            return;
          }

          // Google Docs preview reader
          if (expr.includes("cdp-workspace-docs")) {
            ws.send(JSON.stringify({
              id: msg.id,
              result: {
                result: {
                  value: {
                    kind: "google_docs",
                    source: "preview_dom",
                    url: "https://docs.google.com/document/d/doc1/preview",
                    title: "Project Specification",
                    bodyText: "Single page specification text verified completely.",
                    headings: ["Introduction", "Scope"],
                    pageCount: 1,
                    verificationScope: "text_content",
                    verificationScopes: {
                      text_content: "verified",
                      tables: "not_read",
                      images: "not_read",
                      comments: "not_read",
                      suggestions: "not_read",
                      drawings: "not_read",
                      footnotes: "not_read",
                      document_tabs: "unknown",
                    },
                    completeCandidate: true,
                    warnings: [],
                  },
                },
              },
            }));
            return;
          }

          // Google Forms reader
          if (expr.includes("cdp-workspace-forms")) {
            if (mockFormsMode === "responses") {
              ws.send(JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    value: {
                      kind: "google_forms",
                      formMode: "responses",
                      source: "dom",
                      url: "https://docs.google.com/forms/d/form1/edit#responses",
                      title: "Customer Survey",
                      bodyText: "144 responses recorded.",
                      questions: [],
                      sections: [],
                      completeCandidate: false,
                      warnings: [
                        "Form responses tab/view detected. Normal form reading extracts form structure and questions only; submitted user responses are not read as form questions.",
                      ],
                    },
                  },
                },
              }));
              return;
            }

            if (mockFormsMode === "forms_home") {
              ws.send(JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    value: {
                      kind: "google_forms",
                      formMode: "forms_home",
                      source: "dom",
                      url: "https://docs.google.com/forms/u/0/",
                      title: "Google Forms",
                      bodyText: "Recent forms dashboard.",
                      questions: [],
                      sections: [],
                      completeCandidate: false,
                      warnings: [
                        "Google Forms dashboard / home view detected, not an individual form document.",
                      ],
                    },
                  },
                },
              }));
              return;
            }

            // Public form / editor with structured questions
            ws.send(JSON.stringify({
              id: msg.id,
              result: {
                result: {
                  value: {
                    kind: "google_forms",
                    formMode: "public_form",
                    source: "dom",
                    url: "https://docs.google.com/forms/d/e/1FAIpQLSc/viewform",
                    title: "Beta Feedback Survey",
                    description: "Please rate your experience with SuperAgent.",
                    sections: [{ index: 1, title: "General Experience" }],
                    totalQuestions: 5,
                    questions: [
                      { index: 1, title: "Full Name", type: "short_answer", required: true },
                      { index: 2, title: "Satisfaction Rating", type: "linear_scale", required: true, options: ["1", "2", "3", "4", "5"] },
                      { index: 3, title: "Feature Preferences", type: "checkboxes", required: false, options: ["CDP", "CLI Bridge", "MCP"] },
                      { index: 4, title: "System Matrix Evaluation", type: "multiple_choice_grid", required: false, options: ["Fast", "Stable"] },
                      { index: 5, title: "Log File Attachment", type: "file_upload", required: false },
                    ],
                    verificationScopes: {
                      form_structure: "verified",
                      questions: "verified",
                      response_data: "segregated",
                    },
                    completeCandidate: true,
                    warnings: [],
                  },
                },
              },
            }));
            return;
          }

          // Standalone failure probe
          if (expr.includes("cdp-workspace-failure-detection")) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { failed: false } } } }));
            return;
          }

          // Fallback Runtime.evaluate
          ws.send(JSON.stringify({ id: msg.id, result: { result: { value: {} } } }));
          return;
        }

        // Generic CDP methods
        const canned: Record<string, any> = {
          "Page.enable": {},
          "Page.navigate": {},
          "Page.addScriptToEvaluateOnNewDocument": {},
          "Input.dispatchKeyEvent": {},
          "Network.getCookies": { cookies: [] },
        };
        if (msg.method in canned) {
          ws.send(JSON.stringify({ id: msg.id, result: canned[msg.method] }));
        }
      });
    });

    // 2. Mock CDP HTTP Server
    httpServer = createServer((req, res) => {
      const url = req.url || "";
      if (url === "/json/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pages));
      } else if (url.startsWith("/json/new?")) {
        const targetUrl = decodeURIComponent(url.replace("/json/new?", ""));
        tempTabCounter++;
        const newPage: MockPage = {
          id: `T_TEMP_${tempTabCounter}`,
          type: "page",
          title: `Temporary Tab ${tempTabCounter}`,
          url: targetUrl,
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_TEMP_${tempTabCounter}`,
        };
        pages.push(newPage);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: newPage.id, url: newPage.url }));
      } else if (url.startsWith("/json/close/")) {
        const closeId = url.replace("/json/close/", "");
        pages = pages.filter((p) => p.id !== closeId);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Target is closing");
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
    wss.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  // Reset page targets and flags before each test
  function resetMockChrome(initialPages: MockPage[]) {
    pages = [...initialPages];
    mockSheetsAllSheets = false;
    mockSheetsIncomplete = false;
    mockFormsMode = "editor";
    simulateSlowIframe = false;
    slowIframeProbeCount = 0;
    simulateTargetCloseDuringRead = false;
    simulateFailure = null;
  }

  // P10: Sheets all_sheets
  describe("P10: Sheets all_sheets Integration", () => {
    test("reads single active sheet with gid override and tab discovery by default", async () => {
      resetMockChrome([
        {
          id: "T_SHEETS",
          type: "page",
          title: "Quarterly Revenue",
          url: "https://docs.google.com/spreadsheets/d/wb1/edit?gid=0",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_SHEETS`,
        },
      ]);

      const res = await controlChromeCdpTool.execute({
        command: "read_workspace",
        targetId: "T_SHEETS",
      });
      const data = JSON.parse(res);

      expect(data.kind).toBe("google_sheets");
      expect(data.verificationScope).toBe("active_sheet");
      expect(data.activeSheet).toBe("Revenue");
      expect(data.status).toBe("verified");
      expect(data.complete).toBe(true);
      expect(data.sheetTabs).toHaveLength(2);
      expect(data.capabilities.displayed_values).toBe("verified");
      expect(data.capabilities.formulas_types).toBe("unavailable");
      expect(data.mergedRanges).toHaveLength(1);
    });

    test("reads all sheets in workbook when all_sheets: true is specified", async () => {
      resetMockChrome([
        {
          id: "T_SHEETS_ALL",
          type: "page",
          title: "Multi-Tab Budget",
          url: "https://docs.google.com/spreadsheets/d/wb1/edit",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_SHEETS_ALL`,
        },
      ]);
      mockSheetsAllSheets = true;

      const res = await controlChromeCdpTool.execute({
        command: "read_workspace",
        targetId: "T_SHEETS_ALL",
        all_sheets: true,
      });
      const data = JSON.parse(res);

      expect(data.kind).toBe("google_sheets");
      expect(data.verificationScope).toBe("workbook");
      expect(data.status).toBe("verified");
      expect(data.complete).toBe(true);
      expect(data.totalSheets).toBe(2);
      expect(data.sheetsRead).toBe(2);
      expect(data.totalRows).toBe(45);
      expect(data.totalCells).toBe(180);
      expect(data.sheets).toHaveLength(2);
      expect(data.sheets[0].name).toBe("Revenue");
      expect(data.sheets[1].name).toBe("Expenses");
    });

    test("fails workbook completeness when one or more sheets fail or are partial", async () => {
      resetMockChrome([
        {
          id: "T_SHEETS_INC",
          type: "page",
          title: "Incomplete Multi-Tab",
          url: "https://docs.google.com/spreadsheets/d/wb1/edit",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_SHEETS_INC`,
        },
      ]);
      mockSheetsAllSheets = true;
      mockSheetsIncomplete = true;

      const res = await controlChromeCdpTool.execute({
        command: "read_workspace",
        targetId: "T_SHEETS_INC",
        all_sheets: true,
      });
      const data = JSON.parse(res);

      expect(data.kind).toBe("google_sheets");
      expect(data.verificationScope).toBe("workbook");
      expect(data.status).toBe("partial");
      expect(data.complete).toBe(false);
      expect(data.sheetsRead).toBe(2);
      expect(data.totalSheets).toBe(3);
      expect(data.warnings[0]).toContain("only 2 were successfully verified");
    });
  });

  // P11: Forms Hardening
  describe("P11: Forms Hardening Integration", () => {
    test("extracts public form questions, types, sections, and required flags", async () => {
      resetMockChrome([
        {
          id: "T_FORM",
          type: "page",
          title: "Beta Feedback Survey",
          url: "https://docs.google.com/forms/d/e/1FAIpQLSc/viewform",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_FORM`,
        },
      ]);
      mockFormsMode = "public_form";

      const res = await controlChromeCdpTool.execute({
        command: "read_workspace",
        targetId: "T_FORM",
      });
      const data = JSON.parse(res);

      expect(data.kind).toBe("google_forms");
      expect(data.formMode).toBe("public_form");
      expect(data.status).toBe("verified");
      expect(data.complete).toBe(true);
      expect(data.questions).toHaveLength(5);
      expect(data.questions[0].type).toBe("short_answer");
      expect(data.questions[0].required).toBe(true);
      expect(data.questions[1].type).toBe("linear_scale");
      expect(data.questions[3].type).toBe("multiple_choice_grid");
      expect(data.questions[4].type).toBe("file_upload");
      expect(data.verificationScopes.response_data).toBe("segregated");
    });

    test("segregates responses tab and rejects submitted user responses from question parsing", async () => {
      resetMockChrome([
        {
          id: "T_FORM_RESP",
          type: "page",
          title: "Customer Survey - Responses",
          url: "https://docs.google.com/forms/d/form1/edit#responses",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_FORM_RESP`,
        },
      ]);
      mockFormsMode = "responses";

      const res = await controlChromeCdpTool.execute({
        command: "read_workspace",
        targetId: "T_FORM_RESP",
      });
      const data = JSON.parse(res);

      expect(data.kind).toBe("google_forms");
      expect(data.formMode).toBe("responses");
      expect(data.status).toBe("partial");
      expect(data.complete).toBe(false);
      expect(data.questions).toHaveLength(0);
      expect(data.warnings[0]).toContain("submitted user responses are not read as form questions");
    });
  });

  // P12: Failure & Permission Detection
  describe("P12: Centralized Failure and Permission Detection", () => {
    test("detects Google Login redirect and returns fail-closed status", async () => {
      resetMockChrome([
        {
          id: "T_LOGIN",
          type: "page",
          title: "Sign in - Google Accounts",
          url: "https://accounts.google.com/ServiceLogin?continue=https://docs.google.com/document/d/doc1",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_LOGIN`,
        },
      ]);

      const res = await controlChromeCdpTool.execute({
        command: "read_workspace",
        targetId: "T_LOGIN",
      });
      const data = JSON.parse(res);

      expect(data.status).toBe("failed");
      expect(data.complete).toBe(false);
      expect(data.failed).toBe(true);
      expect(data.reason).toBe("login_required");
      expect(data.error).toContain("Google Workspace authentication required");
    });

    test("detects access_denied / permission_request and returns failed status", async () => {
      resetMockChrome([
        {
          id: "T_DENIED",
          type: "page",
          title: "You need access",
          url: "https://docs.google.com/document/d/restricted/edit",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_DENIED`,
        },
      ]);
      simulateFailure = { failed: true, reason: "access_denied", message: "You need permission to access this item." };

      const res = await controlChromeCdpTool.execute({
        command: "read_workspace",
        targetId: "T_DENIED",
      });
      const data = JSON.parse(res);

      expect(data.status).toBe("failed");
      expect(data.complete).toBe(false);
      expect(data.failed).toBe(true);
      expect(data.reason).toBe("access_denied");
    });
  });

  // P13 & P15: Verification Scopes for Docs & Slides
  describe("P13 & P15: Verification Scopes", () => {
    test("Docs exposes explicit verificationScopes and avoids false whole-document verification", async () => {
      resetMockChrome([
        {
          id: "T_DOCS",
          type: "page",
          title: "Project Specification",
          url: "https://docs.google.com/document/d/doc1/edit",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_DOCS`,
        },
      ]);

      const res = await controlChromeCdpTool.execute({
        command: "read_workspace",
        targetId: "T_DOCS",
      });
      const data = JSON.parse(res);

      expect(data.kind).toBe("google_docs");
      expect(data.verificationScope).toBe("text_content");
      expect(data.verificationScopes).toBeDefined();
      expect(data.verificationScopes.text_content).toBe("verified");
      expect(data.verificationScopes.tables).toBe("not_read");
      expect(data.verificationScopes.images).toBe("not_read");
      expect(data.verificationScopes.comments).toBe("not_read");
    });

    test("Slides exposes explicit verificationScopes and marks speaker_notes not_read", async () => {
      resetMockChrome([
        {
          id: "T_SLIDES",
          type: "page",
          title: "Architecture Strategy 2027",
          url: "https://docs.google.com/presentation/d/deck1/edit",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_SLIDES`,
        },
      ]);

      const res = await controlChromeCdpTool.execute({
        command: "read_workspace",
        targetId: "T_SLIDES",
      });
      const data = JSON.parse(res);

      expect(data.kind).toBe("google_slides");
      expect(data.totalSlides).toBe(10);
      expect(data.slidesRead).toBe(10);
      expect(data.status).toBe("verified");
      expect(data.verificationScopes.slide_text).toBe("verified");
      expect(data.verificationScopes.speaker_notes).toBe("not_read");
      expect(data.verificationScopes.media_references).toBe("unavailable");
      expect(data.verificationScopes.hyperlinks).toBe("verified");
      expect(data.verificationScopes.images_alt_text).toBe("partial");
    });
  });

  // P17: Recovery, Cleanup & Concurrency
  describe("P17: Recovery and Concurrency", () => {
    test("handles slow iframe loading by waiting for table readiness", async () => {
      resetMockChrome([
        {
          id: "T_SLOW_SHEETS",
          type: "page",
          title: "Slow Sheet Loading",
          url: "https://docs.google.com/spreadsheets/d/wb1/edit",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_SLOW_SHEETS`,
        },
      ]);
      simulateSlowIframe = true;

      const res = await controlChromeCdpTool.execute({
        command: "read_workspace",
        targetId: "T_SLOW_SHEETS",
      });
      const data = JSON.parse(res);

      expect(data.kind).toBe("google_sheets");
      expect(slowIframeProbeCount).toBeGreaterThanOrEqual(3);
      expect(data.status).toBe("verified");
    });

    test("guarantees 0 leaked temporary read tabs in Chrome", async () => {
      resetMockChrome([
        {
          id: "T_CLEANUP",
          type: "page",
          title: "Cleanup Target Test",
          url: "https://docs.google.com/spreadsheets/d/wb1/edit",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_CLEANUP`,
        },
      ]);

      const initialPagesCount = pages.length;
      await controlChromeCdpTool.execute({
        command: "read_workspace",
        targetId: "T_CLEANUP",
      });

      // Temporary tab was closed in finally block
      expect(pages.length).toBe(initialPagesCount);
      expect(pages.find((p) => p.id.startsWith("T_TEMP"))).toBeUndefined();
    });

    test("handles target closed during read gracefully with target_closed reason", async () => {
      resetMockChrome([
        {
          id: "T_CLOSE",
          type: "page",
          title: "Tab That Closes",
          url: "https://docs.google.com/spreadsheets/d/wb1/edit",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_CLOSE`,
        },
      ]);
      simulateTargetCloseDuringRead = true;

      const res = await controlChromeCdpTool.execute({
        command: "read_workspace",
        targetId: "T_CLOSE",
      });
      const data = JSON.parse(res);

      expect(data.status).toBe("failed");
      expect(data.complete).toBe(false);
      expect(data.failed).toBe(true);
      expect(data.reason).toBe("target_closed");
    });

    test("executes concurrent Workspace reads with complete target isolation", async () => {
      resetMockChrome([
        {
          id: "T_CONC_1",
          type: "page",
          title: "Sheet Concurrency 1",
          url: "https://docs.google.com/spreadsheets/d/wb1/edit",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_CONC_1`,
        },
        {
          id: "T_CONC_2",
          type: "page",
          title: "Slide Concurrency 2",
          url: "https://docs.google.com/presentation/d/deck1/edit",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T_CONC_2`,
        },
      ]);

      const [res1, res2] = await Promise.all([
        controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_CONC_1" }),
        controlChromeCdpTool.execute({ command: "read_workspace", targetId: "T_CONC_2" }),
      ]);

      const data1 = JSON.parse(res1);
      const data2 = JSON.parse(res2);

      expect(data1.kind).toBe("google_sheets");
      expect(data2.kind).toBe("google_slides");
      expect(data1.status).toBe("verified");
      expect(data2.status).toBe("verified");
      expect(pages.find((p) => p.id.startsWith("T_TEMP"))).toBeUndefined();
    });
  });
});
