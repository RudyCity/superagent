import {describe,it,expect} from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {senopatiRuntimeCommand} from "../src/core/commands/senopatiRuntimeCommand.js";

async function invoke(args:string):Promise<Array<{type:string;content:string}>>{
 const lines:Array<{type:string;content:string}>=[];
 await senopatiRuntimeCommand.execute(args,{addLine:(line:any)=>{
  lines.push({type:line.type,content:line.content});
 }} as any);
 return lines;
}
describe("Senopati V6.9 user-facing slash command",()=>{
 it("documents owner-safe lifecycle operations",async()=>{
  const results=await invoke("help");
  expect(results[0].content).toContain("/senopati status");
  expect(results[0].content).toContain("autostart on|off");
  expect(results[0].content).toContain("doctor");
 });
 it("reports config and policy without leaking IPC bearer credentials",async()=>{
  const results=await invoke("status");
  expect(results[0].type).toBe("system");
  expect(results[0].content).toContain("SENOPATI SHARED CLASSIFIER");
  expect(results[0].content).toContain("no classifier permissions");
  expect(results[0].content).not.toMatch(/(?:secret|bearer|nonce)[=:]/i);
 });
 it("rejects unrecognized controls rather than invoking arbitrary shell commands",async()=>{
  const results=await invoke("delete all");
  expect(results[0].type).toBe("error");
 });
 it("changes only the isolated autostart configuration",async()=>{
  const prior=process.env.SUPERAGENT_CONFIG_DIR;
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"senopati-slash-"));
  try{
   process.env.SUPERAGENT_CONFIG_DIR=folder;
   const off=await invoke("autostart off");
   expect(off[0].content).toContain("OFF");
   const file=path.join(folder,"senopati-lifecycle.json");
   expect(JSON.parse(fs.readFileSync(file,"utf8")).autoStartOnAppLaunch).toBe(false);
   const on=await invoke("autostart on");
   expect(on[0].content).toContain("ON");
   expect(JSON.parse(fs.readFileSync(file,"utf8")).autoStartOnAppLaunch).toBe(true);
  }finally{
   if(prior===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
   else process.env.SUPERAGENT_CONFIG_DIR=prior;
   fs.rmSync(folder,{recursive:true,force:true});
  }
 });
});
