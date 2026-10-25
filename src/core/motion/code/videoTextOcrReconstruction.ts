import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadImage } from "@napi-rs/canvas";
import { readMotionVideo } from "../assets/motionVideoClips.js";
import { createMotionProject, motionWorkspaceRoot, updateMotionProject } from "../project/projectStore.js";
import { validateMotionProject } from "../schema/validation.js";
import type { MotionProject, MotionTrack, TextLayer } from "../schema/types.js";
import { segmentStudioCaptionTimeline, buildStudioCaptionTimelineLayers } from "./videoCaptionTimeline.js";

const run = promisify(execFile);
interface OcrLine { text: string; confidence: number; x: number; y: number; width: number; height: number; }
interface OcrFrame {
  index: number; width: number; height: number;
  background: string; lines: OcrLine[];
}
export interface StudioTextOcrResult {
  status: "experimental-ocr"; projectId: string; revision: number;
  lines: Array<{ id: string; text: string; confidence: number; box: { x: number; y: number; width: number; height: number } }>;
  sampleTimes: number[]; dimensions: { width: number; height: number };
  averageConfidence: number; limitations: string[];
}
export interface StudioCaptionTimelineResult {
  status: "experimental-ocr-timeline"; projectId: string; revision: number;
  captions: Array<{ id: string; text: string; confidence: number;
    startFrame: number; endFrame: number;
    box: { x: number; y: number; width: number; height: number } }>;
  sampleTimes: number[]; dimensions: { width: number; height: number };
  averageConfidence: number; limitations: string[];
}
export function studioCaptionTimelineFrames(totalFrames: number): number[] {
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 30 || totalFrames > 360)
    throw new Error("Invalid bounded OCR timeline duration");
  return Array.from({ length: 9 }, (_, index) =>
    Math.round((totalFrames - 1) * .96 * index / 8));
}

/** Expose OCR UI only when the local executable and English data exist.
 * This runtime check is independent of a built/packaged feature flag.
 */
export async function localStudioTextOcrReady(): Promise<boolean> {
  try {
    const { stdout, stderr } = await run("tesseract", ["--list-langs"], {
      timeout: 5000, maxBuffer: 8192, windowsHide: true,
    });
    return (String(stdout) + String.fromCharCode(10) + String(stderr))
      .split(String.fromCharCode(10)).some(line => line.trim() === "eng");
  } catch {
    return false;
  }
}

