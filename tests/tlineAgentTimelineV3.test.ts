import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { bindTlineRootAgent, inheritTlineChildScope, recordTlineChildToolEvent,
  readAgentTimeline, recordAgentTimeline, setAgentTimelineRootForTests,
  projectAgentTimelineEnvelope } from '../src/core/channels/tlineAgentTimeline.js';
import { handleTlineAgentTimelineRoute } from '../src/core/channels/tlineAgentTimelineHttp.js';
import { cancelTlineApproval, decideTlineApproval, getTlineApproval,
  listTlineApprovals, registerTlineApproval } from '../src/core/channels/tlineApprovalRegistry.js';

let temp = '';
const scope = { workspace: 'D:/Root/isolated', sessionId: 'v3_session' };
beforeEach(() => { temp = mkdtempSync(path.join(os.tmpdir(), 'tline-v3-')); setAgentTimelineRootForTests(temp); });
afterEach(() => {
  setAgentTimelineRootForTests();
  rmSync(temp,{recursive:true,force:true});
  vi.useRealTimers();
});
describe('Core agent timeline V3', () => {
  it('correlates start/end by hashed call ID and links verified nested agent parent without raw IDs', () => {
    const root = {}; const sub = {}; const grandchild = {};
    bindTlineRootAgent(root, scope);
    expect(inheritTlineChildScope(root, sub, 'secret-child-id')).toBe(true);
    expect(inheritTlineChildScope(sub, grandchild, 'secret-grandchild-id')).toBe(true);
    expect(recordTlineChildToolEvent(sub, 'secret-child-id', {
      type:'tool_start', toolCall:{id:'secret-tool-capability-id',name:'read_files'}
    })).toBe(true);
    expect(recordTlineChildToolEvent(sub, 'secret-child-id', {
      type:'tool_end', toolResult:{toolCallId:'secret-tool-capability-id',name:'read_files',isError:false}
    })).toBe(true);
    expect(recordTlineChildToolEvent(grandchild,'secret-grandchild-id',{
      type:'tool_start',toolCall:{id:'another-call',name:'web_search'}
    })).toBe(true);
    const events = readAgentTimeline(scope,0).events;
    expect(events).toHaveLength(3);
    expect(events[0].actor).toBe(events[1].actor);
    expect(events[0].callId).toBe(events[1].callId);
    expect(events[0].callId).toMatch(/^[a-f0-9]{20}$/);
    expect(events[0].parent).toBe('main');
    expect(events[2].parent).toBe(events[0].actor);
    expect(JSON.stringify(events)).not.toContain('secret-child-id');
    expect(JSON.stringify(events)).not.toContain('secret-tool-capability-id');
  });
  it('projects root tool call IDs without leaking original capability', () => {
    for (const ev of [
      {type:'agent_event',event:{type:'tool_start',toolCall:{id:'private-id',name:'read_files'}}},
      {type:'agent_event',event:{type:'tool_end',toolCall:{id:'private-id',name:'read_files'},
        toolResult:{name:'read_files',isError:false}}},
    ]) for (const meta of projectAgentTimelineEnvelope(ev))
      expect(recordAgentTimeline(scope,meta)).toBe(true);
    const rows = readAgentTimeline(scope,0).events;
    expect(rows[0].callId).toBe(rows[1].callId);
    expect(rows[0].callId).not.toBe('private-id');
  });
  it('rejects invalid ownership in streaming route and emits only sanitized SSE', async () => {
    recordAgentTimeline(scope,{kind:'tool_start',actor:'main',tool:'read_files',callId:'private-tool'});
    const req = {method:'GET',headers:{'x-workspace-path':scope.workspace,'x-client-mode':'tline'}} as unknown as http.IncomingMessage;
    const response = new EventEmitter() as EventEmitter & {
      setHeader:(k:string,v:string)=>void;writeHead:(s:number,h:any)=>void;
      write:(s:string)=>void;end:()=>void; socket:any;destroyed:boolean;writableEnded:boolean;
    };
    const writes:string[]=[]; const statuses:number[]=[];
    response.setHeader=()=>{}; response.writeHead=(status)=>{statuses.push(status)};
    response.write=(line)=>{writes.push(line)};
    response.end=()=>{response.writableEnded=true}; response.socket={setNoDelay:()=>{}};
    response.destroyed=false;response.writableEnded=false;
    const sendJSON=(_res:any,status:number)=>{statuses.push(status)};
    const url = new URL('http://localhost/api/tline/agent-timeline/stream?workspace=' +
      encodeURIComponent(scope.workspace)+'&sessionId='+scope.sessionId+'&cursor=0');
    await handleTlineAgentTimelineRoute(req,response as any,url.pathname,url,{
      resolveSession:()=>({...scope,clientMode:'tline'}),sendJSON,
    });
    response.emit('close');
    expect(statuses).toEqual([200]);
    const serialized=writes.join('');
    expect(serialized).toMatch(/^id: 1\ndata: \{[^\n]+\}\n\n$/);
    expect(serialized.split('\n\n')).toHaveLength(2);
    const parsedEvent = JSON.parse(serialized.split('\n')[1].slice('data: '.length));
    expect(parsedEvent.seq).toBe(1);
    expect(parsedEvent.tool).toBe('read_files');
    expect(serialized).not.toContain(String.raw`\n`);
    expect(serialized).toContain('"tool":"read_files"');
    expect(serialized).not.toContain('private-tool');
    const other = new EventEmitter() as any;
    other.setHeader=()=>{};other.writeHead=()=>{};other.write=()=>{};
    const denied:number[]=[];
    await handleTlineAgentTimelineRoute(req,other,url.pathname,url,{
      resolveSession:()=>({...scope,clientMode:'chrome-extension'}),
      sendJSON:(_res,status)=>{denied.push(status)},
    });
    expect(denied).toEqual([403]);
  });
  it('stops an already-open stream when owner session is revoked', async () => {
    vi.useFakeTimers();
    recordAgentTimeline(scope, { kind:'tool_start', actor:'main', tool:'read_files' });
    let authorized = true;
    const req = { method: 'GET', headers: {
      'x-workspace-path': scope.workspace, 'x-client-mode': 'tline'
    }} as unknown as http.IncomingMessage;
    const res = new EventEmitter() as any;
    const lines: string[] = [];
    let ended = 0;
    res.setHeader = () => {};
    res.writeHead = () => {};
    res.write = (part: string) => { lines.push(part); };
    res.end = () => { ended++; res.writableEnded = true; res.emit('close'); };
    res.socket = { setNoDelay: () => {} };
    res.destroyed = false; res.writableEnded = false;
    const url = new URL('http://localhost/api/tline/agent-timeline/stream?workspace=' +
      encodeURIComponent(scope.workspace) + '&sessionId=' + scope.sessionId);
    await handleTlineAgentTimelineRoute(req,res,url.pathname,url,{
      resolveSession: () => authorized ? {...scope,clientMode:'tline'} : null,
      sendJSON: () => { throw Error('Unexpected JSON response'); },
    });
    expect(lines.join('')).toContain('id: 1\ndata:');
    authorized = false;
    vi.advanceTimersByTime(1000);
    expect(ended).toBe(1);
    expect(lines).toHaveLength(1);
    vi.advanceTimersByTime(15000);
    expect(lines).toHaveLength(1);
  });
});
describe('T-Line approval CAS lifecycle', () => {
  it('is exact-session, single-decision and resolves expiration as denial', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
    const onExpiry=vi.fn();
    registerTlineApproval('permission_alpha',scope.sessionId,scope.workspace,onExpiry);
    expect(listTlineApprovals(scope.sessionId,scope.workspace)[0].state).toBe('pending');
    expect(decideTlineApproval('permission_alpha','different',scope.workspace,'approved')).toBeNull();
    expect(decideTlineApproval('permission_alpha',scope.sessionId,scope.workspace,'approved')?.state).toBe('approved');
    expect(decideTlineApproval('permission_alpha',scope.sessionId,scope.workspace,'denied')).toBeNull();
    vi.advanceTimersByTime(300001);
    expect(onExpiry).not.toHaveBeenCalled();
    registerTlineApproval('permission_beta',scope.sessionId,scope.workspace,onExpiry);
    vi.advanceTimersByTime(300001);
    expect(getTlineApproval('permission_beta')?.state).toBe('expired');
    expect(onExpiry).toHaveBeenCalledOnce();
    expect(decideTlineApproval('permission_beta',scope.sessionId,scope.workspace,'approved')).toBeNull();
  });
  it('cancels only the owning session and never reopens a decided request', () => {
    const id = 'permission_cancellation_' + Math.random().toString(16).slice(2);
    registerTlineApproval(id, scope.sessionId, scope.workspace, vi.fn());
    expect(cancelTlineApproval(id, 'other-session', scope.workspace)).toBe(false);
    expect(cancelTlineApproval(id, scope.sessionId, 'other-workspace')).toBe(false);
    expect(cancelTlineApproval(id, scope.sessionId, scope.workspace)).toBe(true);
    expect(getTlineApproval(id)?.state).toBe('cancelled');
    expect(cancelTlineApproval(id, scope.sessionId, scope.workspace)).toBe(false);
    expect(decideTlineApproval(id, scope.sessionId, scope.workspace, 'approved')).toBeNull();
    expect(listTlineApprovals(scope.sessionId, scope.workspace).some(
      item => item.permissionId === id && item.state === 'cancelled')).toBe(true);
  });
});
