import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,writeFileSync,symlinkSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {
  readTrustedInputPolicy,parseTrustedInputPolicy,trustedWindowMatch,
  type TrustedInputPolicy,
} from "../../src/core/tools/desktopTrustedInput.js";
import {
  DesktopUiConsentManager,DesktopUiSessionManager,
} from "../../src/core/tools/desktopUiTools.js";
import {createTrustedInputPrompt} from "../../src/core/desktopUi/trustedInputPrompt.js";
import type {DesktopUiAdapter} from "../../src/core/desktopUi/types.js";

const now=Date.now();
const target={pid:423,title:"Antigravity Code",nativeId:"hwnd-424",application:"Antigravity",
  active:true,bounds:{x:5,y:5,width:840,height:700}};
const entry={pid:423,nativeId:"hwnd-424",title:"Antigravity Code",application:"Antigravity",
  approvedAt:now,expiresAt:now+600_000};
const trusted:TrustedInputPolicy={version:1,mode:"trusted",targets:[entry]};
const png=()=>{const b=Buffer.alloc(25);Buffer.from([137,80,78,71,13,10,26,10]).copy(b,0);b.writeUInt32BE(120,16);b.writeUInt32BE(90,20);return b;};
function fixture(){
  const dispatch=vi.fn(async()=>undefined);
  const adapter:DesktopUiAdapter={
    platform:"win32",
    probe:async()=>({platform:"win32",available:true,screenshot:true,accessibility:true,
      input:true,scroll:true,prerequisites:[],limitations:[],errors:[]}),
    listWindows:async(limit)=>({limit,windows:[target],truncated:false}),
    capture:async()=>({image:png(),capturedAt:"2026-11-14T08:00:00Z",targetWindow:target}),
    inspectAccessibility:async()=>({window:target,elements:[{
      role:"button",label:"OK",description:null,value:null,
      bounds:{x:30,y:30,width:50,height:20},center:{x:55,y:40},
      actionable:true,nativeRef:"ok",
    }]}),
    dispatch,
  };
  return {adapter,dispatch};
}
const request=(adapter:DesktopUiAdapter)=>({
  pid:423,nativeId:"hwnd-424",title:"Antigravity Code",ownerPrincipal:"mcp-user",
  allowInput:true,adapter,
});
afterEach(()=>vi.restoreAllMocks());

describe("trusted-input policy fail closed",()=>{
  it("accepts only exact bounded, non-expired native target policy",()=>{
    expect(parseTrustedInputPolicy(trusted,now)).toEqual(trusted);
    expect(trustedWindowMatch(trusted,target,target,now)).toEqual(entry);
    expect(trustedWindowMatch({...trusted,mode:"off"},target,target,now)).toBeNull();
    expect(trustedWindowMatch(trusted,target,{...target,application:"Other"},now)).toBeNull();
    expect(trustedWindowMatch(trusted,target,{...target,active:false},now)).toBeNull();
    expect(trustedWindowMatch(trusted,target,{...target,title:"Different"},now)).toBeNull();
    expect(trustedWindowMatch(trusted,target,target,entry.expiresAt)).toBeNull();
    expect(parseTrustedInputPolicy({...trusted,targets:[{...entry,expiresAt:now+40*60_000}]},now)).toBeNull();
    expect(parseTrustedInputPolicy({...trusted,targets:[entry,entry]},now)).toBeNull();
    expect(parseTrustedInputPolicy({...trusted,targets:[{...entry,arbitraryCommand:"powershell"}]},now)).toBeNull();
    expect(parseTrustedInputPolicy({...trusted,mode:"all-windows"},now)).toBeNull();
  });
  it("rejects missing/oversize/symlinked/corrupt local preferences",()=>{
    const root=mkdtempSync(path.join(tmpdir(),"desktop-trusted-test-"));
    try{
      expect(readTrustedInputPolicy({configDir:root})).toBeNull();
      writeFileSync(path.join(root,"desktop-input-trusted.json"),JSON.stringify(trusted));
      expect(readTrustedInputPolicy({configDir:root,now})).toEqual(trusted);
      writeFileSync(path.join(root,"desktop-input-trusted.json"),"x".repeat(17000));
      expect(readTrustedInputPolicy({configDir:root,now})).toBeNull();
      writeFileSync(path.join(root,"desktop-input-trusted.json"),"{broken");
      expect(readTrustedInputPolicy({configDir:root,now})).toBeNull();
    }finally{rmSync(root,{recursive:true,force:true});}
    const symlinks=mkdtempSync(path.join(tmpdir(),"desktop-trust-symlink-"));
    try{
      writeFileSync(path.join(symlinks,"safe.json"),JSON.stringify(trusted));
      try{
        symlinkSync(path.join(symlinks,"safe.json"),path.join(symlinks,"desktop-input-trusted.json"));
        expect(readTrustedInputPolicy({configDir:symlinks,now})).toBeNull();
      }catch{/* Windows Developer Mode may not authorize symlinks. */}
    }finally{rmSync(symlinks,{recursive:true,force:true});}
  });
});

