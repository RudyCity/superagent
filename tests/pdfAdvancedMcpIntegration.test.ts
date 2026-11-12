import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fsSync from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { setYoloMode } from "../src/core/permissions.js";

let dir: string;
const oldSecret = process.env.SUPERAGENT_PDF_P12_PASSWORD;
type Primary = ReturnType<typeof createSuperagentMcpServer>;
type Handler = (request: unknown) => Promise<any>;
function h(server: Primary, name: string): Handler {
  const result = (server as unknown as {_requestHandlers: Map<string, Handler>})._requestHandlers.get(name);
  if (!result) throw new Error("No handler "+name);
  return result;
}
const call = (server: Primary, name: string, args: Record<string, unknown>={}) =>
  h(server,"tools/call")({method:"tools/call",params:{name,arguments:args}});
function parsed(res: {content: Array<{text:string}>}) { return JSON.parse(res.content[0].text); }
function openssl(args: string[]) {
  const out=spawnSync("openssl",args,{cwd:dir,windowsHide:true,encoding:"utf8",timeout:20000});
  if(out.error || out.status!==0) throw new Error("OpenSSL test fixture failure");
}
beforeAll(async()=>{
  dir=await fs.mkdtemp(path.join(os.tmpdir(),"superagent-primary-pdf-advanced-"));
  openssl(["req","-x509","-newkey","rsa:2048","-nodes","-days","1","-keyout","key.pem",
    "-out","cert.pem","-subj","/CN=Temporary MCP Test Only"]);
  openssl(["pkcs12","-export","-out","test-bundle.p12","-inkey","key.pem","-in","cert.pem",
    "-passout","pass:temporary-only"]);
  process.env.SUPERAGENT_PDF_P12_PASSWORD="temporary-only";
});
afterAll(async()=>{
  setYoloMode(false);
  if(oldSecret===undefined) delete process.env.SUPERAGENT_PDF_P12_PASSWORD;
  else process.env.SUPERAGENT_PDF_P12_PASSWORD=oldSecret;
  await fs.rm(dir,{recursive:true,force:true});
});
beforeEach(async()=>{
  const doc=await PDFDocument.create();
  const page=doc.addPage([400,560]);
  page.drawText("CONFIDENTIAL CODE",{x:40,y:460,font:await doc.embedFont(StandardFonts.Helvetica),size:15});
  await fs.writeFile(path.join(dir,"source.pdf"),await doc.save({useObjectStreams:false}));
});

const ocrModelReady = fsSync.existsSync(path.join(os.homedir(), ".superagent-r", "models", "pdf-ocr-v6", "tiny", "PP-OCRv6_rec_tiny.onnx"));

