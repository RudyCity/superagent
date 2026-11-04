import {describe,it,expect,afterEach,vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {McpServiceReloadLedger} from "../src/core/runtime/serviceReloadLedger.js";

const prior=process.env.SUPERAGENT_CONFIG_DIR;
const dirs:string[]=[];
const args=(id:string)=>({
  operationId:id,ownerPid:92345,publicUrl:"https://staging.example.com/mcp",
});
function isolated(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"service-reload-ledger-"));
  dirs.push(dir);
  process.env.SUPERAGENT_CONFIG_DIR=dir;
  return new McpServiceReloadLedger(19997);
}
afterEach(()=>{
  vi.restoreAllMocks();
  if(prior===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=prior;
  for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});
});
describe("MCP backend-only reload journal",()=>{
  it("deduplicates across new instances and preserves history after another completed operation",()=>{
    const ledger=isolated(),a="mcp-stage-reload-op-001",b="mcp-stage-reload-op-002";
    expect(ledger.begin(args(a)).replayed).toBe(false);
    ledger.complete(a,22223);
    const recovered=new McpServiceReloadLedger(19997);
    expect(recovered.begin(args(a))).toEqual({replayed:true,backendPid:22223});
    vi.spyOn(Date,"now").mockReturnValue(Date.now()+6500);
    expect(recovered.begin(args(b)).replayed).toBe(false);
    recovered.complete(b,22224);
    expect(new McpServiceReloadLedger(19997).begin(args(a)))
      .toEqual({replayed:true,backendPid:22223});
    const content=fs.readFileSync(ledger.file,"utf8");
    expect(content).not.toContain(a);
    expect(content).not.toContain("https://staging.example.com");
  });
  it("blocks uncertain outcomes and prohibits concurrent overlapping reload",()=>{
    const ledger=isolated(),a="mcp-stage-pending-0001";
    ledger.begin(args(a));
    expect(()=>ledger.begin(args(a))).toThrow("UNCERTAIN_PENDING");
    expect(()=>new McpServiceReloadLedger(19997).begin(args("mcp-stage-pending-0002")))
      .toThrow("UNCERTAIN_PENDING");
    ledger.complete(a,22223);
    expect(()=>ledger.begin(args("mcp-stage-pending-0002")))
      .toThrow("COOLDOWN");
  });
  it("rejects changed URL/owner for same operation ID",()=>{
    const ledger=isolated(),a="mcp-stage-owner-check-001";
    ledger.begin(args(a));ledger.complete(a,23333);
    expect(()=>ledger.begin({...args(a),ownerPid:56789})).toThrow("CONFLICT");
    expect(()=>ledger.begin({...args(a),publicUrl:"https://other.example.com/mcp"}))
      .toThrow("CONFLICT");
  });
});
