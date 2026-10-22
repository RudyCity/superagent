import { getSettings } from "./config/jsonConfig.js";
import { getConfiguredProviders } from "./config/providers.js";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { getNormalizedProjectPath } from "./tools/helpers.js";
import { createMemoryRecordMetadata, isMemoryRecordMetadata } from "./memoryRecord.js";
import { fuseScopedMemoryHits } from "./memoryRetrieval.js";
import { redactMemorySecrets } from "./memoryLifecycle.js";
import { recordMemorySearchPerformance, recordMemoryIngestion } from "./memoryTelemetry.js";

const globalDataDir = path.join(os.homedir(), ".superagent-r", "rmemory");

export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
// Sharing the in-flight model load prevents duplicate ~100 MB ONNX instances.
const sharedEmbeddingExtractors = new Map<string, Promise<any>>();
const MAX_SHARED_EMBEDDING_MODELS = 2;
// Only vector arrays are cached (query/source text is represented by SHA-256).
// Bounded LRU so long-running CLIs cannot accumulate unlimited embeddings.
const embeddingVectorCache = new Map<string, number[]>();
const MAX_EMBEDDING_VECTOR_CACHE = 512;
function rememberEmbeddingVector(key: string, vector: number[]): void {
  if (embeddingVectorCache.has(key)) embeddingVectorCache.delete(key);
  embeddingVectorCache.set(key, vector.slice());
  if (embeddingVectorCache.size > MAX_EMBEDDING_VECTOR_CACHE) {
    const oldest = embeddingVectorCache.keys().next().value;
    if (oldest) embeddingVectorCache.delete(oldest);
  }
}
function getCachedEmbeddingVector(key: string): number[] | undefined {
  const vector = embeddingVectorCache.get(key);
  if (!vector) return undefined;
  embeddingVectorCache.delete(key);
  embeddingVectorCache.set(key, vector);
  return vector.slice();
}


export type RMemoryMigrationStatus = "not_checked" | "current" | "migrated" | "failed";

export function checkLocalModelDownloadStatus(modelRepoName: string, isMemoryLoaded: boolean = false): string {
  if (isMemoryLoaded) {
    return "LOADED (In Memory)";
  }

  // Handle Senopati System-1 ONNX model (pre-installed natively in repository)
  if (modelRepoName.includes("Supra-Router") || modelRepoName.includes("Senopati") || modelRepoName.includes("classifier")) {
    const localSenopati = path.resolve(process.cwd(), "models", "senopati", "senopati_superagent.onnx");
    const absSenopati = "D:\\backup from pc asus\\Documents Development\\superagent\\models\\senopati\\senopati_superagent.onnx";
    if (fs.existsSync(localSenopati) || fs.existsSync(absSenopati)) {
      return "READY (Native Senopati ONNX)";
    }
  }

  const cacheBase = process.env.TRANSFORMERS_CACHE || path.join(os.homedir(), ".cache", "huggingface", "hub");
  const folderName = `models--${modelRepoName.replace(/\//g, "--")}`;
  const path1 = path.join(cacheBase, folderName);
  const path2 = path.join(os.homedir(), ".cache", "huggingface", "hub", folderName);
  const path3 = path.join(os.homedir(), ".cache", "transformers", modelRepoName);

  const exists = (p: string) => {
    try {
      return fs.existsSync(p) && fs.readdirSync(p).length > 0;
    } catch {
      return false;
    }
  };

  if (exists(path1) || exists(path2) || exists(path3)) {
    return "DOWNLOADED (Cached on Disk)";
  }

  return "NOT DOWNLOADED (Pending Auto-Download)";
}

export function resetRMemoryInstance() {
  try {
    if (rMemoryInstance && typeof rMemoryInstance.close === "function") rMemoryInstance.close();
    else if (rMemoryInstance?.db && typeof rMemoryInstance.db.close === "function") rMemoryInstance.db.close();
  } catch {}
  try {
    if (skillsIndexInstance && typeof skillsIndexInstance.close === "function") skillsIndexInstance.close();
    else if (skillsIndexInstance?.db && typeof skillsIndexInstance.db.close === "function") skillsIndexInstance.db.close();
  } catch {}
  rMemoryInstance = null;
  cachedRMemoryModelName = "";
  cachedRMemoryDimensions = 0;
  rMemoryInitFailed = false;
  rMemoryInitError = null;
  hasLoggedInitError = false;
  rMemoryMigrationStatus = "not_checked";
  rMemoryLastSafeError = null;
  skillsIndexInstance = null;
  skillsIndexHash = "";
}

export function getActiveRMemoryEmbeddingInfo(): { provider: "local" | "openai"; modelName: string; dimensions: number } {
  const settings = getSettings();
  const providerType = (settings.rmemoryEmbeddingProvider || "local") as "local" | "openai";
  if (providerType === "openai") {
    const rawModel = settings.rmemoryEmbeddingModel;
    const modelName = (!rawModel || rawModel.includes("Xenova") || rawModel === DEFAULT_LOCAL_EMBEDDING_MODEL) ? "text-embedding-3-small" : rawModel;
    return {
      provider: "openai",
      modelName,
      dimensions: settings.rmemoryEmbeddingDimensions || 1536,
    };
  }
  const rawModel = settings.rmemoryEmbeddingModel;
  const modelName = (!rawModel || rawModel.startsWith("text-embedding-")) ? DEFAULT_LOCAL_EMBEDDING_MODEL : rawModel;
  const provider = new OptimizedLocalTextEmbeddingProvider({ modelName });
  return {
    provider: "local",
    modelName,
    dimensions: provider.dimensions,
  };
}

export async function preloadLocalEmbeddingModel(): Promise<void> {
  const info = getActiveRMemoryEmbeddingInfo();
  if (info.provider !== "local") return;
  const provider = new OptimizedLocalTextEmbeddingProvider({ modelName: info.modelName });
  await provider.embedText("Initialization preload test");
}

export class OptimizedLocalTextEmbeddingProvider {
  get dimensions(): number {
    return this.modelName.includes("nomic") ? 768 : 384;
  }
  private modelName: string;
  private device: string;
  private dtype: string;
  private extractor: any = null;

  constructor(options: { modelName?: string; device?: string; dtype?: string } = {}) {
    let name = options.modelName || DEFAULT_LOCAL_EMBEDDING_MODEL;
    if (name === "Xenova/nomic-embed-text-v1.5") {
      name = "nomic-ai/nomic-embed-text-v1.5";
    }
    this.modelName = name;
    this.device = options.device || "cpu";
    this.dtype = options.dtype || "q8";
  }

  private formatText(text: string, type?: "query" | "passage"): string {
    if (!this.modelName.includes("nomic")) {
      return text;
    }
    const prefix = type === "query" ? "search_query: " : "search_document: ";
    if (text.startsWith("search_query:") || text.startsWith("search_document:")) {
      return text;
    }
    return prefix + text;
  }

  private async initializeExtractor() {
    if (!this.extractor) {
      try {
        const { pipeline, env } = await import("@huggingface/transformers");
        if (env?.backends?.onnx) {
          (env.backends.onnx as any).logLevel = 'error';
        }
        if (env) {
          (env as any).logLevel = 'error';
        }
        const isMocked = (pipeline as any).mock || (pipeline as any)._isMockFunction || typeof (pipeline as any).mockImplementation === "function";
        if (process.env.NODE_ENV === "test" && !isMocked) {
          this.extractor = async () => {
            return {
              data: new Float32Array(this.dimensions).fill(0.1),
            };
          };
          return this.extractor;
        }
        let onProgress: ((event: any) => void) | undefined = undefined;
        try {
          const { getProgressCallback } = await import("./tools/state.js");
          const cb = getProgressCallback();
          if (cb) onProgress = cb;
        } catch {}
        let downloadStarted = false;
        this.extractor = await pipeline("feature-extraction", this.modelName, {
          device: this.device as any,
          dtype: this.dtype as any,
          session_options: {
            intraOpNumThreads: 2,
            interOpNumThreads: 1,
            logSeverityLevel: 3,
          } as any,
          progress_callback: (data: any) => {
            if (data.status === "downloading" && !downloadStarted) {
              downloadStarted = true;
              if (onProgress) {
                onProgress({
                  type: "model_download",
                  modelName: "embedding",
                  status: "downloading"
                });
              } else {
                console.log(`\n[INFO] Downloading local embedding model (~100MB) to cache...`);
              }
            }
            if (data.status === "progress" && downloadStarted) {
               const pct = typeof data.progress === "number" ? data.progress : 0;
               if (onProgress) {
                 onProgress({
                   type: "model_download",
                   modelName: "embedding",
                   status: "progress",
                   progress: pct,
                   loaded: typeof data.loaded === "number" ? data.loaded : undefined,
                   total: typeof data.total === "number" ? data.total : undefined
                 });
               } else {
                const pctStr = typeof data.progress === "number" ? data.progress.toFixed(1) : "0.0";
                process.stdout.write(`\r[INFO] Downloading embedding model: ${pctStr}%`);
              }
            }
          }
        });
        if (downloadStarted) {
          if (onProgress) {
            onProgress({
              type: "model_download",
              modelName: "embedding",
              status: "loaded"
            });
          } else {
            console.log(`\n[INFO] Embedding model loaded successfully.`);
          }
        }
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error("Failed to initialize embedding model \"" + this.modelName + "\": " + detail, { cause: err });
      }
    }
    return this.extractor;
  }

  private embeddingCacheKey(text: string): string {
    return createHash("sha256").update([this.modelName, this.dtype, this.device, text].join(" ")).digest("hex");
  }

  private async getExtractor(): Promise<any> {
    if (this.extractor) return this.extractor;
    // Tests use independent mocked pipelines and must not leak model state.
    if (process.env.NODE_ENV === "test") return this.initializeExtractor();
    const key = [this.modelName, this.dtype, this.device].join(":");
    let current = sharedEmbeddingExtractors.get(key);
    if (!current) {
      current = this.initializeExtractor().catch(error => {
        if (sharedEmbeddingExtractors.get(key) === current) sharedEmbeddingExtractors.delete(key);
        throw error;
      });
      sharedEmbeddingExtractors.set(key, current);
      if (sharedEmbeddingExtractors.size > MAX_SHARED_EMBEDDING_MODELS) {
        const oldest = sharedEmbeddingExtractors.keys().next().value;
        if (oldest && oldest !== key) sharedEmbeddingExtractors.delete(oldest);
      }
    }
    this.extractor = await current;
    return this.extractor;
  }

  async embedText(text: string, type?: "query" | "passage"): Promise<number[]> {
    try {
      const formattedText = this.formatText(text, type);
      const cacheKey = this.embeddingCacheKey(formattedText);
      const cached = getCachedEmbeddingVector(cacheKey);
      if (cached) return cached;
      const extractor = await this.getExtractor();
      const output = await extractor(formattedText, {
        pooling: "mean",
        normalize: true,
      });
      const result = Array.from(output.data) as number[];
      if (result.length === this.dimensions && result.every(Number.isFinite)) {
        rememberEmbeddingVector(cacheKey, result);
      }
      if (output && typeof output.dispose === "function") {
        try {
          output.dispose();
        } catch {}
      }
      return result;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error("Failed to embed text with model \"" + this.modelName + "\": " + detail, { cause: err });
    }
  }