describe("Advanced PDF tools through primary authenticated MCP server",()=>{
  it("discovers and describes all three new tools through the same gateway",async()=>{
    setYoloMode(true);
    const server=createSuperagentMcpServer({
      workspace:dir,toolExposure:"gateway",authMode:"oauth",allowDangerous:true,
      getIdentity:()=>({mode:"oauth",subject:"pdf-advanced-mcp-qa",scopes:["mcp:tools","mcp:tools:write"]}),
    });
    try{
      // The gateway intentionally caps a fuzzy search at 20 matches. A
      // broad "pdf" query can rank non-PDF tools ahead of a specialized PDF
      // tool, so verify each exact capability remains individually discoverable.
      for (const name of [
        "superagent_pdf_edit_vector_exact", "superagent_pdf_sign",
        "superagent_pdf_verify_signature", "superagent_pdf_ocr",
        "superagent_pdf_ocr_searchable",
      ]) {
        const catalog=parsed(await call(server,"superagent_tool_search",{query:name,limit:20}));
        expect((catalog.tools as Array<{name:string}>).map(t=>t.name)).toContain(name);
      }
      const described=parsed(await call(server,"superagent_tool_describe",{name:"superagent_pdf_sign"}));
      expect(JSON.stringify(described)).toContain("certificatePath");
    }finally{await server.close();}
  });

  it.skipIf(!ocrModelReady)("creates searchable PDF via authenticated write MCP, refusing unsafe read-only mutation",async()=>{
    const canvas=createCanvas(1100,270);
    const context=canvas.getContext("2d");
    context.fillStyle="#fff";context.fillRect(0,0,1100,270);
    context.fillStyle="#000";context.font="42px Arial";
    context.fillText("FAKULTAS AGROINDUSTRI BRAWIJAYA",25,130);
    const scan=await PDFDocument.create();
    const img=await scan.embedPng(canvas.toBuffer("image/png"));
    scan.addPage([550,135]).drawImage(img,{x:0,y:0,width:550,height:135});
    await fs.writeFile(path.join(dir,"scanned.pdf"),await scan.save());
    setYoloMode(true);
    const server=createSuperagentMcpServer({
      workspace:dir,toolExposure:"all",authMode:"oauth",allowDangerous:true,
      getIdentity:()=>({mode:"oauth",subject:"pdf-advanced-mcp-qa",scopes:["mcp:tools","mcp:tools:write"]}),
    });
    try {
      const inspected=parsed(await call(server,"superagent_pdf_inspect",{inputPath:"scanned.pdf"}));
      const created=parsed(await call(server,"superagent_pdf_ocr_searchable",{
        inputPath:"scanned.pdf",outputPath:"scanned.searchable.pdf",engine:"tiny",language:"id",
        expectedInputSha256:inspected.sha256,
      }));
      expect(created.status).toBe("verified");
      expect(created.mappedTextLines).toBeGreaterThan(0);
      const extracted=parsed(await call(server,"superagent_pdf_extract",{inputPath:"scanned.searchable.pdf"}));
      expect(extracted.text).toContain("FAKULTAS AGROINDUSTRI BRAWIJAYA");
      expect((await fs.readFile(path.join(dir,"scanned.pdf"))).subarray(0,5).toString()).toBe("%PDF-");
    }finally{await server.close();}
  },60000);

  it("redacts a unique source text operator using authenticated primary MCP dispatch",async()=>{
    setYoloMode(true);
    const server=createSuperagentMcpServer({
      workspace:dir,toolExposure:"all",authMode:"oauth",allowDangerous:true,
      getIdentity:()=>({mode:"oauth",subject:"pdf-advanced-mcp-qa",scopes:["mcp:tools","mcp:tools:write"]}),
    });
    try {
      const inspected=parsed(await call(server,"superagent_pdf_inspect",{inputPath:"source.pdf"}));
      const result=parsed(await call(server,"superagent_pdf_edit_vector_exact",{
        inputPath:"source.pdf",outputPath:"safe-vector.pdf",expectedInputSha256:inspected.sha256,
        page:1,mode:"redact_exact",targetText:"CONFIDENTIAL CODE",confirmRedact:true,
      }));
      expect(result.status).toBe("verified");
      expect(result.vectorGraphicsPreserved).toBe(true);
      const extracted=parsed(await call(server,"superagent_pdf_extract",{inputPath:"safe-vector.pdf"}));
      expect(extracted.text).not.toContain("CONFIDENTIAL CODE");
      expect((await fs.readFile(path.join(dir,"safe-vector.pdf"))).subarray(0,5).toString()).toBe("%PDF-");
    }finally{await server.close();}
  });

  it("signs with a temporary certificate and verifies detached CMS through primary MCP",async()=>{
    setYoloMode(true);
    const server=createSuperagentMcpServer({
      workspace:dir,toolExposure:"all",authMode:"oauth",allowDangerous:true,
      getIdentity:()=>({mode:"oauth",subject:"pdf-advanced-mcp-qa",scopes:["mcp:tools","mcp:tools:write"]}),
    });
    try {
      const inspected=parsed(await call(server,"superagent_pdf_inspect",{inputPath:"source.pdf"}));
      const signed=parsed(await call(server,"superagent_pdf_sign",{
        inputPath:"source.pdf",outputPath:"authorized-signed.pdf",
        expectedInputSha256:inspected.sha256,certificatePath:"test-bundle.p12",
        confirmSign:true,signerName:"Ephemeral Test Only",
      }));
      expect(signed.status).toBe("verified");
      expect(signed.cryptographicSignatureValid).toBe(true);
      const verified=parsed(await call(server,"superagent_pdf_verify_signature",{inputPath:"authorized-signed.pdf"}));
      expect(verified).toMatchObject({status:"verified",certificateTrusted:"not_checked",cryptographicSignatureValid:true});
    }finally{await server.close();}
  });
});