describe("trusted approval is never model-authorized",()=>{
  it("requires native approval and grants only a single session",async()=>{
    const consent=new DesktopUiConsentManager();
    const confirm=vi.fn(async()=>true);
    const manager=new DesktopUiSessionManager(consent,{
      policy:()=>trusted,prompt:{confirm},
    });
    const {adapter,dispatch}=fixture();
    const opened=await manager.openSession(request(adapter));
    expect(opened.inputAllowed).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      principal:"mcp-user",nativeId:"hwnd-424",application:"Antigravity",
    });
    expect(consent.hasConsent(target)).toBe(false); // no PID-wide grant
    expect(consent.hasConsent(target,opened.sessionToken)).toBe(true);

    const snapshot=(await manager.snapshot({
      sessionToken:opened.sessionToken,ownerPrincipal:"mcp-user",
    })).schema;
    await manager.action({
      sessionToken:opened.sessionToken,ownerPrincipal:"mcp-user",action:"click",
      elementId:"a1",expectedRevision:snapshot.screenshot.revision,
      expectedHash:snapshot.screenshot.sha256,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(manager.closeSession(opened.sessionToken,"mcp-user")).toEqual({closed:true});
    expect(consent.hasConsent(target,opened.sessionToken)).toBe(false);
  });
  it("auto-requests for exact Trusted targets when allowInput is omitted, but never when explicitly false",async()=>{
    const confirm=vi.fn(async()=>true);
    const manager=new DesktopUiSessionManager(new DesktopUiConsentManager(),{
      policy:()=>trusted,prompt:{confirm},
    });
    const {adapter}=fixture();
    const automatic=await manager.openSession({
      pid:423,nativeId:"hwnd-424",title:"Antigravity Code",
      ownerPrincipal:"mcp-user",adapter,
    });
    expect(automatic.inputAllowed).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    manager.closeSession(automatic.sessionToken,"mcp-user");

    const disabled=await manager.openSession({
      pid:423,nativeId:"hwnd-424",title:"Antigravity Code",
      ownerPrincipal:"mcp-user",adapter,allowInput:false,
    });
    expect(disabled.inputAllowed).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it("does not grant input when the host declines",async()=>{
    const consent=new DesktopUiConsentManager();
    const manager=new DesktopUiSessionManager(consent,{
      policy:()=>trusted,prompt:{confirm:async()=>false},
    });
    const {adapter}=fixture();
    const opened=await manager.openSession(request(adapter));
    expect(opened.inputAllowed).toBe(false);
    expect(opened.consentDenied).toBe(true);
    expect(consent.hasConsent(target,opened.sessionToken)).toBe(false);
  });
  it("revocation, disabling Trusted, or file loss blocks the next input action",async()=>{
    for(const revoked of [null,{...trusted,mode:"off"} as TrustedInputPolicy]){
      let policy:TrustedInputPolicy|null=trusted;
      const consent=new DesktopUiConsentManager();
      const manager=new DesktopUiSessionManager(consent,{
        policy:()=>policy,prompt:{confirm:async()=>true},
      });
      const {adapter,dispatch}=fixture();
      const opened=await manager.openSession(request(adapter));
      expect(opened.inputAllowed).toBe(true);
      policy=revoked;
      await expect(manager.action({
        sessionToken:opened.sessionToken,ownerPrincipal:"mcp-user",
        action:"key",key:"ENTER",expectedRevision:1,expectedHash:"a".repeat(64),
      })).rejects.toMatchObject({code:"INPUT_DISABLED"});
      expect(consent.hasConsent(target,opened.sessionToken)).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    }
  });
  it("checks fresh OS discovery before native prompt and rejects renamed/window-swapped targets",async()=>{
    const consent=new DesktopUiConsentManager();
    const confirm=vi.fn(async()=>true);
    const manager=new DesktopUiSessionManager(consent,{
      policy:()=>trusted,prompt:{confirm},
    });
    const {adapter}=fixture();
    adapter.listWindows=async(limit)=>({limit,windows:[{...target,title:"Replaced window"}],truncated:false});
    const opened=await manager.openSession(request(adapter));
    expect(opened.inputAllowed).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("cannot grant when Trusted is disabled even if a prompt is injectable",async()=>{
    const confirm=vi.fn(async()=>true);
    const manager=new DesktopUiSessionManager(new DesktopUiConsentManager(),{
      policy:()=>({...trusted,mode:"off"}),prompt:{confirm},
    });
    const {adapter}=fixture();
    expect((await manager.openSession(request(adapter))).inputAllowed).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("rechecks policy after native dialog to prevent revocation during approval",async()=>{
    let policy:TrustedInputPolicy|null=trusted;
    const manager=new DesktopUiSessionManager(new DesktopUiConsentManager(),{
      policy:()=>policy,prompt:{confirm:async()=>{policy=null;return true;}},
    });
    const {adapter}=fixture();
    expect((await manager.openSession(request(adapter))).inputAllowed).toBe(false);
  });
  it("native approval prompt fails closed on declined or unavailable OS dialog",async()=>{
    const runner={
      run:vi.fn(async()=>({stdout:'{"approved":false}',stderr:"",exitCode:0})),
    } as any;
    const prompt=createTrustedInputPrompt({platform:"win32",runner});
    const req={principal:"mcp-user",pid:423,nativeId:"hwnd-424",
      application:"Antigravity",title:"Antigravity Code",expiresAt:Date.now()+300_000};
    expect(await prompt.confirm(req)).toBe(false);
    runner.run=vi.fn(async()=>{throw new Error("no interactive host")});
    expect(await prompt.confirm(req)).toBe(false);
  });
});
