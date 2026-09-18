import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { isValidLesson } from "./lessonValidation.js";
import { SELFDEV_LIMITS, SELFDEV_STORE_SCHEMA_VERSION,
  type SelfDevLesson, type SelfDevLessonInput, type SelfDevLessonUpdate,
  type SelfDevStoreData } from "./types.js";

export const MAX_CANDIDATE_STORE_BYTES = 16 * 1024 * 1024;
export interface CandidateStoreOptions {
  storePath: string;
  workspace: string;
  enabled?: () => boolean;
  /** Global count limit, bounded by the shared hard cap. */
  maxLessons?: number;
}
const inputFields = ["id", "workspace", "statement", "rationale", "evidenceIds", "tags"];
const patchFields = ["statement", "rationale", "evidenceIds", "tags"];
const lessonFields = [...inputFields, "version", "status", "createdAt", "updatedAt"];
function fields(value: unknown, allowed: string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key) &&
      Object.getOwnPropertyDescriptor(value, key)?.get === undefined &&
      Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}
function candidate(value: unknown): asserts value is SelfDevLesson {
  if (!fields(value, lessonFields) || !isValidLesson(value) || value.status !== "candidate") {
    throw new Error("Invalid candidate lesson");
  }
}
function copy(lesson: SelfDevLesson): SelfDevLesson {
  return { id: lesson.id, workspace: lesson.workspace, version: lesson.version, status: "candidate",
    statement: lesson.statement,
    ...(lesson.rationale === undefined ? {} : { rationale: lesson.rationale }),
    evidenceIds: [...lesson.evidenceIds], tags: [...lesson.tags],
    createdAt: lesson.createdAt, updatedAt: lesson.updatedAt };
}
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
/**
 * Candidate-only storage; structural validation is NOT evidence verification or redaction.
 * Workspace equality is exact; normalization is deferred to a future trusted runtime.
 * No approval, activation, injection, settings, or default global path.
 * Cooperating processes must use the same path without symlink/path aliases.
 * Locks fail fast and are never automatically reclaimed after a crash.
 * Disabled operations return empty/undefined without filesystem access.
 */
