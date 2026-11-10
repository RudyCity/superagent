import { beforeEach, afterEach, describe, test, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimCdpTarget, releaseCdpTarget } from "../src/core/tools/chromeCdpSessionManager.js";
import { validatePreviewRequest, captureQualifiedManagedPreview,
  resetManagedPreviewRateLimitForTests } from "../src/core/tools/chromeCdpVisualPreview.js";
import * as registry from "../src/core/tools/managedBrowserRegistry.js";

describe("private managed Chrome visual preview", () => {
  let temp = "", claim: Awaited<ReturnType<typeof claimCdpTarget>>;
  const prior = process.env.SUPERAGENT_CDP_SESSION_DIR;
  const jpeg = Buffer.concat([Buffer.from([255,216,255,224]),
    Buffer.alloc(120, 1),Buffer.from([255,217])]).toString("base64");
  const now = Date.now();
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), "cdp-private-preview-"));
    process.env.SUPERAGENT_CDP_SESSION_DIR = temp;
    resetManagedPreviewRateLimitForTests();
    claim = await claimCdpTarget(9573, "TEST_TARGET", "owner");
    vi.spyOn(registry, "listManagedBrowserRegistrations").mockReturnValue([{
      port:9573,targetId:"TEST_TARGET",profileId:"managed",generation:"gen_12345678_10_abcdef01",
      browserFingerprint:"a".repeat(64),registeredAt:now-2000,expiresAt:now+60000,
    }]);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await releaseCdpTarget(9573,"TEST_TARGET","owner",claim.sessionToken);
    if (prior===undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
    else process.env.SUPERAGENT_CDP_SESSION_DIR = prior;
    await rm(temp,{recursive:true,force:true});
  });
  test("never captures without explicit consent, exact registered target, and current revision",async()=>{
    const request={port:9573,targetId:"TEST_TARGET",expectedRevision:claim.revision,consent:true,previewId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
    expect(() => validatePreviewRequest({...request,consent:false})).toThrow(/consent/);
    expect(() => validatePreviewRequest({...request,url:"http://evil"})).toThrow(/consent/);
    const capture=vi.fn(async()=>jpeg);
    const fingerprint=vi.fn(async()=> "a".repeat(64));
    const urlDigest=vi.fn(async()=> "c".repeat(64));
    await expect(captureQualifiedManagedPreview({...request,targetId:"OTHER"},{
      capture, fingerprint, urlDigest,
    })).rejects.toThrow(/registration/);
    await expect(captureQualifiedManagedPreview({...request,expectedRevision:99},{
      capture, fingerprint, urlDigest,
    })).rejects.toThrow(/revision/);
    expect(capture).not.toHaveBeenCalled();
  });
  test("returns only bounded transient JPEG and throttles another frame",async()=>{
    const request={port:9573,targetId:"TEST_TARGET",expectedRevision:claim.revision,consent:true,previewId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
    let clock=Date.now();
    const deps={capture:vi.fn(async()=>jpeg),fingerprint:async()=> "a".repeat(64),urlDigest:async()=> "c".repeat(64),now:()=>clock};
    const first=await captureQualifiedManagedPreview(request,deps);
    expect(first).toMatchObject({format:"jpeg",jpeg,targetId:"TEST_TARGET",revision:claim.revision});
    expect(JSON.stringify(first)).not.toMatch(/browserFingerprint|sessionToken|url/);
    await expect(captureQualifiedManagedPreview(request,deps)).rejects.toThrow(/rate limit/);
    clock+=1001;
    expect((await captureQualifiedManagedPreview(request,deps)).jpeg).toBe(jpeg);
    expect(deps.capture).toHaveBeenCalledTimes(2);
  });
  test("rejects non-JPEG images, fingerprint mismatch, and oversized images",async()=>{
    const request={port:9573,targetId:"TEST_TARGET",expectedRevision:claim.revision,consent:true,previewId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
    await expect(captureQualifiedManagedPreview(request,{
      capture:async()=>Buffer.alloc(150,5).toString("base64"),
      fingerprint:async()=> "a".repeat(64),urlDigest:async()=> "c".repeat(64),
    })).rejects.toThrow(/not a JPEG/);
    resetManagedPreviewRateLimitForTests();
    await expect(captureQualifiedManagedPreview(request,{
      capture:async()=>jpeg,fingerprint:async()=> "b".repeat(64),urlDigest:async()=> "c".repeat(64),
    })).rejects.toThrow(/fingerprint/);
    resetManagedPreviewRateLimitForTests();
    await expect(captureQualifiedManagedPreview(request,{
      capture:async()=> "A".repeat(800000),fingerprint:async()=> "a".repeat(64),urlDigest:async()=> "c".repeat(64),
    })).rejects.toThrow(/oversized/);
  });
  test("refuses changed document under an old consent ID and detects in-flight navigation",async()=>{
    const request={port:9573,targetId:"TEST_TARGET",expectedRevision:claim.revision,consent:true,
      previewId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
    let digest="c".repeat(64);
    let clock=Date.now();
    const capture=vi.fn(async()=>jpeg);
    const deps={capture, fingerprint:async()=> "a".repeat(64),
      urlDigest:async()=>digest,now:()=>clock};
    expect((await captureQualifiedManagedPreview(request,deps)).format).toBe("jpeg");
    clock+=1100;
    digest="d".repeat(64);
    await expect(captureQualifiedManagedPreview(request,deps)).rejects.toThrow(/document changed/);
    expect(capture).toHaveBeenCalledTimes(1);
    const newConsent={...request,previewId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
    expect((await captureQualifiedManagedPreview(newConsent,deps)).format).toBe("jpeg");
    resetManagedPreviewRateLimitForTests();
    let reads=0;
    await expect(captureQualifiedManagedPreview(request,{
      capture:async()=>jpeg, fingerprint:async()=> "a".repeat(64),
      urlDigest:async()=> (++reads===1 ? "e":"f").repeat(64),
    })).rejects.toThrow(/navigated during capture/);
  });
});