  async embedTexts(texts: string[], type?: "query" | "passage"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const formatted = texts.map(text => this.formatText(text, type));
    const results: Array<number[] | undefined> = Array(texts.length).fill(undefined);
    const misses = new Map<string, { text: string; positions: number[] }>();
    for (let i = 0; i < texts.length; i++) {
      const key = this.embeddingCacheKey(formatted[i]);
      const cached = getCachedEmbeddingVector(key);
      if (cached) { results[i] = cached; continue; }
      const existing = misses.get(key);
      if (existing) existing.positions.push(i);
      else misses.set(key, { text: formatted[i], positions: [i] });
    }
    if (misses.size > 0) {
      const extractor = await this.getExtractor();
      const unique = [...misses.entries()];
      for (let start = 0; start < unique.length; start += 8) {
        const batch = unique.slice(start, start + 8);
        const output = await extractor(batch.map(([, entry]) => entry.text), { pooling: "mean", normalize: true });
        try {
          if (!output.data || output.data.length !== batch.length * this.dimensions)
            throw new Error("Embedding response dimensions do not match the request.");
          for (let i = 0; i < batch.length; i++) {
            const [key, entry] = batch[i];
            const vector = Array.from(output.data.subarray(i * this.dimensions, (i + 1) * this.dimensions)) as number[];
            if (!vector.every(Number.isFinite)) throw new Error("Embedding returned a non-finite vector.");
            rememberEmbeddingVector(key, vector);
            for (const position of entry.positions) results[position] = vector.slice();
          }
        } finally {
          try { output.dispose?.(); } catch {}
        }
      }
    }
    if (results.some(vector => !vector)) throw new Error("Embedding results are incomplete.");
    return results as number[][];
  }

  async embedImage(image: string | Buffer | Uint8Array): Promise<number[]> {
    throw new Error("LocalTextEmbeddingProvider does not support image embeddings.");
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

export function resolveScenarioPath(dataDir: string, requestedPath: string): string {
  if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
    throw new Error("Scenario path must be a non-empty relative path.");
  }
  const normalized = requestedPath.replace(/\\/g, "/");
  if (path.isAbsolute(requestedPath) || path.win32.isAbsolute(requestedPath)) {
    throw new Error("Absolute scenario paths are not allowed.");
  }
  const parts = normalized.split("/");
  if (parts.length !== 2 || parts[0] !== "scene_blocks" || !parts[1] || parts[1] === "." || parts[1] === ".." || !parts[1].toLowerCase().endsWith(".md")) {
    throw new Error("Scenario path must point to a Markdown file directly inside scene_blocks.");
  }
  const dataRoot = fs.realpathSync(dataDir);
  const lexicalSceneRoot = path.resolve(dataRoot, "scene_blocks");
  let sceneRoot = lexicalSceneRoot;
  try {
    sceneRoot = fs.realpathSync(lexicalSceneRoot);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (sceneRoot !== dataRoot && !isContainedPath(dataRoot, sceneRoot)) {
    throw new Error("Scenario directory resolves outside the memory data directory.");
  }
  const candidate = path.resolve(sceneRoot, parts[1]);
  if (!isContainedPath(sceneRoot, candidate)) {
    throw new Error("Scenario path resolves outside the scenario directory.");
  }
  try {
    const resolvedCandidate = fs.realpathSync(candidate);
    if (!isContainedPath(sceneRoot, resolvedCandidate)) {
      throw new Error("Scenario file resolves outside the scenario directory.");
    }
    return resolvedCandidate;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      try { fs.lstatSync(candidate); }
      catch (lstatError: any) { if (lstatError?.code === "ENOENT") return candidate; }
    }
    throw err;
  }
}

export interface RMemoryMigrationTransaction {
  /** Finalize a staged migration after the replacement index has passed health checks. */
  commit(): void;
  /** Restore the previous index and metadata if replacement initialization fails. */
  rollback(): void;
}

export function checkAndPerformDbMigration(
  targetDir: string, currentModelName: string, currentDimensions: number, options: { deferCommit?: boolean } = {},
): RMemoryMigrationTransaction | undefined {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const metadataPath = path.join(targetDir, "metadata.json");

  let migrateNeeded = false;
  if (fs.existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      if (metadata.modelName !== currentModelName || metadata.dimensions !== currentDimensions) {
        migrateNeeded = true;
      }
    } catch {
      migrateNeeded = true;
    }
  } else {
    if (fs.existsSync(targetDir)) {
      const hasDb = fs.readdirSync(targetDir).some(f => f.endsWith(".db"));
      if (hasDb) {
        migrateNeeded = true;
      }
    }
  }

  const knownIndexArtifacts = new Set([
    "vectors.db", "vectors.db-wal", "vectors.db-shm", "vectors.db-journal",
    "skills.db", "skills.db-wal", "skills.db-shm", "skills.db-journal",
  ]);
  const backupDir = path.join(targetDir, ".index-backups", "backup-" + process.pid + "-" + Date.now());
  const movedArtifacts: string[] = [];

  if (migrateNeeded) {
    for (const entry of fs.readdirSync(targetDir)) {
      if (!knownIndexArtifacts.has(entry)) continue;
      try {
        if (movedArtifacts.length === 0) fs.mkdirSync(backupDir, { recursive: true });
        fs.renameSync(path.join(targetDir, entry), path.join(backupDir, entry));
        movedArtifacts.push(entry);
      } catch (err) {
        for (const moved of [...movedArtifacts].reverse()) {
          try { fs.renameSync(path.join(backupDir, moved), path.join(targetDir, moved)); } catch {}
        }
        try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
        throw new Error("Unable to stage stale RMemory index artifact \"" + entry + "\"; existing metadata was preserved.", { cause: err });
      }
    }
  }

  const metadata = JSON.stringify({ modelName: currentModelName, dimensions: currentDimensions });
  const tempMetadataPath = metadataPath + "." + process.pid + "." + Date.now() + ".tmp";
  const previousMetadataPath = metadataPath + "." + process.pid + ".previous";
  let previousMetadataMoved = false;
  try {
    fs.writeFileSync(tempMetadataPath, metadata, "utf-8");
    if (fs.existsSync(metadataPath)) {
      fs.renameSync(metadataPath, previousMetadataPath);
      previousMetadataMoved = true;
    }
    fs.renameSync(tempMetadataPath, metadataPath);
    if (!options.deferCommit) {
      // A successful embedding-model switch must NEVER delete the old index.
      // Retain it outside the live directory, with its original model metadata.
      if (previousMetadataMoved) {
        // Archiving old metadata is best-effort after committing the new one:
        // a rename failure must not destroy or silently rollback the old DB.
        try {
          if (movedArtifacts.length > 0) {
            fs.mkdirSync(backupDir, { recursive: true });
            fs.renameSync(previousMetadataPath, path.join(backupDir, "metadata.json"));
          } else {
            fs.rmSync(previousMetadataPath, { force: true });
          }
        } catch (error) {
          console.warn("[RMemory] Previous metadata remains at its .previous path; backup recovery is still possible:", error);
        }
      }
    }
  } catch (err) {
    try { fs.rmSync(tempMetadataPath, { force: true }); } catch {}
    if (previousMetadataMoved) {
      try {
        if (fs.existsSync(metadataPath)) fs.rmSync(metadataPath, { force: true });
        fs.renameSync(previousMetadataPath, metadataPath);
      } catch {}
    }
    for (const moved of [...movedArtifacts].reverse()) {
      try { fs.renameSync(path.join(backupDir, moved), path.join(targetDir, moved)); } catch {}
    }
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
    throw new Error("Unable to persist RMemory index metadata; previous metadata and index artifacts were restored where possible.", { cause: err });
  }
  if (!options.deferCommit || !migrateNeeded) return undefined;

  let settled = false;
  return {
    commit() {
      if (settled) return;
      settled = true;
      if (previousMetadataMoved) {
        try {
          if (movedArtifacts.length > 0) {
            fs.mkdirSync(backupDir, { recursive: true });
            fs.renameSync(previousMetadataPath, path.join(backupDir, "metadata.json"));
          } else {
            fs.rmSync(previousMetadataPath, { force: true });
          }
        } catch (error) {
          console.warn("[RMemory] Old index retained but previous metadata archiving needs inspection:", error);
        }
      }
      // Keep the old index as a recoverable versioned backup. Never unlink it
      // automatically: embedding model changes cannot safely re-embed old data.
    },
    rollback() {
      if (settled) return;
      const errors: unknown[] = [];
      const remember = (action: () => void) => {
        try { action(); } catch (err) { errors.push(err); }
      };
      for (const entry of ["vectors.db", "vectors.db-wal", "vectors.db-shm", "vectors.db-journal", "skills.db", "skills.db-wal", "skills.db-shm", "skills.db-journal"]) {
        remember(() => fs.rmSync(path.join(targetDir, entry), { force: true }));
      }
      if (previousMetadataMoved) {
        remember(() => {
          fs.rmSync(metadataPath, { force: true });
          fs.renameSync(previousMetadataPath, metadataPath);
        });
      } else {
        remember(() => fs.rmSync(metadataPath, { force: true }));
      }
      for (const moved of [...movedArtifacts].reverse()) {
        remember(() => fs.renameSync(path.join(backupDir, moved), path.join(targetDir, moved)));
      }
      remember(() => fs.rmSync(backupDir, { recursive: true, force: true }));
      settled = true;
      if (errors.length > 0) throw new AggregateError(errors, "RMemory migration rollback was incomplete; inspect preserved backup artifacts before retrying.");
    },
  };
}

let rMemoryInstance: any = null;
let rMemoryInitializationInFlight: Promise<any> | null = null;
let cachedRMemoryModelName: string = "";
let cachedRMemoryDimensions: number = 0;
let rMemoryInitFailed = false;
let rMemoryInitError: any = null;
let hasLoggedInitError = false;
let rMemoryMigrationStatus: RMemoryMigrationStatus = "not_checked";
let rMemoryLastSafeError: string | null = null;

/**
 * Exclusively owns the SQLite index bootstrap while dimensions/migration are
 * checked. Single-flight protects one process; this lock protects multiple
 * concurrently starting Bun CLIs sharing ~/.superagent-r/rmemory.
 */
async function acquireRMemoryInitLock(): Promise<() => void> {
  fs.mkdirSync(globalDataDir, { recursive: true });
  const lockPath = path.join(globalDataDir, ".index-init.lock");
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() })); }
      catch (error) { fs.closeSync(fd); fs.unlinkSync(lockPath); throw error; }
      return () => {
        fs.closeSync(fd);
        try { fs.unlinkSync(lockPath); } catch {}
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
        if (typeof owner.pid === "number" && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (err: any) {
            if (err?.code === "ESRCH") { fs.unlinkSync(lockPath); continue; }
          }
        } else if (Date.now() - fs.statSync(lockPath).mtimeMs > 30 * 60_000) {
          fs.unlinkSync(lockPath); continue;
        }
      } catch {
        // A fresh or ambiguous lock is never removed by an unrelated process.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("RMemory index bootstrap is locked by another process; retry after its initialization completes.");
}

