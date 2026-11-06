import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { parseTrayLanAction } from "../src/core/runtime/trayLanBridge.js";

const deviceId = "a0b1c2d3-1234-4abc-9f00-aabbccddeeff";
const read = (path: string) => fs.readFileSync(path, "utf8");
const dir = "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/";
const schema = read(dir + "AndroidUiSchema.java");
const service = read(dir + "ControlledAccessibilityService.java");
const androidServer = read(dir + "LanClientServer.java");
const projection = read(dir + "ScreenProjectionService.java");
const view = read("apps/superagent-tray/ui/lan-screen-viewer.js");
const controller = read("src/core/lanRemote/controller.ts");
const rust = read("apps/superagent-tray/src-tauri/src/main.rs");
const xml = read("apps/superagent-lan-android/app/src/main/res/xml/remote_accessibility.xml");
const html = read("apps/superagent-tray/ui/index.html");

describe("Android UI schema-first protocol and privacy", () => {
  it("requires an authenticated device and bounded numeric delta revision", () => {
    expect(parseTrayLanAction({ action: "schema", deviceId, knownRevision: 0 }).action).toBe("schema");
    expect(parseTrayLanAction({ action: "schema", deviceId, knownRevision: 5 }).args.knownRevision).toBe(5);
    expect(parseTrayLanAction({ action: "schema", deviceId }).action).toBe("schema");
    for (const extra of [
      { knownRevision: -1 }, { knownRevision: 1.2 },
      { knownRevision: "1" }, { knownRevision: 1_000_000_001 },
      { token: "wrong" }, { url: "http://untrusted.test" },
    ]) expect(() => parseTrayLanAction({ action: "schema", deviceId, ...extra })).toThrow();
  });

  it("requires fresh revision and exact semantic element ID for click", () => {
    const valid = { action: "element", deviceId, kind: "click", elementId: "0.1.12", revision: 8 };
    expect(parseTrayLanAction(valid).action).toBe("element");
    for (const extra of [
      { kind: "type" }, { kind: "scroll" }, { elementId: "../0" },
      { elementId: "1.1" }, { elementId: "0.999" },
      { elementId: "0.1;sh" }, { elementId: "0." },
      { elementId: "0.1.1.1.1.1.1.1.1.1.1.1.1.1" },
      { revision: 0 }, { revision: -1 }, { revision: 1.5 },
      { revision: "8" }, { payload: { shell: "rm" } },
    ]) expect(() => parseTrayLanAction({ ...valid, ...extra })).toThrow();
    expect(rust).toContain('"schema" => &["deviceId", "knownRevision"]');
    expect(rust).toContain('"element" => &["deviceId", "elementId", "revision", "kind"]');
    expect(rust).toContain('data["kind"].as_str() != Some("click")');
  });

  it("never captures or sends raw Android UI text values, content descriptions or password fields", () => {
    for (const forbidden of [
      ".getText()", ".getContentDescription()", ".getHintText()",
      ".getTextSelectionStart()", ".getExtras()", ".getViewIdResourceName().toString()",
    ]) expect(schema).not.toContain(forbidden);
    expect(schema).toContain("if (!editable)");
    expect(schema).toContain("!password");
    expect(schema).toContain("safeResourceId");
    expect(schema).toContain('"password"');
    expect(schema).toContain('"otp"');
    expect(schema).toContain('"token"');
    expect(schema).toContain("privateWindow");
    expect(schema).not.toContain('.put("package"');
    expect(service).toContain("Never inspect, log or persist event payloads");
    expect(xml).toContain("typeWindowContentChanged");
    expect(xml).toContain("typeWindowStateChanged");
  });

  it("bounds traversal and sends an unchanged-revision delta rather than a whole tree", () => {
    expect(schema).toContain("MAX_ELEMENTS = 96");
    expect(schema).toContain("MAX_SCAN = 512");
    expect(schema).toContain("MAX_DEPTH = 12");
    expect(schema).toContain('put("changed", false)');
    expect(schema).toContain("knownRevision == revision");
    expect(schema).toContain('MessageDigest.getInstance("SHA-256")');
    expect(service).toContain("lastSchema.response(knownRevision)");
    expect(service).toContain("schemaDirty = true");
    expect(service).toContain("now - service.lastSchema.at > 1200");
    expect(controller).toContain("schema.nodes.length > 96");
    expect(controller).toContain("schema.revision !== knownRevision");
    expect(controller).toContain("getAndroidUiSchema(");
  });

  it("rejects stale element actions after layout changes or local permission revocation", () => {
    expect(service).toContain("requireEnabled()");
    expect(service).toContain("snapshot.revision != revision");
    expect(service).toContain("service.schemaDirty");
    expect(service).toContain("now - snapshot.at > 1500");
    expect(service).toContain("now - service.lastElementActionAt < 250");
    expect(service).toContain("original.equals(actual)");
    expect(service).toContain("node.isPassword()");
    expect(service).toContain("node.isEditable()");
    expect(service).toContain("AccessibilityNodeInfo.ACTION_CLICK");
    expect(androidServer).toContain('if ("schema".equals(op))');
    expect(androidServer).toContain('if ("element".equals(op))');
    expect(androidServer).toContain("ControlledAccessibilityService.clickElement(revision, elementId)");
  });

  it("avoids JPEG encoding unless the user explicitly requests a screenshot", () => {
    expect(projection).toContain("private volatile boolean frameRequested");
    expect(projection).toContain("service.frameRequested = true");
    expect(projection).toContain("|| !frameRequested");
    expect(view).toContain('invoke("schema"');
    expect(view).toContain('invoke("element"');
    expect(view).toContain('invoke("screen"');
    const schemaPoll = view.slice(view.indexOf("async function pollSchema"), view.indexOf("function start()"));
    expect(schemaPoll).not.toContain('invoke("screen"');
    expect(view).toContain('lan-screen-capture');
    expect(html).toContain("Capture one screenshot (fallback)");
    expect(html).toContain('id="lan-schema-list"');
    expect(view).not.toContain("innerHTML");
    expect(view).not.toContain("localStorage.setItem");
    expect(view).not.toContain("MediaRecorder");
    expect(view).not.toContain("fetch(");
  });
});
