import {afterEach,describe,expect,it} from "vitest";
import http from "node:http";
import {safeManagedChromeObservation} from "../src/core/tools/safeManagedChromeObservation.js";
async function serverWith(payload:unknown){
 const server=http.createServer((_req,res)=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(payload));});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 return {server,port:(server.address() as {port:number}).port};
}
afterEach(()=>{delete process.env.SUPERAGENT_CDP_HOST;});
describe("certified Chrome metadata reader",()=>{
 it("exposes only HTTP(S) page metadata, not local files or sensitive internal tabs",async()=>{
   const {server,port}=await serverWith([
     {type:"page",id:"public1",title:"Public",url:"https://example.com/"},
     {type:"page",id:"secret1",title:"secret document",url:"file:///C:/private.txt"},
     {type:"page",id:"internal1",title:"Internal",url:"chrome://settings"},
     {type:"service_worker",id:"worker1",title:"Worker",url:"https://example.com/"},
   ]);
   try{
     const result=await safeManagedChromeObservation({command:"list_targets",debug_port:port});
     expect(result).toContain("public1");
     expect(result).not.toContain("secret");
     expect(result).not.toContain("internal1");
     const status=JSON.parse(await safeManagedChromeObservation({command:"transport_status",debug_port:port}));
     expect(status.certifiedHttpTargets).toBe(1);
     expect(status.browserLaunch).toBe(false);
   }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it("blocks unsupported routes, ports, and remote hosts before I/O",async()=>{
   await expect(safeManagedChromeObservation({command:"evaluate"})).rejects.toThrow(/Uncertified/);
   await expect(safeManagedChromeObservation({command:"list_targets",transport:"delegate"})).rejects.toThrow(/managed/);
   await expect(safeManagedChromeObservation({command:"list_targets",debug_port:1})).rejects.toThrow(/Invalid/);
   process.env.SUPERAGENT_CDP_HOST="192.0.2.1";
   await expect(safeManagedChromeObservation({command:"list_targets"})).rejects.toThrow(/Remote/);
 });
 it("redacts credentials, query strings, fragments and control characters from certified URL inventory",async()=>{
   const {server,port}=await serverWith([
     {type:"page",id:"safe1",title:"Public\\nPage",url:"https://user:pass@example.org/photos?token=DO_NOT_EXPOSE#private"},
   ]);
   try{
     const output=await safeManagedChromeObservation({command:"list_targets",debug_port:port});
     expect(output).toContain("safe1");
     expect(output).toContain("https://example.org/photos");
     expect(output).not.toMatch(/DO_NOT_EXPOSE|user:pass|#private/);
     expect(output).not.toContain("Public\\nPage");
   }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it("reports a closed debugging port without claiming that Delegate is disconnected",async()=>{
   const {server,port}=await serverWith([]);
   await new Promise<void>(resolve=>server.close(()=>resolve()));
   const status=JSON.parse(await safeManagedChromeObservation({command:"transport_status",debug_port:port}));
   expect(status).toMatchObject({
     transport:"managed",reachable:false,failureCode:"CDP_ENDPOINT_REFUSED",
     port,portSource:"explicit",browserLaunch:false,localFileTabsExcluded:true,
   });
   expect(status.diagnostic).toContain("debug_port");
   expect(status.diagnostic).toContain("Delegate");
   await expect(safeManagedChromeObservation({command:"list_targets",debug_port:port}))
     .rejects.toThrow(/CDP_ENDPOINT_REFUSED.*127\\.0\\.0\\.1/);
 });

});
