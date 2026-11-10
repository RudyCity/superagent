import {afterEach,describe,expect,test,vi} from "vitest";
import {EventEmitter} from "node:events";
import {Readable} from "node:stream";
import {handleServerRoute} from "../src/serverRoutes.js";
import {ensureServerAuthToken} from "../src/core/utils/serverSecurity.js";
import * as feed from "../src/core/tools/chromeCdpLiveFeed.js";
import * as approvals from "../src/core/tools/chromeCdpReplayApprovals.js";
import * as registry from "../src/core/tools/managedBrowserRegistry.js";
import * as control from "../src/core/tools/managedBrowserControl.js";

type Result={status:number;body:any;headers:Record<string,string>};
async function invoke(path:string, options:{
  method?:string; body?:unknown; headers?:Record<string,string>; remote?:string;
}={}):Promise<Result>{
 const payload=options.body===undefined ? [] : [JSON.stringify(options.body)];
 const req=Readable.from(payload) as any;
 req.method=options.method??"GET";
 req.url=path;
 req.headers={host:"127.0.0.1:7888",
   authorization:"Bearer "+ensureServerAuthToken(),...options.headers};
 req.socket={remoteAddress:options.remote??"127.0.0.1",localPort:7888};
 const res=Object.assign(new EventEmitter(),{
   destroyed:false,
   setHeader:(key:string,value:string)=>{reply.headers[key.toLowerCase()]=value;},
 }) as any;
 const reply:Result={status:-1,body:null,headers:{}};
 const base=path.split("?")[0];
 const handled=await handleServerRoute(req,res,base,
   new URL("http://127.0.0.1:7888"+path),{
     activeSessions:new Map(),
     readBody:async(input:NodeJS.ReadableStream)=>{
       let contents="";
       for await(const chunk of input) contents+=String(chunk);
       return contents;
     },
     sendJSON:(_res:unknown,status:number,body:unknown)=>{reply.status=status;reply.body=body;},
   } as any);
 expect(handled).toBe(true);
 return reply;
}
afterEach(()=>vi.restoreAllMocks());
describe("local native CDP activity and operator authorization boundary",()=>{
 test("live feed requires local bearer and rejects forwarded/browser-origin requests",async()=>{
   const watch=vi.spyOn(feed,"watchManagedCdpLive").mockResolvedValue({
     status:"heartbeat",cursor:"a".repeat(64),
     managedCdp:{status:"known",observedAt:Date.now(),sessions:[],
       truncated:false,summary:{agents:0,tabs:0,queued:0,busy:0},
       replayApprovals:[]},
   } as any);
   const authorized=await invoke("/api/desktop/cdp/live?cursor="+"a".repeat(64));
   expect(authorized.status).toBe(200);
   expect(authorized.body.status).toBe("heartbeat");
   expect(authorized.headers["cache-control"]).toBe("no-store");
   expect(watch).toHaveBeenCalledWith("a".repeat(64),expect.objectContaining({signal:expect.any(Object)}));
   const count=watch.mock.calls.length;
   const rejected=[
     {headers:{authorization:""}},
     {headers:{authorization:"Bearer incorrect"}},
     {headers:{host:"attacker.example"}},
     {headers:{origin:"https://evil.example"}},
     {headers:{referer:"https://evil.example"}},
     {headers:{"x-forwarded-for":"127.0.0.1"}},
     {remote:"192.0.2.1"},
   ];
   for(const item of rejected)
     expect((await invoke("/api/desktop/cdp/live",item)).status).toBe(403);
   expect(watch).toHaveBeenCalledTimes(count);
   expect((await invoke("/api/desktop/cdp/live?token=secret")).status).toBe(405);
   expect((await invoke("/api/desktop/cdp/live?cursor=private")).status).toBe(400);
   expect((await invoke("/api/desktop/cdp/live",{method:"POST"})).status).toBe(405);
 });
 test("manual takeover accepts only live registered target, explicit revision and native auth",async()=>{
   const registration={port:9222,targetId:"TARGET_1",profileId:"private-managed",
     generation:"1001-1793000000000000",browserFingerprint:"a".repeat(64),
     registeredAt:Date.now(),expiresAt:Date.now()+60000};
   vi.spyOn(registry,"listManagedBrowserRegistrations").mockReturnValue([registration]);
   const controlFn=vi.spyOn(control,"setManagedBrowserControl").mockResolvedValue({mode:"human"});
   const body={port:9222,targetId:"TARGET_1",mode:"human",expectedRevision:4};
   const response=await invoke("/api/desktop/cdp/control",{method:"POST",body});
   expect(response.status).toBe(200);
   expect(response.body.note).toContain("agent mutations blocked");
   expect(controlFn).toHaveBeenCalledWith(expect.objectContaining({
     browserFingerprint:registration.browserFingerprint,mode:"human",
   }),undefined,4);
   const count=controlFn.mock.calls.length;
   expect((await invoke("/api/desktop/cdp/control",{method:"POST",body:{...body,secret:"unexpected"}})).status).toBe(409);
   expect((await invoke("/api/desktop/cdp/control",{method:"POST",body:{...body,expectedRevision:-1}})).status).toBe(409);
   expect((await invoke("/api/desktop/cdp/control",{method:"POST",body:{...body,targetId:"OTHER"}})).status).toBe(409);
   expect((await invoke("/api/desktop/cdp/control",{method:"POST",body,headers:{origin:"https://evil.example"}})).status).toBe(403);
   expect(controlFn).toHaveBeenCalledTimes(count);
 });
 test("replay approval is local, exact, and POST-only",async()=>{
   const review=vi.spyOn(approvals,"reviewReplayApproval").mockResolvedValue({
     approvalId:"a".repeat(8)+"-aaaa-4aaa-8aaa-"+"a".repeat(12),status:"approved",
   } as any);
   const body={approvalId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",decision:"approve"};
   expect((await invoke("/api/desktop/cdp/approval",{method:"POST",body})).body.approval.status).toBe("approved");
   expect(review).toHaveBeenCalledWith(body.approvalId,"approve");
   expect((await invoke("/api/desktop/cdp/approval",{method:"GET"})).status).toBe(405);
   expect((await invoke("/api/desktop/cdp/approval",{method:"POST",body:{...body,url:"https://private.test"}})).status).toBe(409);
   expect((await invoke("/api/desktop/cdp/approval",{method:"POST",body:{...body,decision:"auto"}})).status).toBe(409);
   expect((await invoke("/api/desktop/cdp/approval",{method:"POST",body,headers:{authorization:""}})).status).toBe(403);
   expect(review).toHaveBeenCalledTimes(1);
 });
});
