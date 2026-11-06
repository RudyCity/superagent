import { describe, expect, it } from 'vitest';
import {
  authorizeDelegateTarget, claimDelegateTarget, handoverDelegateTarget,
  inviteDelegateAgent, joinDelegateTarget, listDelegateSessions,
  noteDelegateWriteSuccess, releaseDelegateTarget, setDelegateSharing,
} from '../src/core/browserTransport/sessionCoordinator.js';

// No Chrome, Tray, Core or MCP process is contacted. Each scenario uses unique
// local in-memory session keys and cleanup; browser requests are never sent.
let ordinal = 970000;
const client = () => 'scenario-profile-' + (++ordinal);
const claim = (profile: string, tab: number, owner: string) =>
  claimDelegateTarget(profile, tab, owner);

describe('Delegate-CDP multi-orchestrator safety scenario (in-memory)', () => {
  it('isolation across profiles: foreign tokens cannot write a peer tab', () => {
    const a = client(), b = client(), tab = 501;
    const one = claim(a, tab, 'first-owner');
    const two = claim(b, tab, 'second-owner');
    try {
      expect(() => authorizeDelegateTarget(a, tab, 'second-owner', two.sessionToken, true))
        .toThrow(/claimed/i);
      expect(() => authorizeDelegateTarget(b, tab, 'first-owner', one.sessionToken, true))
        .toThrow(/claimed/i);
      authorizeDelegateTarget(a, tab, 'first-owner', one.sessionToken, true);
      authorizeDelegateTarget(b, tab, 'second-owner', two.sessionToken, true);
      expect(listDelegateSessions().filter(s => s.tabId === tab &&
        (s.clientId === a || s.clientId === b))).toHaveLength(2);
    } finally {
      releaseDelegateTarget(a, tab, 'first-owner', one.sessionToken);
      releaseDelegateTarget(b, tab, 'second-owner', two.sessionToken);
    }
  });

  it('denies observer write, stale contributor write, and unsafe handover', () => {
    const p = client(), tab = 502;
    const owner = claim(p, tab, 'orchestrator-primary');
    let promoted = false, writerToken = '';
    try {
      setDelegateSharing(p, tab, 'orchestrator-primary', owner.sessionToken, true);
      const readInvite = inviteDelegateAgent(p, tab, 'orchestrator-primary',
        owner.sessionToken, 'observer-peer', 'observer');
      const observer = joinDelegateTarget(p, tab, 'observer-peer',
        readInvite.inviteId, readInvite.invitationToken);
      const writeInvite = inviteDelegateAgent(p, tab, 'orchestrator-primary',
        owner.sessionToken, 'contributor-peer', 'contributor');
      const writer = joinDelegateTarget(p, tab, 'contributor-peer',
        writeInvite.inviteId, writeInvite.invitationToken);
      writerToken = writer.sessionToken;
      expect(() => authorizeDelegateTarget(p, tab, 'observer-peer',
        observer.sessionToken, true, writer.revision)).toThrow(/observer|read.only/i);
      expect(() => authorizeDelegateTarget(p, tab, 'contributor-peer',
        writerToken, true)).toThrow(/revision/i);
      authorizeDelegateTarget(p, tab, 'contributor-peer', writerToken, true, writer.revision);
      noteDelegateWriteSuccess(p, tab, 'contributor-peer', writerToken);
      expect(() => authorizeDelegateTarget(p, tab, 'contributor-peer',
        writerToken, true, writer.revision)).toThrow(/stale revision/i);
      expect(() => handoverDelegateTarget(p, tab, 'orchestrator-primary',
        owner.sessionToken, 'observer-peer')).toThrow(/contributor/i);
      const handed = handoverDelegateTarget(p, tab, 'orchestrator-primary',
        owner.sessionToken, 'contributor-peer');
      promoted = true;
      expect(handed.agentId).toBe('contributor-peer');
      expect(() => authorizeDelegateTarget(p, tab, 'orchestrator-primary',
        owner.sessionToken, true)).toThrow(/claimed/i);
      expect(() => authorizeDelegateTarget(p, tab, 'contributor-peer',
        writerToken, true, writer.revision)).toThrow(/stale revision/i);
      authorizeDelegateTarget(p, tab, 'contributor-peer', writerToken, true, handed.revision);
      expect(JSON.stringify(listDelegateSessions())).not.toContain(writerToken);
      expect(JSON.stringify(handed)).not.toContain('sessionToken');
    } finally {
      if (promoted) releaseDelegateTarget(p, tab, 'contributor-peer', writerToken);
      else releaseDelegateTarget(p, tab, 'orchestrator-primary', owner.sessionToken);
    }
  });

  it('simulates disconnect safely: no implicit release, reclaim or replay', () => {
    const p = client(), tab = 503;
    const owner = claim(p, tab, 'original-owner');
    // Simulated transport failure: there is no associated live bridge at all.
    // A lock cannot be reclaimed just because the front end stops receiving polls.
    try {
      expect(() => claim(p, tab, 'foreign-owner')).toThrow(/another owner|claimed/i);
      const publicSession = listDelegateSessions().find(s => s.clientId === p && s.tabId === tab);
      expect(publicSession?.agentId).toBe('original-owner');
      expect(publicSession).not.toHaveProperty('sessionToken');
      expect(() => authorizeDelegateTarget(p, tab, 'foreign-owner',
        undefined, true)).toThrow(/claimed/i);
    } finally {
      releaseDelegateTarget(p, tab, 'original-owner', owner.sessionToken);
    }
  });
});
