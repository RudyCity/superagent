import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { projectDelegateActionTelemetry } from "../src/core/delegate/delegateStatusProjection.js";
import {
  recordDelegateAction, readDelegateActionDiagnostics,
} from "../src/core/browserTransport/delegateActionDiagnostics.js";

describe("Delegate-CDP Tray action diagnostics", () => {
  it("includes only connected clients and applies a requested profile filter", () => {
    const clientA = "chrome_client_001";
    const clientB = "chrome_client_002";
    const a = recordDelegateAction({
      command: "click", clientId: clientA, tabId: 4, startedAt: Date.now(),
      result: 'control_chrome_cdp: Delegate click: {"ok":true}',
    });
    const b = recordDelegateAction({
      command: "snapshot", clientId: clientB, tabId: 8, startedAt: Date.now(),
      result: "control_chrome_cdp: Delegate snapshot: []",
    });
    const source = readDelegateActionDiagnostics(30).filter(row =>
      row.operationId === a.operationId || row.operationId === b.operationId);
    expect(projectDelegateActionTelemetry(source, [clientA], clientA).actionDiagnostics)
      .toEqual([expect.objectContaining({ operationId: a.operationId, outcome: "executed" })]);
    expect(projectDelegateActionTelemetry(source, [clientA], clientB).actionDiagnostics).toEqual([]);
    expect(projectDelegateActionTelemetry(source, [], undefined).actionDiagnostics).toEqual([]);
    expect(projectDelegateActionTelemetry(source, [clientA, clientB]).actionDiagnostics)
      .toHaveLength(2);
    const hash = createHash("sha256").update(clientA).digest("hex").slice(0, 12);
    expect(projectDelegateActionTelemetry(source, [clientA]).actionDiagnostics[0].clientFingerprint)
      .toBe(hash);
  });

  it("uses a local auth route, marks stale telemetry unknown, and never renders HTML from trace values", () => {
    const routes = readFileSync("src/serverRoutes.ts", "utf8");
    const projection = readFileSync("src/core/delegate/delegateStatusProjection.ts", "utf8");
    const html = readFileSync("apps/superagent-tray/ui/index.html", "utf8");
    const ui = readFileSync("apps/superagent-tray/ui/delegate-multitab.js", "utf8");
    expect(routes).toContain('pathname === "/api/delegate/multitab/status"');
    expect(routes).toContain('if ((!bearer && !headerToken) || !isRequestAuthorized(req, parsedUrl))');
    expect(projection).toContain('actionDiagnosticsStatus: "unknown"');
    expect(html).toContain('id="delegate-action-history"');
    expect(html).toContain('id="delegate-action-summary"');
    expect(ui).toContain('snapshot.actionDiagnosticsStatus === "known"');
    expect(ui).toContain('!state.sessionsStale');
    expect(ui).toContain('card.append(elem(');
    expect(ui).not.toContain("innerHTML");
    expect(ui).toContain("OpenAI-side tool rejections");
  });
});
