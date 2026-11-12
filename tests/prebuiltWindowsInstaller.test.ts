import { describe, expect, it } from "vitest";
import { checksumForFilename, selectInstaller, validateAssetUrl, type ReleaseInfo } from "../scripts/install-prebuilt-windows";

const sha = "a".repeat(64);
const name = "SuperAgent_1.14.64_x64-setup.exe";
const release: ReleaseInfo = {
  tag_name: "v1.14.64-rc.1",
  draft: false,
  assets: [
    { name, size: 250_000_000, browser_download_url: "https://github.com/RudyCity/superagent/releases/download/v1.14.64-rc.1/" + name },
    { name: "SHA256SUMS.txt", size: 100, browser_download_url: "https://github.com/RudyCity/superagent/releases/download/v1.14.64-rc.1/SHA256SUMS.txt" },
  ],
};

describe("Windows prebuilt Tray installer contract", () => {
  it("selects the published Windows setup with checksum, ignoring drafts and empty releases", () => {
    const draft: ReleaseInfo = { ...release, draft: true };
    expect(selectInstaller([draft, { tag_name: "v1.2.615", draft: false, assets: [] }, release]).version).toBe("1.14.64");
  });
  it("does not accept unchecksummed, undersized, or unrelated Windows binaries", () => {
    expect(() => selectInstaller([{ ...release, assets: release.assets?.slice(0, 1) }])).toThrow();
    expect(() => selectInstaller([{ ...release, assets: [{ ...release.assets![0], size: 1 }, release.assets![1]] }])).toThrow();
    expect(() => selectInstaller([{ ...release, tag_name: "v1.14.64", assets: release.assets }])).toThrow();
  });
  it("rejects release-tag injection and picks only an explicitly selected release", () => {
    expect(() => selectInstaller([release], "v1.14.64-rc.1?x=1")).toThrow();
    expect(() => selectInstaller([release], "v1.14.65-rc.1")).toThrow();
    expect(selectInstaller([release], "v1.14.64-rc.1").installer.name).toBe(name);
  });
  it("requires the exact GitHub repository and release path for the asset", () => {
    const candidate = selectInstaller([release]);
    expect(validateAssetUrl(candidate, candidate.installer)).toContain(name);
    expect(() => validateAssetUrl(candidate, { ...candidate.installer, browser_download_url: "https://github.com.evil.example/RudyCity/superagent/releases/download/v1.14.64-rc.1/" + name })).toThrow();
    expect(() => validateAssetUrl(candidate, { ...candidate.installer, browser_download_url: "https://github.com/Other/repo/releases/download/v1.14.64-rc.1/" + name })).toThrow();
    expect(() => validateAssetUrl(candidate, { ...candidate.installer, browser_download_url: candidate.installer.browser_download_url + "?untrusted=1" })).toThrow();
  });
  it("parses the exact SHA-256SUMS entry including CRLF and GNU binary marker", () => {
    expect(checksumForFilename(sha + " *" + name + "\r\n", name)).toBe(sha);
    expect(checksumForFilename(sha.toUpperCase() + "  " + name + "\n", name)).toBe(sha);
  });
  it("fails closed on missing or duplicate checksum entries", () => {
    expect(() => checksumForFilename(sha + "  other.exe", name)).toThrow();
    expect(() => checksumForFilename(sha + "  " + name + "\n" + sha + "  " + name, name)).toThrow();
  });
});
