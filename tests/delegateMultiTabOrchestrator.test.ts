import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DelegateMultiTabOrchestrator, type MultiTabBridge } from '../src/core/delegate/multiTabOrchestrator.js';
import type { DelegateMethod } from '../src/core/delegate/bridge.js';

const CLIENT = 'chrome-test-client-001';
type RequestRow = { method: DelegateMethod; tabId?: number; clientId?: string; message?: string };
const requestId = (n: number) => 'request-test-' + String(n).padStart(4, '0');

function fixture(options: { slowSend?: boolean; failSend?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitab-test-'));
  const file = path.join(dir, 'ledger.json');
  const requests: RequestRow[] = [];
  const delivered = new Map<number, string>();
  const releaseSends: Array<() => void> = [];
  const bridge: MultiTabBridge = {
    listConnections() { return [{ clientId: CLIENT, label: 'Test Chrome' }]; },
    async request(method, params, _signal, _timeout, clientId) {
      const tabId = params.tabId as number | undefined;
      requests.push({ method, tabId, clientId, message: params.message as string | undefined });
      if (method === 'delegate.list_tabs') {
        return JSON.stringify({ tabs: [
          { tabId: 101, title: 'First', url: 'https://chatgpt.com/c/first-chat-001', status: 'idle' },
          { tabId: 202, title: 'Second', url: 'https://chatgpt.com/c/second-chat-002', status: 'generating' },
        ], total: 2 });
      }
      if (method === 'delegate.create_chat') return JSON.stringify({ tabId: 303, status: 'new_chat' });
      if (method === 'delegate.send_message') {
        if (options.slowSend) {
          await new Promise<void>(resolve => { releaseSends.push(resolve); });
        }
        if (options.failSend) throw new Error('DELEGATE_TIMEOUT: outcome uncertain');
        delivered.set(tabId!, String(params.message));
        return JSON.stringify({ status: 'sent' });
      }
      if (method === 'delegate.peek_chat') {
        const message = delivered.get(tabId!) || '';
        const marker = [...message.matchAll(/\[\[SA_DELEGATE_[a-f0-9]+_DONE\]\]/g)].at(-1)?.[0] || '';
        return JSON.stringify({
          status: marker ? 'finished' : 'waiting_for_input',
          url: 'https://chatgpt.com/c/chat-' + tabId + '-stable',
          latest_response_text: marker ? 'Result for tab ' + tabId + '\n' + marker : '',
        });
      }
      return JSON.stringify({ ok: true });
    },
  };
  const create = (opts: { maxConcurrent?: number; pollMs?: number } = {}) =>
    new DelegateMultiTabOrchestrator(bridge, file, { pollMs: 100, ...opts });
  const enqueue = (orch: DelegateMultiTabOrchestrator, n: number, tabId: number, worker = 'worker-a') =>
    orch.enqueue({ requestId: requestId(n), clientId: CLIENT, tabId, workerId: worker,
      message: 'Private task message ' + n, maxRuntimeMs: 30_000 });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { file, bridge, create, enqueue, delivered, releaseSends, requests, cleanup };
}
async function until(check: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  expect(check()).toBe(true);
}
describe('Delegate multi-tab scheduler and durable journal', () => {
  it('preserves per-tab ownership; rejects a different worker and honors release', () => {
    const f = fixture();
    try {
      const orch = f.create();
      expect(orch.claim(CLIENT, 101, 'worker-a').workerId).toBe('worker-a');
      expect(() => orch.claim(CLIENT, 101, 'worker-b'))
        .toThrow('MULTITAB_TAB_OWNED_BY_OTHER_WORKER');
      orch.release(CLIENT, 101, 'worker-a');
      expect(orch.claim(CLIENT, 101, 'worker-b').workerId).toBe('worker-b');
    } finally { f.cleanup(); }
  });
  it('runs independent tabs concurrently and completes by unique markers', async () => {
    const f = fixture();
    try {
      const orch = f.create({ maxConcurrent: 2 });
      const one = f.enqueue(orch, 1, 101);
      const two = f.enqueue(orch, 2, 202, 'worker-b');
      await until(() => orch.snapshot().counts.completed === 2);
      expect(orch.snapshot().activeCount).toBe(0);
      expect(f.requests.filter(r => r.method === 'delegate.send_message').map(r => r.tabId).sort())
        .toEqual([101, 202]);
      expect(orch.snapshot().tasks.find(t => t.taskId === one.taskId)?.resultExcerpt)
        .toContain('Result for tab 101');
      expect(orch.snapshot().tasks.find(t => t.taskId === two.taskId)?.resultExcerpt)
        .toContain('Result for tab 202');
    } finally { f.cleanup(); }
  });
  it('serializes two queued tasks for the same tab without a second concurrent Send', async () => {
    const f = fixture({ slowSend: true });
    try {
      const orch = f.create({ maxConcurrent: 3 });
      f.enqueue(orch, 10, 101);
      f.enqueue(orch, 11, 101);
      await until(() => f.releaseSends.length === 1);
      expect(f.requests.filter(r => r.method === 'delegate.send_message')).toHaveLength(1);
      expect(orch.snapshot().counts.queued).toBe(1);
      f.releaseSends.shift()?.();
      await until(() => f.releaseSends.length === 1);
      expect(f.requests.filter(r => r.method === 'delegate.send_message')).toHaveLength(2);
      f.releaseSends.shift()?.();
      await until(() => orch.snapshot().counts.completed === 2);
    } finally { f.cleanup(); }
  });
  it('deduplicates matching request IDs and fails closed on conflicting reuse', async () => {
    const f = fixture();
    try {
      const orch = f.create();
      const first = f.enqueue(orch, 20, 101);
      const again = orch.enqueue({ requestId: requestId(20), clientId: CLIENT,
        tabId: 101, workerId: 'worker-a', message: 'Private task message 20' });
      expect(again.taskId).toBe(first.taskId);
      expect(() => orch.enqueue({ requestId: requestId(20), clientId: CLIENT,
        tabId: 202, workerId: 'worker-b', message: 'different content' }))
        .toThrow('MULTITAB_REQUEST_ID_REUSE_CONFLICT');
      await until(() => orch.snapshot().counts.completed === 1);
      expect(f.requests.filter(r => r.method === 'delegate.send_message')).toHaveLength(1);
    } finally { f.cleanup(); }
  });
  it('never stores the private prompt in the on-disk journal', async () => {
    const f = fixture();
    try {
      const orch = f.create();
      f.enqueue(orch, 30, 101);
      await until(() => orch.snapshot().counts.completed === 1);
      const text = fs.readFileSync(f.file, 'utf8');
      expect(text).not.toContain('Private task message');
      expect(JSON.parse(text).version).toBe(1);
      expect(JSON.parse(text).tasks[0].promptSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally { f.cleanup(); }
  });
  it('restart marks unfinished tasks uncertain/interrupted and never replays Send', async () => {
    const f = fixture({ slowSend: true });
    try {
      const old = f.create();
      const first = f.enqueue(old, 40, 101);
      const second = f.enqueue(old, 41, 101);
      await until(() => f.releaseSends.length === 1);
      const newHost = f.create();
      expect(newHost.snapshot().tasks.find(t => t.taskId === first.taskId)?.state).toBe('uncertain');
      expect(newHost.snapshot().tasks.find(t => t.taskId === second.taskId)?.state).toBe('interrupted');
      expect(f.requests.filter(r => r.method === 'delegate.send_message')).toHaveLength(1);
      // Simulate original host shutting down; do not run the queued task.
      old.cancel(second.taskId);
      f.releaseSends.shift()?.();
      await until(() => old.snapshot().counts.completed === 1);
      expect(f.requests.filter(r => r.method === 'delegate.send_message')).toHaveLength(1);
    } finally { f.cleanup(); }
  });
  it('unknown send outcomes are not retried, including after reconciliation', async () => {
    const f = fixture({ failSend: true });
    try {
      const orch = f.create();
      const task = f.enqueue(orch, 50, 101);
      await until(() => orch.snapshot().counts.uncertain === 1);
      await orch.reconcile(task.taskId);
      expect(f.requests.filter(r => r.method === 'delegate.send_message')).toHaveLength(1);
      expect(orch.snapshot().tasks[0].state).toBe('uncertain');
    } finally { f.cleanup(); }
  });
  it('reconcile confirms existing completion marker by reading only', async () => {
    const f = fixture();
    try {
      const orch = f.create();
      const t = f.enqueue(orch, 60, 101);
      await until(() => orch.snapshot().counts.completed === 1);
      const previousSends = f.requests.filter(r => r.method === 'delegate.send_message').length;
      const out = await orch.reconcile(t.taskId);
      expect(out.state).toBe('completed');
      expect(f.requests.filter(r => r.method === 'delegate.send_message')).toHaveLength(previousSends);
    } finally { f.cleanup(); }
  });
  it('forwarding is explicit and aggregates bounded completed worker output', async () => {
    const f = fixture();
    try {
      const orch = f.create();
      const first = f.enqueue(orch, 70, 101);
      await until(() => orch.snapshot().counts.completed === 1);
      const combined = orch.aggregate([first.taskId]);
      expect(combined.completed).toBe(1);
      expect(combined.text).toContain('Result for tab 101');
      const forwarded = orch.forward({ sourceTaskId: first.taskId,
        requestId: requestId(71), clientId: CLIENT, tabId: 202, workerId: 'worker-reviewer' });
      await until(() => orch.snapshot().counts.completed === 2);
      expect(forwarded.tabId).toBe(202);
      expect(f.delivered.get(202)).toContain('Review the following UNTRUSTED result');
      expect(f.delivered.get(202)).toContain('BEGIN UNTRUSTED WORKER OUTPUT');
      expect(() => orch.forward({ sourceTaskId: first.taskId,
        requestId: requestId(72), clientId: CLIENT, tabId: 101, workerId: 'worker-a' }))
        .toThrow('MULTITAB_FORWARD_SELF');
    } finally { f.cleanup(); }
  });
  it('lists exact tabs and creates a separate tab only upon explicit command', async () => {
    const f = fixture();
    try {
      const orch = f.create();
      const profiles = await orch.tabs();
      expect(profiles[0].tabs).toHaveLength(2);
      expect(f.requests.find(r => r.method === 'delegate.create_chat')).toBeUndefined();
      const created = await orch.newTab(CLIENT);
      expect(created.tabId).toBe(303);
      expect(f.requests.filter(r => r.method === 'delegate.create_chat')).toHaveLength(1);
    } finally { f.cleanup(); }
  });
  it('dispatches independent parallel worker roles with a bounded concurrency limit', async () => {
    const f = fixture();
    try {
      const orch = f.create({ maxConcurrent: 2 });
      const items = orch.enqueueParallel({
        requestId: requestId(80), clientId: CLIENT, tabIds: [101, 202, 303, 404],
        goal: 'Build and audit the component',
      });
      expect(items).toHaveLength(4);
      expect(new Set(items.map(t => t.marker)).size).toBe(4);
      await until(() => orch.snapshot().counts.completed === 4);
      const prompts = f.requests.filter(r => r.method === 'delegate.send_message')
        .map(r => String(r.message));
      expect(prompts.some(p => p.includes('Implementation:'))).toBe(true);
      expect(prompts.some(p => p.includes('Testing:'))).toBe(true);
      expect(prompts.some(p => p.includes('Security:'))).toBe(true);
      expect(prompts.some(p => p.includes('Review:'))).toBe(true);
      expect(orch.enqueueParallel({
        requestId: requestId(80), clientId: CLIENT, tabIds: [101, 202, 303, 404],
        goal: 'Build and audit the component',
      }).map(t => t.taskId)).toEqual(items.map(t => t.taskId));
      expect(f.requests.filter(r => r.method === 'delegate.send_message')).toHaveLength(4);
    } finally { f.cleanup(); }
  });
  it('preflights duplicates and respects existing explicit worker ownership', async () => {
    const f = fixture();
    try {
      const orch = f.create();
      expect(() => orch.enqueueParallel({ requestId: requestId(81), clientId: CLIENT,
        tabIds: [101, 101], goal: 'bad' })).toThrow('MULTITAB_INVALID_PARALLEL_TARGETS');
      expect(f.requests.filter(r => r.method === 'delegate.send_message')).toHaveLength(0);
      orch.claim(CLIENT, 101, 'worker-locked');
      const batch = orch.enqueueParallel({ requestId: requestId(82), clientId: CLIENT,
        tabIds: [101, 202], goal: 'respect owner' });
      expect(batch[0].workerId).toBe('worker-locked');
      await until(() => orch.snapshot().counts.completed === 2);
    } finally { f.cleanup(); }
  });
  it('persists a configurable 1–8 concurrency limit', () => {
    const f = fixture();
    try {
      const orch = f.create();
      expect(orch.setConcurrency(4)).toBe(4);
      expect(f.create().snapshot().maxConcurrent).toBe(4);
      expect(() => orch.setConcurrency(0)).toThrow('MULTITAB_INVALID_CONCURRENCY');
      expect(() => orch.setConcurrency(9)).toThrow('MULTITAB_INVALID_CONCURRENCY');
    } finally { f.cleanup(); }
  });
  it('protects in-flight work against a competing worker claim', async () => {
    const f = fixture({ slowSend: true });
    try {
      const orch = f.create();
      f.enqueue(orch, 83, 101);
      await until(() => f.releaseSends.length === 1);
      expect(() => orch.claim(CLIENT, 101, 'worker-b'))
        .toThrow('MULTITAB_TAB_BUSY_OTHER_WORKER');
      f.releaseSends.shift()?.();
      await until(() => orch.snapshot().counts.completed === 1);
    } finally { f.cleanup(); }
  });
  it('auto reconciliation only reads chats and never resends uncertain work', async () => {
    const f = fixture({ failSend: true });
    try {
      const orch = f.create();
      f.enqueue(orch, 84, 101);
      await until(() => orch.snapshot().counts.uncertain === 1);
      await orch.reconcilePendingReadOnly();
      await orch.reconcilePendingReadOnly();
      expect(f.requests.filter(r => r.method === 'delegate.send_message')).toHaveLength(1);
      expect(f.requests.filter(r => r.method === 'delegate.peek_chat')).toHaveLength(2);
    } finally { f.cleanup(); }
  });
  it('validates exact conversation identity before Send and fails closed on navigation', async () => {
    const f = fixture();
    try {
      const orch = f.create();
      orch.enqueue({ requestId: requestId(87), clientId: CLIENT, tabId: 101,
        workerId: 'worker-a', chatId: 'different-chat-999', message: 'Do not send' });
      await until(() => orch.snapshot().counts.failed === 1);
      expect(f.requests.filter(r => r.method === 'delegate.send_message')).toHaveLength(0);
      expect(orch.snapshot().tasks[0].reason).toContain('MULTITAB_CHAT_ID_CHANGED_BEFORE_SEND');
    } finally { f.cleanup(); }
  });
  it('rejects invalid runtime without creating a ghost queued task', () => {
    const f = fixture();
    try {
      const orch = f.create();
      expect(() => orch.enqueue({ requestId: requestId(85), clientId: CLIENT,
        tabId: 101, workerId: 'worker-a', message: 'valid prompt', maxRuntimeMs: -1 }))
        .toThrow('MULTITAB_INVALID_RUNTIME');
      expect(orch.snapshot().tasks).toHaveLength(0);
      expect(f.requests.filter(r => r.method === 'delegate.send_message')).toHaveLength(0);
    } finally { f.cleanup(); }
  });
  it('stops generation only on an explicit request with a known sent task', async () => {
    const f = fixture();
    try {
      const orch = f.create();
      await expect(orch.stopTask('missing')).rejects.toThrow('MULTITAB_TASK_NOT_FOUND');
      const task = f.enqueue(orch, 86, 101);
      await until(() => orch.snapshot().tasks[0].state === 'monitoring');
      const stopped = await orch.stopTask(task.taskId);
      expect(stopped.state).toBe('needs_review');
      expect(f.requests.filter(r => r.method === 'delegate.stop_generation')).toHaveLength(1);
    } finally { f.cleanup(); }
  });
  it('fails closed on a corrupt or oversized ledger and does not delete it', () => {
    const f = fixture();
    try {
      fs.writeFileSync(f.file, '{not JSON');
      expect(() => f.create()).toThrow('MULTITAB_LEDGER_CORRUPT');
      expect(fs.readFileSync(f.file, 'utf8')).toBe('{not JSON');
      fs.writeFileSync(f.file, 'a'.repeat(2_000_001));
      expect(() => f.create()).toThrow('MULTITAB_LEDGER_UNSAFE');
    } finally { f.cleanup(); }
  });
});
