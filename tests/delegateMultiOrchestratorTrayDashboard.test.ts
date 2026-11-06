import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync('apps/superagent-tray/ui/delegate-multitab.js', 'utf8');
const clientA = 'chrome-profile-a-00001';
const clientB = 'chrome-profile-b-00002';
const snapshot = () => ({
  success: true, maxConcurrent: 3,
  counts: { queued: 1, sending: 1, monitoring: 0, uncertain: 1, interrupted: 0 },
  owners: [{ clientId: clientA, tabId: 101, workerId: 'worker-a', claimedAt: 1 }],
  tasks: [
    { taskId: 't-1', clientId: clientA, tabId: 101, workerId: 'worker-a', state: 'queued', priority: 5, title: 'Queued' },
    { taskId: 't-2', clientId: clientB, tabId: 303, workerId: 'worker-b', state: 'sending', priority: 6, title: 'In flight' },
    { taskId: 't-3', clientId: clientA, tabId: 101, workerId: 'worker-a', state: 'uncertain', priority: 3,
      title: 'Recovery', reason: 'Delivery outcome unknown' },
  ],
  profiles: [
    { clientId: clientA, label: 'Profile <svg onload=bad()>', tabs: [
      { tabId: 101, title: '<img src=x onerror=bad()>', status: 'idle' },
      { tabId: 202, title: 'Other tab', status: 'idle' },
    ] },
    { clientId: clientB, label: 'Second profile', tabs: [
      { tabId: 303, title: 'Worker B', status: 'running' },
    ] },
  ],
});
function fixture(start = snapshot()) {
  let response: any = start;
  let reject = false;
  const nodes = new Map<string, any>();
  const calls: any[] = [];
  let poll: (() => unknown) | undefined;
  function element(tag = 'div', id = ''): any {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const node: any = {
      tag, id, className: '', textContent: '', children: [] as any[],
      value: '', hidden: false,
      append(...xs: any[]) { node.children.push(...xs); },
      replaceChildren(...xs: any[]) { node.children = xs; },
      addEventListener(type: string, fn: (...args: any[]) => unknown) { handlers.set(type, fn); },
      fire(type: string) { return handlers.get(type)?.(); },
    };
    return node;
  }
  function $(id: string) {
    if (!nodes.has(id)) nodes.set(id, element('div', id));
    return nodes.get(id);
  }
  $('page-delegate').hidden = false;
  $('multitab-worker').value = 'worker-a';
  $('multitab-concurrency').value = '3';
  const context = {
    window: { __TAURI__: { core: { invoke: vi.fn(async (name: string, data: any) => {
      calls.push([name, data]);
      if (name !== 'delegate_action' || data.action !== 'orchestrator-status')
        throw new Error('Unexpected mutation in read-only fixture');
      if (reject) throw new Error('backend disconnected');
      return response;
    }) } } } as any,
    document: { readyState: 'complete', getElementById: $, createElement: element, addEventListener() {} },
    setInterval(fn: () => unknown) { poll = fn; return 1; },
    crypto: { randomUUID: () => 'request-0001' }, confirm: () => false, console,
  };
  vm.runInNewContext(script, context);
  const read = () => context.window.__superagentMultiTabRefresh();
  const tabs = () => $('multitab-tabs').children.filter((c: any) => c.tag === 'button');
  const content = (node: any): string => [node.textContent, ...node.children.map(content)].join('\n');
  return { $, read, tabs, content, calls, poll: () => poll?.(),
    response: (next: any) => { response = next; },
    reject: (value: boolean) => { reject = value; } };
}

describe('Tray Delegate multi-orchestrator dashboard read-only contract', () => {
  it('separates profiles, per-tab owner, queue and recovery without pretending CDP session data exists', async () => {
    const f = fixture();
    await f.read();
    const rows = f.tabs();
    expect(rows).toHaveLength(3);
    expect(f.content(rows[0])).toContain('Orchestrator owner: worker-a');
    expect(f.content(rows[0])).toContain('Recent tasks: queued / active: 1 queued · 0 active');
    expect(f.content(rows[0])).toContain('Recovery: 1 require review');
    expect(f.content(rows[0])).toContain('CDP owner: unknown');
    expect(f.content(rows[0])).toContain('Participants: unknown');
    expect(f.content(rows[0])).toContain('Heartbeat: unknown');
    expect(f.content(rows[0])).toContain('Revision: unknown');
    expect(f.content(rows[2])).toContain('Recent tasks: queued / active: 0 queued · 1 active');
    expect(f.content(rows[2])).toContain('Orchestrator owner: unknown');
    expect(f.$('multitab-count-active').textContent).toBe('1 running');
    expect(f.$('multitab-count-queued').textContent).toBe('1 queued');
    await f.poll();
    expect(f.calls.every(x => x[1].action === 'orchestrator-status' && x[1].payload === null)).toBe(true);
  });
  it('uses only public session fields; never interpolates token fields or executes markup', async () => {
    const data: any = snapshot();
    data.sessions = [
      { transport: 'delegate', clientId: clientA, tabId: 101, agentId: 'owner-a',
        expiresAt: Date.UTC(2026, 10, 6, 2, 30), revision: 11,
        sessionToken: 'SENSITIVE-OWNER-TOKEN',
        participants: [
          { agentId: 'watcher<img>', role: 'observer', sessionToken: 'SENSITIVE-WATCHER' },
          { agentId: 'writer-b', role: 'contributor', invitationToken: 'SENSITIVE-INVITE' },
        ] },
      { transport: 'delegate', clientId: clientB, tabId: 303, agentId: 'owner-b',
        revision: 0, participants: [] },
    ];
    data.tasks[2].resultExcerpt = 'sessionToken=SECRET123 other text';
    const f = fixture(data);
    await f.read();
    const content = f.content(f.$('multitab-tabs')) + f.content(f.$('multitab-tasks'));
    expect(content).toContain('owner-a');
    expect(content).toContain('watcher<img> (observer)');
    expect(content).toContain('writer-b (contributor)');
    expect(content).toContain('Revision: 11');
    expect(content).toContain('Lease expires: 2026-11-06T02:30:00.000Z');
    expect(content).toContain('sessionToken=[redacted]');
    expect(content).not.toContain('SECRET123');
    expect(content).not.toContain('SENSITIVE-OWNER-TOKEN');
    expect(content).not.toContain('SENSITIVE-WATCHER');
    expect(content).not.toContain('SENSITIVE-INVITE');
    expect(content).toContain('<img src=x onerror=bad()>');
    expect(f.tabs()[0].children.every((c: any) => !('innerHTML' in c))).toBe(true);
  });
  it('clears stale claims on status failure and restores safely on a later GET', async () => {
    const f = fixture();
    await f.read();
    expect(f.tabs()).toHaveLength(3);
    f.reject(true);
    await f.read();
    expect(f.tabs()).toHaveLength(0);
    expect(f.$('multitab-count-tabs').textContent).toBe('unknown tabs');
    expect(f.$('multitab-count-queued').textContent).toBe('unknown queued');
    expect(f.$('multitab-feedback').textContent).toContain('backend disconnected');
    f.reject(false);
    await f.read();
    expect(f.tabs()).toHaveLength(3);
    expect(f.$('multitab-feedback').textContent).toContain('Status restored');
    expect(f.calls).toHaveLength(3);
  });
});
