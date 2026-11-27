import { describe, expect, it } from 'vitest';
import { isLoopbackRemote, projectCdpSessions } from '../src/core/browserSessionProjection';

const key = 'a'.repeat(64);

describe('browser session projection', () => {
  it('accepts only loopback remote addresses', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackRemote(address)).toBe(true);
    }
    for (const address of [undefined, '', '10.0.0.5', '192.168.1.9', '::2', 'localhost']) {
      expect(isLoopbackRemote(address)).toBe(false);
    }
  });

  it('projects claim metadata without tokens and derives the summary', () => {
    const projection = projectCdpSessions([
      {
        key,
        port: 53331,
        targetId: 'TAB-1',
        agentId: 'agent-a',
        mode: 'shared',
        revision: 7,
        paused: true,
        generation: '4242-1730000000000000',
        claimedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_600_000,
        participants: [
          { agentId: 'agent-a', role: 'owner' },
          { agentId: 'agent-b', role: 'observer' },
        ],
        // Session tokens and cookie material must never survive projection.
        sessionToken: 'secret-token',
      } as never,
    ]);

    expect(projection.ok).toBe(true);
    expect(projection.summary).toEqual({ activeTabs: 1, activeAgents: 2 });
    expect(projection.sessions).toHaveLength(1);
    const session = projection.sessions[0];
    expect(session).toEqual({
      key,
      port: 53331,
      targetId: 'TAB-1',
      agentId: 'agent-a',
      mode: 'shared',
      revision: 7,
      paused: true,
      generation: '4242-1730000000000000',
      claimedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_600_000,
      participants: [
        { agentId: 'agent-a', role: 'owner' },
        { agentId: 'agent-b', role: 'observer' },
      ],
    });
    expect(JSON.stringify(session)).not.toContain('secret-token');
  });

  it('drops malformed entries and repairs missing owners', () => {
    const projection = projectCdpSessions([
      { key, port: 80, targetId: 'TAB', agentId: 'agent-a' },
      { key, port: 53331, targetId: '../escape', agentId: 'agent-a' },
      { key: 'not-a-key', port: 53331, targetId: 'TAB', agentId: 'agent-a' },
      { key, port: 53331, targetId: 'TAB-2', agentId: 'agent-a', participants: [] },
    ] as never);

    expect(projection.sessions).toHaveLength(1);
    expect(projection.sessions[0].targetId).toBe('TAB-2');
    expect(projection.sessions[0].mode).toBe('isolated');
    expect(projection.sessions[0].participants).toEqual([{ agentId: 'agent-a', role: 'owner' }]);
    expect(projection.summary).toEqual({ activeTabs: 1, activeAgents: 1 });
  });

  it('handles an empty session list', () => {
    expect(projectCdpSessions([])).toEqual({
      ok: true,
      sessions: [],
      summary: { activeTabs: 0, activeAgents: 0 },
    });
  });
});
