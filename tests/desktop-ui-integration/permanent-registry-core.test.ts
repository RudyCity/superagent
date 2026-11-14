import {describe,expect,it,vi} from "vitest";
import {DesktopUiConsentManager,DesktopUiSessionManager} from "../../src/core/tools/desktopUiTools.js";
import type {DesktopUiAdapter} from "../../src/core/desktopUi/types.js";
import type {PersistentAccessPolicy,ExecutableIdentity} from "../../src/core/desktopUi/persistentAccessPolicy.js";

const app:ExecutableIdentity={platform:"win32",executablePath:"C:\\Apps\\Antigravity\\antigravity.exe",sha256:"a".repeat(64)};
const window={pid:403,nativeId:"hwnd-405",title:"Antigravity Code",application:"Antigravity",
  active:true,bounds:{x:0,y:0,width:1200,height:800}};
const allow={id:"permanent-antigravity",kind:"desktop" as const,effect:"allow" as const,
  app,operations:["view" as const,"input" as const],scope:{windowTitle:"Antigravity Code"}};
const deny={...allow,id:"block-antigravity",effect:"deny" as const,operations:["input" as const]};
const policy=(rules:PersistentAccessPolicy["rules"]):PersistentAccessPolicy=>({
  version:2,defaultEffect:"deny",rules,
});
const png=()=>{const b=Buffer.alloc(25);Buffer.from([137,80,78,71,13,10,26,10]).copy(b,0);b.writeUInt32BE(120,16);b.writeUInt32BE(90,20);return b;};
const mockAdapter=()=>{
  const dispatch=vi.fn(async()=>undefined);
  const adapter:DesktopUiAdapter={
    platform:"win32",
    probe:async()=>({platform:"win32",available:true,screenshot:true,accessibility:true,input:true,scroll:true,
      prerequisites:[],limitations:[],errors:[]}),
    listWindows:async(limit)=>({windows:[window],limit,truncated:false}),
    capture:async()=>({image:png(),capturedAt:new Date().toISOString(),targetWindow:window}),
    inspectAccessibility:async()=>({window,elements:[{
      role:"button",label:"OK",value:null,description:null,
      bounds:{x:5,y:5,width:40,height:20},center:{x:25,y:15},actionable:true,nativeRef:"ok",
    }]}),
    dispatch,
  };
  return {adapter,dispatch};
};
function request(adapter:DesktopUiAdapter){
  return {pid:window.pid,nativeId:window.nativeId,title:window.title,adapter,ownerPrincipal:"test-agent",allowInput:true};
}
describe("permanent registry Core authorization",()=>{
  it("uses pre-approved OS application rule without a second native prompt, while still binding a short session",async()=>{
    const prompt=vi.fn(async()=>false);
    let p=policy([allow]);
    const manager=new DesktopUiSessionManager(new DesktopUiConsentManager(),{
      policy:()=>({version:1,mode:"trusted",targets:[]}),
      prompt:{confirm:prompt},
      permanentRegistry:()=>p,
      executableIdentity:async()=>app,
    });
    const {adapter,dispatch}=mockAdapter();
    const opened=await manager.openSession(request(adapter));
    expect(opened.inputAllowed).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    const snapshot=(await manager.snapshot({sessionToken:opened.sessionToken,ownerPrincipal:"test-agent"})).schema;
    await manager.action({sessionToken:opened.sessionToken,ownerPrincipal:"test-agent",action:"click",
      elementId:"a1",expectedRevision:snapshot.screenshot.revision,expectedHash:snapshot.screenshot.sha256});
    expect(dispatch).toHaveBeenCalledTimes(1);
    p=policy([]);
    await expect(manager.action({sessionToken:opened.sessionToken,ownerPrincipal:"test-agent",action:"click",
      elementId:"a1",expectedRevision:snapshot.screenshot.revision,expectedHash:snapshot.screenshot.sha256}))
      .rejects.toThrow(/revoked/);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("denies when explicit deny overlaps, executable changes, or OS identity unavailable",async()=>{
    for(const p of [policy([allow,deny]),policy([allow])]){
      for(const observed of [app,{...app,sha256:"b".repeat(64)},null]){
        const m=new DesktopUiSessionManager(new DesktopUiConsentManager(),{
          policy:()=>({version:1,mode:"trusted",targets:[]}),
          permanentRegistry:()=>p,
          executableIdentity:async()=>observed,
          prompt:{confirm:async()=>{throw Error("Legacy prompt must not run");}},
        });
        const {adapter}=mockAdapter();
        if (observed !== app) {
          await expect(m.openSession(request(adapter))).rejects.toThrow(/viewing not registered/);
        } else {
          const opened=await m.openSession(request(adapter));
          expect(opened.inputAllowed).toBe(p.rules.length===1);
        }
      }
    }
  });
  it("does not override explicit read-only session request",async()=>{
    const m=new DesktopUiSessionManager(new DesktopUiConsentManager(),{
      permanentRegistry:()=>policy([allow]),executableIdentity:async()=>app,
    });
    const {adapter}=mockAdapter();
    const opened=await m.openSession({...request(adapter),allowInput:false});
    expect(opened.inputAllowed).toBe(false);
  });
});

describe("permanent application element scopes",()=>{
  it("allows exact OS accessibility role+label but rejects a different label or naked key",async()=>{
    const view = {...allow,id:"view-only",operations:["view" as const]};
    const element = {...allow,id:"click-ok",operations:["input" as const],
      scope:{windowTitle:"Antigravity Code",elementRole:"button",elementLabel:"OK"}};
    let p=policy([view,element]);
    const m=new DesktopUiSessionManager(new DesktopUiConsentManager(),{
      permanentRegistry:()=>p,executableIdentity:async()=>app,
      policy:()=>({version:1,mode:"trusted",targets:[]}),
    });
    const {adapter,dispatch}=mockAdapter();
    const opened=await m.openSession(request(adapter));
    expect(opened.inputAllowed).toBe(true);
    const snapshot=(await m.snapshot({sessionToken:opened.sessionToken,ownerPrincipal:"test-agent"})).schema;
    const receipt = await m.action({sessionToken:opened.sessionToken,ownerPrincipal:"test-agent",action:"click",
      elementId:"a1",expectedRevision:snapshot.screenshot.revision,expectedHash:snapshot.screenshot.sha256});
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(m.action({sessionToken:opened.sessionToken,ownerPrincipal:"test-agent",action:"key",
      key:"ESCAPE",expectedRevision:receipt.after.revision,expectedHash:receipt.after.sha256}))
      .rejects.toThrow(/dispatch/);
    expect(dispatch).toHaveBeenCalledTimes(1);
    p=policy([view,{...element,scope:{...element.scope,elementLabel:"Different"}}]);
    const fresh=(await m.snapshot({sessionToken:opened.sessionToken,ownerPrincipal:"test-agent"})).schema;
    await expect(m.action({sessionToken:opened.sessionToken,ownerPrincipal:"test-agent",action:"click",
      elementId:"a1",expectedRevision:fresh.screenshot.revision,expectedHash:fresh.screenshot.sha256}))
      .rejects.toThrow(/dispatch/);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("explicit element deny takes precedence over broad app allow",async()=>{
    const view={...allow,id:"view",operations:["view" as const]};
    const input={...allow,id:"input",operations:["input" as const]};
    const blocked={...input,id:"block-ok",effect:"deny" as const,
      scope:{windowTitle:"Antigravity Code",elementRole:"button",elementLabel:"OK"}};
    const m=new DesktopUiSessionManager(new DesktopUiConsentManager(),{
      permanentRegistry:()=>policy([view,input,blocked]),executableIdentity:async()=>app,
    });
    const {adapter,dispatch}=mockAdapter();
    const opened=await m.openSession(request(adapter));
    const snap=(await m.snapshot({sessionToken:opened.sessionToken,ownerPrincipal:"test-agent"})).schema;
    await expect(m.action({sessionToken:opened.sessionToken,ownerPrincipal:"test-agent",action:"click",
      elementId:"a1",expectedRevision:snap.screenshot.revision,expectedHash:snap.screenshot.sha256}))
      .rejects.toThrow(/dispatch/);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