async function initializeRMemoryInstance(): Promise<any> {
  let pendingMigration: RMemoryMigrationTransaction | undefined;
  let pendingCandidate: any = null;
  let releaseInitLock: (() => void) | undefined;
  if (rMemoryInitFailed) {
    throw rMemoryInitError || new Error("RMemory initialization previously failed.");
  }

  try {
    const { RMemory, OpenAIEmbeddingProvider } = await import("r-memory");
    const settings = getSettings();
    
    const localModelName = settings.rmemoryEmbeddingModel || DEFAULT_LOCAL_EMBEDDING_MODEL;
    let provider: any;
    if (settings.rmemoryEmbeddingProvider === "openai") {
      const activeProvider = getConfiguredProviders().find(p => p.isActive);
      const isOpenAICompatible = activeProvider && (
        activeProvider.type === "openai" ||
        activeProvider.type === "openrouter" ||
        activeProvider.type === "custom" ||
        activeProvider.type === "ollama" ||
        activeProvider.type === "lmstudio"
      );
      
      // Determine an API key only when a real one exists — never fall back to "".
      let apiKey = "";
      if (isOpenAICompatible && activeProvider?.apiKey && activeProvider.apiKey.trim() !== "") {
        apiKey = activeProvider.apiKey.trim();
      } else if (isOpenAICompatible) {
        throw new Error(
          `Embedding API key missing for active provider '${activeProvider?.name || "unknown"}' (type: ${activeProvider?.type}). Configure an OpenAI-compatible provider in /login, or switch rmemoryEmbeddingProvider away from "openai".`
        );
      } else {
        throw new Error(
          `RMemory embedding provider is set to "openai" but active provider type '${activeProvider?.type || "none"}' is not OpenAI-compatible. Switch rmemoryEmbeddingProvider to a local model or configure an OpenAI-compatible active provider.`
        );
      }
      const baseURL = isOpenAICompatible ? activeProvider.baseUrl : undefined;

      provider = new OpenAIEmbeddingProvider({
        apiKey,
        baseURL,
        model: settings.rmemoryEmbeddingModel || "text-embedding-3-small",
        dimensions: settings.rmemoryEmbeddingDimensions || 1536,
      });
    } else {
      provider = new OptimizedLocalTextEmbeddingProvider({
        modelName: localModelName,
        dtype: "q8",
        device: "cpu",
      });
    }
    
    const currentModelName = settings.rmemoryEmbeddingProvider === "openai"
      ? (settings.rmemoryEmbeddingModel || "text-embedding-3-small")
      : localModelName;
    const currentDimensions = provider.dimensions;

    if (rMemoryInstance && (cachedRMemoryModelName !== currentModelName || cachedRMemoryDimensions !== currentDimensions)) {
      try {
        if (typeof rMemoryInstance.close === "function") {
          rMemoryInstance.close();
        } else if (rMemoryInstance.db && typeof rMemoryInstance.db.close === "function") {
          rMemoryInstance.db.close();
        }
      } catch {}
      rMemoryInstance = null;
    }

    if (!rMemoryInstance) {
      releaseInitLock = await acquireRMemoryInitLock();
      const dbPath = path.join(globalDataDir, "vectors.db");
      
      pendingMigration = checkAndPerformDbMigration(globalDataDir, currentModelName, currentDimensions, { deferCommit: true });
      pendingCandidate = new RMemory({ dbPath, collectionName: "memories", embeddingProvider: provider });

      const probeVector = await provider.embedText("SuperAgent RMemory initialization probe", "passage");
      if (!Array.isArray(probeVector) || probeVector.length !== currentDimensions || !probeVector.every((value: unknown) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`Embedding health check returned an invalid vector (expected ${currentDimensions} finite dimensions).`);
      }
      const probeId = `__superagent_rmemory_probe_${process.pid}_${Date.now()}`;
      await pendingCandidate.addMemory({ id: probeId, content: "SuperAgent RMemory initialization probe", embedding: probeVector, metadata: { type: "internal_probe", internalProbe: true } });
      pendingCandidate.delete(probeId);

      const migrationWasStaged = !!pendingMigration;
      pendingMigration?.commit();
      pendingMigration = undefined;
      rMemoryMigrationStatus = migrationWasStaged ? "migrated" : "current";
      rMemoryLastSafeError = null;
      rMemoryInstance = pendingCandidate;
      pendingCandidate = null;
      cachedRMemoryModelName = currentModelName;
      cachedRMemoryDimensions = currentDimensions;
    }
    return rMemoryInstance;
  } catch (caught: any) {
    let err: any = caught;
    rMemoryMigrationStatus = "failed";
    try {
      if (pendingCandidate) {
        if (typeof pendingCandidate.close === "function") pendingCandidate.close();
        else if (pendingCandidate.db && typeof pendingCandidate.db.close === "function") pendingCandidate.db.close();
      }
    } catch {}
    if (pendingMigration) {
      try { pendingMigration.rollback(); }
      catch (rollbackError) { err = new AggregateError([caught, rollbackError], "RMemory initialization failed and migration rollback needs manual inspection."); }
    }
    rMemoryInitFailed = true;
    rMemoryLastSafeError = getSafeRMemoryError(err);
    rMemoryInitError = err;
    if (!hasLoggedInitError) {
      hasLoggedInitError = true;
      console.warn(`[WARN] RMemory failed to initialize (will be disabled for this session): ${err.message || String(err)}`);
    }
    throw err;
  } finally {
    releaseInitLock?.();
  }
}

// The bootstrap path (prepopulate) queries memories, persona and scenarios in
// parallel. Serialize initialization so these concurrent readers cannot race
// each other into migrating/creating the same SQLite index.
async function getRMemory(): Promise<any> {
  if (rMemoryInitializationInFlight) return rMemoryInitializationInFlight;
  const inFlight = initializeRMemoryInstance();
  rMemoryInitializationInFlight = inFlight;
  try {
    return await inFlight;
  } finally {
    if (rMemoryInitializationInFlight === inFlight) rMemoryInitializationInFlight = null;
  }
}

export class MemoryClient {
  private endpoint: string;
  private apiKey: string;
  private serviceId: string;
  private timeout: number;

