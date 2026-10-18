import { getSettings } from "./config/jsonConfig.js";
import { getConfiguredProviders } from "./config/providers.js";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { getNormalizedProjectPath } from "./tools/helpers.js";
import { createMemoryRecordMetadata, isMemoryRecordMetadata } from "./memoryRecord.js";

const globalDataDir = path.join(os.homedir(), ".superagent-r", "rmemory");

export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

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

  private async getExtractor() {
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

  async embedText(text: string, type?: "query" | "passage"): Promise<number[]> {
    try {
      const formattedText = this.formatText(text, type);
      const extractor = await this.getExtractor();
      const output = await extractor(formattedText, {
        pooling: "mean",
        normalize: true,
      });
      const result = Array.from(output.data) as number[];
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
    const results: number[][] = [];
    const BATCH_SIZE = 8;
    const extractor = await this.getExtractor();
    
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const formattedTexts = batch.map(t => this.formatText(t, type));
      const output = await extractor(formattedTexts, {
        pooling: "mean",
        normalize: true,
      });
      const dims = this.dimensions;
      const data = output.data;
      for (let j = 0; j < batch.length; j++) {
        const start = j * dims;
        const end = start + dims;
        results.push(Array.from(data.subarray(start, end)));
      }
      if (output && typeof output.dispose === "function") {
        try {
          output.dispose();
        } catch {}
      }
    }
    return results;
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
  const backupDir = path.join(path.dirname(targetDir), "." + path.basename(targetDir) + "-index-backup-" + process.pid + "-" + Date.now());
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
      // Treat backup cleanup as post-commit best-effort, never as a rollback trigger.
      if (previousMetadataMoved) { try { fs.rmSync(previousMetadataPath, { force: true }); } catch {} }
      if (movedArtifacts.length > 0) { try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {} }
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
        try { fs.rmSync(previousMetadataPath, { force: true }); } catch {}
      }
      if (movedArtifacts.length > 0) {
        try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
      }
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
let cachedRMemoryModelName: string = "";
let cachedRMemoryDimensions: number = 0;
let rMemoryInitFailed = false;
let rMemoryInitError: any = null;
let hasLoggedInitError = false;
let rMemoryMigrationStatus: RMemoryMigrationStatus = "not_checked";
let rMemoryLastSafeError: string | null = null;

async function getRMemory(): Promise<any> {
  let pendingMigration: RMemoryMigrationTransaction | undefined;
  let pendingCandidate: any = null;
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
      if (!fs.existsSync(globalDataDir)) {
        fs.mkdirSync(globalDataDir, { recursive: true });
      }
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
    messages: { role: "user" | "assistant" | "system"; content: string; timestamp?: string }[];
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

    // Pre-process messages to truncate excessively long content and avoid OOM / ONNX allocation failures on CPU
    const texts = options.messages.map(msg => {
      const content = msg.content || "";
      return content.length > 8000 ? content.substring(0, 8000) + "... [truncated]" : content;
    });

    // Chunk text embedding generation to keep concurrent batch size small (max 8)
    const BATCH_SIZE = 8;
    const embeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      let batchEmbeddings: number[][];
      if (rMemory.provider && typeof rMemory.provider.embedTexts === "function") {
        batchEmbeddings = await rMemory.provider.embedTexts(batch, "passage");
      } else {
        batchEmbeddings = await Promise.all(
          batch.map(text => rMemory.provider.embedText(text, "passage"))
        );
      }
      embeddings.push(...batchEmbeddings);
    }

    for (let i = 0; i < options.messages.length; i++) {
      const msg = options.messages[i];
      const id = Math.random().toString(36).substring(7);
      await rMemory.addMemory({
        id,
        content: texts[i],
        embedding: embeddings[i],
        metadata: {
          type: "message",
          session: options.session_id,
          ...(options.projectId ? { scope: "project", projectId: options.projectId } : {}),
          role: msg.role,
          timestamp: msg.timestamp || new Date().toISOString(),
        },
      });
      accepted_ids.push(id);
    }

    // @ts-ignore
    const count = rMemory.db.getAll({ session: options.session_id }).length;

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
    const rMemory = await getRMemory();
    const limit = options.limit ?? 5;
    
    const results = await rMemory.query({
      query: options.query,
      limit,
      hybrid: true,
      filter: options.projectId ? { type: "message", projectId: options.projectId } : { type: "message" },
    });

    const messages = results
      .filter((r: any) => r.memory.metadata && r.memory.metadata.role)
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
    const limit = options.limit ?? 5;
    let results: any[];
    if (options.projectId) {
      const [projectResults, globalResults, legacyResults] = await Promise.all([
        rMemory.query({ query: options.query, limit, hybrid: true, filter: { scope: "project", projectId: options.projectId } }),
        rMemory.query({ query: options.query, limit, hybrid: true, filter: { scope: "global" } }),
        rMemory.query({ query: options.query, limit: Math.max(limit * 4, 20), hybrid: true, filter: { type: "memory" } }),
      ]);
      const safeLegacyResults = legacyResults.filter((r: any) => {
        const metadata = r.memory?.metadata || {};
        const content = String(r.memory?.content || "");
        if (metadata.scope) return false;
        return content.startsWith("[global]") || content.startsWith(`[project:${options.projectId}]`);
      });
      const byId = new Map<string, any>();
      for (const result of [...projectResults, ...globalResults, ...safeLegacyResults]) {
        const id = String(result.memory?.id || "");
        if (id && !byId.has(id)) byId.set(id, result);
      }
      results = Array.from(byId.values()).sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1)).slice(0, limit);
    } else {
      results = await rMemory.query({ query: options.query, limit, hybrid: true });
    }
    const items = results.map((r: any) => ({
      id: r.memory.id,
      content: r.memory.content,
      type: r.memory.metadata?.memoryType || r.memory.metadata?.type || "memory",
      score: r.score ?? (1.0 - r.distance),
      metadata: r.memory.metadata,
    }));
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
    const truncatedContent = content.length > 8000
      ? content.substring(0, 8000) + "... [truncated]"
      : content;
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
      return updatedB - updatedA;
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

const RMEMORY_GATEWAY_KEY_MISSING_ERROR =
  "rmemory gateway API key is not configured. Set it via /settings.";

export function getRMemoryClient(timeoutMs = 3000): MemoryClient {
  const settings = getSettings();
  const endpoint = settings.rmemoryGatewayUrl || "http://127.0.0.1:8420";
  const apiKey = settings.rmemoryGatewayApiKey || "";
  const serviceId = settings.rmemoryServiceId || "default";

  const client = new MemoryClient({
    endpoint,
    apiKey,
    serviceId,
    timeout: timeoutMs,
  });

  if (!apiKey.trim()) {
    return new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") {
          return (...callArgs: unknown[]) =>
            Promise.reject(new Error(RMEMORY_GATEWAY_KEY_MISSING_ERROR));
        }
        return value;
      },
    }) as MemoryClient;
  }

  return client;
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

