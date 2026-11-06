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
    expect(link?.[0]).toContain("Support on Ko-fi");
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
});
