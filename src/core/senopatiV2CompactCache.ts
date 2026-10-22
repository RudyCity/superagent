/**
 * Senopati V2 compact compiled cache: explicit creation, read-only runtime.
 * A cache is a performance artifact, NOT a trusted model source or authorization.
 * The caller must first validate SHA-256 of the original registry-bound model
 * and policy files, then pass their exact digests to the decoder.
 *
 * Format: 8 byte magic + 4 byte LE header length + UTF-8 JSON header +
 * little-endian typed-array sections + SHA-256 digest of all preceding bytes.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SenopatiV2CompactShadow } from "./senopatiV2CompactShadow.js";
import type { SenopatiV2CompactSnapshot } from "./senopatiV2CompactSnapshot.js";
import { SENOPATI_V2_HEADS } from "./senopatiV2Shadow.js";

const MAGIC = Buffer.from("SNPV2C01","ascii");
const VERSION = 1;
const DIGEST_LENGTH = 32;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const MAX_POSTINGS = 1_000_000;
const HEADS = ["domain","intent","action","risk","approval"] as const;

type Header = {
  version:number;
  modelSha256:string;
  policySha256:string;
  records:number;
  postings:number;
  features:string[];
};

function sha(data:Buffer):Buffer{return createHash("sha256").update(data).digest();}
function isSha(value:unknown):value is string {
  return typeof value==="string" && /^[a-f0-9]{64}$/.test(value);
}
function assertHeader(x:unknown,modelHash:string,policyHash:string):asserts x is Header {
  if(typeof x!=="object"||!x)throw new Error("Invalid compact cache header");
  const h=x as Partial<Header>;
  if(h.version!==VERSION||h.modelSha256!==modelHash||h.policySha256!==policyHash||
      !Number.isInteger(h.records)||!Number.isInteger(h.postings)||
      h.records!<1||h.records!>MAX_RECORDS||
      h.postings!<0||h.postings!>MAX_POSTINGS||
      !Array.isArray(h.features)||h.features.length>MAX_POSTINGS){
    throw new Error("Compact cache version, registry hash or bounds mismatch");
  }
  const seen=new Set<string>();
  for(const key of h.features){
    if(typeof key!=="string"||key.length>512||!key.length||!/^[wbpcs]:/.test(key)||seen.has(key))
      throw new Error("Malformed compact feature dictionary");
    seen.add(key);
  }
  if(h.features.length===0 && h.postings!==0)
    throw new Error("Unindexed cache postings");
}
export function compiledCachePath(modelHash:string,policyHash:string,root=path.resolve("build","superagent","cache")):string {
  if(!isSha(modelHash)||!isSha(policyHash))throw new Error("Invalid registry SHA for cache naming");
  return path.join(path.resolve(root),`senopati-v2-${VERSION}-${modelHash}-${policyHash}.bin`);
}

function floats(values:Float64Array):Buffer {
  const out=Buffer.allocUnsafe(values.length*8);
  for(let i=0;i<values.length;i++)out.writeDoubleLE(values[i],i*8);
  return out;
}
function uint32(values:Uint32Array):Buffer {
  const out=Buffer.allocUnsafe(values.length*4);
  for(let i=0;i<values.length;i++)out.writeUInt32LE(values[i],i*4);
  return out;
}
function uint16(values:Uint16Array):Buffer {
  const out=Buffer.allocUnsafe(values.length*2);
  for(let i=0;i<values.length;i++)out.writeUInt16LE(values[i],i*2);
  return out;
}
export function encodeCompiledShadowCache(
  model:SenopatiV2CompactShadow,modelHash:string,policyHash:string
):Buffer {
  if(!isSha(modelHash)||!isSha(policyHash))throw new Error("Invalid registry SHA for compiled cache");
  const s=model.toCompiledSnapshot();
  const header:Header={
    version:VERSION,modelSha256:modelHash,policySha256:policyHash,
    records:s.records,postings:s.rowIds.length,features:[...s.features]
  };
  const json=Buffer.from(JSON.stringify(header),"utf8");
  if(json.length>MAX_HEADER_BYTES)throw new Error("Compiled cache header too large");
  const prefix=Buffer.alloc(12);
  MAGIC.copy(prefix,0);prefix.writeUInt32LE(json.length,8);
  const parts=[prefix,json,uint32(s.starts),uint16(s.rowIds),floats(s.weights),floats(s.norms),Buffer.from(s.labels)];
  const length=parts.reduce((sum,item)=>sum+item.length,0)+DIGEST_LENGTH;
  if(length>MAX_CACHE_BYTES)throw new Error("Compiled cache too large");
  const data=Buffer.concat(parts);
  return Buffer.concat([data,sha(data)]);
}

export function decodeCompiledShadowCache(
  buffer:Buffer,modelHash:string,policyHash:string
):SenopatiV2CompactShadow {
  if(!isSha(modelHash)||!isSha(policyHash))throw new Error("Invalid pinned cache hashes");
  if(buffer.length<12+DIGEST_LENGTH||buffer.length>MAX_CACHE_BYTES||
      !buffer.subarray(0,8).equals(MAGIC))throw new Error("Invalid compact cache magic/length");
  const length=buffer.readUInt32LE(8);
  if(length>MAX_HEADER_BYTES||12+length+DIGEST_LENGTH>buffer.length)
    throw new Error("Invalid compact cache header length");
  const expected=buffer.subarray(buffer.length-DIGEST_LENGTH);
  const actual=sha(buffer.subarray(0,buffer.length-DIGEST_LENGTH));
  if(!timingSafeEqual(actual,expected))throw new Error("Compact cache checksum mismatch");
  const header=JSON.parse(buffer.toString("utf8",12,12+length)) as unknown;
  assertHeader(header,modelHash,policyHash);
  const {records,postings,features}=header;
  const expectedSize=12+length+(features.length+1)*4+postings*2+postings*8+records*8+records*HEADS.length+DIGEST_LENGTH;
  if(expectedSize!==buffer.length)throw new Error("Compact cache section-length mismatch");
  let off=12+length;
  const starts=new Uint32Array(features.length+1);
  for(let i=0;i<starts.length;i++){starts[i]=buffer.readUInt32LE(off);off+=4;}
  if(starts[0]!==0||starts[features.length]!==postings)
    throw new Error("Compact cache posting span invalid");
  for(let i=1;i<starts.length;i++){
    if(starts[i]<starts[i-1]||starts[i]>postings)throw new Error("Compact cache span not monotonic");
  }
  const rowIds=new Uint16Array(postings);
  for(let i=0;i<postings;i++){
    const v=buffer.readUInt16LE(off);off+=2;
    if(v>=records)throw new Error("Compact cache posting row out of bounds");
    rowIds[i]=v;
  }
  const weights=new Float64Array(postings);
  for(let i=0;i<postings;i++){
    const w=buffer.readDoubleLE(off);off+=8;
    if(!Number.isFinite(w)||w<0||w>10)throw new Error("Compact cache invalid feature weight");
    weights[i]=w;
  }
  const norms=new Float64Array(records);
  for(let i=0;i<records;i++){
    const v=buffer.readDoubleLE(off);off+=8;
    if(!Number.isFinite(v)||v<0)throw new Error("Compact cache invalid vector norm");
    norms[i]=v;
  }
  const labels=new Uint8Array(records*HEADS.length);
  for(let r=0;r<records;r++){
    for(let h=0;h<HEADS.length;h++){
      const v=buffer.readUInt8(off++);
      if(v>=SENOPATI_V2_HEADS[HEADS[h]].length)throw new Error("Compact cache invalid head label ID");
      labels[r*HEADS.length+h]=v;
    }
  }
  // Validate the compiled index shape independently of its checksum:
  // each feature's postings must be sorted by original training-record ID,
  // and each vector norm must agree with the encoded feature weights.
  const squares=new Float64Array(records);
  for(let featureId=0;featureId<features.length;featureId++){
    let previous=-1;
    for(let pos=starts[featureId];pos<starts[featureId+1];pos++){
      const row=rowIds[pos];
      if(row<=previous)throw new Error("Compact cache duplicate/unsorted postings");
      previous=row;
      squares[row]+=weights[pos]*weights[pos];
    }
  }
  for(let r=0;r<records;r++){
    const reconstructed=Math.sqrt(squares[r]);
    if(Math.abs(reconstructed-norms[r])>1e-9*Math.max(1,reconstructed)){
      throw new Error("Compact cache inconsistent vector norm");
    }
  }
  const snapshot:SenopatiV2CompactSnapshot={
    features,starts,rowIds,weights,norms,labels,records
  };
  return SenopatiV2CompactShadow.fromTrustedCompiledSnapshot(snapshot);
}

/**
 * Explicit cache compiler writer. File creation is atomic and cache readers
 * never consult the lock. A locked compiler fails instead of overwriting the
 * running compiler's data. Stale locks require a deliberate human inspection.
 *
 * Repair, when explicitly requested, temporarily renames corrupt content out
 * of the well-known path. Concurrent readers then fail closed to reference
 * until the newly validated cache becomes visible.
 */
