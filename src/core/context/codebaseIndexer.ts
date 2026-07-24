import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { getSettings } from "../config/jsonConfig.js";

export interface CodeChunk {
  id: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  content: string;
  fileHash: string;
}

export interface CodeSearchResult {
  relativePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".cache",
  "vendor",
  "target",
  ".idea",
  ".vscode",
  ".gemini",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".ttf", ".woff", ".woff2", ".eot",
  ".lock", "-lock.json", ".sqlite", ".db",
]);

const MAX_FILE_SIZE_BYTES = 500 * 1024; // 500 KB limit per file

function getWorkspaceHash(workspacePath: string): string {
  const norm = path.resolve(workspacePath).toLowerCase();
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

function getWorkspaceIndexDir(workspacePath: string): string {
  const hash = getWorkspaceHash(workspacePath);
  return path.join(os.homedir(), ".superagent-r", "codebase-index", hash);
}

function isBinaryOrIgnoredFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (filePath.endsWith("package-lock.json") || filePath.endsWith("bun.lockb") || filePath.endsWith("yarn.lock")) {
    return true;
  }
  return false;
}

function readGitIgnoreRules(workspacePath: string): string[] {
  const gitignorePath = path.join(workspacePath, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return [];
  try {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    return content
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function shouldIgnorePath(relPath: string, gitignoreRules: string[]): boolean {
  const parts = relPath.split(path.sep);
  for (const part of parts) {
    if (IGNORED_DIRS.has(part)) return true;
  }
  for (const rule of gitignoreRules) {
    const cleanRule = rule.replace(/^\//, "").replace(/\/$/, "");
    if (cleanRule && (relPath === cleanRule || relPath.startsWith(cleanRule + path.sep))) {
      return true;
    }
  }
  return false;
}

function collectCodeFiles(workspacePath: string): string[] {
  const gitignoreRules = readGitIgnoreRules(workspacePath);
  const results: string[] = [];

  function walk(currentDir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(workspacePath, fullPath);

      if (shouldIgnorePath(relPath, gitignoreRules)) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (isBinaryOrIgnoredFile(fullPath)) continue;
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size <= MAX_FILE_SIZE_BYTES) {
            results.push(relPath);
          }
        } catch {}
      }
    }
  }

  walk(workspacePath);
  return results;
}

/**
 * Structural + Line-based chunking of source files
 */
export function chunkFileContent(relativePath: string, content: string, fileHash: string): CodeChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const chunks: CodeChunk[] = [];
  const CHUNK_SIZE = 80;
  const OVERLAP = 20;

  // Structural boundary detection (functions, classes, exports, interfaces)
  const isStructuralLanguage = /\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|cs)$/i.test(relativePath);

  if (isStructuralLanguage && lines.length > CHUNK_SIZE) {
    let currentChunkLines: string[] = [];
    let startLine = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      currentChunkLines.push(line);

      const isBlockEnd = /^(export\s+)?(function|class|const|interface|type|async\s+function|def|func|pub\s+fn)/.test(line.trim()) && currentChunkLines.length >= 30;
      const isSizeLimit = currentChunkLines.length >= CHUNK_SIZE;

      if (isBlockEnd || isSizeLimit || i === lines.length - 1) {
        const endLine = startLine + currentChunkLines.length - 1;
        const chunkContent = currentChunkLines.join("\n");
        const chunkId = `code-${getWorkspaceHash(relativePath)}-${startLine}-${endLine}`;

        chunks.push({
          id: chunkId,
          relativePath,
          startLine,
          endLine,
          content: `[File: ${relativePath} (lines ${startLine}-${endLine})]\n${chunkContent}`,
          fileHash,
        });

        // Retain overlap for continuity
        const overlapCount = Math.min(OVERLAP, currentChunkLines.length);
        currentChunkLines = currentChunkLines.slice(currentChunkLines.length - overlapCount);
        startLine = endLine - overlapCount + 1;
      }
    }
  } else {
    // Standard line chunking
    for (let i = 0; i < lines.length; i += (CHUNK_SIZE - OVERLAP)) {
      const chunkLines = lines.slice(i, i + CHUNK_SIZE);
      if (chunkLines.length === 0) break;

      const startLine = i + 1;
      const endLine = i + chunkLines.length;
      const chunkContent = chunkLines.join("\n");
      const chunkId = `code-${getWorkspaceHash(relativePath)}-${startLine}-${endLine}`;

      chunks.push({
        id: chunkId,
        relativePath,
        startLine,
        endLine,
        content: `[File: ${relativePath} (lines ${startLine}-${endLine})]\n${chunkContent}`,
        fileHash,
      });

      if (i + CHUNK_SIZE >= lines.length) break;
    }
  }

  return chunks;
}

