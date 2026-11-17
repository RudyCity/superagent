/**
 * Bounded, project-local ZIP writer for finalized recording archives.
 * Only explicit basenames are included, in STORE mode (MP4 is compressed).
 * No shell commands, network transfer, symlinks, nested paths, or huge buffers.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

export const RECORDING_ZIP_ENTRIES = Object.freeze([
  "video.mp4", "manifest.json", "README.txt", "actions.json",
  "transcript.jsonl", "console.jsonl", "errors.jsonl", "network.jsonl",
  "diagnostics.jsonl",
]);
const MAX_ENTRY_BYTES = 160_000_000;
const MAX_TOTAL_BYTES = 175_000_000;
const MAX_ZIP_BYTES = 176_000_000;
const active = new Set<string>();
const TABLE = Array.from({length:256},(_,i)=>{
  let crc=i;
  for(let n=0;n<8;n++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  return crc>>>0;
});
function crcUpdate(crc:number,chunk:Buffer):number {
  for(const byte of chunk) crc=TABLE[(crc^byte)&255]^(crc>>>8);
  return crc>>>0;
}
async function safeEntry(directory:string, basename:string) {
  const path=join(directory,basename);
  const info=await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() ||
      info.size>MAX_ENTRY_BYTES || info.size<0) throw Error("Unsafe ZIP entry.");
  const absolute=await realpath(path);
  const rel=relative(directory,absolute);
  if(rel!==basename || isAbsolute(rel)) throw Error("ZIP entry leaves recording directory.");
  return {path,info};
}
async function appendAll(handle:Awaited<ReturnType<typeof open>>,chunk:Buffer,position:number):Promise<number> {
  let written=0;
  while(written<chunk.length) {
    const next=await handle.write(chunk,written,chunk.length-written,position+written);
    if(next.bytesWritten<=0)throw Error("ZIP write failed.");
    written+=next.bytesWritten;
  }
  return position+written;
}
async function metadata(path:string,limit=MAX_ENTRY_BYTES) {
  const flags=constants.O_RDONLY | (process.platform==="win32"?0:constants.O_NOFOLLOW);
  const handle=await open(path,flags);
  let crc=0xffffffff,bytes=0;
  const digest=createHash("sha256");
  try {
    for await(const input of handle.createReadStream({autoClose:false,highWaterMark:65536})){
      const chunk=input as Buffer;
      bytes+=chunk.length;
      if(bytes>limit)throw Error("Archive entry exceeds ZIP size limit.");
      crc=crcUpdate(crc,chunk);
      digest.update(chunk);
    }
  } finally {await handle.close();}
  return {bytes,crc:(crc^0xffffffff)>>>0,sha256:digest.digest("hex")};
}
type Entry={name:string;path?:string;data?:Buffer;bytes:number;crc:number;offset:number};
function header(entry:Entry,central=false):Buffer {
  const name=Buffer.from(entry.name,"utf8");
  const extra=central?46:30;
  const bytes=Buffer.alloc(extra);
  bytes.writeUInt32LE(central?0x02014b50:0x04034b50,0);
  if(central){
    bytes.writeUInt16LE(20,4);bytes.writeUInt16LE(20,6);
    bytes.writeUInt16LE(0x0800,8);bytes.writeUInt16LE(0,10);
    bytes.writeUInt32LE(entry.crc,16);
    bytes.writeUInt32LE(entry.bytes,20);bytes.writeUInt32LE(entry.bytes,24);
    bytes.writeUInt16LE(name.length,28);
    bytes.writeUInt32LE(entry.offset,42);
  }else{
    bytes.writeUInt16LE(20,4);bytes.writeUInt16LE(0x0800,6);
    bytes.writeUInt16LE(0,8);bytes.writeUInt32LE(entry.crc,14);
    bytes.writeUInt32LE(entry.bytes,18);bytes.writeUInt32LE(entry.bytes,22);
    bytes.writeUInt16LE(name.length,26);
  }
  return Buffer.concat([bytes,name]);
}
export async function writeProjectRecordingZip(directory:string):Promise<{
  path:string;bytes:number;sha256:string;entries:number;
}> {
  const real=await realpath(directory);
  if(real!==directory)throw Error("Archive directory must be canonical.");
  if(active.has(real))throw Error("A ZIP export is already running.");
  active.add(real);
  const output=join(real,"recording.zip");
  const temp=join(real,"recording.zip.tmp-"+randomUUID());
  let created=false;
  try {
    let total=0;
    const entries:Entry[]=[];
    const hashes:string[]=[];
    for(const name of RECORDING_ZIP_ENTRIES){
      let info;
      try { info=await safeEntry(real,name); }
      catch(error){
        if((error as NodeJS.ErrnoException).code==="ENOENT" &&
           name!=="video.mp4" && name!=="manifest.json")continue;
        throw error;
      }
      total+=info.info.size;
      if(total>MAX_TOTAL_BYTES)throw Error("Recording archive exceeds export limit.");
      const digest=await metadata(info.path);
      if(digest.bytes!==info.info.size)throw Error("Archive changed while preparing ZIP.");
      entries.push({name,path:info.path,bytes:digest.bytes,crc:digest.crc,offset:0});
      hashes.push(digest.sha256+"  "+name);
    }
    const checks=Buffer.from(hashes.join("\n")+"\n","utf8");
    const crc=(crcUpdate(0xffffffff,checks)^0xffffffff)>>>0;
    entries.push({name:"checksums.sha256",data:checks,bytes:checks.length,crc,offset:0});
    if(entries.length>16)throw Error("Too many archive entries.");
    const destination=await open(temp,"wx",0o600);
    created=true;
    let offset=0;
    try {
      for(const entry of entries){
        entry.offset=offset;
        offset=await appendAll(destination,header(entry),offset);
        if(entry.data){
          offset=await appendAll(destination,entry.data,offset);
        }else{
          const handle=await open(entry.path!,constants.O_RDONLY |
            (process.platform==="win32"?0:constants.O_NOFOLLOW));
          try {
            const now=await handle.stat();
            if(!now.isFile() || now.size!==entry.bytes)throw Error("Archive entry changed during ZIP.");
            for await(const input of handle.createReadStream({autoClose:false,highWaterMark:65536})){
              offset=await appendAll(destination,input as Buffer,offset);
              if(offset>MAX_ZIP_BYTES)throw Error("ZIP output exceeded limit.");
            }
          }finally{await handle.close();}
        }
      }
      const centralStart=offset;
      for(const entry of entries)offset=await appendAll(destination,header(entry,true),offset);
      const centralSize=offset-centralStart;
      const footer=Buffer.alloc(22);
      footer.writeUInt32LE(0x06054b50,0);
      footer.writeUInt16LE(entries.length,8);
      footer.writeUInt16LE(entries.length,10);
      footer.writeUInt32LE(centralSize,12);
      footer.writeUInt32LE(centralStart,16);
      offset=await appendAll(destination,footer,offset);
      if(offset>MAX_ZIP_BYTES)throw Error("ZIP output exceeded limit.");
      await destination.sync();
    }finally{await destination.close();}
    // Never follow or overwrite a manually modified existing export.
    try{
      const old=await lstat(output);
      if(!old.isFile() || old.isSymbolicLink() || old.size>MAX_ZIP_BYTES)
        throw Error("Unexpected prior ZIP export.");
      await rm(output);
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
    }
    await rename(temp,output);
    const packaged=await metadata(output,MAX_ZIP_BYTES);
    return {path:output,bytes:packaged.bytes,sha256:packaged.sha256,entries:entries.length};
  }finally{
    if(created)await rm(temp,{force:true}).catch(()=>{});
    active.delete(real);
  }
}
