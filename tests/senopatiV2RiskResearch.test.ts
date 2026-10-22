import {describe,expect,it} from "vitest";
import {observeExperimentalRisk} from "../src/core/senopatiV2RiskResearch.js";

describe("Senopati V2 research risk escalation, shadow-only",()=>{
  it.each([
    ["Kirim laporan ke email eksternal yang belum dikenal.","unfamiliar_external_delivery"],
    ["Authorize a wire transfer to an unfamiliar beneficiary.","unfamiliar_wire_beneficiary"],
    ["Send the report to an unknown external email recipient.","unfamiliar_external_delivery"],
    ["Setujui transfer dana ke penerima yang tidak dikenal.","unfamiliar_wire_beneficiary"],
  ])("proposes a sensitive label for the new research case: %s", (text,reason)=>{
    const v=observeExperimentalRisk(text,"safe");
    expect(v.label).toBe("sensitive");
    expect(v.proposal).toBe("sensitive");
    expect(v.reason).toBe(reason);
    expect(v.escalated).toBe(true);
    expect(v.authorizesExecution).toBe(false);
    expect(v.eligibleForAutomaticToolRouting).toBe(false);
    expect(v.confidenceCalibrated).toBe(false);
  });
  it.each([
    "Please explain what a wire transfer is.",
    "Jelaskan cara mengirim laporan internal.",
    "Share the public report with my colleague.",
    "Berikan ringkasan laporan, jangan dikirim.",
    "Draft a wire transfer checklist.",
  ])("does not escalate unrelated or internal content: %s",(text)=>{
    const v=observeExperimentalRisk(text,"safe");
    expect(v.label).toBe("safe");
    expect(v.escalated).toBe(false);
  });
  it("never lowers destructive/sensitive baselines, even on nonmatching input",()=>{
    for(const text of ["Apa efek git reset --hard?", "hello", "Authorize a wire transfer to an unfamiliar beneficiary."]){
      expect(observeExperimentalRisk(text,"destructive").label).toBe("destructive");
      expect(observeExperimentalRisk(text,"sensitive").label).not.toBe("safe");
    }
  });
  it("fails on invalid baseline and oversized input",()=>{
    expect(()=>observeExperimentalRisk("anything","none" as any)).toThrow();
    expect(()=>observeExperimentalRisk("x".repeat(8193),"safe")).toThrow();
  });
});
