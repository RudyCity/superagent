import { describe, expect, it } from "vitest";
import {
  NativeDesktopApprovalGuard,
} from "../../src/core/desktopUi/nativeApprovalProof.js";

const key = Buffer.from("11".repeat(32), "hex");
const target = {
  pid: 4851,
  nativeId: "cg:12345",
  consent: true,
  expectedTitle: "Editor — Hello",
  expectedApplication: "Sample.app",
  expectedBounds: { x: -220, y: 80, width: 1200, height: 800 },
};
function guard(now: () => number = () => 10_000) {
  return new NativeDesktopApprovalGuard(() => key, now);
}
function sign(token: string, body: Record<string,unknown> = target) {
  return {
    ...body,
    approvalProof: {
      nonce: token,
      mac: NativeDesktopApprovalGuard.computeProofForTest(key, body, token),
    },
  };
}
describe("native Desktop Live approval — one-time, exact-window proof", () => {
  it("rejects bearer-only consent and unsigned target, never invoking window discovery", () => {
    const g = guard();
    expect(() => g.consume({ ...target })).toThrow(/approval/);
    expect(() => g.consume({ ...target, approvalProof: {nonce:"0".repeat(48),mac:"0".repeat(64)} }))
      .toThrow(/approval/);
  });
  it("agrees with the independent Rust native signature vector for UTF-8 titles", () => {
    const nonce="0123456789abcdef".repeat(3);
    expect(NativeDesktopApprovalGuard.computeProofForTest(key, target, nonce))
      .toBe("a881eb0505eeef0f0994aab5b0839302259604cd7f1b757c5534be3efade3e51");
  });

  it("accepts one native-signed exact target and burns the challenge", () => {
    const g = guard();
    const {nonce,expiresAt} = g.issue();
    expect(nonce).toMatch(/^[a-f0-9]{48}$/);
    expect(expiresAt).toBe(40_000);
    const approved = sign(nonce);
    expect(g.consume(approved)).toEqual(target);
    expect(() => g.consume(approved)).toThrow(/approval/);
  });
  it("rejects changes to each selected window property, even with consent:true", () => {
    for(const variant of [
      { ...target, pid: 4852 },
      { ...target, nativeId: "cg:12346" },
      { ...target, expectedTitle: "Another window" },
      { ...target, expectedApplication: "Other.app" },
      { ...target, expectedBounds: { ...target.expectedBounds, x: -221 } },
      { ...target, expectedBounds: { ...target.expectedBounds, width: 1201 } },
    ]) {
      const g=guard();
      const {nonce}=g.issue();
      const genuine=sign(nonce);
      expect(() => g.consume({...variant,approvalProof:genuine.approvalProof})).toThrow(/approval/);
      expect(() => g.consume(genuine)).toThrow(/approval/);
    }
  });
  it("rejects a fabricated MAC and burns nonce, even if later signed legitimately", () => {
    const g=guard();
    const {nonce}=g.issue();
    expect(()=>g.consume({...target,approvalProof:{nonce,mac:"0".repeat(64)}}))
      .toThrow(/approval/);
    expect(()=>g.consume(sign(nonce))).toThrow(/approval/);
  });
  it("rejects expired and cross-instance challenges", () => {
    let now=3_000;
    const g=guard(()=>now);
    const nonce=g.issue().nonce;
    now=33_000;
    expect(()=>g.consume(sign(nonce))).toThrow(/approval/);
    const second=guard();
    expect(()=>second.consume(sign(nonce))).toThrow(/approval/);
  });
  it("requires independent recording consent and binds window, project, preset and preview token", () => {
    const recordingBody={...target, action:"start-native",
      projectDirectory:process.platform==="win32" ? "C:\\\\projects\\\\example" : "/tmp/projects/example",
      previewToken:"a".repeat(64),videoPreset:"standard"};
    const recordingGuard=()=>new NativeDesktopApprovalGuard(()=>key,()=>10_000,"recording");
    const approved=recordingGuard();
    const {nonce}=approved.issue();
    const mac=NativeDesktopApprovalGuard.computeProofForTest(key,recordingBody,nonce,"recording");
    const protectedBody={...recordingBody,approvalProof:{nonce,mac}};
    expect(approved.consume(protectedBody)).toEqual(recordingBody);
    expect(()=>approved.consume(protectedBody)).toThrow(/approval/);
    for(const changed of [
      {...recordingBody,projectDirectory:recordingBody.projectDirectory+"-other"},
      {...recordingBody,previewToken:"b".repeat(64)},
      {...recordingBody,videoPreset:"detail"},
      {...recordingBody,expectedTitle:"Other window"},
    ]) {
      const guard=recordingGuard();
      const fresh=guard.issue().nonce;
      const valid=NativeDesktopApprovalGuard.computeProofForTest(key,recordingBody,fresh,"recording");
      expect(()=>guard.consume({...changed,approvalProof:{nonce:fresh,mac:valid}}))
        .toThrow(/approval/);
    }
    const replay=recordingGuard();
    const replayNonce=replay.issue().nonce;
    const previewMac=NativeDesktopApprovalGuard.computeProofForTest(key,recordingBody,replayNonce);
    expect(()=>replay.consume({...recordingBody,approvalProof:{nonce:replayNonce,mac:previewMac}}))
      .toThrow(/approval/);
  });

  it("bounds pending challenges to prevent unauthenticated request flooding", () => {
    const g=guard();
    for(let i=0;i<8;i++) g.issue();
    expect(()=>g.issue()).toThrow(/approval/);
  });
});