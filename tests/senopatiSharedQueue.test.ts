import { describe, expect, it } from "vitest";
import { SenopatiBoundedQueue } from "../src/core/senopatiSharedQueue.js";
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
describe("Senopati shared IPC bounded scheduler",()=>{
 it("keeps concurrency below limit and executes all queued tasks",async()=>{
   const queue=new SenopatiBoundedQueue<number>(3,40,1500);
   let concurrent=0,peak=0;
   const jobs=Array.from({length:35},(_,i)=>queue.run(async()=>{
     concurrent++;
     peak=Math.max(peak,concurrent);
     await wait(8);
     concurrent--;
     return i;
   }));
   const values=await Promise.all(jobs);
   expect(values).toEqual(Array.from({length:35},(_,i)=>i));
   expect(peak).toBeLessThanOrEqual(3);
   expect(queue.stats()).toMatchObject({active:0,queued:0,completed:35,rejected:0,timedOut:0});
 });
 it("rejects fast after bounded queue is full, no hidden extra workers",async()=>{
   const queue=new SenopatiBoundedQueue<string>(1,2,1500);
   let unblock!:()=>void;
   const gate=new Promise<void>(resolve=>{unblock=resolve;});
   const a=queue.run(async()=>{await gate;return "a";});
   const b=queue.run(async()=> "b");
   const c=queue.run(async()=> "c");
   const d=await queue.run(async()=> "NEVER");
   expect(d).toBeNull();
   expect(queue.stats()).toMatchObject({active:1,queued:2,rejected:1});
   unblock();
   expect(await Promise.all([a,b,c])).toEqual(["a","b","c"]);
 });
 it("expires waiting requests before executing them",async()=>{
   const queue=new SenopatiBoundedQueue<string>(1,1,100);
   let unblock!:()=>void;
   const gate=new Promise<void>(resolve=>{unblock=resolve;});
   const busy=queue.run(async()=>{await gate;return "done";});
   let ran=false;
   const stale=queue.run(async()=>{ran=true;return "stale";});
   expect(await stale).toBeNull();
   expect(ran).toBe(false);
   expect(queue.stats().timedOut).toBe(1);
   unblock();
   expect(await busy).toBe("done");
 });
 it("close rejects pending, but active job can drain",async()=>{
   const queue=new SenopatiBoundedQueue<number>(1,3,1200);
   let complete!:()=>void;
   const gate=new Promise<void>(resolve=>{complete=resolve;});
   const active=queue.run(async()=>{await gate;return 1;});
   const pending=queue.run(async()=>2);
   queue.close();
   expect(await pending).toBeNull();
   expect(await queue.run(async()=> 3)).toBeNull();
   complete();
   expect(await active).toBe(1);
   expect(queue.stats()).toMatchObject({active:0,queued:0,rejected:2});
 });
 it("cancels a disconnected client's queued work before ONNX runs",async()=>{
   const queue=new SenopatiBoundedQueue<string>(1,2,1200);
   let done!:()=>void;
   const hold=new Promise<void>(resolve=>{done=resolve;});
   const running=queue.run(async()=>{await hold;return "working";});
   let executed=false;
   const client=new AbortController();
   const pending=queue.run(async()=>{executed=true;return "not expected";},client.signal);
   expect(queue.stats().queued).toBe(1);
   client.abort();
   expect(await pending).toBeNull();
   expect(executed).toBe(false);
   expect(queue.stats()).toMatchObject({queued:0,canceled:1});
   done();
   expect(await running).toBe("working");
 });
 it("does not run a request with an already aborted signal",async()=>{
   const queue=new SenopatiBoundedQueue<string>(1,2,1200);
   const cancelled=new AbortController();
   cancelled.abort();
   let executed=false;
   expect(await queue.run(async()=>{executed=true;return "unsafe";},cancelled.signal)).toBeNull();
   expect(executed).toBe(false);
   expect(queue.stats()).toMatchObject({active:0,queued:0,canceled:1});
 });
 it("rejects arbitrary unsafe queue configuration",()=>{
   expect(()=>new SenopatiBoundedQueue(0,64,7000)).toThrow();
   expect(()=>new SenopatiBoundedQueue(4,2048,7000)).toThrow();
   expect(()=>new SenopatiBoundedQueue(4,64,50)).toThrow();
 });
});
