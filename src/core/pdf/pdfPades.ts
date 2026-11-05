import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PdfOperationError } from "./pdfEngine.js";

const BACKEND = fileURLToPath(new URL("../../../scripts/pdf_pades_backend.py", import.meta.url));

function fail(code:string,message:string):never { throw new PdfOperationError(code,message); }
async function operatorFile(env:string,label:string):Promise<string>{
  const value=process.env[env];
  if(!value || !path.isAbsolute(value)) fail("trust_store_missing",label+" requires operator environment "+env+".");
  const st=await fs.lstat(value).catch(()=>null);
  if(!st?.isFile() || st.isSymbolicLink() || st.size<1 || st.size>5*1024*1024)
    fail("trust_store_invalid",label+" must be a regular non-symlink file under 5 MiB.");
  return value;
}
function candidates():string[]{
  const configured=process.env.SUPERAGENT_PDF_PADES_PYTHON_BIN;
  const local=path.join(os.homedir(),".superagent-r","venvs","pdf-pades",
    process.platform==="win32"?"Scripts/python.exe":"bin/python");
  return [...(configured&&path.isAbsolute(configured)?[configured]:[]),local];
}

export async function verifyPdfPadesIndependent(
  inputPath:string, signal?:AbortSignal,
):Promise<Record<string,unknown>>{
  if(signal?.aborted) fail("cancelled","Independent signature validation cancelled.");
  const python=(await Promise.all(candidates().map(async p=>({p,s:await fs.lstat(p).catch(()=>null)}))))
    .find(v=>v.s?.isFile()&&!v.s.isSymbolicLink())?.p;
  if(!python) fail("independent_validator_unavailable","Pinned pyHanko validator environment is not installed.");
  const backendStat=await fs.lstat(BACKEND).catch(()=>null);
  if(!backendStat?.isFile()) fail("independent_validator_unavailable","Bundled pyHanko validation backend is missing.");
  const caBundle=await operatorFile("SUPERAGENT_PDF_CA_BUNDLE","Independent signer trust validation");
  let tsaCaBundle:string|undefined;
  if(process.env.SUPERAGENT_PDF_TSA_CA_BUNDLE)
    tsaCaBundle=await operatorFile("SUPERAGENT_PDF_TSA_CA_BUNDLE","Independent TSA trust validation");
  const payload=JSON.stringify({inputPath,caBundle,...(tsaCaBundle?{tsaCaBundle}:{})});
  return await new Promise((resolve,reject)=>{
    const child=spawn(python,[BACKEND],{shell:false,windowsHide:true,stdio:["pipe","pipe","pipe"],signal});
    let stdout="",stderr="",settled=false;
    const done=(fn:()=>void)=>{if(!settled){settled=true;clearTimeout(timer);fn();}};
    const timer=setTimeout(()=>{child.kill();done(()=>reject(new PdfOperationError("timeout","Independent signature validation exceeded 30 seconds.")));},30000);
    child.stdout.on("data",c=>{stdout=(stdout+String(c)).slice(0,65537);if(stdout.length>65536)child.kill();});
    child.stderr.on("data",c=>{stderr=(stderr+String(c)).slice(-1000);});
    child.on("error",e=>done(()=>reject(new PdfOperationError("independent_validator_unavailable",e.message.slice(0,120)))));
    child.on("close",code=>done(()=>{
      if(signal?.aborted)return reject(new PdfOperationError("cancelled","Independent signature validation cancelled."));
      if(code!==0||stdout.length>65536)return reject(new PdfOperationError("independent_validation_failed","Independent validator exited unsuccessfully."));
      try{
        const result=JSON.parse(stdout.trim());
        if(!result||typeof result!=="object"||Array.isArray(result))throw new Error();
        if(result.status==="failed")return reject(new PdfOperationError(String(result.code||"independent_validation_failed"),String(result.message||"Independent validation failed.")));
        if(result.engine!=="pyHanko"||result.engineVersion!=="0.38.1"||result.networkFetching!==false)
          return reject(new PdfOperationError("independent_validation_failed","Independent validator provenance mismatch."));
        resolve(result);
      }catch(error){
        if(error instanceof PdfOperationError)return reject(error);
        reject(new PdfOperationError("independent_validation_failed","Independent validator returned invalid JSON. "+(stderr?"See local validator logs.":"")));
      }
    }));
    child.stdin.end(payload);
  });
}
