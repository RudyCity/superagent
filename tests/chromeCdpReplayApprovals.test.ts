import {afterEach,beforeEach,describe,expect,test} from "vitest";
import {mkdtemp,rm,readdir,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {claimCdpTarget,listCdpSessions,releaseCdpTarget,pauseCdpTarget} from "../src/core/tools/chromeCdpSessionManager.js";
import {prepareReplayClick,listPendingReplayApprovals,reviewReplayApproval,
  consumeApprovedReplayClick,revokeReplayApprovalsForTarget} from "../src/core/tools/chromeCdpReplayApprovals.js";
describe("two-party one-shot replay approval",()=>{
 const original=process.env.SUPERAGENT_CDP_SESSION_DIR;
 let temp="", session:any, request:any;
 beforeEach(async()=>{
   temp=await mkdtemp(join(tmpdir(),"cdp-replay-approval-"));
   process.env.SUPERAGENT_CDP_SESSION_DIR=temp;
   session=await claimCdpTarget(9222,"APPROVE_TAB","owner");
   const payload={port:9222,targetId:"APPROVE_TAB",actorId:"owner",generation:session.generation,
     recordingId:"a1111111-1111-4111-8111-111111111111",sequence:1,
     selector:"#confirm",targetUrl:"https://example.test/pay?token=VERY_PRIVATE",
     revision:session.revision};
   request={payload,public:await prepareReplayClick(payload)};
 });
 afterEach(async()=>{
   await releaseCdpTarget(9222,"APPROVE_TAB","owner",session.sessionToken).catch(()=>{});
   if(original===undefined)delete process.env.SUPERAGENT_CDP_SESSION_DIR;
   else process.env.SUPERAGENT_CDP_SESSION_DIR=original;
   await rm(temp,{recursive:true,force:true});
 });
 test("native approval is required; no URL or CSS selector leaks to disk or public response",async()=>{
   const pending=await listPendingReplayApprovals();
   expect(pending).toHaveLength(1);
   expect(pending[0].approvalId).toBe(request.public.approvalId);
   const record=JSON.stringify(pending);
   expect(record).not.toMatch(/VERY_PRIVATE|#confirm|example.test/);
   const files=await readdir(join(temp,"gateway","replay-approvals"));
   const raw=await readFile(join(temp,"gateway","replay-approvals",files[0]),"utf8");
   expect(raw).not.toMatch(/VERY_PRIVATE|#confirm|example.test|sessionToken/);
   const args={...request.payload,approvalId:request.public.approvalId};
   await expect(consumeApprovedReplayClick(args)).rejects.toThrow(/operator approval/);
   const approved=await reviewReplayApproval(args.approvalId,"approve");
   expect(approved.status).toBe("approved");
   expect(await listPendingReplayApprovals()).toHaveLength(0);
   await expect(consumeApprovedReplayClick({...args,selector:"#other"}))
     .rejects.toThrow(/context changed/);
   expect((await consumeApprovedReplayClick(args)).consumed).toBe(true);
   await expect(consumeApprovedReplayClick(args)).rejects.toThrow(/already consumed/);
   await expect(reviewReplayApproval(args.approvalId,"approve")).rejects.toThrow(/already resolved/);
 });
 test("human handoff invalidates existing replay approvals",async()=>{
   const id=request.public.approvalId;
   expect((await reviewReplayApproval(id,"approve")).status).toBe("approved");
   expect(await revokeReplayApprovalsForTarget(9222,"APPROVE_TAB")).toBe(1);
   await expect(consumeApprovedReplayClick({...request.payload,approvalId:id}))
     .rejects.toThrow(/operator approval/);
   expect(await revokeReplayApprovalsForTarget(9222,"APPROVE_TAB")).toBe(0);
 });
 test("denial and stale revision always fail closed",async()=>{
   const id=request.public.approvalId;
   await reviewReplayApproval(id,"deny");
   await expect(consumeApprovedReplayClick({...request.payload,approvalId:id}))
     .rejects.toThrow(/operator approval/);
   const newer=await prepareReplayClick(request.payload);
   await pauseCdpTarget(9222,"APPROVE_TAB","owner",session.sessionToken);
   await expect(reviewReplayApproval(newer.approvalId,"approve"))
     .rejects.toThrow(/lease\/revision changed/);
 });
});