const OCR_PATTERN = /^[a-zA-Z0-9 .,!?:;&'()\/+\-]{2,80}$/;
const rgbHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map(n => Math.round(n).toString(16).padStart(2, "0")).join("");

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
/** Pure TSV parser. No TSV content is used as a command, path or HTML. */
export function parseStudioOcrTsv(tsv: string, width: number, height: number): OcrLine[] {
  if (tsv.length > 200_000 || width < 1 || height < 1) throw new Error("Unbounded OCR output");
  const rows = tsv.trim().split(/\r?\n/);
  const headers = rows.shift()?.split("\t") ?? [];
  const expected = ["level", "block_num", "par_num", "line_num", "left", "top", "width", "height", "conf", "text"];
  const indices = expected.map(key => headers.indexOf(key));
  if (indices.some(i => i < 0)) throw new Error("Invalid OCR TSV header");
  const grouped = new Map<string, Array<OcrLine>>();
  for (const row of rows) {
    const columns = row.split("\t");
    const get = (key: string) => columns[indices[expected.indexOf(key)]] ?? "";
    if (get("level") !== "5") continue;
    const text = normalizeLine(get("text"));
    const confidence = Number(get("conf"));
    const x = Number(get("left")), y = Number(get("top"));
    const w = Number(get("width")), h = Number(get("height"));
    if (!text || !Number.isFinite(confidence) || confidence < 72 || !OCR_PATTERN.test(text) ||
      !/[a-zA-Z]{2}/.test(text) ||
      ![x,y,w,h].every(Number.isFinite) || x < 0 || y < 0 || w < 2 || h < 4 ||
      x + w > width || y + h > height) continue;
    const key = [get("block_num"),get("par_num"),get("line_num")].join(":");
    grouped.set(key, [...(grouped.get(key) ?? []), { text, confidence, x, y, width:w, height:h }]);
  }
  const output: OcrLine[] = [];
  for (const words of grouped.values()) {
    words.sort((a,b)=>a.x-b.x);
    const text = normalizeLine(words.map(word=>word.text).join(" "));
    if (!OCR_PATTERN.test(text) || !/[a-zA-Z]{2}/.test(text)) continue;
    const x = Math.min(...words.map(word=>word.x));
    const y = Math.min(...words.map(word=>word.y));
    const right = Math.max(...words.map(word=>word.x+word.width));
    const bottom = Math.max(...words.map(word=>word.y+word.height));
    const confidence = words.reduce((sum,word)=>sum+word.confidence,0)/words.length;
    output.push({ text, confidence, x, y, width:right-x, height:bottom-y });
  }
  return output.sort((a,b)=>a.y-b.y || a.x-b.x).slice(0,4);
}

/** This reconstructs simple stable English captions from an imported video.
 * It is intentionally isolated from the vector tracker: glyphs should never
 * be falsely interpreted as independent motion objects. OCR is local only.
 */
export async function reconstructStudioTextVideo(
  workspace: string, videoId: string,
): Promise<StudioTextOcrResult> {
  return reconstructStudioTextVideoInternal(workspace,videoId,false) as Promise<StudioTextOcrResult>;
}
export async function reconstructStudioCaptionTimelineVideo(
  workspace: string,videoId: string,
): Promise<StudioCaptionTimelineResult> {
  return reconstructStudioTextVideoInternal(workspace,videoId,true) as Promise<StudioCaptionTimelineResult>;
}
async function reconstructStudioTextVideoInternal(
  workspace:string, videoId:string, timeline:boolean,
): Promise<StudioTextOcrResult | StudioCaptionTimelineResult> {
  const video = await readMotionVideo(workspace, videoId);
  if (video.length > 12*1024*1024) throw new Error("OCR source video exceeds 12 MiB");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-text-ocr-"));
  try {
    const source = path.join(directory, video[0] === 0x1a ? "input.webm" : "input.mp4");
    await fs.writeFile(source,video,{mode:0o600});
    const probed = await run("ffprobe", [
      "-v","error","-show_entries","format=duration:stream=codec_type,width,height",
      "-of","json",source
    ],{timeout:10000,maxBuffer:32768,windowsHide:true});
    const metadata = JSON.parse(String(probed.stdout));
    const duration = Number(metadata.format?.duration);
    const track = metadata.streams?.find((item: {codec_type?: string})=>item.codec_type==="video");
    const sw = Number(track?.width), sh=Number(track?.height);
    if (!(duration>=1 && duration<=12) || !(sw>=64 && sw<=1280 && sh>=32 && sh<=720) ||
      sw/sh<.25 || sw/sh>4) throw new Error("OCR prototype accepts 1–12s video up to 1280×720");
    const totalFrames = Math.round(duration*30);
    const sampledFrames = timeline ? studioCaptionTimelineFrames(totalFrames)
      : [0,Math.round(totalFrames*.48),Math.min(totalFrames-1,Math.round(totalFrames*.94))];
    const sampled: OcrFrame[]=[];
    for (let i=0;i<sampledFrames.length;i++) {
      const frame=sampledFrames[i];
      const filename=path.join(directory,"ocr-"+i+".png");
      await run("ffmpeg",[
        "-hide_banner","-loglevel","error","-ss",String(frame/30),"-i",source,
        "-frames:v","1","-vf","scale=640:-2","-y",filename,
      ],{timeout:15000,maxBuffer:32768,windowsHide:true});
      const png=await fs.readFile(filename);
      if(png.length>4*1024*1024 || png.length<24) throw new Error("Invalid bounded OCR image");
      const img=await loadImage(png);
      if(img.width!==640 || img.height>1440) throw new Error("Invalid OCR dimensions");
      const {createCanvas}=await import("@napi-rs/canvas");
      const canvas=createCanvas(img.width,img.height);
      const context=canvas.getContext("2d");
      context.drawImage(img,0,0);
      const pixels=context.getImageData(0,0,img.width,img.height).data;
      const cornerOffsets=[0,img.width-1,(img.height-1)*img.width,img.height*img.width-1];
      const corners=cornerOffsets.map(index=>Array.from(pixels.slice(index*4,index*4+3)));
      const mean=[0,1,2].map(channel=>corners.reduce((sum,pixel)=>sum+pixel[channel],0)/4);
      if(corners.some(pixel=>Math.hypot(...pixel.map((value,k)=>value-mean[k]))>38))
        throw new Error("OCR background is not stable at image corners");
      const result=await run("tesseract",[
        filename,"stdout","-l","eng","--psm","6","tsv"
      ],{timeout:15000,maxBuffer:220000,windowsHide:true});
      const lines=parseStudioOcrTsv(String(result.stdout),img.width,img.height);
      if((!timeline && !lines.length) || lines.length>3)
        throw new Error("OCR could not confidently recognize 1–3 caption lines");
      sampled.push({index:frame,width:img.width,height:img.height,
        background:rgbHex(mean[0],mean[1],mean[2]),lines});
    }
    const reference=sampled[0];
    if(sampled.some(sample=>sample.width!==reference.width || sample.height!==reference.height ||
      (!timeline && sample.lines.length!==reference.lines.length)))
      throw new Error("OCR text lines or dimensions changed across sampled frames");
    const background=reference.background;
    const color=background.slice(1).match(/../g)!.map(v=>parseInt(v,16));
    if(sampled.some(frame=>{
      const channels=frame.background.slice(1).match(/../g)!.map(v=>parseInt(v,16));
      return Math.hypot(...channels.map((v,k)=>v-color[k]))>35;
    })) throw new Error("OCR background changed across sampled frames");
    if(timeline) {
      const segments=segmentStudioCaptionTimeline(sampled,totalFrames,reference.width,reference.height);
      const inferredWhite=color.reduce((a,b)=>a+b,0)/3<128;
      const annotated=buildStudioCaptionTimelineLayers(sampled,segments,totalFrames,
        inferredWhite?"#ffffff":"#121212");
      const composition={
        width:reference.width,height:reference.height,
        background,fps:{numerator:30,denominator:1},durationFrames:totalFrames,
        layers:annotated.map(item=>item.layer)
      };
      const now=new Date().toISOString();
      const preview:MotionProject={
        schemaVersion:1,id:"studio-ocr-timeline-preview",
        workspaceRoot:await motionWorkspaceRoot(workspace),
        name:"Editable caption timeline from reference video",revision:1,
        createdAt:now,updatedAt:now,composition
      };
      validateMotionProject(preview);
      const created=await createMotionProject(workspace,preview.name);
      const saved=await updateMotionProject(workspace,created.id,created.revision,[
        {type:"replace-composition",composition}
      ]);
      return {
        status:"experimental-ocr-timeline",projectId:saved.id,revision:saved.revision,
        captions:annotated.map(({layer,confidence,startFrame,endFrame})=>({
          id:layer.id,text:layer.text,confidence:Number((confidence/100).toFixed(3)),
          startFrame,endFrame,
          box:{x:layer.x,y:layer.y,width:layer.width,height:layer.height}
        })),
        sampleTimes:sampledFrames.map(frame=>Number((frame/30).toFixed(3))),
        dimensions:{width:reference.width,height:reference.height},
        averageConfidence:Number((annotated.reduce((sum,item)=>sum+item.confidence,0)
          /annotated.length/100).toFixed(3)),
        limitations:[
          "Caption transitions are approximated midway between samples, not frame-accurate.",
          "Only 1–3 simultaneous English caption lines on a stable solid-color background.",
          "One-sample captions and inconsistent OCR text/geometry require manual review.",
          "Local Tesseract only; font, color, glyph metrics and timing are approximate."
        ]
      };
    }
    for(const frame of sampled) for(let j=0;j<reference.lines.length;j++){
      const original=reference.lines[j], current=frame.lines[j];
      if(normalizeLine(current.text).toUpperCase()!==normalizeLine(original.text).toUpperCase() ||
        current.width/original.width<.7 || current.width/original.width>1.3 ||
        current.height/original.height<.7 || current.height/original.height>1.3 ||
        Math.hypot((current.x-original.x)/frame.width,(current.y-original.y)/frame.height)>.4)
        throw new Error("OCR text or geometry changed across sampled frames; review manually");
    }
    const inferredWhite=color.reduce((a,b)=>a+b,0)/3<128;
    const layers:TextLayer[]=reference.lines.map((line,j)=>{
      const lineTrack=(property:"x"|"y"):MotionTrack=>({
        property,keyframes:sampled.map(item=>({
          frame:item.index,
          value:item.lines[j][property] + (property==="y" ? -Math.max(2,Math.round(line.height*.12)):0),
          easing:"linear" as const,
        }))
      });
      return {
        id:"ocr-caption-"+(j+1),kind:"text",text:line.text,
        x:line.x,y:line.y,width:Math.max(8,Math.round(line.width*1.25)),
        height:Math.max(8,Math.round(line.height*1.4)),
        rotation:0,opacity:1,fill:inferredWhite?"#ffffff":"#121212",
        fontSize:Math.max(8,Math.min(96,Math.round(line.height*1.2))),
        fontFamily:"Arial",tracks:[lineTrack("x"),lineTrack("y")]
      };
    });
    const composition={
      width:reference.width,height:reference.height,
      background,fps:{numerator:30,denominator:1},durationFrames:totalFrames,
      layers,
    };
    const now=new Date().toISOString();
    const preview:MotionProject={
      schemaVersion:1,id:"studio-ocr-preview",workspaceRoot:await motionWorkspaceRoot(workspace),
      name:"Editable OCR text from reference video",revision:1,
      createdAt:now,updatedAt:now,composition
    };
    validateMotionProject(preview);
    const created=await createMotionProject(workspace,preview.name);
    const saved=await updateMotionProject(workspace,created.id,created.revision,[
      {type:"replace-composition",composition}
    ]);
    return {
      status:"experimental-ocr",projectId:saved.id,revision:saved.revision,
      lines:layers.map((layer,j)=>({id:layer.id,text:layer.text,
        confidence:Number((sampled.reduce((acc,f)=>acc+f.lines[j].confidence,0)/3/100).toFixed(3)),
        box:{x:layer.x,y:layer.y,width:layer.width,height:layer.height}})),
      sampleTimes:sampledFrames.map(frame=>Number((frame/30).toFixed(3))),
      dimensions:{width:reference.width,height:reference.height},
      averageConfidence:Number((sampled.reduce((sum,f)=>sum+f.lines.reduce((t,l)=>t+l.confidence,0),0)
        /(sampled.length*reference.lines.length)/100).toFixed(3)),
      limitations:[
        "Local Tesseract English OCR only, no model-powered scene understanding.",
        "Only 1–3 stable caption lines on a solid background; new/disappearing text is refused.",
        "Font family, glyph metrics and fill color are approximations; visually review and edit each text layer.",
        "Accuracy confidence is Tesseract's OCR estimate, not pixel/video parity.",
      ]
    };
  } finally {
    await fs.rm(directory,{recursive:true,force:true});
  }
}
