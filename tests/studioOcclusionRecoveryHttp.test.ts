import { describe,expect,it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { importMotionVideo } from "../src/core/motion/assets/motionVideoClips.js";
import { listMotionProjects } from "../src/core/motion/project/projectStore.js";
const run=promisify(execFile);
describe("P8.2 identity confirmation behind workspace-scoped Studio HTTP route",()=>{
  it("never saves a preview, rejects a wrong mapping/token, and commits only reviewed candidate",async()=>{
    const ws=await fs.mkdtemp(path.join(os.tmpdir(),"studio-recovery-api-"));
    const server=http.createServer((req,res)=>{
      const url=new URL(req.url??"/","http://127.0.0.1");
      void handleMotionHttpRoute(req,res,url.pathname,url,{
        resolveWorkspacePath:()=>ws,
        sendJSON(r,status,data){r.writeHead(status,{"Content-Type":"application/json"});r.end(JSON.stringify(data));},
      }).then(handled=>{
        if(!handled && !res.headersSent){res.writeHead(404);res.end();}
      }).catch(err=>{if(!res.headersSent){res.writeHead(500);res.end(String(err));}});
    });
    try{
      for(let frame=0;frame<30;frame++){
        const canvas=createCanvas(160,90),ctx=canvas.getContext("2d");
        ctx.fillStyle="#101010";ctx.fillRect(0,0,160,90);
        ctx.fillStyle="#ffcc66";ctx.fillRect(35,18,20,20);
        ctx.fillStyle="#22ddff";ctx.fillRect(frame>=17&&frame<=19?54:70,18,20,20);
        await fs.writeFile(path.join(ws,"recovery"+String(frame).padStart(3,"0")+".png"),
          await canvas.encode("png"));
      }
      await run("ffmpeg",["-hide_banner","-loglevel","error","-framerate","10",
        "-i",path.join(ws,"recovery%03d.png"),"-y","-c:v","libx264",
        "-pix_fmt","yuv420p",path.join(ws,"clip.mp4")],
        {timeout:30000,maxBuffer:4096,windowsHide:true});
      const imported=await importMotionVideo(ws,await fs.readFile(path.join(ws,"clip.mp4")));
      await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
      const address=server.address();
      if(!address||typeof address==="string")throw new Error("Missing local test listener");
      const api="http://127.0.0.1:"+address.port+"/api/studio/reconstruct/multi/recovery";
      const post=async(args:Record<string,unknown>)=>{
        const response=await fetch(api,{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({videoId:imported.id,frame:54,...args})});
        return {status:response.status,body:await response.json() as Record<string,unknown>};
      };
      expect((await post({previewOnly:true,beforeToAfter:[0,0]})).status).toBe(400);
      expect((await post({previewOnly:true,beforeToAfter:[1,0]})).status).toBe(400);
      expect((await post({previewOnly:false,beforeToAfter:[0,1]})).status).toBe(400);
      expect(await listMotionProjects(ws)).toHaveLength(0);
      const candidate=await post({previewOnly:true,beforeToAfter:[0,1]});
      expect(candidate.status).toBe(200);
      expect(candidate.body.status).toBe("recovery-candidate");
      expect(String(candidate.body.token)).toMatch(/^[a-f0-9]{64}$/);
      expect(Buffer.from(String(candidate.body.previewPngBase64),"base64")
        .subarray(0,8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(JSON.stringify(candidate.body)).not.toContain(ws);
      expect(await listMotionProjects(ws)).toHaveLength(0);
      const rejected=await post({previewOnly:false,beforeToAfter:[0,1],
        candidateToken:"0".repeat(64),acknowledgement:"APPROVE_MANUAL_RECOVERY"});
      expect(rejected.status).toBe(400);
      expect(await listMotionProjects(ws)).toHaveLength(0);
      const accepted=await post({previewOnly:false,beforeToAfter:[0,1],
        candidateToken:candidate.body.token,acknowledgement:"APPROVE_MANUAL_RECOVERY"});
      expect(accepted.status).toBe(201);
      expect(accepted.body.status).toBe("experimental-multi");
      expect(accepted.body.recovery).toMatchObject({frame:54,manuallyConfirmed:true});
      expect(JSON.stringify(accepted.body)).not.toContain(ws);
      expect((accepted.body as Record<string,unknown>).reviewPng).toBeUndefined();
      expect((accepted.body as Record<string,unknown>).diffPng).toBeUndefined();
      expect(await listMotionProjects(ws)).toHaveLength(1);
    }finally{
      server.closeAllConnections();
      if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
      await fs.rm(ws,{recursive:true,force:true});
    }
  },65000);
});
