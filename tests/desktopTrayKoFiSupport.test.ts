import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("SuperAgent optional community support", () => {
  it("shows an accessible, safe Ko-fi link in the Tray sidebar", () => {
    const html = readFileSync("apps/superagent-tray/ui/index.html", "utf8");
    const link = html.match(/<a\b[^>]*id="tray-support-link"[^>]*>[\s\S]*?<\/a>/);

    expect(link).not.toBeNull();
    expect(link?.[0]).toContain('href="https://ko-fi.com/rudycity"');
    expect(link?.[0]).toContain('target="_blank"');
    expect(link?.[0]).toMatch(/rel="(?=[^"]*noopener)(?=[^"]*noreferrer)[^"]+"/);
    expect(link?.[0]).toMatch(/aria-label="Support SuperAgent development on Ko-fi/);
    // The sidebar chip shows the short brand label; the full sentence lives in
    // the aria-label so screen readers keep the descriptive name.
    expect(link?.[0]).toMatch(/>\s*Ko-fi\s*</);
  });

  it("keeps funding optional and matches the GitHub sponsor setting", () => {
    const funding = readFileSync(".github/FUNDING.yml", "utf8");
    const readme = readFileSync("README.md", "utf8");
    const styles = readFileSync("apps/superagent-tray/ui/styles.css", "utf8");

    expect(funding).toMatch(/^ko_fi: rudycity\s*$/m);
    expect(readme).toContain("https://ko-fi.com/rudycity");
    expect(readme).toMatch(/Donations are completely optional/);
    expect(styles).toContain(".support-link:focus-visible");
  });

  it("provides a dedicated Ko-fi support modal dialog with copy and open actions", () => {
    const html = readFileSync("apps/superagent-tray/ui/index.html", "utf8");
    const appJs = readFileSync("apps/superagent-tray/ui/app.js", "utf8");
    const styles = readFileSync("apps/superagent-tray/ui/styles.css", "utf8");

    // Modal structure in index.html
    expect(html).toContain('id="support-modal-dialog"');
    expect(html).toContain('id="support-modal-close"');
    expect(html).toContain('id="support-modal-url"');
    expect(html).toContain('id="support-modal-copy-btn"');
    expect(html).toContain('id="support-modal-open-btn"');
    expect(html).toContain('id="support-modal-done-btn"');
    expect(html).toContain("https://ko-fi.com/rudycity");

    // Styling present in styles.css
    expect(styles).toContain(".support-modal");
    expect(styles).toContain(".support-modal-hero");
    expect(styles).toContain(".support-modal-url-input");

    // Logic wired in app.js
    expect(appJs).toContain("support-modal-dialog");
    expect(appJs).toContain("open_external_url");
    expect(appJs).toContain("openSupportModal");
  });
});
