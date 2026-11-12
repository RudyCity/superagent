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
    const metadata = JSON.parse(fs.readFileSync(
      path.resolve("apps/superagent-lan-android/app/build/outputs/apk/debug/output-metadata.json"),
      "utf8",
    )) as { applicationId: string; variantName: string; elements: { versionCode: number; versionName: string }[] };
    expect(metadata.applicationId).toBe("click.superagent.lanclient");
    expect(metadata.variantName).toBe("debug");
    expect(metadata.elements[0].versionCode).toBeGreaterThan(0);
    expect(ticket.filename).toBe(`SuperAgent-Android-${metadata.elements[0].versionName}.apk`);
    expect(ticket.filename).not.toContain("0.9.1-qr-scan-fix");

    for (let i = 0; i < 12; i++) {
      const resolved = getAndroidApkDownloadTicket(ticket.token);
      expect(path.resolve(resolved.filePath)).toBe(expected);
    }
    expect(getAndroidApkDownloadTicketStatus(ticket.token)).toMatchObject({ valid: true, expiresAt: ticket.expiresAt });
  });

  it("refuses same-size APK changes rather than serving an outdated checksum", () => {
    const ticket = createAndroidApkDownloadTicket();
    const originalRead = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const bytes = (originalRead as (...parameters: unknown[]) => Buffer | string)(file, ...args);
      if (path.resolve(String(file)) !== path.resolve(androidApkPath()) || !Buffer.isBuffer(bytes))
        return bytes;
      const changed = Buffer.from(bytes);
      changed[0] ^= 0xff;
      return changed;
    }) as typeof fs.readFileSync);
    try {
      expect(() => getAndroidApkDownloadTicket(ticket.token)).toThrow(/APK artifact changed after ticket creation/);
    } finally {
      spy.mockRestore();
    }
  });

  it("marks a same-size APK rebuild stale during heartbeat and invalidates its ticket", () => {
    const ticket = createAndroidApkDownloadTicket();
    const originalRead = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const data = (originalRead as (...parameters: unknown[]) => Buffer | string)(file, ...args);
      if (path.resolve(String(file)) !== path.resolve(androidApkPath()) || !Buffer.isBuffer(data))
        return data;
      const modified = Buffer.from(data);
      modified[0] ^= 0xff; // changed bytes, identical APK size
      return modified;
    }) as typeof fs.readFileSync);
    try {
      expect(getAndroidApkDownloadTicketStatus(ticket.token)).toMatchObject({
        valid: false, reason: "artifact_changed",
      });
      expect(() => getAndroidApkDownloadTicket(ticket.token)).toThrow(/expired|unknown/i);
    } finally {
      spy.mockRestore();
    }
  });

  it("also invalidates a QR when only its Gradle version metadata changes", () => {
    const ticket = createAndroidApkDownloadTicket();
    const originalRead = fs.readFileSync.bind(fs);
    const metadataPath = path.resolve("apps/superagent-lan-android/app/build/outputs/apk/debug/output-metadata.json");
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const data = (originalRead as (...parameters: unknown[]) => Buffer | string)(file, ...args);
      if (path.resolve(String(file)) !== metadataPath || typeof data !== "string") return data;
      const metadata = JSON.parse(data) as { elements: { versionName: string }[] };
      metadata.elements[0].versionName = "0.99.99-rebuilt";
      return JSON.stringify(metadata);
    }) as typeof fs.readFileSync);
    try {
      expect(getAndroidApkDownloadTicketStatus(ticket.token)).toMatchObject({
        valid: false, reason: "artifact_changed",
      });
    } finally {
      spy.mockRestore();
    }
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