  constructor(options: {
    endpoint: string;
    apiKey: string;
    serviceId: string;
    timeout: number;
  }) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.serviceId = options.serviceId;
    this.timeout = options.timeout;
  }

  async addConversation(options: {
    session_id: string;
    projectId?: string;
    messages: { role: "user" | "assistant" | "system"; content: string; timestamp?: string; messageId?: string }[];
  }): Promise<{ accepted_ids: string[]; total_count: number }> {
    const rMemory = await getRMemory();
    const accepted_ids: string[] = [];
    
    if (options.messages.length === 0) {
      // @ts-ignore
      const count = rMemory.db.getAll({ session: options.session_id }).length;
      return {
        accepted_ids,
        total_count: count,
      };
    }

    // Stable IDs make ingestion idempotent even after partial failures or retries.
    // Existing records are checked *before* running expensive embedding.
    const pending: Array<{ id: string; text: string; message: (typeof options.messages)[number]; timestamp: string }> = [];
    for (const msg of options.messages) {
      const timestamp = msg.timestamp || new Date().toISOString();
      const identity = msg.messageId || `${msg.role}\0${timestamp}\0${msg.content}`;
      const id = "conv_" + createHash("sha256")
        .update(`${options.projectId || "legacy"}\0${options.session_id}\0${identity}`).digest("hex");
      const content = msg.content || "";
      // Redact BEFORE embedding and storing: no plaintext secrets reach vectors.
      const text = redactMemorySecrets(content.length > 8000 ? content.substring(0, 8000) + "... [truncated]" : content);
      const existing = typeof rMemory.db?.getById === "function" ? rMemory.db.getById(id) : null;
      if (existing) {
        if (existing.content !== text || existing.metadata?.session !== options.session_id ||
            existing.metadata?.projectId !== options.projectId || existing.metadata?.role !== msg.role) {
          throw new Error("RMemory conversation ID collision or conflicting metadata; refusing overwrite.");
        }
        accepted_ids.push(id);
        continue;
      }
      pending.push({ id, text, message: msg, timestamp });
    }
    // Bound *total* in-memory vectors, not merely the batch creation size.
    // Persist each batch before embedding the next; deterministic IDs make
    // recovery safe even if a later batch fails or the process crashes.
    const BATCH_SIZE = 8;
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const batchTexts = batch.map(({ text }) => text);
      const embeddings: number[][] = rMemory.provider?.embedTexts
        ? await rMemory.provider.embedTexts(batchTexts, "passage")
        : await Promise.all(batchTexts.map(text => rMemory.provider.embedText(text, "passage")));
      if (embeddings.length !== batch.length) {
        throw new Error("RMemory embedding batch returned an inconsistent number of vectors.");
      }
      for (let j = 0; j < batch.length; j++) {
        const { message: msg, id, timestamp, text } = batch[j];
        // Parallel importers may have committed this row while embedding.
        const existing = typeof rMemory.db?.getById === "function" ? rMemory.db.getById(id) : null;
        if (existing) {
          if (existing.content !== text || existing.metadata?.projectId !== options.projectId ||
              existing.metadata?.session !== options.session_id || existing.metadata?.role !== msg.role) {
            throw new Error("RMemory conversation ID collision or conflicting metadata; refusing overwrite.");
          }
          accepted_ids.push(id);
          continue;
        }
        await rMemory.addMemory({
          id,
          content: text,
          embedding: embeddings[j],
          metadata: {
            type: "message",
            session: options.session_id,
            ...(options.projectId ? { scope: "project", projectId: options.projectId } : {}),
            role: msg.role,
            timestamp,
          },
        });
        accepted_ids.push(id);
      }
    }

    // @ts-ignore
    const count = rMemory.db.getAll({ session: options.session_id }).length;
    recordMemoryIngestion(pending.length, options.messages.length - pending.length);

    return {
      accepted_ids,
      total_count: count,
    };
  }

  async searchConversation(options: {
    query: string;
    limit?: number;
    projectId?: string;
  }): Promise<{ messages: { role: string; content: string; timestamp: string; session_id?: string; project_id?: string }[] }> {
    if (!options.projectId) throw new Error("Conversation search requires an authorized project scope.");
    const rMemory = await getRMemory();
    const limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 5)));
    const results = await rMemory.query({
      query: options.query.slice(0, 1000),
      limit,
      hybrid: true,
      filter: { type: "message", scope: "project", projectId: options.projectId },
    });

    const messages = results
      .filter((r: any) => r.memory?.metadata?.type === "message" &&
        r.memory?.metadata?.scope === "project" && r.memory?.metadata?.projectId === options.projectId &&
        r.memory?.metadata?.role)
      .map((r: any) => ({
        role: r.memory.metadata.role,
        content: r.memory.content,
        timestamp: r.memory.metadata.timestamp || new Date(r.memory.createdAt).toISOString(),
        session_id: r.memory.metadata.session,
        project_id: r.memory.metadata.projectId,
      }));

    return { messages };
  }

  async searchAtomic(options: {
    query: string;
    limit?: number;
    projectId?: string;
  }): Promise<{ items: { id: string; content: string; type: string; score: number; metadata?: Record<string, any> }[] }> {
    const rMemory = await getRMemory();
    const limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 5)));
    const query = String(options.query || "").slice(0, 1000);
    if (!options.projectId) {
      throw new Error("Structured memory search requires a canonical project scope.");
    }
    const candidateLimit = Math.max(limit * 4, 20);
    const startedAt = Date.now();
    const [projectResults, globalResults, legacyResults] = await Promise.all([
      rMemory.query({ query, limit: candidateLimit, hybrid: true, filter: { scope: "project", projectId: options.projectId } }),
      rMemory.query({ query, limit: candidateLimit, hybrid: true, filter: { scope: "global" } }),
      rMemory.query({ query, limit: candidateLimit, hybrid: true, filter: { type: "memory" } }),
    ]);
    const items = fuseScopedMemoryHits(
      [projectResults, globalResults, legacyResults], options.projectId, limit);
    recordMemorySearchPerformance(Date.now() - startedAt, items.length);
    return { items };
  }

  async updateAtomic(options: {
    id: string;
    content: string;
    metadata?: Record<string, any>;
  }): Promise<{ id: string; updated_at: string }> {
    const rMemory = await getRMemory();
    const storageId = getRMemoryStorageId(options.id, options.metadata);
    let existingMetadata: Record<string, any> = {};
    try {
      const existing = typeof rMemory.db?.getById === "function" ? rMemory.db.getById(storageId) : null;
      if (existing?.metadata && typeof existing.metadata === "object") existingMetadata = existing.metadata;
    } catch {
      // A metadata lookup is best-effort; writes still proceed with explicit caller metadata.
    }

    const content = options.content || "";
    const truncatedContent = redactMemorySecrets(content.length > 8000
      ? content.substring(0, 8000) + "... [truncated]"
      : content);
    const now = new Date().toISOString();
    const suppliedMetadata = options.metadata || {};
    const metadata: Record<string, any> = {
      ...existingMetadata,
      ...suppliedMetadata,
      type: suppliedMetadata.type || existingMetadata.type || "memory",
      createdAt: existingMetadata.createdAt || suppliedMetadata.createdAt || now,
      updatedAt: now,
      ...(suppliedMetadata.scope === "project"
        ? { logicalId: options.id }
        : existingMetadata.scope === "project" && existingMetadata.projectId
          ? { logicalId: existingMetadata.logicalId || options.id }
          : {}),
    };
    if (suppliedMetadata.scope === "global") delete metadata.projectId;

    await rMemory.addMemory({
      id: storageId,
      content: truncatedContent,
      metadata,
    });

    return {
      id: options.id,
      updated_at: now,
    };
  }

  private findAtomicByScope(
    rMemory: any,
    options: { id: string; scope: "project" | "global"; projectId: string },
  ): { storageId: string; content: string; metadata: Record<string, any>; createdAt?: number } | null {
    const candidates = options.scope === "project"
      ? [getRMemoryStorageId(options.id, { scope: "project", projectId: options.projectId }), options.id]
      : [options.id];
    const seen = new Set<string>();

    for (const storageId of candidates) {
      if (seen.has(storageId)) continue;
      seen.add(storageId);
      let record: any;
      try {
        record = typeof rMemory.db?.getById === "function" ? rMemory.db.getById(storageId) : null;
      } catch {
        record = null;
      }
      if (!record || typeof record.content !== "string") continue;

      const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
      const matches = options.scope === "global"
        ? metadata.scope === "global" || (!metadata.scope && record.content.startsWith("[global]"))
        : (metadata.scope === "project" && metadata.projectId === options.projectId) ||
          (!metadata.scope && record.content.startsWith(`[project:${options.projectId}]`));
      if (matches) return { storageId, content: record.content, metadata, createdAt: record.createdAt };
    }
    return null;
  }

  async inspectAtomic(options: {
    id: string;
    scope: "project" | "global";
    projectId: string;
  }): Promise<{ id: string; content: string; scope: "project" | "global"; metadata: Record<string, any> } | null> {
    const rMemory = await getRMemory();
    const record = this.findAtomicByScope(rMemory, options);
    if (!record) return null;
    const logicalId = typeof record.metadata.logicalId === "string"
      ? record.metadata.logicalId
      : record.storageId.startsWith(`${options.projectId}:`)
        ? record.storageId.slice(options.projectId.length + 1)
        : options.id;
    return {
      id: logicalId,
      content: record.content,
      scope: options.scope,
      metadata: record.metadata,
    };
  }

  async exportAtomic(options: {
    projectId: string;
    includeGlobal?: boolean;
    limit?: number;
    sortBy?: "updatedAtDesc" | "updatedAtAsc";
  }): Promise<{ total: number; truncated: boolean; items: Array<{ id: string; content: string; scope: "project" | "global"; metadata: Record<string, any> }> }> {
    const rMemory = await getRMemory();
    if (typeof rMemory.db?.getAll !== "function") {
      throw new Error("RMemory index does not support safe memory export.");
    }
    const records = rMemory.db.getAll();
    const items: Array<{ id: string; content: string; scope: "project" | "global"; metadata: Record<string, any> }> = [];

    for (const record of records) {
      if (!record || typeof record.content !== "string") continue;
      const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
      // Do not export conversation, skills, probes, or arbitrary non-atomic index rows.
      const isAtomicRecord = metadata.type === "memory" ||
        (!metadata.type && (record.content.startsWith("[global]") || record.content.startsWith(`[project:${options.projectId}]`)));
      if (!isAtomicRecord) continue;

      const scope: "project" | "global" | null =
        metadata.scope === "global" || (!metadata.scope && record.content.startsWith("[global]"))
          ? "global"
          : metadata.scope === "project" && metadata.projectId === options.projectId
            ? "project"
            : !metadata.scope && record.content.startsWith(`[project:${options.projectId}]`)
              ? "project"
              : null;
      if (!scope || (scope === "global" && options.includeGlobal === false)) continue;

      const id = typeof metadata.logicalId === "string"
        ? metadata.logicalId
        : String(record.id || "").startsWith(`${options.projectId}:`)
          ? String(record.id).slice(options.projectId.length + 1)
          : String(record.id || "");
      items.push({ id, content: record.content, scope, metadata });
    }
    items.sort((a, b) => {
      const updatedA = Date.parse(String(a.metadata.updatedAt || "")) || Number(a.metadata.createdAt) || 0;
      const updatedB = Date.parse(String(b.metadata.updatedAt || "")) || Number(b.metadata.createdAt) || 0;
      return options.sortBy === "updatedAtAsc" ? updatedA - updatedB : updatedB - updatedA;
    });
    const requestedLimit = Number(options.limit) || 100;
    const limit = Math.max(1, Math.min(500, Math.floor(requestedLimit)));
    return { total: items.length, truncated: items.length > limit, items: items.slice(0, limit) };
  }
  async migrateLegacyAtomicMemories(options: {
    projectId: string;
    includeGlobal?: boolean;
    dryRun?: boolean;
    limit?: number;
  }): Promise<{
    dryRun: boolean;
    scanned: number;
    candidates: number;
    migrated: number;
    skipped: number;
    failed: number;
    items: Array<{ id: string; scope: "project" | "global"; status: "would_migrate" | "migrated" | "conflict" | "skipped" | "failed"; reason?: string }>;
  }> {
    const rMemory = await getRMemory();
    if (typeof rMemory.db?.getAll !== "function") throw new Error("RMemory index does not support safe legacy migration.");
    if (!options.projectId?.trim()) throw new Error("A canonical project ID is required for safe legacy migration.");

    const dryRun = options.dryRun !== false;
    const limit = Math.max(1, Math.min(500, Math.floor(Number(options.limit) || 100)));
    const records = rMemory.db.getAll();
    const candidates: Array<{
      sourceId: string;
      id: string;
      content: string;
      scope: "project" | "global";
      metadata: Record<string, any>;
      createdAt?: string;
    }> = [];
    const items: Array<{ id: string; scope: "project" | "global"; status: "would_migrate" | "migrated" | "conflict" | "skipped" | "failed"; reason?: string }> = [];

    for (const record of records) {
      if (!record || typeof record.content !== "string" || typeof record.id !== "string") continue;
      const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
        ? record.metadata as Record<string, any>
        : {};
      if (metadata.scope || (metadata.type && metadata.type !== "memory")) continue;

      const globalMatch = record.content.match(/^\[global\]\s+([\s\S]+)$/);
      const projectMatch = record.content.match(/^\[project:([^\]]+)\]\s+([\s\S]+)$/);
      let scope: "project" | "global";
      let content: string;
      if (globalMatch) {
        if (options.includeGlobal === false) continue;
        scope = "global";
        content = globalMatch[1].trim();
      } else if (projectMatch) {
        if (projectMatch[1] !== options.projectId) continue;
        scope = "project";
        content = projectMatch[2].trim();
      } else {
        // Untagged or ambiguous legacy records must never be assigned to a project.
        continue;
      }

      const storagePrefix = options.projectId + ":";
      const inferredId = scope === "project" && record.id.startsWith(storagePrefix)
        ? record.id.slice(storagePrefix.length)
        : record.id;
      const id = typeof metadata.logicalId === "string" && metadata.logicalId.trim()
        ? metadata.logicalId.trim()
        : inferredId;
      if (!id || id.length > 160 || !content) {
        items.push({ id: id.slice(0, 160) || "[invalid-id]", scope, status: "skipped", reason: "invalid_id_or_empty_content" });
        continue;
      }

      const createdAtRaw = metadata.createdAt ?? record.createdAt;
      const createdAt = typeof createdAtRaw === "string" && Number.isFinite(Date.parse(createdAtRaw))
        ? new Date(createdAtRaw).toISOString()
        : typeof createdAtRaw === "number" && Number.isFinite(createdAtRaw)
          ? new Date(createdAtRaw).toISOString()
          : undefined;
      candidates.push({ sourceId: record.id, id, content, scope, metadata, createdAt });
      if (candidates.length >= limit) break;
    }

    for (const candidate of candidates) {
      const scopedMetadata = {
        ...candidate.metadata,
        scope: candidate.scope,
        ...(candidate.scope === "project" ? { projectId: options.projectId } : {}),
      };
      const targetId = getRMemoryStorageId(candidate.id, scopedMetadata);
      let target: any = null;
      try { target = rMemory.db.getById?.(targetId) || null; } catch {}
      if (target && targetId !== candidate.sourceId) {
        const targetMetadata = target.metadata && typeof target.metadata === "object" ? target.metadata : {};
        const sameScope = candidate.scope === "global"
          ? targetMetadata.scope === "global" && !targetMetadata.projectId
          : targetMetadata.scope === "project" && targetMetadata.projectId === options.projectId;
        const sameRecord = isMemoryRecordMetadata(targetMetadata) &&
          targetMetadata.memoryId === candidate.id &&
          sameScope &&
          String(target.content || "") === candidate.content;
        if (!sameRecord) {
          items.push({ id: candidate.id, scope: candidate.scope, status: "conflict", reason: "canonical_record_already_exists_with_different_content" });
          continue;
        }
        if (dryRun) {
          items.push({ id: candidate.id, scope: candidate.scope, status: "would_migrate", reason: "identical_canonical_record_exists" });
          continue;
        }
        try {
          rMemory.delete(candidate.sourceId);
          items.push({ id: candidate.id, scope: candidate.scope, status: "migrated", reason: "removed_duplicate_legacy_copy" });
        } catch {
          items.push({ id: candidate.id, scope: candidate.scope, status: "failed", reason: "could_not_remove_duplicate_legacy_copy" });
        }
        continue;
      }

      if (dryRun) {
        items.push({ id: candidate.id, scope: candidate.scope, status: "would_migrate" });
        continue;
      }

      try {
        const metadata = createMemoryRecordMetadata({
          memoryId: candidate.id,
          memoryType: typeof candidate.metadata.memoryType === "string" ? candidate.metadata.memoryType : "fact",
          scope: candidate.scope,
          projectId: options.projectId,
          source: "legacy_prefix_migration",
          now: new Date().toISOString(),
          createdAt: candidate.createdAt,
          existingMetadata: candidate.metadata,
        });
        await this.updateAtomic({
          id: candidate.id,
          content: candidate.content,
          metadata: { ...candidate.metadata, ...metadata, type: "memory", scope: candidate.scope },
        });

        const migratedRecord = rMemory.db.getById?.(targetId);
        const migratedMetadata = migratedRecord?.metadata;
        const valid = !!migratedRecord &&
          isMemoryRecordMetadata(migratedMetadata) &&
          migratedMetadata.memoryId === candidate.id &&
          migratedMetadata.scope === candidate.scope &&
          (candidate.scope === "global" ? !migratedMetadata.projectId : migratedMetadata.projectId === options.projectId) &&
          migratedRecord.content === candidate.content;
        if (!valid) {
          items.push({ id: candidate.id, scope: candidate.scope, status: "failed", reason: "canonical_write_verification_failed; legacy_record_preserved" });
          continue;
        }

        if (candidate.sourceId !== targetId) rMemory.delete(candidate.sourceId);
        items.push({ id: candidate.id, scope: candidate.scope, status: "migrated" });
      } catch {
        // The old record is intentionally left untouched if the new write fails.
        items.push({ id: candidate.id, scope: candidate.scope, status: "failed", reason: "migration_write_failed; legacy_record_preserved" });
      }
    }

    const migrated = items.filter(item => item.status === "migrated").length;
    const failed = items.filter(item => item.status === "failed").length;
    const skipped = items.filter(item => item.status === "conflict" || item.status === "skipped").length;
    return { dryRun, scanned: records.length, candidates: candidates.length, migrated, skipped, failed, items };
  }



  private legacySourceFingerprint(record: { id?: string; content?: string; metadata?: Record<string, any> }): string {
    return createHash("sha256").update(`${String(record.content || "")}
${JSON.stringify(record.metadata || {})}`).digest("hex");
  }

  async previewLegacyAtomicMapping(options: { sourceId: string; targetId: string; content?: string; scope: "project" | "global"; projectId: string }) {
    const rMemory = await getRMemory();
    const source = typeof rMemory.db?.getById === "function" ? rMemory.db.getById(options.sourceId) : null;
    if (!source) return null;
    const sourceMetadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
    if (sourceMetadata.type === "memory_revision" || sourceMetadata.type === "memory") {
      if (sourceMetadata.scope === "global" || sourceMetadata.scope === "project") {
        throw new Error("Source already has structured scope; use normal scoped memory review instead of legacy mapping.");
      }
    }
    const prefix = String(source.content || "").match(/^\[(global|project(?::([^\]]+))?)\]\s*/i);
    if (prefix?.[1]?.toLowerCase() === "global" && options.scope !== "global") throw new Error("Source has an explicit [global] prefix; refusing a conflicting project mapping.");
    if (prefix?.[2] && (options.scope !== "project" || prefix[2] !== options.projectId)) throw new Error("Source has an explicit project prefix that conflicts with the requested mapping.");
    if (!options.sourceId.trim() || !options.targetId.trim() || !options.projectId.trim()) throw new Error("Source ID, target ID and canonical project ID are required.");
    const proposedText = typeof options.content === "string" ? options.content : String(source.content || "").replace(/^\[(?:global|project(?::[^\]]+)?|project)\]\s*/i, "");
    const proposedContent = `${options.scope === "global" ? "[global]" : `[project:${options.projectId}]`} ${proposedText.replace(/^\[(?:global|project(?::[^\]]+)?|project)\]\s*/i, "").slice(0, 8000)}`;
    const storageId = getRMemoryStorageId(options.targetId, options.scope === "project" ? { scope: "project", projectId: options.projectId } : { scope: "global" });
    const target = typeof rMemory.db?.getById === "function" ? rMemory.db.getById(storageId) : null;
    return { sourceId: options.sourceId, targetId: options.targetId, storageId, scope: options.scope, projectId: options.scope === "project" ? options.projectId : undefined,
      sourceContent: String(source.content || ""), proposedContent, expectedSourceFingerprint: this.legacySourceFingerprint(source),
      targetExists: !!target, targetContent: target ? String(target.content || "") : undefined,
      targetMetadata: target?.metadata || undefined, originalPreserved: true };
  }

  async mapLegacyAtomicMemory(options: { sourceId: string; targetId: string; content?: string; scope: "project" | "global"; projectId: string; expectedSourceFingerprint: string; reason?: string; agentTier?: string }) {
    const rMemory = await getRMemory();
    const preview = await this.previewLegacyAtomicMapping(options);
    if (!preview) return { status: "not_found" as const, sourceId: options.sourceId, targetId: options.targetId };
    if (preview.expectedSourceFingerprint !== options.expectedSourceFingerprint) return { status: "source_changed" as const, sourceId: options.sourceId, targetId: options.targetId };
    if (preview.targetExists) {
      if (preview.targetContent === preview.proposedContent && preview.targetMetadata?.mappedFromLegacyId === options.sourceId) return { status: "already_mapped" as const, sourceId: options.sourceId, targetId: options.targetId, scope: options.scope };
      return { status: "target_conflict" as const, sourceId: options.sourceId, targetId: options.targetId, reason: "target_exists_with_different_content" };
    }
    const now = new Date().toISOString();
    const metadata = createMemoryRecordMetadata({ memoryId: options.targetId, memoryType: "fact", scope: options.scope, projectId: options.projectId,
      source: "legacy_owner_mapping", agentTier: options.agentTier || "master", now,
      existingMetadata: { mappedFromLegacyId: options.sourceId, mappedAt: now, mappingReason: String(options.reason || "owner_confirmed_legacy_mapping").slice(0, 200), reviewState: "unreviewed", validationStatus: "unverified" } });
    const latestSource = typeof rMemory.db?.getById === "function" ? rMemory.db.getById(options.sourceId) : null;
    if (!latestSource || this.legacySourceFingerprint(latestSource) !== options.expectedSourceFingerprint) return { status: "source_changed" as const, sourceId: options.sourceId, targetId: options.targetId };
    const storageId = preview.storageId;
    await rMemory.addMemory({ id: storageId, content: preview.proposedContent, metadata });
    const written = rMemory.db?.getById?.(storageId);
    const verified = !!written && written.content === preview.proposedContent && written.metadata?.scope === options.scope
      && (options.scope === "global" ? !written.metadata?.projectId : written.metadata?.projectId === options.projectId)
      && written.metadata?.memoryId === options.targetId && written.metadata?.mappedFromLegacyId === options.sourceId;
    if (!verified) {
      try { if (rMemory.db?.getById?.(storageId)?.metadata?.mappedFromLegacyId === options.sourceId) rMemory.delete?.(storageId); } catch {}
      return { status: "verification_failed" as const, sourceId: options.sourceId, targetId: options.targetId, originalPreserved: true };
    }
    return { status: "mapped" as const, sourceId: options.sourceId, targetId: options.targetId, scope: options.scope, storageId, updatedAt: now, originalPreserved: true };
  }

  async previewAtomicRevision(options: { id: string; content: string; scope: "project" | "global"; projectId: string }) {
    const rMemory = await getRMemory();
    const current = this.findAtomicByScope(rMemory, options);
    if (!current) return null;
    const meta = current.metadata;
    if (meta.scope !== options.scope || (options.scope === "project" && meta.projectId !== options.projectId)) {
      throw new Error("Legacy or ambiguous memory scope must be reviewed/migrated before a revision.");
    }
    const version = typeof meta.updatedAt === "string" && Number.isFinite(Date.parse(meta.updatedAt)) ? new Date(meta.updatedAt).toISOString() : "";
    if (!version) throw new Error("Memory has no valid updatedAt version token; review/migrate before revising.");
    const content = (options.scope === "global" ? "[global] " : `[project:${options.projectId}] `)
      + String(options.content || "").replace(/^\[(?:global|project(?::[^\]]+)?)\]\s*/i, "").slice(0, 8000);
    return { id: options.id, scope: options.scope, currentContent: current.content, proposedContent: content,
      expectedUpdatedAt: version, revisionNumber: Math.max(1, Math.floor(Number(meta.revisionNumber) || 1)), metadata: meta };
  }

  async reviseAtomic(options: { id: string; content: string; scope: "project" | "global"; projectId: string; expectedUpdatedAt: string; reason?: string }) {
    const rMemory = await getRMemory();
    const current = this.findAtomicByScope(rMemory, options);
    if (!current) return { status: "not_found" as const, id: options.id };
    const meta = current.metadata;
    if (meta.scope !== options.scope || (options.scope === "project" && meta.projectId !== options.projectId)) return { status: "needs_migration" as const, id: options.id };
    const version = typeof meta.updatedAt === "string" && Number.isFinite(Date.parse(meta.updatedAt)) ? new Date(meta.updatedAt).toISOString() : "";
    if (!version) return { status: "needs_migration" as const, id: options.id };
    const expected = Date.parse(options.expectedUpdatedAt || "");
    if (!Number.isFinite(expected) || new Date(expected).toISOString() !== version) return { status: "conflict" as const, id: options.id, currentUpdatedAt: version };
    const content = (options.scope === "global" ? "[global] " : `[project:${options.projectId}] `)
      + String(options.content || "").replace(/^\[(?:global|project(?::[^\]]+)?)\]\s*/i, "").slice(0, 8000);
    if (content === current.content) return { status: "unchanged" as const, id: options.id, currentUpdatedAt: version };
    const now = new Date().toISOString();
    const currentRevision = Math.max(1, Math.floor(Number(meta.revisionNumber) || 1));
    const nextRevision = currentRevision + 1;
    const logicalRevisionId = `${options.id}::revision:${currentRevision}:${createHash("sha256").update(`${version}:${now}`).digest("hex").slice(0, 10)}`;
    const revisionId = getRMemoryStorageId(logicalRevisionId, options.scope === "project" ? { scope: "project", projectId: options.projectId } : { scope: "global" });
    const revisionMetadata = { ...meta, type: "memory_revision", originalMemoryId: options.id, revisionId,
      revisionNumber: currentRevision, revisionCreatedAt: now, sourceUpdatedAt: version,
      archivedReason: String(options.reason || "owner_confirmed_revision").slice(0, 160), scope: options.scope,
      ...(options.scope === "project" ? { projectId: options.projectId } : {}) };
    await rMemory.addMemory({ id: revisionId, content: current.content, metadata: revisionMetadata });
    const snapshot = rMemory.db?.getById?.(revisionId);
    if (!snapshot || snapshot.content !== current.content || snapshot.metadata?.originalMemoryId !== options.id) throw new Error("Revision backup could not be verified; current memory was not changed.");
    const latest = this.findAtomicByScope(rMemory, options);
    const latestVersion = latest?.metadata?.updatedAt && Number.isFinite(Date.parse(String(latest.metadata.updatedAt))) ? new Date(String(latest.metadata.updatedAt)).toISOString() : "";
    if (!latest || latest.storageId !== current.storageId || latestVersion !== version || latest.content !== current.content) return { status: "conflict" as const, id: options.id, ...(latestVersion ? { currentUpdatedAt: latestVersion } : {}) };
    const activeMetadata = createMemoryRecordMetadata({ memoryId: options.id,
      memoryType: typeof meta.memoryType === "string" ? meta.memoryType : "fact", scope: options.scope, projectId: options.projectId,
      source: "rmemory_revise", agentTier: typeof (meta.provenance as any)?.agentTier === "string" ? (meta.provenance as any).agentTier : undefined,
      createdAt: meta.createdAt, now, validationStatus: "unverified",
      existingMetadata: { ...meta, type: "memory", reviewState: "unreviewed", lifecycleState: "active", validationStatus: "unverified",
        revisionNumber: nextRevision, supersedesMemoryId: revisionId, supersededByMemoryId: undefined, supersededAt: undefined,
        reviewedAt: undefined, reviewedBy: undefined, quarantineReason: undefined, conflictWithMemoryIds: undefined } });
    try {
      await rMemory.addMemory({ id: current.storageId, content, metadata: activeMetadata });
      const written = rMemory.db?.getById?.(current.storageId);
      if (!written || written.content !== content || written.metadata?.scope !== options.scope
        || (options.scope === "global" ? !!written.metadata?.projectId : written.metadata?.projectId !== options.projectId)
        || written.metadata?.memoryId !== options.id) throw new Error("Revised memory failed verification.");
    } catch (error) {
      try { await rMemory.addMemory({ id: current.storageId, content: current.content, metadata: current.metadata }); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Revision failed and rollback was incomplete; archived snapshot remains available."); }
      throw new Error("Revision failed; previous memory version was restored.", { cause: error });
    }
    // Mark the snapshot as superseded only after the replacement has been verified.
    // A failed history metadata update must not turn a successful content write into a reported rollback.
    try {
      const snapshotNow = rMemory.db?.getById?.(revisionId);
      if (!snapshotNow || snapshotNow.content !== current.content || snapshotNow.metadata?.originalMemoryId !== options.id) {
        throw new Error("Verified revision snapshot disappeared after the active write.");
      }
      const historyMetadata = { ...snapshotNow.metadata, lifecycleState: "superseded", supersededAt: now, supersededByMemoryId: options.id };
      await rMemory.addMemory({ id: revisionId, content: current.content, metadata: historyMetadata });
      const historyWritten = rMemory.db?.getById?.(revisionId);
      if (!historyWritten || historyWritten.metadata?.lifecycleState !== "superseded" || historyWritten.metadata?.supersededByMemoryId !== options.id) {
        throw new Error("Supersession history verification failed.");
      }
    } catch {
      return { status: "revised" as const, id: options.id, currentUpdatedAt: version, updatedAt: now, revisionId, revisionNumber: nextRevision,
        historyWarning: "The new active version was verified, but its archived snapshot's supersession marker could not be verified. The preserved snapshot remains in revision history." };
    }
    return { status: "revised" as const, id: options.id, currentUpdatedAt: version, updatedAt: now, revisionId, revisionNumber: nextRevision };
  }

  async listAtomicRevisions(options: { id: string; scope: "project" | "global"; projectId: string; limit?: number }): Promise<Array<{ revisionId: string; id: string; content: string; revisionNumber: number; revisionCreatedAt?: string; sourceUpdatedAt?: string; metadata: Record<string, any> }>> {
    const rMemory = await getRMemory();
    if (typeof rMemory.db?.getAll !== "function") throw new Error("RMemory index does not support revision history.");
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 20)));
    return rMemory.db.getAll().filter((record: any) => {
      const meta = record?.metadata || {};
      return meta.type === "memory_revision" && meta.originalMemoryId === options.id && meta.scope === options.scope
        && (options.scope === "global" ? !meta.projectId : meta.projectId === options.projectId);
    }).map((record: any) => ({ revisionId: String(record.metadata.revisionId || record.id), id: options.id,
      content: String(record.content || ""), revisionNumber: Number(record.metadata.revisionNumber) || 0,
      revisionCreatedAt: record.metadata.revisionCreatedAt, sourceUpdatedAt: record.metadata.sourceUpdatedAt,
      metadata: record.metadata })).sort((a: any, b: any) => String(b.revisionCreatedAt || "").localeCompare(String(a.revisionCreatedAt || ""))).slice(0, limit);
  }

  async restoreAtomicRevision(options: { id: string; revisionId: string; scope: "project" | "global"; projectId: string; expectedUpdatedAt: string }) {
    const rMemory = await getRMemory();
    const revision = typeof rMemory.db?.getById === "function" ? rMemory.db.getById(options.revisionId) : null;
    const meta = revision?.metadata || {};
    if (!revision || meta.type !== "memory_revision" || meta.originalMemoryId !== options.id || meta.scope !== options.scope
      || (options.scope === "global" ? !!meta.projectId : meta.projectId !== options.projectId)) return { status: "not_found" as const, id: options.id };
    return this.reviseAtomic({ ...options, content: String(revision.content || ""), reason: `restore:${options.revisionId}` });
  }

  async markAtomicStale(options: { id: string; scope: "project" | "global"; projectId: string; expectedUpdatedAt: string; reason: string }) {
    const rMemory = await getRMemory();
    const current = this.findAtomicByScope(rMemory, options);
    if (!current) return { status: "not_found" as const, id: options.id };
    const meta = current.metadata;
    if (meta.scope !== options.scope || (options.scope === "project" && meta.projectId !== options.projectId)) return { status: "needs_migration" as const, id: options.id };
    const version = typeof meta.updatedAt === "string" && Number.isFinite(Date.parse(meta.updatedAt)) ? new Date(meta.updatedAt).toISOString() : "";
    const expected = Date.parse(options.expectedUpdatedAt || "");
    if (!version || !Number.isFinite(expected) || new Date(expected).toISOString() !== version) return { status: "conflict" as const, id: options.id, ...(version ? { currentUpdatedAt: version } : {}) };
    const now = new Date().toISOString();
    const next = { ...meta, validationStatus: "stale", staleReason: String(options.reason || "retention_review").slice(0, 200), updatedAt: now };
    await rMemory.addMemory({ id: current.storageId, content: current.content, metadata: next });
    const written = rMemory.db?.getById?.(current.storageId);
    if (!written || written.content !== current.content || written.metadata?.validationStatus !== "stale" || written.metadata?.scope !== options.scope) throw new Error("Stale marking could not be verified.");
    return { status: "marked_stale" as const, id: options.id, updatedAt: now };
  }

  /** Mark an expired memory without deleting content; compare-and-set guards against concurrent edits. */
  async markAtomicExpired(options: { id: string; scope: "project" | "global"; projectId: string; expectedUpdatedAt: string; reason: string }) {
    const rMemory = await getRMemory();
    const current = this.findAtomicByScope(rMemory, options);
    if (!current) return { status: "not_found" as const, id: options.id };
    const meta = current.metadata;
    if (meta.scope !== options.scope || (options.scope === "project" && meta.projectId !== options.projectId)) {
      return { status: "needs_migration" as const, id: options.id };
    }
    const version = typeof meta.updatedAt === "string" && Number.isFinite(Date.parse(meta.updatedAt)) ? new Date(meta.updatedAt).toISOString() : "";
    const expected = Date.parse(options.expectedUpdatedAt || "");
    if (!version || !Number.isFinite(expected) || new Date(expected).toISOString() !== version) {
      return { status: "conflict" as const, id: options.id, ...(version ? { currentUpdatedAt: version } : {}) };
    }
    const now = new Date().toISOString();
    const next = {
      ...meta,
      lifecycleState: "expired",
      validationStatus: "stale",
      expiredAt: now,
      staleReason: String(options.reason || "retention_sweep_expired").slice(0, 200),
      updatedAt: now,
    };
    await rMemory.addMemory({ id: current.storageId, content: current.content, metadata: next });
    const written = rMemory.db?.getById?.(current.storageId);
    if (!written || written.content !== current.content || written.metadata?.lifecycleState !== "expired" ||
      written.metadata?.validationStatus !== "stale" || written.metadata?.scope !== options.scope ||
      (options.scope === "project" && written.metadata?.projectId !== options.projectId)) {
      throw new Error("Expired-memory marking could not be verified.");
    }
    return { status: "marked_expired" as const, id: options.id, updatedAt: now };
  }

  async reviewAtomicConflictPair(options: {
    first: { id: string; expectedUpdatedAt: string };
    second: { id: string; expectedUpdatedAt: string };
    scope: "project" | "global";
    projectId: string;
    reviewedBy?: string;
    reason?: string;
  }) {
    const rMemory = await getRMemory();
    if (options.first.id === options.second.id) throw new Error("Conflict pair requires two distinct memory IDs.");
    const first = this.findAtomicByScope(rMemory, { id: options.first.id, scope: options.scope, projectId: options.projectId });
    const second = this.findAtomicByScope(rMemory, { id: options.second.id, scope: options.scope, projectId: options.projectId });
    if (!first || !second) return { status: "not_found" as const, firstFound: !!first, secondFound: !!second };
    const validScope = (record: { metadata: Record<string, any> }) => record.metadata.scope === options.scope
      && (options.scope === "global" ? !record.metadata.projectId : record.metadata.projectId === options.projectId);
    if (!validScope(first) || !validScope(second)) return { status: "needs_migration" as const };
    const version = (record: { metadata: Record<string, any> }) => typeof record.metadata.updatedAt === "string" && Number.isFinite(Date.parse(record.metadata.updatedAt)) ? new Date(record.metadata.updatedAt).toISOString() : "";
    const firstVersion = version(first); const secondVersion = version(second);
    const firstExpected = Date.parse(options.first.expectedUpdatedAt || ""); const secondExpected = Date.parse(options.second.expectedUpdatedAt || "");
    if (!firstVersion || !secondVersion || !Number.isFinite(firstExpected) || !Number.isFinite(secondExpected)
      || new Date(firstExpected).toISOString() !== firstVersion || new Date(secondExpected).toISOString() !== secondVersion) {
      return { status: "conflict" as const, firstUpdatedAt: firstVersion || undefined, secondUpdatedAt: secondVersion || undefined };
    }
    const firstKey = typeof first.metadata.assertionKey === "string" ? first.metadata.assertionKey.trim() : "";
    const secondKey = typeof second.metadata.assertionKey === "string" ? second.metadata.assertionKey.trim() : "";
    const normalize = (value: string) => value.replace(/^\[(?:global|project(?::[^\]]+)?)\]\s*/i, "").trim().replace(/\s+/g, " ").toLowerCase();
    if (!firstKey || firstKey !== secondKey || normalize(first.content) === normalize(second.content)) return { status: "not_conflicting" as const };
    const now = new Date().toISOString();
    const actor = String(options.reviewedBy || "owner").slice(0, 128);
    const conflictAudit = { conflictDetectedAt: now, conflictDetectedBy: actor, conflictReason: String(options.reason || "Owner confirmed conflicting assertions").slice(0, 240) };
    const firstMeta = { ...first.metadata, ...conflictAudit, updatedAt: now, lifecycleState: "conflicted", reviewState: "unreviewed", validationStatus: "candidate", conflictWithMemoryIds: [options.second.id] };
    const secondMeta = { ...second.metadata, ...conflictAudit, updatedAt: now, lifecycleState: "conflicted", reviewState: "unreviewed", validationStatus: "candidate", conflictWithMemoryIds: [options.first.id] };
    try {
      await rMemory.addMemory({ id: first.storageId, content: first.content, metadata: firstMeta });
      const firstWritten = rMemory.db?.getById?.(first.storageId);
      if (!firstWritten || firstWritten.metadata?.lifecycleState !== "conflicted" || !firstWritten.metadata?.conflictWithMemoryIds?.includes(options.second.id)) throw new Error("First conflict marker failed verification.");
      await rMemory.addMemory({ id: second.storageId, content: second.content, metadata: secondMeta });
      const secondWritten = rMemory.db?.getById?.(second.storageId);
      if (!secondWritten || secondWritten.metadata?.lifecycleState !== "conflicted" || !secondWritten.metadata?.conflictWithMemoryIds?.includes(options.first.id)) throw new Error("Second conflict marker failed verification.");
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const previous of [first, second]) {
        try { await rMemory.addMemory({ id: previous.storageId, content: previous.content, metadata: previous.metadata }); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Conflict pair update failed and rollback was incomplete.");
      throw new Error("Conflict pair update failed; both previous records were restored.", { cause: error });
    }
    return { status: "marked_conflicted" as const, firstId: options.first.id, secondId: options.second.id, assertionKey: firstKey, updatedAt: now };
  }

  async resolveAtomicConflictPair(options: {
    first: { id: string; expectedUpdatedAt: string };
    second: { id: string; expectedUpdatedAt: string };
    scope: "project" | "global";
    projectId: string;
    reviewedBy?: string;
  }) {
    const rMemory = await getRMemory();
    if (options.first.id === options.second.id) throw new Error("Conflict pair requires two distinct memory IDs.");
    const first = this.findAtomicByScope(rMemory, { id: options.first.id, scope: options.scope, projectId: options.projectId });
    const second = this.findAtomicByScope(rMemory, { id: options.second.id, scope: options.scope, projectId: options.projectId });
    if (!first || !second) return { status: "not_found" as const, firstFound: !!first, secondFound: !!second };
    const validScope = (record: { metadata: Record<string, any> }) => record.metadata.scope === options.scope
      && (options.scope === "global" ? !record.metadata.projectId : record.metadata.projectId === options.projectId);
    if (!validScope(first) || !validScope(second)) return { status: "needs_migration" as const };
    const version = (record: { metadata: Record<string, any> }) => typeof record.metadata.updatedAt === "string" && Number.isFinite(Date.parse(record.metadata.updatedAt)) ? new Date(record.metadata.updatedAt).toISOString() : "";
    const firstVersion = version(first); const secondVersion = version(second);
    const firstExpected = Date.parse(options.first.expectedUpdatedAt || ""); const secondExpected = Date.parse(options.second.expectedUpdatedAt || "");
    if (!firstVersion || !secondVersion || !Number.isFinite(firstExpected) || !Number.isFinite(secondExpected)
      || new Date(firstExpected).toISOString() !== firstVersion || new Date(secondExpected).toISOString() !== secondVersion) {
      return { status: "conflict" as const, firstUpdatedAt: firstVersion || undefined, secondUpdatedAt: secondVersion || undefined };
    }
    const firstKey = String(first.metadata.assertionKey || "").trim();
    const secondKey = String(second.metadata.assertionKey || "").trim();
    if (!firstKey || firstKey !== secondKey || first.metadata.lifecycleState !== "conflicted" || second.metadata.lifecycleState !== "conflicted"
      || !(Array.isArray(first.metadata.conflictWithMemoryIds) && first.metadata.conflictWithMemoryIds.includes(options.second.id))
      || !(Array.isArray(second.metadata.conflictWithMemoryIds) && second.metadata.conflictWithMemoryIds.includes(options.first.id))) return { status: "not_conflicted_pair" as const };
    const now = new Date().toISOString(); const actor = String(options.reviewedBy || "owner").slice(0, 128);
    const makeResolved = (metadata: Record<string, any>) => {
      const next: Record<string, any> = { ...metadata, updatedAt: now, lifecycleState: "active", reviewState: "reviewed", validationStatus: "unverified", reviewedAt: now, reviewedBy: actor };
      delete next.conflictWithMemoryIds;
      return next;
    };
    try {
      await rMemory.addMemory({ id: first.storageId, content: first.content, metadata: makeResolved(first.metadata) });
      const firstWritten = rMemory.db?.getById?.(first.storageId);
      if (!firstWritten || firstWritten.metadata?.lifecycleState !== "active" || firstWritten.metadata?.conflictWithMemoryIds) throw new Error("First conflict resolution failed verification.");
      await rMemory.addMemory({ id: second.storageId, content: second.content, metadata: makeResolved(second.metadata) });
      const secondWritten = rMemory.db?.getById?.(second.storageId);
      if (!secondWritten || secondWritten.metadata?.lifecycleState !== "active" || secondWritten.metadata?.conflictWithMemoryIds) throw new Error("Second conflict resolution failed verification.");
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const previous of [first, second]) {
        try { await rMemory.addMemory({ id: previous.storageId, content: previous.content, metadata: previous.metadata }); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Conflict resolution failed and rollback was incomplete.");
      throw new Error("Conflict resolution failed; both previous records were restored.", { cause: error });
    }
    return { status: "resolved" as const, firstId: options.first.id, secondId: options.second.id, assertionKey: firstKey, updatedAt: now, validationStatus: "unverified" as const };
  }

  async reviewAtomic(options: {
    id: string; scope: "project" | "global"; projectId: string; expectedUpdatedAt: string;
    action: "verify" | "quarantine" | "unquarantine" | "mark_conflicted" | "resolve_conflict";
    reason?: string; reviewedBy?: string; conflictWithMemoryIds?: string[];
  }) {
    const rMemory = await getRMemory();
    const current = this.findAtomicByScope(rMemory, options);
    if (!current) return { status: "not_found" as const, id: options.id };
    const meta = current.metadata;
    if (meta.scope !== options.scope || (options.scope === "project" && meta.projectId !== options.projectId)) return { status: "needs_migration" as const, id: options.id };
    const updatedAt = typeof meta.updatedAt === "string" && Number.isFinite(Date.parse(meta.updatedAt)) ? new Date(meta.updatedAt).toISOString() : "";
    const expected = Date.parse(options.expectedUpdatedAt || "");
    if (!updatedAt || !Number.isFinite(expected) || new Date(expected).toISOString() !== updatedAt) return { status: "conflict" as const, id: options.id, ...(updatedAt ? { currentUpdatedAt: updatedAt } : {}) };
    const now = new Date().toISOString();
    const next: Record<string, any> = { ...meta, updatedAt: now, reviewedAt: now, reviewedBy: String(options.reviewedBy || "owner").slice(0, 128) };
    if (options.action === "verify") {
      if (meta.lifecycleState === "conflicted" || meta.lifecycleState === "superseded" || meta.lifecycleState === "expired" || meta.reviewState === "quarantined") return { status: "review_required" as const, id: options.id };
      next.reviewState = "reviewed"; next.validationStatus = "verified"; next.lastVerifiedAt = now;
      delete next.quarantineReason;
    } else if (options.action === "quarantine") {
      next.reviewState = "quarantined"; next.quarantineReason = String(options.reason || "Owner requested quarantine").slice(0, 240);
    } else if (options.action === "unquarantine") {
      if (meta.reviewState !== "quarantined") return { status: "not_quarantined" as const, id: options.id };
      next.reviewState = "unreviewed"; next.validationStatus = "unverified"; delete next.quarantineReason;
    } else if (options.action === "mark_conflicted") {
      const ids = Array.from(new Set((options.conflictWithMemoryIds || []).filter(id => typeof id === "string" && id.trim() && id !== options.id).map(id => id.trim().slice(0, 160)))).slice(0, 20);
      if (!ids.length) throw new Error("At least one other memory ID is required to mark a conflict.");
      next.lifecycleState = "conflicted"; next.reviewState = "unreviewed"; next.validationStatus = "candidate"; next.conflictWithMemoryIds = ids;
    } else {
      if (meta.lifecycleState !== "conflicted") return { status: "not_conflicted" as const, id: options.id };
      next.lifecycleState = "active"; next.reviewState = "reviewed"; next.validationStatus = "unverified";
      delete next.conflictWithMemoryIds;
    }
    await rMemory.addMemory({ id: current.storageId, content: current.content, metadata: next });
    const written = rMemory.db?.getById?.(current.storageId);
    if (!written || written.content !== current.content || written.metadata?.updatedAt !== now || written.metadata?.scope !== options.scope) throw new Error("Memory review update could not be verified.");
    return { status: "updated" as const, id: options.id, action: options.action, updatedAt: now };
  }

  async deleteAtomicScoped(options: {
    id: string;
    scope: "project" | "global";
    projectId: string;
  }): Promise<boolean> {
    const rMemory = await getRMemory();
    const record = this.findAtomicByScope(rMemory, options);
    if (!record) return false;
    rMemory.delete(record.storageId);
    return true;
  }

  async deleteAtomic(options: { ids: string[] }): Promise<void> {
    const rMemory = await getRMemory();
    for (const id of options.ids) {
      rMemory.delete(id);
    }
  }

  async getConversationMessages(sessionId: string): Promise<{ role: string; content: string; timestamp: string }[]> {
    const rMemory = await getRMemory();
    try {
      // @ts-ignore
      const results = rMemory.db.getAll();
      const filtered = results.filter((item: any) => item.metadata && item.metadata.session === sessionId);
      filtered.sort((a: any, b: any) => {
        const tA = new Date(a.metadata?.timestamp || a.createdAt).getTime();
        const tB = new Date(b.metadata?.timestamp || b.createdAt).getTime();
        return tA - tB;
      });
      return filtered.map((r: any) => ({
        role: r.metadata?.role || "user",
        content: r.content,
        timestamp: r.metadata?.timestamp || new Date(r.createdAt).toISOString(),
      }));
    } catch (err) {
      console.error("Failed to retrieve conversation messages from RMemory:", err);
      return [];
    }
  }

  async readCore(): Promise<{ content: string | null }> {
    const personaPath = path.join(globalDataDir, "persona.md");
    try {
      if (fs.existsSync(personaPath)) {
        const content = fs.readFileSync(personaPath, "utf-8");
        return { content };
      }
    } catch (e) {
      console.error("Error reading persona.md:", e);
    }
    return { content: null };
  }

  async listScenarios(options: {}): Promise<{ entries: { path: string }[] }> {
    const sceneDir = path.join(globalDataDir, "scene_blocks");
    try {
      if (fs.existsSync(sceneDir)) {
        const files = fs.readdirSync(sceneDir);
        const entries = files
          .filter(f => f.endsWith(".md"))
          .map(f => ({ path: `scene_blocks/${f}` }));
        return { entries };
      }
    } catch (e) {
      console.error("Error listing scene_blocks:", e);
    }
    return { entries: [] };
  }

  async readScenario(options: { path: string }): Promise<{
    path: string;
    content: string | null;
    created_at: string | null;
    updated_at: string | null;
  }> {
    try {
      const resolvedPath = resolveScenarioPath(globalDataDir, options.path);
      // Read through a descriptor, rejecting final-component symlinks where supported
      // to reduce the gap between canonical-path validation and the actual read.
      const noFollow = (fs.constants as any).O_NOFOLLOW || 0;
      const descriptor = fs.openSync(resolvedPath, fs.constants.O_RDONLY | noFollow);
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile()) throw new Error("Scenario target is not a regular file.");
        const content = fs.readFileSync(descriptor, "utf-8");
        return {
          path: options.path,
          content,
          created_at: stat.birthtime.toISOString(),
          updated_at: stat.mtime.toISOString(),
        };
      } finally {
        fs.closeSync(descriptor);
      }
    } catch {
      return {
        path: options.path,
        content: null,
        created_at: null,
        updated_at: null,
      };
    }
    return {
      path: options.path,
      content: null,
      created_at: null,
      updated_at: null,
    };
  }

  async clear(): Promise<void> {
    const rMemory = await getRMemory();
    rMemory.clear();
    
    const personaPath = path.join(globalDataDir, "persona.md");
    if (fs.existsSync(personaPath)) {
      try {
        fs.unlinkSync(personaPath);
      } catch (e) {}
    }
    const sceneDir = path.join(globalDataDir, "scene_blocks");
    if (fs.existsSync(sceneDir)) {
      try {
        fs.rmSync(sceneDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }
}

export function getRMemoryClient(timeoutMs = 3000): MemoryClient {
  const settings = getSettings();
  const endpoint = settings.rmemoryGatewayUrl || "http://127.0.0.1:8420";
  const apiKey = settings.rmemoryGatewayApiKey || "";
  const serviceId = settings.rmemoryServiceId || "default";

  // MemoryClient reads/writes the local index, not the HTTP gateway.
  // A missing gateway token must never prevent local memory operations.
  return new MemoryClient({
    endpoint,
    apiKey,
    serviceId,
    timeout: timeoutMs,
  });


}

/** Canonical versioned identity shared by memory writes, search, and automatic recall. */
export function getRMemoryProjectId(cwd?: string): string {
  const normalizedPath = getNormalizedProjectPath(cwd || process.cwd()).replace(/\\/g, "/");
  const stablePath = process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
  return "p_" + createHash("sha256").update(stablePath).digest("hex").slice(0, 16);
}

/** Avoid collisions when projects intentionally reuse the same human-readable memory ID. */
export function getRMemoryStorageId(id: string, metadata?: Record<string, any>): string {
  if (metadata?.scope === "project" && typeof metadata.projectId === "string" && metadata.projectId.length > 0) {
    return `${metadata.projectId}:${id}`;
  }
  return id;
}

export function getRMemorySessionKey(historyPath: string | null): string {
  const keySource = historyPath || process.cwd();
  return createHash("sha1").update(keySource).digest("hex").slice(0, 8);
}

export async function isRmemoryActive(forceRefresh = false): Promise<boolean> {
  if (rMemoryInitFailed) return false;
  return !!getSettings().enableRmemory;
}

export function isRmemoryActiveSync(): boolean {
  if (rMemoryInitFailed) return false;
  return !!getSettings().enableRmemory;
}

function getSafeRMemoryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/api.?key|401|403|unauthori[sz]ed|forbidden/i.test(message)) return "Embedding provider authentication or authorization failed.";
  if (/embedding|embed|model|dimension|vector|pipeline/i.test(message)) return "Embedding model health check failed.";
  if (/database|sqlite|sql|migration|file|index/i.test(message)) return "Memory index initialization or migration failed.";
  return "RMemory initialization failed.";
}

