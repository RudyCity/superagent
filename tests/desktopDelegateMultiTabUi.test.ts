import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync('apps/superagent-tray/ui/delegate-multitab.js', 'utf8');
const html = fs.readFileSync('apps/superagent-tray/ui/index.html', 'utf8');
const tauri = fs.readFileSync('apps/superagent-tray/src-tauri/src/main.rs', 'utf8');
function fixture() {
  const elements = new Map<string, any>();
  const calls: Array<{ action: string; payload?: any }> = [];
  const status = {
    success: true, maxConcurrent: 3,
    counts: { queued: 0, monitoring: 0, uncertain: 0 },
    owners: [], tasks: [],
    profiles: [{
      clientId: 'chrome-test-profile-001', label: 'Test Chrome',
      tabs: [
        { tabId: 101, title: 'One', url: 'https://chatgpt.com/c/first-chat-001', status: 'idle' },
        { tabId: 202, title: '<img onerror=evil()>', url: 'https://chatgpt.com/c/second-chat-002', status: 'generating' },
      ],
    }],
  };
  let rejectEnqueue = false;
  function node(tag: string, id = ''): any {
    const listeners = new Map<string, () => any>();
    const out: any = {
      tag, id, value: '', textContent: '', className: '', hidden: false,
      disabled: false, children: [] as any[],
      append(...items: any[]) { out.children.push(...items); },
      replaceChildren(...items: any[]) { out.children = [...items]; },
      addEventListener(name: string, fn: () => any) { listeners.set(name, fn); },
      fire(name: string) { return listeners.get(name)?.(); },
    };
    return out;
  }
  function $(id: string) {
    if (!elements.has(id)) elements.set(id, node('div', id));
    return elements.get(id);
  }
  $('multitab-priority').value = '5';
  $('multitab-worker').value = 'worker-a';
  $('multitab-concurrency').value = '3';
  $('page-delegate').hidden = false;
  const windowObject: any = {
    __TAURI__: { core: { invoke: vi.fn(async (name: string, data: any) => {
      if (name !== 'delegate_action') throw new Error('Unexpected Tauri command');
      calls.push({ action: data.action, payload: data.payload });
      if (data.action === 'orchestrator-status') return status;
      if (data.payload?.action === 'enqueue' && rejectEnqueue)
        throw new Error('Connection lost: delivery may be uncertain');
      return { success: true, result: data.payload?.action === 'new-tab'
        ? { tabId: 303 } : { taskId: 'task-' + calls.length } };
    }) } },
  };
  vm.runInNewContext(script, {
    document: { getElementById: $, createElement: (tag: string) => node(tag),
      readyState: 'complete', addEventListener: () => {} },
    window: windowObject, console,
    setInterval: () => 0,
    crypto: { randomUUID: () => 'request-id-for-ui-test-1234' },
    confirm: () => true,
  });
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { $, calls, status, windowObject, flush, rejectNext: () => { rejectEnqueue = true; } };
}

describe('Tray multi-tab controller', () => {
  it('wires a fixed native command and renders per-tab data with textContent', async () => {
    expect(html).toContain('delegate-multitab.js');
    expect(html).toContain('delegate-multitab.css');
    expect(tauri).toContain('"orchestrator-status"');
    expect(tauri).toContain('"set-concurrency"');
    const f = fixture();
    await f.windowObject.__superagentMultiTabRefresh();
    expect(f.$('multitab-count-tabs').textContent).toBe('2 tabs');
    expect(f.$('multitab-tabs').children).toHaveLength(3);
    expect(f.$('multitab-tabs').children[2].children[0].textContent)
      .toContain('<img onerror=evil()>');
    expect(f.calls.map(x => x.action)).toEqual(['orchestrator-status']);
  });
  it('routes a task only to the explicitly selected tab and worker', async () => {
    const f = fixture();
    await f.windowObject.__superagentMultiTabRefresh();
    f.$('multitab-tabs').children[2].fire('click');
    f.$('multitab-worker').value = 'worker-security';
    f.$('multitab-message').value = 'Audit this target';
    f.$('multitab-enqueue').fire('click');
    await f.flush();
    const posted = f.calls.find(x => x.payload?.action === 'enqueue');
    expect(posted?.payload).toMatchObject({
      clientId: 'chrome-test-profile-001', tabId: 202, workerId: 'worker-security',
      message: 'Audit this target',
    });
    expect(posted?.payload.chatId).toBe('second-chat-002');
    expect(f.$('multitab-message').value).toBe('');
  });
  it('never resends after an uncertain outcome unless explicitly acknowledged', async () => {
    const f = fixture();
    await f.windowObject.__superagentMultiTabRefresh();
    f.$('multitab-message').value = 'Do not duplicate';
    f.rejectNext();
    f.$('multitab-enqueue').fire('click');
    await f.flush();
    const count = f.calls.filter(x => x.payload?.action === 'enqueue').length;
    f.$('multitab-enqueue').fire('click');
    await f.flush();
    expect(f.calls.filter(x => x.payload?.action === 'enqueue')).toHaveLength(count);
    expect(f.$('multitab-feedback').textContent).toMatch(/outcome was unknown|outcome was uncertain/i);
  });
  it('supports bounded concurrency updates and explicit open-tab actions', async () => {
    const f = fixture();
    await f.windowObject.__superagentMultiTabRefresh();
    f.$('multitab-concurrency').value = '4';
    f.$('multitab-concurrency').fire('change');
    await f.flush();
    expect(f.calls.find(x => x.payload?.action === 'set-concurrency')?.payload.maxConcurrent).toBe(4);
    f.$('multitab-new-tab').fire('click');
    await f.flush();
    expect(f.calls.find(x => x.payload?.action === 'new-tab')?.payload.clientId)
      .toBe('chrome-test-profile-001');
  });
});
