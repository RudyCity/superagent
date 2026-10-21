/**
 * SuperAgent-owned runtime acceptance. Never touches a user's live port 7888,
 * MCP registrations or persistent memory. Tests compiled CLI, isolated server,
 * worker pool, bun:sqlite, and RMemory using Bun alone.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const bun = process.execPath;
if (!process.versions.bun) throw new Error('SuperAgent runtime acceptance must be executed with Bun');

for (const script of ['scripts/bun-runtime-smoke.ts', 'scripts/bun-server-smoke.ts']) {
  const result = spawnSync(bun, [path.join(root, script)], {
    cwd: root, encoding: 'utf8', timeout: 45000,
    env: { ...process.env },
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error || result.status !== 0) {
    throw new Error(`Bun acceptance failed at ${script}: ${result.error?.message || result.status}`);
  }
}
console.log('SUPERAGENT_BUN_ACCEPTANCE_OK', process.versions.bun);