/** Non-mutating, secret-safe snapshot for diagnostics and the rmemory_status tool. */
export function getRMemoryDiagnostics(): {
  enabled: boolean;
  provider: "local" | "openai";
  modelName: string;
  dimensions: number;
  indexReady: boolean;
  initializationState: "ready" | "not_initialized" | "degraded";
  migrationStatus: RMemoryMigrationStatus;
  degraded: boolean;
  retryAvailable: boolean;
  error: string | null;
} {
  const settings = getSettings();
  let info: ReturnType<typeof getActiveRMemoryEmbeddingInfo> | null = null;
  try { info = getActiveRMemoryEmbeddingInfo(); } catch {}
  const provider = info?.provider || (settings.rmemoryEmbeddingProvider === "openai" ? "openai" : "local");
  const modelName = info?.modelName || settings.rmemoryEmbeddingModel || (provider === "openai" ? "text-embedding-3-small" : DEFAULT_LOCAL_EMBEDDING_MODEL);
  const dimensions = info?.dimensions || settings.rmemoryEmbeddingDimensions || (modelName.toLowerCase().includes("nomic") ? 768 : 384);
  const degraded = rMemoryInitFailed;
  const indexReady = !!rMemoryInstance && !degraded;
  return {
    enabled: !!settings.enableRmemory,
    provider,
    modelName,
    dimensions,
    indexReady,
    initializationState: degraded ? "degraded" : indexReady ? "ready" : "not_initialized",
    migrationStatus: rMemoryMigrationStatus,
    degraded,
    retryAvailable: degraded,
    error: rMemoryLastSafeError,
  };
}

