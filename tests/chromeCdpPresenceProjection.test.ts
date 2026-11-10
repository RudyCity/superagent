import { describe, expect, test } from "vitest";
import { projectManagedCdpPresence } from "../src/core/tools/chromeCdpPresenceProjection.js";

const now=Date.now();
const session={
  key:"a".repeat(64),port:9222,targetId:"A1",agentId:"owner-agent",
  mode:"shared",revision:3,expiresAt:now+60000,
  sessionToken:"SECRET_SESSION",tokenHash:"SECRET_HASH",
  url:"https://private.example/?token=SECRET_QUERY",
  participants:[{agentId:"owner-agent",role:"owner",secret:"OWNER_SECRET"},
    {agentId:"observer-agent",role:"observer",secret:"WATCHER_SECRET"}],
};
describe("Managed CDP Tray presence projection",()=>{
  test("explicitly drops keys, capability tokens, urls and private browser content",()=>{
    const data=projectManagedCdpPresence({sessions:[session],queue:[
      {key:"a".repeat(16),queued:2,locked:true,ownerToken:"QUEUE_SECRET"},
    ]},now);
    expect(data.status).toBe("known");
    expect(data.sessions).toEqual([{
      transport:"managed",port:9222,targetId:"A1",agentId:"owner-agent",
      mode:"shared",revision:3,expiresAt:now+60000,queued:2,busy:true,
      participants:[{agentId:"owner-agent",role:"owner"},{agentId:"observer-agent",role:"observer"}],
    }]);
    const raw=JSON.stringify(data);
    for(const secret of ["SECRET_SESSION","SECRET_HASH","SECRET_QUERY","OWNER_SECRET",
        "WATCHER_SECRET","QUEUE_SECRET","tokenHash","sessionToken","url",'"key"'])
      expect(raw).not.toContain(secret);
  });
  test("unknown is explicit; stale sessions are omitted",()=>{
    expect(projectManagedCdpPresence(null).status).toBe("unknown");
    expect(projectManagedCdpPresence({sessions:[{...session,expiresAt:now-1}],queue:[]},now).sessions)
      .toHaveLength(0);
  });
  test("bounds output",()=>{
    const sessions=Array.from({length:134},(_,i)=>({...session,targetId:"Tab"+i}));
    const result=projectManagedCdpPresence({sessions,queue:[]},now);
    expect(result.sessions).toHaveLength(128);
    expect(result.truncated).toBe(true);
  });
});
