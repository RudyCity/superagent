import { describe, it, expect, beforeEach } from "vitest";
import { generateSessionId, purgeEmptySessions, exportSession, importSession, saveSessionToDb, loadSessionFromDb, deleteSessionFromDb } from "../src/core/config.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("Session Architecture Improvements", () => {
  describe("Unified Session ID Generator", () => {
    it("should generate session IDs starting with sess_ prefix", () => {
      const id1 = generateSessionId();
      const id2 = generateSessionId();

      expect(id1).toMatch(/^sess_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^sess_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe("Purge Empty Sessions", () => {
    it("should purge empty sessions with messageCount = 0", () => {
      const emptySessionId = generateSessionId();
      const mockFilePath = path.join(os.tmpdir(), `${emptySessionId}.json`);

      fs.writeFileSync(mockFilePath, JSON.stringify({ id: emptySessionId }));

      saveSessionToDb(
        {
          id: emptySessionId,
          filePath: mockFilePath,
          displayName: "Empty Draft",
          messageCount: 0,
          lastModified: Date.now() - 1000,
          preview: "",
        },
        []
      );

      const result = purgeEmptySessions(0);
      expect(result.purgedCount).toBeGreaterThanOrEqual(1);

      const loaded = loadSessionFromDb(emptySessionId);
      expect(loaded.session).toBeNull();
    });
  });

  describe("Export and Import Session", () => {
    it("should export session to JSON and Markdown and re-import", () => {
      const testSessionId = generateSessionId();
      const mockFilePath = path.join(os.tmpdir(), `${testSessionId}.json`);

      saveSessionToDb(
        {
          id: testSessionId,
          filePath: mockFilePath,
          displayName: "Export Test Session",
          messageCount: 2,
          lastModified: Date.now(),
          preview: "Hello World",
          workingDirectory: process.cwd(),
        },
        [
          { sessionId: testSessionId, role: "user", content: "Hello", timestamp: Date.now(), sequenceOrder: 0 },
          { sessionId: testSessionId, role: "assistant", content: "Hi there!", timestamp: Date.now() + 10, sequenceOrder: 1 },
        ]
      );

      const mdExport = exportSession(testSessionId, "markdown");
      expect(mdExport).toContain("Session Export:");
      expect(mdExport).toContain("Hello");
      expect(mdExport).toContain("Hi there!");

      const jsonExport = exportSession(testSessionId, "json");
      expect(jsonExport).toContain(testSessionId);

      const exportFile = path.join(os.tmpdir(), `export_${testSessionId}.json`);
      fs.writeFileSync(exportFile, jsonExport!);

      // Delete before import
      deleteSessionFromDb(testSessionId);
      expect(loadSessionFromDb(testSessionId).session).toBeNull();

      const importResult = importSession(exportFile);
      expect(importResult.success).toBe(true);
      expect(importResult.id).toBe(testSessionId);

      const reloaded = loadSessionFromDb(testSessionId);
      expect(reloaded.session).not.toBeNull();
      expect(reloaded.messages.length).toBe(2);

      // Clean up
      try { fs.unlinkSync(exportFile); } catch {}
      try { fs.unlinkSync(mockFilePath); } catch {}
      deleteSessionFromDb(testSessionId);
    });
  });
});
