import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = "chrome-extension-delegate/";

describe("Delegate popup version follows the active installed manifest", () => {
  const html = readFileSync(root + "popup.html", "utf8");
  const js = readFileSync(root + "popup.js", "utf8");
  const manifest = JSON.parse(readFileSync(root + "manifest.json", "utf8"));

  it("does not hardcode a possibly stale version in popup markup", () => {
    expect(html).toContain('id="extension-version"');
    expect(html).not.toMatch(/class="version"[^>]*>v\d+\.\d+\.\d+/);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(js).toContain("renderExtensionVersion();");
  });

  it("renders exactly the version reported by Chrome in this profile", () => {
    const functionBody = js.match(/function renderExtensionVersion\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(functionBody).toBeDefined();
    const element = { textContent: "" };
    const chrome = {
      runtime: {
        getManifest: () => ({ version: "1.9.3" }),
      },
    };
    const context = { chrome, document: { getElementById: (id: string) => {
      expect(id).toBe("extension-version");
      return element;
    } } };
    vm.runInNewContext("const $ = (id) => document.getElementById(id);\n" +
      functionBody + "\nrenderExtensionVersion();", context);
    expect(element.textContent).toBe("v1.9.3");
    chrome.runtime.getManifest = () => ({ version: "2.0.1" });
    vm.runInNewContext(functionBody + "\nrenderExtensionVersion();", {
      ...context,
      $: (id: string) => context.document.getElementById(id),
    });
    expect(element.textContent).toBe("v2.0.1");
  });
});
