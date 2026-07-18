import { getSettings } from "./config.js";
import { getConfiguredProviders } from "./config/providers.js";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

const globalDataDir = path.join(os.homedir(), ".superagent-r", "rmemory");

class OptimizedLocalTextEmbeddingProvider {
  get dimensions(): number {
    return this.modelName.includes("nomic") ? 768 : 384;
  }
  private modelName: string;
  private device: string;
  private dtype: string;
  private extractor: any = null;

  constructor(options: { modelName?: string; device?: string; dtype?: string } = {}) {
    let name = options.modelName || "nomic-ai/nomic-embed-text-v1.5";
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
      const { pipeline } = await import("@huggingface/transformers");
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
        },
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
                progress: pct
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
    }
    return this.extractor;
  }

  async embedText(text: string, type?: "query" | "passage"): Promise<number[]> {
    const formattedText = this.formatText(text, type);
    const extractor = await this.getExtractor();
    const output = await extractor(formattedText, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data);
  }

  async embedTexts(texts: string[], type?: "query" | "passage"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const formattedTexts = texts.map(t => this.formatText(t, type));
    const extractor = await this.getExtractor();
    const output = await extractor(formattedTexts, {
      pooling: "mean",
      normalize: true,
    });
    const dims = this.dimensions;
    const data = output.data;
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      const start = i * dims;
      const end = start + dims;
      results.push(Array.from(data.subarray(start, end)));
    }
    return results;
  }

  async embedImage(image: string | Buffer | Uint8Array): Promise<number[]> {
    throw new Error("LocalTextEmbeddingProvider does not support image embeddings.");
  }
}

function checkAndPerformDbMigration(currentModelName: string, currentDimensions: number) {
  const metadataPath = path.join(globalDataDir, "metadata.json");
  const dbPath = path.join(globalDataDir, "vectors.db");

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
    if (fs.existsSync(dbPath)) {
      migrateNeeded = true;
    }
  }

  if (migrateNeeded) {
    try {
      const filesToDelete = [
        path.join(globalDataDir, "vectors.db"),
        path.join(globalDataDir, "vectors.db-wal"),
        path.join(globalDataDir, "vectors.db-shm"),
        path.join(globalDataDir, "skills.db"),
        path.join(globalDataDir, "skills.db-wal"),
        path.join(globalDataDir, "skills.db-shm"),
        path.join(globalDataDir, "skills.hash")
      ];
      for (const file of filesToDelete) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    } catch (err) {
      console.error("Failed to delete stale DB files during embedding model migration:", err);
    }
  }

  try {
    fs.writeFileSync(metadataPath, JSON.stringify({
      modelName: currentModelName,
      dimensions: currentDimensions
    }), "utf-8");
  } catch {
    // Ignore write errors
  }
}

let rMemoryInstance: any = null;