// ---------------------------------------------------------------------------
// Skill Semantic Search — standalone RMemory index for get_skills
// Uses the same local embedding model, but a separate DB (skills.db) so it never
// pollutes conversation memory. Active regardless of enableRmemory setting.
// ---------------------------------------------------------------------------

const skillsDataDir = path.join(os.homedir(), ".superagent-r", "rmemory-skills");
let skillsIndexInstance: any = null;
let skillsIndexHash: string = "";

async function getSkillsIndex(): Promise<any> {
  if (!skillsIndexInstance) {
    if (!fs.existsSync(skillsDataDir)) {
      fs.mkdirSync(skillsDataDir, { recursive: true });
    }
    const dbPath = path.join(skillsDataDir, "skills.db");
    const { RMemory } = await import("r-memory");
    const provider = new OptimizedLocalTextEmbeddingProvider({
      modelName: "Xenova/all-MiniLM-L6-v2",
      dtype: "q8",
      device: "cpu",
    });

    const migration = checkAndPerformDbMigration(skillsDataDir, "Xenova/all-MiniLM-L6-v2", provider.dimensions, { deferCommit: true });
    let candidate: any;
    try {
      candidate = new RMemory({ dbPath, collectionName: "skills", embeddingProvider: provider });
      const probeVector = await provider.embedText("SuperAgent skills index initialization probe", "passage");
      if (!Array.isArray(probeVector) || probeVector.length !== provider.dimensions || !probeVector.every((value: unknown) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`Skills embedding health check returned an invalid vector (expected ${provider.dimensions} finite dimensions).`);
      }
      const probeId = `__superagent_skills_probe_${process.pid}_${Date.now()}`;
      await candidate.addMemory({ id: probeId, content: "SuperAgent skills index initialization probe", embedding: probeVector, metadata: { type: "internal_probe", internalProbe: true } });
      candidate.delete(probeId);
      migration?.commit();
      skillsIndexInstance = candidate;
    } catch (error) {
      try { candidate?.close?.(); } catch {}
      try { migration?.rollback(); } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Skills index initialization failed and migration rollback needs manual inspection.");
      }
      throw error;
    }
  }
  return skillsIndexInstance;
}

