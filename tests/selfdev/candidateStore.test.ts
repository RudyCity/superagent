import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CandidateStore, MAX_CANDIDATE_STORE_BYTES } from "../../src/core/selfdev/candidateStore.js";
import { SELFDEV_LIMITS, SELFDEV_STORE_SCHEMA_VERSION, type SelfDevLessonInput, type SelfDevLessonUpdate } from "../../src/core/selfdev/types.js";

async function fixture() {
  const root = resolve("tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "candidate-store-"));
  const storePath = join(dir, "lessons.json");
  const store = new CandidateStore({ storePath, workspace: "scope-a", enabled: () => true });
  return { dir, storePath, store };
}
const input = { workspace: "scope-a", statement: "Run the focused tests", evidenceIds: ["test-1"] };

describe("CandidateStore", () => {
  it("persists revisions across restart and isolates exact scopes", async () => {
    const { store, storePath } = await fixture();
    const created = await store.create({ ...input, id: "shared" });
    const other = new CandidateStore({ storePath, workspace: "scope-b", enabled: () => true });
    expect(await other.get("shared")).toBeUndefined();
    await expect(other.update("shared", 1, { statement: "Other" })).rejects.toThrow("not found");
    await other.create({ ...input, workspace: "scope-b", id: "shared" });
    const restarted = new CandidateStore({ storePath, workspace: input.workspace, enabled: () => true });
    expect(await restarted.get("shared")).toEqual(created);
    const updated = await restarted.update("shared", 1, { statement: "Check types too", tags: ["test"] });
    expect(updated).toMatchObject({ version: 2, status: "candidate", createdAt: created?.createdAt });
    await expect(store.update("shared", 1, {})).rejects.toThrow("version conflict");
    expect(await store.list()).toEqual([updated]);
    expect((await other.get("shared"))?.version).toBe(1);
    expect(await new CandidateStore({ storePath, workspace: "SCOPE-A", enabled: () => true }).list()).toEqual([]);
    expect(Object.getOwnPropertyNames(CandidateStore.prototype).sort()).toEqual(["constructor", "create", "get", "list", "update"]);
  });

  it("does no filesystem work when disabled and no mkdir on enabled reads", async () => {
    const { dir } = await fixture();
    const storePath = join(dir, "missing", "lessons.json");
    let enabled = false;
    const store = new CandidateStore({ storePath, workspace: input.workspace, enabled: () => enabled });
    const defaults = new CandidateStore({ storePath, workspace: input.workspace });
    expect(await defaults.create(input)).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(await store.get("id")).toBeUndefined();
    expect(await store.create(input)).toBeUndefined();
    expect(await store.update("id", 1, {})).toBeUndefined();
    enabled = true;
    expect(await store.list()).toEqual([]);
    expect(await store.get("id")).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    await store.create(input);
    enabled = false;
    await writeFile(storePath, "corrupt");
    expect(await store.list()).toEqual([]);
    expect(await store.get("id")).toBeUndefined();
    expect(await store.create(input)).toBeUndefined();
    expect(await store.update("id", 1, {})).toBeUndefined();
    expect(await readFile(storePath, "utf8")).toBe("corrupt");
  });

  it("rejects invalid settings, unknown input fields and forged lifecycle fields", async () => {
    const { dir, storePath, store } = await fixture();
    expect(() => new CandidateStore({ storePath: "relative.json", workspace: input.workspace })).toThrow("absolute");
    for (const maxLessons of [0, -1, 1.5, NaN, SELFDEV_LIMITS.MAX_LESSONS + 1]) {
      expect(() => new CandidateStore({ storePath, workspace: input.workspace, maxLessons })).toThrow("maxLessons");
    }
    for (const workspace of ["", " ", "x".repeat(SELFDEV_LIMITS.MAX_CONTEXT_ID_LENGTH + 1)]) {
      expect(() => new CandidateStore({ storePath, workspace })).toThrow("workspace");
    }
    const invalid: unknown[] = [null, [], { ...input, statement: " " }, { ...input, evidenceIds: [] },
      { ...input, evidenceIds: ["a", "a"] }, { ...input, workspace: "scope-b" },
      { ...input, statement: "x".repeat(SELFDEV_LIMITS.MAX_STATEMENT_LENGTH + 1) },
      ...["status", "approvedBy", "approvedAt", "retiredReason", "extra", "version"].map(key => ({ ...input, [key]: "forged" }))];
    for (const value of invalid) await expect(store.create(value as SelfDevLessonInput)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
    await store.create({ ...input, id: "one" });
    const before = await readFile(storePath, "utf8");
    for (const value of [{ status: "active" }, { approvedBy: "human" }, { extra: true }, { evidenceIds: [] }, { statement: " " }]) {
      await expect(store.update("one", 1, value as SelfDevLessonUpdate)).rejects.toThrow();
    }
    for (const version of [0, -1, NaN, 1.5, 2]) await expect(store.update("one", version, {})).rejects.toThrow();
    await expect(store.create({ ...input, id: "one" })).rejects.toThrow("already exists");
    expect(await readFile(storePath, "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual(["lessons.json"]);
  });

  it("enforces the maximum count on writes and oversized stored counts on reads", async () => {
    const { storePath, dir } = await fixture();
    const store = new CandidateStore({ storePath, workspace: input.workspace, enabled: () => true, maxLessons: 2 });
    await store.create({ ...input, id: "one" });
    await store.create({ ...input, id: "two" });
    const before = await readFile(storePath, "utf8");
    await expect(store.create({ ...input, id: "three" })).rejects.toThrow("limit");
    expect(await readFile(storePath, "utf8")).toBe(before);
    expect(await store.update("one", 1, { statement: "Still editable" })).toMatchObject({ version: 2 });
    const stricter = new CandidateStore({ storePath, workspace: input.workspace, enabled: () => true, maxLessons: 1 });
    await expect(stricter.list()).rejects.toThrow("Invalid");
    expect(await readdir(dir)).toEqual(["lessons.json"]);
  });

  it("accepts the shared hard maximum and rejects one more lesson", async () => {
    const { storePath, store } = await fixture();
    const lesson = await store.create(input);
    const lessons = Array.from({ length: SELFDEV_LIMITS.MAX_LESSONS - 1 }, (_, i) => ({ ...lesson, id: `seed-${i}` }));
    await writeFile(storePath, JSON.stringify({ schemaVersion: SELFDEV_STORE_SCHEMA_VERSION, updatedAt: Date.now(), lessons }));
    await store.create({ ...input, id: "last" });
    expect(await store.list()).toHaveLength(SELFDEV_LIMITS.MAX_LESSONS);
    const before = await readFile(storePath, "utf8");
    await expect(store.create({ ...input, id: "overflow" })).rejects.toThrow("limit");
    expect(await readFile(storePath, "utf8")).toBe(before);
  });

  it("bounds serialized writes including JSON escaping, releasing the lock on failure", async () => {
    const { storePath, store, dir } = await fixture();
    const lesson = await store.create(input);
    const large = { ...lesson, id: "seed-0000", statement: "\u0001".repeat(SELFDEV_LIMITS.MAX_STATEMENT_LENGTH),
      rationale: "\u0001".repeat(SELFDEV_LIMITS.MAX_RATIONALE_LENGTH) };
    const envelope = { schemaVersion: SELFDEV_STORE_SCHEMA_VERSION, updatedAt: Date.now(), lessons: [] };
    const perLesson = Buffer.byteLength(JSON.stringify(large)) + 1;
    const count = Math.floor((MAX_CANDIDATE_STORE_BYTES - Buffer.byteLength(JSON.stringify(envelope))) / perLesson);
    expect(count).toBeLessThan(SELFDEV_LIMITS.MAX_LESSONS);
    const lessons = Array.from({ length: count }, (_, i) => ({ ...large, id: `seed-${String(i).padStart(4, "0")}` }));
    const before = JSON.stringify({ ...envelope, lessons });
    expect(Buffer.byteLength(before)).toBeLessThanOrEqual(MAX_CANDIDATE_STORE_BYTES);
    await writeFile(storePath, before);
    await expect(store.create({ ...input, id: "overflow", statement: large.statement, rationale: large.rationale })).rejects.toThrow("byte limit");
    expect(await readFile(storePath, "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual(["lessons.json"]);
  });

  it("preserves corrupt, unsupported, unknown-field and noncandidate stores", async () => {
    const { storePath, store, dir } = await fixture();
    const lesson = await store.create(input);
    const envelope = { schemaVersion: SELFDEV_STORE_SCHEMA_VERSION, updatedAt: Date.now(), lessons: [lesson] };
    const invalid = ["", "{broken", "null", JSON.stringify({ ...envelope, schemaVersion: 999 }),
      JSON.stringify({ ...envelope, unknown: true }),
      JSON.stringify({ ...envelope, lessons: [{ ...lesson, unknown: true }] }),
      JSON.stringify({ ...envelope, lessons: [{ ...lesson, status: "active", approvedBy: "forged", approvedAt: lesson?.createdAt }] }),
      JSON.stringify({ ...envelope, lessons: [lesson, lesson] }),
      JSON.stringify({ ...envelope, lessons: [{ ...lesson, version: 0 }] })];
    for (const text of invalid) {
      await writeFile(storePath, text);
      await expect(store.list()).rejects.toThrow();
      await expect(store.get("missing")).rejects.toThrow();
      await expect(store.create(input)).rejects.toThrow();
      await expect(store.update(lesson!.id, 1, {})).rejects.toThrow();
      expect(await readFile(storePath, "utf8")).toBe(text);
      expect(await readdir(dir)).toEqual(["lessons.json"]);
    }
  });

  it("caps oversized file reads and preserves the file on rejected writes", async () => {
    const { storePath, store, dir } = await fixture();
    const file = await open(storePath, "w");
    try { await file.truncate(MAX_CANDIDATE_STORE_BYTES + 1); } finally { await file.close(); }
    await expect(store.list()).rejects.toThrow("limit");
    await expect(store.create(input)).rejects.toThrow("limit");
    expect((await stat(storePath)).size).toBe(MAX_CANDIDATE_STORE_BYTES + 1);
    expect(await readdir(dir)).toEqual(["lessons.json"]);
  });

  it("does not reclaim an existing stale lock", async () => {
    const { storePath, store, dir } = await fixture();
    await writeFile(`${storePath}.lock`, "owned elsewhere");
    await expect(store.create(input)).rejects.toThrow("busy");
    expect(await readFile(`${storePath}.lock`, "utf8")).toBe("owned elsewhere");
    expect(await readdir(dir)).toEqual(["lessons.json.lock"]);
  });

  it("snapshots caller input and returned values without retaining mutable references", async () => {
    const { store } = await fixture();
    const data = { ...input, id: "one", evidenceIds: ["original"] };
    const pending = store.create(data);
    data.evidenceIds.push("later");
    const created = await pending;
    created!.evidenceIds.push("returned");
    expect((await store.get("one"))?.evidenceIds).toEqual(["original"]);
    const patch = { tags: ["original"] };
    const updating = store.update("one", 1, patch);
    patch.tags.push("later");
    expect((await updating)?.tags).toEqual(["original"]);
  });

  it("fails fast while another process owns the lock and succeeds after release", async () => {
    const { store, storePath, dir } = await fixture();
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { open, unlink } from 'node:fs/promises';
      const path = process.argv[1];
      const lock = await open(path, 'wx');
      const timer = setTimeout(() => process.exit(2), 10000);
      process.on('message', async () => {
        await lock.close(); await unlink(path); clearTimeout(timer); process.disconnect();
      });
      process.send('locked');
    `, `${storePath}.lock`], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const exited = once(child, "exit");
    try {
      await once(child, "message");
      await expect(store.create(input)).rejects.toThrow("busy");
      expect(await readdir(dir)).toEqual(["lessons.json.lock"]);
      await expect(stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.connected) child.send("release");
      expect((await exited)[0]).toBe(0);
    }
    const lesson = await store.create(input);
    expect(lesson?.status).toBe("candidate");
    expect(await readdir(dir)).toEqual(["lessons.json"]);
    expect(JSON.parse(await readFile(storePath, "utf8")).lessons).toHaveLength(1);
  });
});