async function getRMemory(): Promise<any> {
  if (!rMemoryInstance) {
    if (!fs.existsSync(globalDataDir)) {
      fs.mkdirSync(globalDataDir, { recursive: true });
    }
    const dbPath = path.join(globalDataDir, "vectors.db");
    
    const { RMemory, OpenAIEmbeddingProvider } = await import("r-memory");
    const settings = getSettings();
    
    let provider;
    if (settings.rmemoryEmbeddingProvider === "openai") {
      const activeProvider = getConfiguredProviders().find(p => p.isActive);
      const isOpenAICompatible = activeProvider && (
        activeProvider.type === "openai" ||
        activeProvider.type === "openrouter" ||
        activeProvider.type === "custom" ||
        activeProvider.type === "ollama" ||
        activeProvider.type === "lmstudio"
      );
      
      const apiKey = isOpenAICompatible ? activeProvider.apiKey : (process.env.OPENAI_API_KEY || "");
      const baseURL = isOpenAICompatible ? activeProvider.baseUrl : undefined;
      
      provider = new OpenAIEmbeddingProvider({
        apiKey,
        baseURL,
        model: settings.rmemoryEmbeddingModel || "text-embedding-3-small",
        dimensions: settings.rmemoryEmbeddingDimensions || 1536,
      });
    } else {
      provider = new OptimizedLocalTextEmbeddingProvider({
        modelName: "nomic-ai/nomic-embed-text-v1.5",
        dtype: "q8",
        device: "cpu",
      });
    }
    
    const currentModelName = settings.rmemoryEmbeddingProvider === "openai"
      ? (settings.rmemoryEmbeddingModel || "text-embedding-3-small")
      : "nomic-ai/nomic-embed-text-v1.5";
    
    checkAndPerformDbMigration(currentModelName, provider.dimensions);

    rMemoryInstance = new RMemory({
      dbPath,
      collectionName: "memories",
      embeddingProvider: provider,
    });
  }
  return rMemoryInstance;
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
          session: options.session_id,
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
  }): Promise<{ messages: { role: string; content: string; timestamp: string; session_id?: string }[] }> {
    const rMemory = await getRMemory();
    const limit = options.limit ?? 5;
    
    const results = await rMemory.query({
      query: options.query,
      limit,
      hybrid: true,
    });

    const messages = results
      .filter((r: any) => r.memory.metadata && r.memory.metadata.role)
      .map((r: any) => ({
        role: r.memory.metadata.role,
        content: r.memory.content,
        timestamp: r.memory.metadata.timestamp || new Date(r.memory.createdAt).toISOString(),
        session_id: r.memory.metadata.session,
      }));

    return { messages };
  }

  async searchAtomic(options: {
    query: string;
    limit?: number;
  }): Promise<{ items: { id: string; content: string; type: string; score: number }[] }> {
    const rMemory = await getRMemory();
    const limit = options.limit ?? 5;

    const results = await rMemory.query({
      query: options.query,
      limit,
      hybrid: true,
    });

    const items = results.map((r: any) => ({
      id: r.memory.id,
      content: r.memory.content,
      type: r.memory.metadata?.type || "memory",
      score: r.score ?? (1.0 - r.distance),
    }));

    return { items };
  }

  async updateAtomic(options: {
    id: string;
    content: string;
  }): Promise<{ id: string; updated_at: string }> {
    const rMemory = await getRMemory();
    
    const content = options.content || "";
    const truncatedContent = content.length > 8000
      ? content.substring(0, 8000) + "... [truncated]"
      : content;

    await rMemory.addMemory({
      id: options.id,
      content: truncatedContent,
      metadata: {
        type: "memory",
      },
    });

    return {
      id: options.id,
      updated_at: new Date().toISOString(),
    };
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
    const resolvedPath = path.join(globalDataDir, options.path);
    try {
      if (fs.existsSync(resolvedPath)) {
        const content = fs.readFileSync(resolvedPath, "utf-8");
        const stat = fs.statSync(resolvedPath);
        return {
          path: options.path,
          content,
          created_at: stat.birthtime.toISOString(),
          updated_at: stat.mtime.toISOString(),
        };
      }
    } catch (e) {
      console.error(`Error reading scenario file ${options.path}:`, e);
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
  const apiKey = settings.rmemoryGatewayApiKey || "sk-xxxx";
  const serviceId = settings.rmemoryServiceId || "default";

  return new MemoryClient({
    endpoint,
    apiKey,
    serviceId,
    timeout: timeoutMs,
  });
}

export function getRMemorySessionKey(historyPath: string | null): string {
  const keySource = historyPath || process.cwd();
  return createHash("sha1").update(keySource).digest("hex").slice(0, 8);
}

export async function isRmemoryActive(forceRefresh = false): Promise<boolean> {
  return !!getSettings().enableRmemory;
}

// ---------------------------------------------------------------------------
// Skill Semantic Search — standalone RMemory index for get_skills
// Uses the same local embedding model, but a separate DB (skills.db) so it never
// pollutes conversation memory. Active regardless of enableRmemory setting.
// ---------------------------------------------------------------------------

const skillsDataDir = path.join(os.homedir(), ".superagent-r", "rmemory");
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
      modelName: "nomic-ai/nomic-embed-text-v1.5",
      dtype: "q8",
      device: "cpu",
    });

    checkAndPerformDbMigration("nomic-ai/nomic-embed-text-v1.5", provider.dimensions);

    skillsIndexInstance = new RMemory({
      dbPath,
      collectionName: "skills",
      embeddingProvider: provider,
    });
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

