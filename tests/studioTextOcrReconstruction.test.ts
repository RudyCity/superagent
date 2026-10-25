import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { promisify } from "node:util";
import { createCanvas } from "@napi-rs/canvas";
import { importMotionVideo } from "../src/core/motion/assets/motionVideoClips.js";
import { localStudioTextOcrReady, parseStudioOcrTsv, reconstructStudioTextVideo } from "../src/core/motion/code/videoTextOcrReconstruction.js";
import { getMotionProject, listMotionProjects } from "../src/core/motion/project/projectStore.js";
import { renderStudioNativeHtml } from "../src/core/motion/code/studioNativeCodeExporter.js";
const execute = promisify(execFile);
const dirs: string[] = [];
const hasOcr = (() => {
  try { execFileSync("tesseract", ["--version"], { timeout: 5000, windowsHide: true, stdio: "ignore" }); return true; }
  catch { return false; }
})();
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
async function clip(changeText = false) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "studio-ocr-test-"));
  dirs.push(workspace);
  for (let frame = 0; frame < 30; frame++) {
    const canvas = createCanvas(640, 360);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f0f0f0";
    ctx.fillRect(0, 0, 640, 360);
    ctx.font = "bold 72px Arial";
    ctx.fillStyle = "#101c40";
    ctx.fillText(changeText && frame >= 14 ? "OTHER" : "STUDIO", 80 + Math.floor(frame / 3), 185);
    await fs.writeFile(path.join(workspace,"f"+String(frame).padStart(3,"0")+".png"),
      await canvas.encode("png"));
  }
  await execute("ffmpeg",[
    "-hide_banner","-loglevel","error","-framerate","10","-i",
    path.join(workspace,"f%03d.png"),"-y","-c:v","libx264","-pix_fmt","yuv420p",
    path.join(workspace,"clip.mp4")
  ],{timeout:30000,maxBuffer:4096,windowsHide:true});
  const imported = await importMotionVideo(workspace, await fs.readFile(path.join(workspace,"clip.mp4")));
  return { workspace, videoId: imported.id };
}
describe("Studio optional local video OCR", () => {
  it("gates OCR readiness on the presence of local English Tesseract", async () => {
    expect(await localStudioTextOcrReady()).toBe(hasOcr);
  });
  it("parses bounded TSV and rejects malicious/untrusted OCR candidates", () => {
    const tsv = "level\tblock_num\tpar_num\tline_num\tleft\ttop\twidth\theight\tconf\ttext\n" +
      "5\t1\t1\t1\t10\t20\t90\t45\t96\tSTUDIO\n" +
      "5\t1\t1\t2\t11\t71\t60\t35\t94\t<script>\n" +
      "5\t1\t1\t3\t10\t120\t90\t45\t42\tWOBBLY\n";
    expect(parseStudioOcrTsv(tsv,640,360)).toMatchObject([
      {text:"STUDIO",confidence:96,x:10,y:20,width:90,height:45}
    ]);
    expect(() => parseStudioOcrTsv("malformed",640,360)).toThrow(/header/);
    expect(() => parseStudioOcrTsv(tsv,0,360)).toThrow();
    expect(() => parseStudioOcrTsv("x".repeat(200001),640,360)).toThrow();
  });
  it.skipIf(!hasOcr)("creates revisioned editable text with tracked x/y from real local MP4", async () => {
    const {workspace,videoId}=await clip();
    const result=await reconstructStudioTextVideo(workspace,videoId);
    expect(result.status).toBe("experimental-ocr");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].text).toBe("STUDIO");
    expect(result.averageConfidence).toBeGreaterThan(.75);
    const saved=await getMotionProject(workspace,result.projectId);
    expect(saved.revision).toBe(2);
    expect(saved.composition.layers).toHaveLength(1);
    const text=saved.composition.layers[0];
    expect(text.kind).toBe("text");
    expect(text.tracks.map(track=>track.property)).toEqual(["x","y"]);
    expect(text.tracks[0].keyframes).toHaveLength(3);
    expect(text.tracks[0].keyframes[2].value).toBeGreaterThan(text.tracks[0].keyframes[0].value);
    const html=renderStudioNativeHtml(saved);
    expect(html).toContain("STUDIO");
    expect(html).not.toContain("cdn.jsdelivr.net");
  },65000);
  it.skipIf(!hasOcr)("does not save projects when caption text changes over time", async () => {
    const {workspace,videoId}=await clip(true);
    await expect(reconstructStudioTextVideo(workspace,videoId))
      .rejects.toThrow(/text or geometry changed/);
    expect(await listMotionProjects(workspace)).toEqual([]);
  },65000);
  it.skipIf(!hasOcr)("creates editable text through the scoped Studio HTTP route", async () => {
    const {workspace,videoId}=await clip();
    const server=http.createServer((req,res)=>{
      const url=new URL(req.url ?? "/", "http://127.0.0.1");
      void handleMotionHttpRoute(req,res,url.pathname,url,{
        resolveWorkspacePath:()=>workspace,
        sendJSON(r,status,data){
          r.writeHead(status,{"Content-Type":"application/json"});
          r.end(JSON.stringify(data));
        },
      }).then(handled=>{
        if(!handled && !res.headersSent) {res.writeHead(404);res.end();}
      }).catch(error=>{
        if(!res.headersSent){res.writeHead(500);res.end(String(error));}
      });
    });
    try {
      await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
      const addr=server.address();
      if(!addr || typeof addr==="string") throw new Error("HTTP test address unavailable");
      const base="http://127.0.0.1:"+addr.port+"/api/studio";
      const invalid=await fetch(base+"/reconstruct/text",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({videoId:"../../outside"}),
      });
      expect(invalid.status).toBe(400);
      expect(await listMotionProjects(workspace)).toHaveLength(0);
      const response=await fetch(base+"/reconstruct/text",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({videoId}),
      });
      expect(response.status).toBe(201);
      const body=await response.json() as {projectId:string;revision:number;lines:Array<{text:string}>};
      expect(body.lines).toMatchObject([{text:"STUDIO"}]);
      const saved=await fetch(base+"/projects/"+body.projectId);
      expect(saved.status).toBe(200);
      expect((await getMotionProject(workspace,body.projectId)).composition.layers[0].kind).toBe("text");
    } finally {
      server.closeAllConnections();
      if(server.listening) await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  },65000);
  it("refuses invalid content-addressed video IDs", async () => {
    const ws=await fs.mkdtemp(path.join(os.tmpdir(),"studio-ocr-bad-"));
    dirs.push(ws);
    await expect(reconstructStudioTextVideo(ws,"../evil")).rejects.toThrow(/Invalid Motion video ID/);
    expect(await listMotionProjects(ws)).toEqual([]);
  });
});
