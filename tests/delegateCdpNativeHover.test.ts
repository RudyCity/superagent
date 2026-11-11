import { afterEach, describe, expect, it, vi } from "vitest";
import { delegateBridge } from "../src/core/delegate/bridge.js";
import { executeDelegateChromeCommand } from "../src/core/delegate/cdpTransport.js";
import {
  claimDelegateTarget, releaseDelegateTarget,
  setDelegateSharing, inviteDelegateAgent, joinDelegateTarget,
} from "../src/core/browserTransport/sessionCoordinator.js";
import { browserCommandSupported } from "../src/core/browserTransport/commandCapabilities.js";

const CLIENT = "browser-hover-delegate";
let tabId = 98710;
afterEach(() => vi.restoreAllMocks());

function stubDelegate() {
  vi.spyOn(delegateBridge,"listConnections").mockReturnValue([{
    clientId:CLIENT, label:"Isolated", extensionId:"b".repeat(32), extensionVersion:"1.9.2",
    capabilities:["delegate-cdp-v1"],connectedAt:Date.now(),
  }]);
  const commands: Array<{ method: string; params: any }> = [];
  vi.spyOn(delegateBridge,"request").mockImplementation(async(method, params) => {
    if(method === "delegate.cdp.command") {
      const request=params as any;
      commands.push({method:request.method,params:request.params});
      if(request.method === "Runtime.evaluate") return JSON.stringify({
        result:{value:true},
      });
    }
    return "{}";
  });
  return commands;
}

describe("Delegate-CDP native hover/click uses the same exact-tab write fence",()=>{
  it("supports native hover, one trusted mouse click, explicit visual pointer, and wheel",async()=>{
    for(const command of ["hover_cursor","click_cursor","show_cursor","hide_cursor","scroll_cursor"])
      expect(browserCommandSupported("delegate",command)).toBe(true);
    const calls=stubDelegate();
    const currentTab=++tabId;
    const claim=claimDelegateTarget(CLIENT,currentTab,"owner");
    const scope={targetId:claim.targetId,agentId:"owner",sessionToken:claim.sessionToken};
    try {
      const hover=await executeDelegateChromeCommand("hover_cursor",scope,{
        x:230,y:160,steps:2,step_delay_ms:0,dwell_ms:0,visualCursor:false,
      });
      expect(hover).toContain("native mouse hover dispatched");
      const mouseAfterHover=calls.filter(x=>x.method==="Input.dispatchMouseEvent");
      expect(mouseAfterHover.length).toBeGreaterThan(0);
      expect(mouseAfterHover.every(x=>x.params.type==="mouseMoved")).toBe(true);
      const clicked=await executeDelegateChromeCommand("click_cursor",scope,{
        x:250,y:175,steps:2,step_delay_ms:0,dwell_ms:0,press_ms:0,visualCursor:false,
      });
      expect(clicked).toContain("native mouse click dispatched once");
      const types=calls.filter(x=>x.method==="Input.dispatchMouseEvent").map(x=>x.params.type);
      expect(types.filter(x=>x==="mousePressed")).toHaveLength(1);
      expect(types.filter(x=>x==="mouseReleased")).toHaveLength(1);
      const where=JSON.parse(await executeDelegateChromeCommand("get_cursor",scope,{}));
      expect(where).toMatchObject({transport:"delegate",x:250,y:175});
      const visible=await executeDelegateChromeCommand("show_cursor",scope,{});
      expect(visible).toContain("visual cursor overlay enabled");
      expect(calls.some(c=>c.method==="Runtime.evaluate"&&
        c.params.expression.includes("data-superagent-cursor"))).toBe(true);
      const wheel=await executeDelegateChromeCommand("scroll_cursor",scope,{
        deltaX:0,deltaY:120,visualCursor:false,
      });
      expect(wheel).toContain("real CDP wheel");
      expect(calls.filter(c=>c.method==="Input.dispatchMouseEvent"&&
        c.params.type==="mouseWheel")).toHaveLength(1);
      const hidden=await executeDelegateChromeCommand("hide_cursor",scope,{});
      expect(hidden).toContain("overlay removed");
    }finally{
      releaseDelegateTarget(CLIENT,currentTab,"owner",claim.sessionToken);
    }
  });

  it("rejects an observer's native clicks and hovers BEFORE any delegate debugger RPC",async()=>{
    const calls=stubDelegate();
    const currentTab=++tabId;
    const claim=claimDelegateTarget(CLIENT,currentTab,"owner");
    try{
      setDelegateSharing(CLIENT,currentTab,"owner",claim.sessionToken,true);
      const offer=inviteDelegateAgent(CLIENT,currentTab,"owner",claim.sessionToken,"viewer","observer");
      const viewer=joinDelegateTarget(CLIENT,currentTab,"viewer",offer.inviteId,offer.invitationToken);
      for(const command of ["hover_cursor","click_cursor","show_cursor","scroll_cursor"]){
        await expect(executeDelegateChromeCommand(command,{
          targetId:claim.targetId,agentId:"viewer",sessionToken:viewer.sessionToken,
          expectedRevision:viewer.revision,
        },{x:210,y:160,dwell_ms:0,press_ms:0,visualCursor:false}))
          .rejects.toThrow(/observer|read-only/i);
      }
      expect(calls).toHaveLength(0);
    }finally{
      releaseDelegateTarget(CLIENT,currentTab,"owner",claim.sessionToken);
    }
  });
});
