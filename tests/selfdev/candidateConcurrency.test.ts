import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CandidateStore } from '../../src/core/selfdev/candidateStore.js';

it('preserves candidates from two real concurrent writer processes', async () => {
  const root = resolve('tmp');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'candidate-concurrency-'));
  const storePath = join(dir, 'selfdev.json');
  const fixture = fileURLToPath(new URL('./fixtures/candidateWriter.mjs', import.meta.url));
  const workers = ['writer-a', 'writer-b'].map(prefix => {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, storePath, prefix],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    const ready = new Promise<void>((resolve, reject) => {
      child.once('message', message => message === 'ready'
        ? resolve() : reject(new Error('Unexpected worker message')));
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Worker exited: ${stderr}`)));
    });
    return { child, ready, closed, stderr: () => stderr };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await Promise.all(workers.map(worker => worker.ready));
        for (const worker of workers) worker.child.send('start');
        const codes = await Promise.all(workers.map(worker => worker.closed));
        expect(codes, workers.map(worker => worker.stderr()).join('\n')).toEqual([0, 0]);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Concurrent writers timed out')), 15000);
      }),
    ]);
    const store = new CandidateStore({ storePath, workspace: 'concurrent', enabled: () => true });
    const lessons = await store.list();
    expect(lessons.map(lesson => lesson.id).sort()).toEqual(
      ['writer-a', 'writer-b'].flatMap(prefix =>
        Array.from({ length: 12 }, (_, i) => `${prefix}-${i}`)).sort());
    expect(lessons.every(lesson => lesson.version === 1 && lesson.status === 'candidate')).toBe(true);
    expect(await readdir(dir)).toEqual(['selfdev.json']);
  } finally {
    clearTimeout(timer);
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    }
    await Promise.allSettled(workers.map(worker => worker.closed));
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