export function writeCompiledShadowCache(
  model:SenopatiV2CompactShadow,modelHash:string,policyHash:string,
  root=path.resolve("build","superagent","cache"),
  options:{repair?:boolean}={}
):string {
  const filename=compiledCachePath(modelHash,policyHash,root);
  const bytes=encodeCompiledShadowCache(model,modelHash,policyHash);
  fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
  const lock=filename+".compile.lock";
  // Atomic cross-process lock acquisition. Do not automatically remove a
  // pre-existing lock: it might belong to another compiler or a crashed run.
  try{
    fs.mkdirSync(lock,{mode:0o700});
  }catch(e){
    const code=(e as NodeJS.ErrnoException).code;
    if(code==="EEXIST")throw new Error("Cache compilation already running or stale lock present: "+lock);
    throw e;
  }
  const tag=process.pid+"-"+randomBytes(8).toString("hex");
  const tmp=filename+".tmp-"+tag;
  const backup=filename+".previous-"+tag;
  let fd:number|undefined;
  let movedOld=false;
  try{
    if(fs.existsSync(filename)){
      const stats=fs.lstatSync(filename);
      if(!stats.isFile()||stats.isSymbolicLink())throw new Error("Cache path is not a regular file");
      if(stats.size<=MAX_CACHE_BYTES){
        const existing=fs.readFileSync(filename);
        if(existing.equals(bytes)){
          // Idempotent; preserve cache inode and avoid forcing reload.
          return filename;
        }
      }
      if(!options.repair)throw new Error(
        "Existing compiled cache differs from pinned candidate; use explicit --repair after inspecting it");
    }
    fd=fs.openSync(tmp,"wx",0o600);
    fs.writeFileSync(fd,bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd=undefined;
    if(fs.existsSync(filename)){
      fs.renameSync(filename,backup);
      movedOld=true;
    }
    // Same-directory hard link atomically publishes the fully flushed cache;
    // EEXIST prevents overwrite if a different external writer races us.
    fs.linkSync(tmp,filename);
    if(movedOld){
      fs.unlinkSync(backup);
      movedOld=false;
    }
    return filename;
  }catch(e){
    // Restore prior cache if publish failed, without deleting another writer's
    // new final path. A missing cache simply triggers safe reference fallback.
    if(movedOld&&!fs.existsSync(filename)){
      try{fs.renameSync(backup,filename);movedOld=false;}catch{}
    }
    throw e;
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    if(fs.existsSync(tmp))fs.unlinkSync(tmp);
    // The lock was acquired by THIS call and is safe to remove here.
    fs.rmdirSync(lock);
  }
}
