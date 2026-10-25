import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  coreAgentSessionReceiptPath, readCoreAgentSessionReceipt,
  writeCoreAgentSessionReceipt, noteCoreAgentSessionTurn,
  decideExplicitCoreSessionResume, mayRouteExplicitCoreResume,
} from "../src/core/runtime/coreAgentSessionCheckpoint.js";
import { CoreSessionAffinity } from "../src/core/runtime/coreSessionRouting.js";

const earlier = process.env.SUPERAGENT_CONFIG_DIR;
const roots: string[] = [];
afterEach(() => {
  if (earlier === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = earlier;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-session-receipt-"));
  roots.push(root); process.env.SUPERAGENT_CONFIG_DIR = root;
  return root;
}
const receipt = { sessionId:"stage_abc1234", workspace:"D:\\Projects\\safe",
  mode:"single" as const, clientMode:"tline" as const };
describe("durable Core session checkpoint, no tool replay", () => {
  it("writes an owner-private bounded metadata receipt and keeps it on reload", () => {
    setup();
    const saved = writeCoreAgentSessionReceipt(receipt);
    expect(saved.createdAt).toBeGreaterThan(0);
    expect(readCoreAgentSessionReceipt(receipt.sessionId)).toEqual(saved);
    const file = coreAgentSessionReceiptPath(receipt.sessionId);
    expect(path.basename(file)).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(fs.readFileSync(file,"utf8")).not.toContain("apiKey");
    expect(writeCoreAgentSessionReceipt({ ...receipt, workspace:"D:/Projects/safe" })).toEqual(saved);
    expect(() => writeCoreAgentSessionReceipt({ ...receipt, workspace:"D:\\OTHER" })).toThrow();
    const turnId="turn_12345678";
    noteCoreAgentSessionTurn(receipt.sessionId, turnId);
    expect(readCoreAgentSessionReceipt(receipt.sessionId)?.lastAcceptedTurnId).toBe(turnId);
  });
  it("rejects symlink, corrupt and inconsistent receipt files", () => {
    const root = setup();
    const file = coreAgentSessionReceiptPath(receipt.sessionId);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file, "{bad");
    expect(() => readCoreAgentSessionReceipt(receipt.sessionId)).toThrow("Corrupt");
    fs.rmSync(file);
    const other = path.join(root, "other.json");
    fs.writeFileSync(other, JSON.stringify({ version:1, ...receipt, createdAt:1 }));
    fs.symlinkSync(other,file);
    expect(() => readCoreAgentSessionReceipt(receipt.sessionId)).toThrow();
  });
  it("requires explicit matching session, saved history and zero ambiguous turns", () => {
    const known={version:1 as const,...receipt,createdAt:10};
    const input={receipt:known,sessionId:receipt.sessionId,workspace:"D:/Projects/safe",
      mode:"single" as const, clientMode:"tline" as const,hasSavedHistory:true,turns:[]};
    expect(decideExplicitCoreSessionResume(input)).toBe("allow");
    expect(decideExplicitCoreSessionResume({ ...input, receipt:null })).toBe("missing_checkpoint");
    expect(decideExplicitCoreSessionResume({ ...input, clientMode:"chrome-extension" })).toBe("scope_mismatch");
    expect(decideExplicitCoreSessionResume({ ...input,hasSavedHistory:false })).toBe("history_missing");
    for (const state of ["running","queued","accepted","recoverable","interrupted","bogus"]) {
      expect(decideExplicitCoreSessionResume({ ...input,turns:[{state,count:1}] })).toBe("requires_review");
    }
    expect(decideExplicitCoreSessionResume({ ...input, turns:[
      {state:"completed",count:3},{state:"failed",count:1},{state:"cancelled",count:1},
    ]})).toBe("allow");
    const hasTurn = { ...known, lastAcceptedTurnId:"turn_12345678",lastAcceptedTurnAt:100 };
    expect(decideExplicitCoreSessionResume({ ...input,receipt:hasTurn,
      historyLastModified:99,historyMessageCount:4 })).toBe("history_stale");
    expect(decideExplicitCoreSessionResume({ ...input,receipt:hasTurn,
      historyLastModified:101,historyMessageCount:0 })).toBe("history_stale");
    expect(decideExplicitCoreSessionResume({ ...input,receipt:hasTurn,
      historyLastModified:101,historyMessageCount:1 })).toBe("allow");
  });
  it("never routes dead session to another worker without exact explicit resume", () => {
    const input={id:"sess123",postedResume:"sess123",postedSessionId:"sess123",
      oldWorkerUnavailable:true,candidateDifferent:true};
    expect(mayRouteExplicitCoreResume(input)).toBe(true);
    expect(mayRouteExplicitCoreResume({...input,postedResume:"other"})).toBe(false);
    expect(mayRouteExplicitCoreResume({...input,oldWorkerUnavailable:false})).toBe(false);
    expect(mayRouteExplicitCoreResume({...input,candidateDifferent:false})).toBe(false);
    expect(mayRouteExplicitCoreResume({...input,postedSessionId:"other"})).toBe(false);
  });
  it("rebinds only after a 200 success receipt and can rollback on disk failure", () => {
    const affinity = new CoreSessionAffinity();
    const previous={pid:101,port:12001,since:10};
    const next={pid:202,port:12002,since:20};
    const success=JSON.stringify({success:true,sessionId:"sess123"});
    expect(affinity.registerFromResponse(200,success,previous,"sess123")).toBe("sess123");
    expect(affinity.rebindFromResponse(400,success,"sess123",previous,next)).toBeUndefined();
    expect(affinity.rebindFromResponse(200,success,"sess123",{...previous,pid:999},next)).toBeUndefined();
    expect(affinity.rebindFromResponse(200,JSON.stringify({success:true,sessionId:"other"}),
      "sess123",previous,next)).toBeUndefined();
    expect(affinity.rebindFromResponse(200,success,"sess123",previous,next)).toBe("sess123");
    expect(affinity.resolve("sess123",next).pid).toBe(202);
    affinity.restoreRebindAfterFailedCheckpoint("sess123",previous,next);
    expect(affinity.resolve("sess123",next).pid).toBe(101);
  });
});
