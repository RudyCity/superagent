/**
 * Read-only runtime smoke of published/compiled SuperAgent using Bun.
 * Creates only disposable temp files; does not open a server, register MCP,
 * import user configuration, or stop running agents.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (typeof Bun === 'undefined' || !process.versions.bun) {
  console.error('BUN_SMOKE_FAILED: this test must run under Bun');
  process.exit(1);
}
const root = path.resolve(import.meta.dir, '..');
const cli = path.join(root, 'dist', 'cli.js');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'superagent-bun-smoke-'));
try {
  const minimalPath = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'].join(path.delimiter)
    : '/usr/bin:/bin';
  const env = { ...process.env, PATH: minimalPath, SUPERAGENT_CONFIG_DIR: temp,
    USERPROFILE: process.platform === 'win32' ? temp : process.env.USERPROFILE,
    HOME: temp };

  const run = spawnSync(process.execPath, [cli, '--version'], {
    cwd: root, env, encoding: 'utf8', timeout: 15000,
  });
  if (run.status !== 0 || !/^\d+\.\d+\.\d+/m.test(run.stdout)) {
    throw new Error('Built CLI cannot run without Node/npm in PATH: ' + run.stderr);
  }

  const { readFilesInProcessPool } = await import('../src/core/agent/ProcessPool.js');
  const filename = path.join(temp, 'worker.txt');
  await fs.writeFile(filename, 'BUN_WORKER_READ_OK ✅\n');
  const result = await readFilesInProcessPool([
    { filePath: filename, displayPath: 'worker.txt', offset: 1, limit: 2 },
  ], { maxWorkers: 1, timeoutMs: 10000 });
  if (result.length !== 1 || !result[0].includes('BUN_WORKER_READ_OK')) {
    throw new Error('Bun file-read worker did not return correct content');
  }

  const { Database } = await import('bun:sqlite');
  const sqlite = new Database(path.join(temp, 'runtime.db'), { create: true });
  try {
    sqlite.exec('CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT)');
    sqlite.query('INSERT INTO smoke (value) VALUES (?)').run('BUN_SQLITE_OK');
    if (sqlite.query('SELECT value FROM smoke').get()?.value !== 'BUN_SQLITE_OK') {
      throw new Error('Bun SQLite read/write failed');
    }
  } finally { sqlite.close(); }

  const { RMemory } = await import('r-memory');
  const instance = new RMemory({
    dbPath: path.join(temp, 'vectors.db'), collectionName: 'smoke',
    embeddingProvider: { dimensions: 3, embedText: async () => [0.1, 0.2, 0.3] },
  } as any);
  try {
    if (typeof instance.addMemory !== 'function') throw new Error('RMemory Bun adapter unavailable');
  } finally { instance.close?.(); }
  console.log('BUN_RUNTIME_SMOKE_OK CLI+ProcessPool+SQLite+RMemory', process.versions.bun);
} catch (error) {
  console.error('BUN_RUNTIME_SMOKE_FAILED', error);
  process.exitCode = 1;
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
}