export class CodebaseIndexer {
  private static rMemoryInstances: Map<string, any> = new Map();
  private static indexingInProgress: Set<string> = new Set();

  private static async getIndexDb(workspacePath: string): Promise<any> {
    const indexDir = getWorkspaceIndexDir(workspacePath);
    if (this.rMemoryInstances.has(indexDir)) {
      return this.rMemoryInstances.get(indexDir);
    }

    if (!fs.existsSync(indexDir)) {
      fs.mkdirSync(indexDir, { recursive: true });
    }

    const dbPath = path.join(indexDir, "codebase.db");
    const { RMemory } = await import("r-memory");
    const { OptimizedLocalTextEmbeddingProvider } = await import("../rmemoryUtil.js");

    const provider = new OptimizedLocalTextEmbeddingProvider({
      modelName: "nomic-ai/nomic-embed-text-v1.5",
      dtype: "q8",
      device: "cpu",
    });

    const instance = new RMemory({
      dbPath,
      collectionName: "codebase",
      embeddingProvider: provider,
    });

    this.rMemoryInstances.set(indexDir, instance);
    return instance;
  }

  private static getHashesPath(workspacePath: string): string {
    return path.join(getWorkspaceIndexDir(workspacePath), "file_hashes.json");
  }

  private static readHashes(workspacePath: string): Record<string, string> {
    const hashFile = this.getHashesPath(workspacePath);
    if (!fs.existsSync(hashFile)) return {};
    try {
      return JSON.parse(fs.readFileSync(hashFile, "utf-8"));
    } catch {
      return {};
    }
  }

  private static saveHashes(workspacePath: string, hashes: Record<string, string>): void {
    const hashFile = this.getHashesPath(workspacePath);
    try {
      fs.writeFileSync(hashFile, JSON.stringify(hashes, null, 2), "utf-8");
    } catch {}
  }

  /**
   * Scans and indexes workspace code files into SQLite vector store incrementally.
   */
  public static async indexWorkspace(
    workspacePath: string,
    force = false
  ): Promise<{ indexedFiles: number; totalChunks: number }> {
    const normWorkspace = path.resolve(workspacePath);
    if (this.indexingInProgress.has(normWorkspace)) {
      return { indexedFiles: 0, totalChunks: 0 };
    }

    this.indexingInProgress.add(normWorkspace);
    let indexedFilesCount = 0;
    let totalChunksCount = 0;

    try {
      const db = await this.getIndexDb(normWorkspace);
      const filePaths = collectCodeFiles(normWorkspace);
      const storedHashes = force ? {} : this.readHashes(normWorkspace);
      const updatedHashes: Record<string, string> = { ...storedHashes };

      const currentFilesSet = new Set(filePaths);

      // Handle deleted files
      for (const oldFile of Object.keys(storedHashes)) {
        if (!currentFilesSet.has(oldFile)) {
          delete updatedHashes[oldFile];
          try {
            // @ts-ignore
            const allMemories = db.db.getAll();
            const stale = allMemories.filter((m: any) => m.metadata?.relativePath === oldFile);
            for (const item of stale) {
              db.delete(item.id);
            }
          } catch {}
        }
      }

      // Collect files needing index update
      const filesToProcess: Array<{ relPath: string; fullPath: string; hash: string }> = [];

      for (const relPath of filePaths) {
        const fullPath = path.join(normWorkspace, relPath);
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const hash = crypto.createHash("sha256").update(content).digest("hex");

          if (storedHashes[relPath] !== hash) {
            filesToProcess.push({ relPath, fullPath, hash });
          }
        } catch {}
      }

      if (filesToProcess.length === 0) {
        this.indexingInProgress.delete(normWorkspace);
        return { indexedFiles: 0, totalChunks: 0 };
      }

      // Process in batches
      const BATCH_SIZE = 8;
      for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
        const batch = filesToProcess.slice(i, i + BATCH_SIZE);
        const batchChunks: CodeChunk[] = [];

        for (const item of batch) {
          try {
            const content = fs.readFileSync(item.fullPath, "utf-8");
            const chunks = chunkFileContent(item.relPath, content, item.hash);
            batchChunks.push(...chunks);
            updatedHashes[item.relPath] = item.hash;
            indexedFilesCount++;
          } catch {}
        }

        if (batchChunks.length > 0) {
          const texts = batchChunks.map(c => c.content);
          let embeddings: number[][];
          if (db.provider && typeof db.provider.embedTexts === "function") {
            embeddings = await db.provider.embedTexts(texts, "passage");
          } else {
            embeddings = await Promise.all(texts.map(t => db.provider.embedText(t, "passage")));
          }

          for (let j = 0; j < batchChunks.length; j++) {
            const chunk = batchChunks[j];
            await db.addMemory({
              id: chunk.id,
              content: chunk.content,
              embedding: embeddings[j],
              metadata: {
                relativePath: chunk.relativePath,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                fileHash: chunk.fileHash,
              },
            });
            totalChunksCount++;
          }
        }

        // Optimize: call global.gc() if exposed, to actively clean up heap after each batch
        if (typeof global !== "undefined" && (global as any).gc) {
          try {
            (global as any).gc();
          } catch {}
        }
      }

