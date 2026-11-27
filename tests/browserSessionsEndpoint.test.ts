import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleServerRoute } from '../src/serverRoutes';

type Captured = { status: number; payload: any; headers: Record<string, string> };

function makeMocks(method: string, remoteAddress: string | undefined): {
  req: IncomingMessage;
  res: ServerResponse;
  captured: Captured;
  ctx: Record<string, any>;
} {
  const captured: Captured = { status: 0, payload: null, headers: {} };
  const req = { method, socket: { remoteAddress }, headers: {} } as unknown as IncomingMessage;
  const res = {
    setHeader: (name: string, value: string) => {
      captured.headers[name.toLowerCase()] = String(value);
    },
    writeHead: (status: number) => {
      captured.status = status;
    },
    end: () => undefined,
  } as unknown as ServerResponse;
  const ctx = {
    sendJSON: (_res: ServerResponse, status: number, data: any) => {
      captured.status = status;
      captured.payload = data;
    },
  };
  return { req, res, captured, ctx };
}

async function callSessions(method: string, remoteAddress: string | undefined) {
  const { req, res, captured, ctx } = makeMocks(method, remoteAddress);
  const handled = await handleServerRoute(
    req,
    res,
    '/api/browser/sessions',
    new URL('http://127.0.0.1:7888/api/browser/sessions'),
    ctx as never,
  );
  return { handled, captured };
}

describe('GET /api/browser/sessions handler', () => {
  it('serves a loopback desktop client with a token-free projection', async () => {
    const { handled, captured } = await callSessions('GET', '127.0.0.1');
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.payload.ok).toBe(true);
    expect(Array.isArray(captured.payload.sessions)).toBe(true);
    expect(captured.payload.summary.activeTabs).toBe(captured.payload.sessions.length);
    expect(captured.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(captured.payload)).not.toContain('tokenHash');
    expect(JSON.stringify(captured.payload)).not.toContain('sessionToken');
  });

  it('accepts both IPv6 loopback spellings', async () => {
    for (const address of ['::1', '::ffff:127.0.0.1']) {
      const { captured } = await callSessions('GET', address);
      expect(captured.status).toBe(200);
      expect(captured.payload.ok).toBe(true);
    }
  });

  it('rejects non-loopback callers with 403', async () => {
    for (const address of ['10.0.0.7', '192.168.1.20', '::2', undefined]) {
      const { captured } = await callSessions('GET', address);
      expect(captured.status).toBe(403);
      expect(captured.payload.ok).toBe(false);
    }
  });

  it('rejects non-GET methods with 405', async () => {
    const { captured } = await callSessions('POST', '127.0.0.1');
    expect(captured.status).toBe(405);
    expect(captured.payload.ok).toBe(false);
  });
});
