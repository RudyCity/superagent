import { RMemory, LocalTextEmbeddingProvider } from "r-memory";
import { getSettings } from "./config.js";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

const globalDataDir = path.join(os.homedir(), ".superagent-r", "rmemory");

let rMemoryInstance: RMemory | null = null;

function getRMemory(): RMemory {
  if (!rMemoryInstance) {
    if (!fs.existsSync(globalDataDir)) {
      fs.mkdirSync(globalDataDir, { recursive: true });
    }
    const dbPath = path.join(globalDataDir, "vectors.db");
    
    const provider = new LocalTextEmbeddingProvider({
      dtype: "q8",
      device: "cpu",
    });
    
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
    const rMemory = getRMemory();
    const accepted_ids: string[] = [];
    
    for (const msg of options.messages) {
      const id = Math.random().toString(36).substring(7);
      await rMemory.addMemory({
        id,
        content: msg.content,
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
  }): Promise<{ messages: { role: string; content: string; timestamp: string }[] }> {
    const rMemory = getRMemory();
    const limit = options.limit ?? 5;
    
    const results = await rMemory.query({
      query: options.query,
      limit,
      hybrid: true,
    });

    const messages = results
      .filter(r => r.memory.metadata && r.memory.metadata.role)
      .map(r => ({
        role: r.memory.metadata.role,
        content: r.memory.content,
        timestamp: r.memory.metadata.timestamp || new Date(r.memory.createdAt).toISOString(),
      }));

    return { messages };
  }

  async searchAtomic(options: {
    query: string;
    limit?: number;
  }): Promise<{ items: { id: string; content: string; type: string; score: number }[] }> {
    const rMemory = getRMemory();
    const limit = options.limit ?? 5;

    const results = await rMemory.query({
      query: options.query,
      limit,
      hybrid: true,
    });

    const items = results.map(r => ({
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
    const rMemory = getRMemory();
    
    await rMemory.addMemory({
      id: options.id,
      content: options.content,
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
    const rMemory = getRMemory();
    for (const id of options.ids) {
      rMemory.delete(id);
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
    const rMemory = getRMemory();
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
  return false;
}