      this.saveHashes(normWorkspace, updatedHashes);
      if (typeof global !== "undefined" && (global as any).gc) {
        try {
          (global as any).gc();
        } catch {}
      }
    } catch (err) {
      // Gracefully handle indexing error without throwing
    } finally {
      this.indexingInProgress.delete(normWorkspace);
    }

    return { indexedFiles: indexedFilesCount, totalChunks: totalChunksCount };
  }

  /**
   * Search indexed codebase using semantic similarity
   */
  public static async searchCodebase(
    workspacePath: string,
    query: string,
    limit = 5
  ): Promise<CodeSearchResult[]> {
    const normWorkspace = path.resolve(workspacePath);
    try {
      const db = await this.getIndexDb(normWorkspace);
      const results = await db.query({
        query,
        limit,
        hybrid: true,
      });

      if (!results || results.length === 0) return [];

      return results.map((r: any) => ({
        relativePath: r.memory?.metadata?.relativePath || "unknown",
        startLine: r.memory?.metadata?.startLine || 1,
        endLine: r.memory?.metadata?.endLine || 1,
        content: r.memory?.content || "",
        score: r.score ?? (1.0 - (r.distance || 0)),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Clears codebase vector cache for the given workspace
   */
  public static async clearIndex(workspacePath: string): Promise<void> {
    const normWorkspace = path.resolve(workspacePath);
    const watcher = this.activeWatchers.get(normWorkspace);
    if (watcher) {
      try {
        watcher.close();
      } catch {}
      this.activeWatchers.delete(normWorkspace);
    }

    const indexDir = getWorkspaceIndexDir(normWorkspace);
    const instance = this.rMemoryInstances.get(indexDir);
    if (instance) {
      try {
        if (typeof instance.close === "function") {
          instance.close();
        }
      } catch {}
      this.rMemoryInstances.delete(indexDir);
    }

    if (fs.existsSync(indexDir)) {
      try {
        fs.rmSync(indexDir, { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * Get indexing status & stats for workspace
   */
  public static async getStatus(workspacePath: string): Promise<{ indexedFiles: number; totalChunks: number; indexDir: string }> {
    const normWorkspace = path.resolve(workspacePath);
    const indexDir = getWorkspaceIndexDir(normWorkspace);
    const storedHashes = this.readHashes(normWorkspace);
    const indexedFiles = Object.keys(storedHashes).length;
    let totalChunks = 0;
    try {
      const db = await this.getIndexDb(normWorkspace);
      // @ts-ignore
      const all = db.db.getAll();
      totalChunks = all.length;
    } catch {}
    return { indexedFiles, totalChunks, indexDir };
  }

  private static activeWatchers: Map<string, fs.FSWatcher> = new Map();

  /**
   * Auto background indexing trigger + live debounced file watcher
   */
  public static initAutoIndexing(workspacePath: string): void {
    const normWorkspace = path.resolve(workspacePath);

    if (!this.activeWatchers.has(normWorkspace)) {
      setTimeout(() => {
        CodebaseIndexer.indexWorkspace(normWorkspace).catch(() => {});
      }, 1000);

      try {
        let timer: NodeJS.Timeout | null = null;
        const watcher = fs.watch(normWorkspace, { recursive: true }, (eventType, filename) => {
          if (!filename || isBinaryOrIgnoredFile(filename)) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            CodebaseIndexer.indexWorkspace(normWorkspace).catch(() => {});
          }, 2000);
        });
        this.activeWatchers.set(normWorkspace, watcher);
      } catch {}
    }
  }

  /**
   * Closes all active watchers and DB connections across all workspaces.
   */
  public static shutdown(): void {
    for (const watcher of this.activeWatchers.values()) {
      try {
        watcher.close();
      } catch {}
    }
    this.activeWatchers.clear();

    for (const instance of this.rMemoryInstances.values()) {
      try {
        if (typeof instance.close === "function") {
          instance.close();
        }
      } catch {}
    }
    this.rMemoryInstances.clear();
  }
}
