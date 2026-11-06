import { describe, expect, it } from 'vitest';
import { handleServerRoute } from '../src/serverRoutes.js';

type Reply = { status: number; payload: any };
async function invoke(input: {
  method?: string; body?: string; remote?: string; host?: string; origin?: string;
} = {}): Promise<Reply> {
  let reply: Reply | undefined;
  const pathname = '/api/desktop/delegate/orchestrator';
  const req: any = {
    method: input.method || 'POST',
    headers: {
      host: input.host || '127.0.0.1:7888',
      ...(input.origin ? { origin: input.origin } : {}),
    },
    socket: { remoteAddress: input.remote || '127.0.0.1' },
  };
  const res: any = { setHeader() {} };
  const handled = await handleServerRoute(req, res, pathname,
    new URL('http://127.0.0.1:7888' + pathname), {
      activeSessions: new Map(),
      sendJSON: (_res: unknown, status: number, payload: unknown) => { reply = { status, payload }; },
      readBody: async () => input.body ?? JSON.stringify({ action: 'no-such-action' }),
    } as any);
  expect(handled).toBe(true);
  expect(reply).toBeDefined();
  return reply!;
}
describe('Authenticated local multi-tab backend route contract', () => {
  it('returns the live dashboard without starting a browser mutation', async () => {
    const result = await invoke({ method: 'GET' });
    expect(result.status).toBe(200);
    expect(result.payload.success).toBe(true);
    expect(result.payload).toEqual(expect.objectContaining({
      maxConcurrent: expect.any(Number), tasks: expect.any(Array),
      owners: expect.any(Array), profiles: expect.any(Array),
    }));
  });
  it('rejects remote addresses and untrusted Host headers before any action', async () => {
    expect((await invoke({ remote: '198.51.100.20' })).status).toBe(403);
    expect((await invoke({ host: 'remote.example' })).status).toBe(403);
    expect((await invoke({ origin: 'https://untrusted.example' })).status).toBe(403);
  });
  it('rejects unsupported methods, actions, extra fields and oversized payloads', async () => {
    expect((await invoke({ method: 'DELETE' })).status).toBe(405);
    expect((await invoke()).status).toBe(400);
    expect((await invoke({ body: JSON.stringify({ action: 'send_raw_cdp', command: 'evaluate' }) })).status)
      .toBe(400);
    expect((await invoke({ body: JSON.stringify({ action: 'enqueue', extra: true }) })).status)
      .toBe(400);
    expect((await invoke({ body: 'x'.repeat(25_001) })).status).toBe(413);
    expect((await invoke({ body: 'malformed JSON' })).status).toBe(409);
  });
  it('fails closed when required tab, client, or task IDs are missing', async () => {
    expect((await invoke({ body: JSON.stringify({ action: 'enqueue' }) })).status).toBe(409);
    expect((await invoke({ body: JSON.stringify({ action: 'parallel', tabIds: [1, 2] }) })).status)
      .toBe(409);
    expect((await invoke({ body: JSON.stringify({ action: 'reconcile', taskId: 'missing' }) })).status)
      .toBe(409);
    expect((await invoke({ body: JSON.stringify({ action: 'set-concurrency', maxConcurrent: 9 }) })).status)
      .toBe(409);
  });
});