function computeSkillsHash(skills: Array<{ name: string; description: string }>): string {
  const combined = skills.map((s) => `${s.name}::${s.description}`).join("|");
  return createHash("sha1").update(combined).digest("hex");
}

async function indexSkillsIfNeeded(skills: Array<{ name: string; description: string; path: string }>): Promise<void> {
  const newHash = computeSkillsHash(skills);

  if (!skillsIndexHash) {
    const hashPath = path.join(skillsDataDir, "skills.hash");
    if (fs.existsSync(hashPath)) {
      try {
        skillsIndexHash = fs.readFileSync(hashPath, "utf-8").trim();
      } catch {
        // ignore read errors
      }
    }
  }

  if (newHash === skillsIndexHash) return; // nothing changed

  const index = await getSkillsIndex();

  // Clear stale index
  try {
    index.clear();
  } catch {
    // ignore if already empty
  }

  // Batch-embed all skill texts (name + description)
  const texts = skills.map((s) => `${s.name}: ${s.description}`);
  const BATCH = 16;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    let batchEmbeddings: number[][];
    if (index.provider && typeof index.provider.embedTexts === "function") {
      batchEmbeddings = await index.provider.embedTexts(batch);
    } else {
      batchEmbeddings = await Promise.all(batch.map((t: string) => index.provider.embedText(t)));
    }
    allEmbeddings.push(...batchEmbeddings);
  }

  // Store each skill as a memory entry keyed by its name
  for (let i = 0; i < skills.length; i++) {
    await index.addMemory({
      id: `skill-${i}`,
      content: texts[i],
      embedding: allEmbeddings[i],
      metadata: { name: skills[i].name, skillPath: skills[i].path },
    });
  }

  skillsIndexHash = newHash;
  try {
    const hashPath = path.join(skillsDataDir, "skills.hash");
    fs.writeFileSync(hashPath, newHash, "utf-8");
  } catch {
    // ignore write errors
  }
}

export interface LoadedSkillRef {
  name: string;
  description: string;
  path: string;
  author?: string;
}

/**
 * Semantic skill search using local embeddings via RMemory.
 * Falls back gracefully (returns []) on any error so callers can use TF-IDF fallback.
 */
export async function searchSkillsByQuery(
  query: string,
  skills: LoadedSkillRef[],
  limit = 8,
): Promise<LoadedSkillRef[]> {
  if (!query || skills.length === 0) return [];

  try {
    await indexSkillsIfNeeded(skills);
    const index = await getSkillsIndex();

    const results = await index.query({ query, limit, hybrid: true });
    if (!results || results.length === 0) return [];

    // Map results back to full LoadedSkillRef objects via skill name in metadata
    const found: LoadedSkillRef[] = [];
    for (const r of results) {
      const skillName: string | undefined = r.memory?.metadata?.name;
      if (!skillName) continue;
      const match = skills.find((s) => s.name === skillName);
      if (match) found.push(match);
    }
    return found;
  } catch {
    return [];
  }
}

