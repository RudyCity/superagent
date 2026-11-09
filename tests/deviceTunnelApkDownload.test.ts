import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  androidApkPath,
  createAndroidApkDownloadTicket,
  getAndroidApkDownloadTicket,
  getAndroidApkDownloadTicketStatus,
  resetAndroidApkDownloadTicketsForTests,
} from "../src/core/deviceTunnel/apkDownload.js";

afterEach(() => {
  vi.useRealTimers();
  resetAndroidApkDownloadTicketsForTests();
});

describe("Android APK QR download ticket", () => {
  it("pins the ticket to the built Android APK and exposes verified metadata only", () => {
    const expected = path.resolve(
      "apps/superagent-lan-android/app/build/outputs/apk/debug/app-debug.apk",
    );
    expect(path.resolve(androidApkPath())).toBe(expected);

    const bytes = fs.readFileSync(expected);
    const expectedSha = crypto.createHash("sha256").update(bytes).digest("hex");
    const ticket = createAndroidApkDownloadTicket();

    expect(ticket.token).toMatch(/^[a-f0-9]{64}$/);
    expect(ticket.expiresAt).toBeGreaterThan(Date.now());
    expect(ticket.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 1000);
    expect(ticket.size).toBe(bytes.length);
    expect(ticket.sha256).toBe(expectedSha);
    expect(ticket.filename).toBe("SuperAgent-Android-0.9.1-qr-scan-fix.apk");

    for (let i = 0; i < 12; i++) {
      const resolved = getAndroidApkDownloadTicket(ticket.token);
      expect(path.resolve(resolved.filePath)).toBe(expected);
    }
    expect(getAndroidApkDownloadTicketStatus(ticket.token)).toMatchObject({ valid: true, expiresAt: ticket.expiresAt });
  });

  it("stays valid for the full ten-minute TTL regardless of repeated reads", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
    const ticket = createAndroidApkDownloadTicket();
    for (let i = 0; i < 25; i++) getAndroidApkDownloadTicket(ticket.token);
    vi.advanceTimersByTime(9 * 60_000 + 59_000);
    expect(getAndroidApkDownloadTicketStatus(ticket.token).valid).toBe(true);
    expect(() => getAndroidApkDownloadTicket(ticket.token)).not.toThrow();
    vi.advanceTimersByTime(1_001);
    expect(getAndroidApkDownloadTicketStatus(ticket.token).valid).toBe(false);
    expect(() => getAndroidApkDownloadTicket(ticket.token)).toThrow(/expired|unknown/i);
  });

  it("rejects malformed or unknown tickets", () => {
    expect(() => getAndroidApkDownloadTicket("../app-debug.apk")).toThrow(/invalid/i);
    expect(() => getAndroidApkDownloadTicket("a".repeat(64))).toThrow(/expired|unknown/i);
  });
});