export class CandidateStore {
  readonly #path: string;
  readonly #workspace: string;
  readonly #enabled: () => boolean;
  readonly #maxLessons: number;
  constructor(options: CandidateStoreOptions) {
    if (typeof options.storePath !== "string" || !isAbsolute(options.storePath)) {
      throw new Error("storePath must be absolute");
    }
    if (typeof options.workspace !== "string" || !options.workspace.trim() ||
        options.workspace.length > SELFDEV_LIMITS.MAX_CONTEXT_ID_LENGTH) throw new Error("Invalid workspace");
    const max = options.maxLessons ?? SELFDEV_LIMITS.MAX_LESSONS;
    if (!Number.isSafeInteger(max) || max < 1 || max > SELFDEV_LIMITS.MAX_LESSONS) {
      throw new Error("Invalid maxLessons");
    }
    this.#path = options.storePath;
    this.#workspace = options.workspace;
    this.#enabled = options.enabled ?? (() => false);
    this.#maxLessons = max;
  }
  async list(): Promise<SelfDevLesson[]> {
    if (!this.#enabled()) return [];
    return (await this.#read()).lessons.filter(lesson => lesson.workspace === this.#workspace);
  }
  async get(id: string): Promise<SelfDevLesson | undefined> {
    if (!this.#enabled()) return undefined;
    return (await this.#read()).lessons.find(lesson => lesson.workspace === this.#workspace && lesson.id === id);
  }
  async create(input: SelfDevLessonInput): Promise<SelfDevLesson | undefined> {
    if (!this.#enabled()) return undefined;
    if (!fields(input, inputFields) || input.workspace !== this.#workspace) {
      throw new Error("Invalid candidate input or workspace");
    }
    const now = Date.now();
    const lesson = { id: input.id === undefined ? randomUUID() : input.id,
      workspace: input.workspace, statement: input.statement, rationale: input.rationale,
      evidenceIds: input.evidenceIds, tags: input.tags === undefined ? [] : input.tags,
      version: 1, status: "candidate", createdAt: now, updatedAt: now };
    candidate(lesson);
    const snapshot = copy(lesson);
    return this.#mutate(data => {
      if (data.lessons.length >= this.#maxLessons) throw new Error("Lesson limit exceeded");
      if (data.lessons.some(item => item.workspace === this.#workspace && item.id === snapshot.id)) {
        throw new Error("Candidate already exists");
      }
      data.lessons.push(snapshot);
      return snapshot;
    });
  }
  async update(id: string, expectedVersion: number, patch: SelfDevLessonUpdate): Promise<SelfDevLesson | undefined> {
    if (!this.#enabled()) return undefined;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !fields(patch, patchFields)) {
      throw new Error("Invalid candidate update");
    }
    // Snapshot before awaiting, so caller mutation cannot bypass validation.
    const changes = { statement: patch.statement, rationale: patch.rationale,
      evidenceIds: Array.isArray(patch.evidenceIds) ? [...patch.evidenceIds] : patch.evidenceIds,
      tags: Array.isArray(patch.tags) ? [...patch.tags] : patch.tags };
    return this.#mutate(data => {
      const index = data.lessons.findIndex(item => item.workspace === this.#workspace && item.id === id);
      if (index < 0) throw new Error("Candidate not found");
      const current = data.lessons[index];
      if (current.version !== expectedVersion) throw new Error("Candidate version conflict");
      const updated = { ...copy(current), version: current.version + 1,
        updatedAt: Math.max(Date.now(), current.updatedAt),
        statement: changes.statement === undefined ? current.statement : changes.statement,
        rationale: changes.rationale === undefined ? current.rationale : changes.rationale,
        evidenceIds: changes.evidenceIds === undefined ? current.evidenceIds : changes.evidenceIds,
        tags: changes.tags === undefined ? current.tags : changes.tags };
      candidate(updated);
      data.lessons[index] = copy(updated);
      return data.lessons[index];
    });
  }
  async #read(): Promise<SelfDevStoreData> {
    const file = await open(this.#path, "r").catch(error => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!file) return { schemaVersion: SELFDEV_STORE_SCHEMA_VERSION, updatedAt: 0, lessons: [] };
    let text: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_CANDIDATE_STORE_BYTES) throw new Error("Store file size/type limit exceeded");
      // Bound the read itself as well as stat, including growth after stat.
      const buffer = Buffer.alloc(MAX_CANDIDATE_STORE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_CANDIDATE_STORE_BYTES) throw new Error("Store byte limit exceeded");
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } finally { await file.close(); }
    const data: unknown = JSON.parse(text);
    if (!fields(data, ["schemaVersion", "updatedAt", "lessons"]) ||
        data.schemaVersion !== SELFDEV_STORE_SCHEMA_VERSION ||
        !Number.isSafeInteger(data.updatedAt) || (data.updatedAt as number) < 0 ||
        !Array.isArray(data.lessons) || data.lessons.length > this.#maxLessons) {
      throw new Error("Invalid or unsupported candidate store");
    }
    const ids = new Set<string>();
    const lessons = data.lessons.map((value: unknown) => {
      candidate(value);
      const key = JSON.stringify([value.workspace, value.id]);
      if (ids.has(key)) throw new Error("Duplicate candidate in store");
      ids.add(key);
      return copy(value);
    });
    return { schemaVersion: SELFDEV_STORE_SCHEMA_VERSION, updatedAt: data.updatedAt as number, lessons };
  }
  async #mutate(change: (data: SelfDevStoreData) => SelfDevLesson): Promise<SelfDevLesson> {
    await mkdir(dirname(this.#path), { recursive: true });
    const lockPath = `${this.#path}.lock`;
    const lock = await open(lockPath, "wx", 0o600).catch(error => {
      if (hasCode(error, "EEXIST")) throw new Error("Candidate store busy");
      throw error;
    });
    try {
      const data = await this.#read();
      const result = change(data);
      data.updatedAt = Math.max(Date.now(), data.updatedAt, result.updatedAt);
      const bytes = Buffer.from(JSON.stringify(data), "utf8");
      if (bytes.length > MAX_CANDIDATE_STORE_BYTES) throw new Error("Store byte limit exceeded");
      await this.#persist(bytes);
      return copy(result);
    } finally {
      try {
        const owned = await lock.stat();
        const current = await lstat(lockPath).catch(error => {
          if (hasCode(error, "ENOENT")) return undefined;
          throw error;
        });
        if (current?.dev === owned.dev && current.ino === owned.ino) await unlink(lockPath);
      } finally { await lock.close(); }
    }
  }
  async #persist(bytes: Buffer): Promise<void> {
    const tempPath = `${this.#path}.${randomUUID()}.tmp`;
    const temp = await open(tempPath, "wx", 0o600);
    let renamed = false;
    try {
      try { await temp.writeFile(bytes); await temp.sync(); }
      finally { await temp.close(); }
      await rename(tempPath, this.#path);
      renamed = true;
    } finally { if (!renamed) await unlink(tempPath); }
  }
}
