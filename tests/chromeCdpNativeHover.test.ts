import { beforeEach, describe, expect, it } from "vitest";
import {
  dispatchHumanMouseMove, executeCursorCommand, getCursorPosition,
  resetCursorPositions, setCursorPosition, UPDATE_CURSOR_OVERLAY_JS,
} from "../src/core/tools/chromeCdpCursor.js";

describe("native CDP hover and mouse pointer fidelity", () => {
  beforeEach(resetCursorPositions);

  it("dispatches real mouseMoved events, dwells, and validates the hit target for hover", async () => {
    const events: Array<{ method: string; params: any }> = [];
    const send = async (_target: any, method: string, params: any) => {
      events.push({ method, params });
      if (method === "Runtime.evaluate" &&
          params?.expression?.includes("const selected = document.querySelector"))
        return { result: { value: true } };
      return {};
    };
    const result = await executeCursorCommand(send, { id: "hover-tab" }, "hover_cursor", {
      selector: "#menu", x: 200, y: 140, steps: 3, step_delay_ms: 0,
      dwell_ms: 0, visualCursor: false,
    }, "agent-one", "Owner");
    // Explicit x/y win over selector for coordinates, while selector is still hit-tested.
    expect(result).toContain("native mouse hover dispatched");
    expect(events.filter(e => e.method === "Input.dispatchMouseEvent").map(e => e.params.type))
      .toEqual(["mouseMoved","mouseMoved","mouseMoved","mouseMoved"]);
    expect(events.some(e => e.method === "Runtime.evaluate" &&
      e.params?.expression?.includes("document.elementFromPoint"))).toBe(true);
    expect(getCursorPosition("hover-tab","agent-one")).toEqual({ x:200,y:140 });
  });

  it("native click_cursor dispatches one real press and release, never DOM click", async () => {
    const events: Array<{ method: string; params: any }> = [];
    const send = async (_target: any, method: string, params: any) => {
      events.push({ method, params });
      if (method === "Runtime.evaluate" && params?.expression?.includes("const selected = document.querySelector"))
        return { result: { value: true } };
      return {};
    };
    const result = await executeCursorCommand(send, { id:"click-tab" }, "click_cursor", {
      x: 300, y: 180, selector:"#submit", steps:2, step_delay_ms:0,
      dwell_ms:0, press_ms:0, visualCursor:false,
    }, "owner","Owner");
    expect(result).toContain("native mouse click dispatched once");
    const inputs=events.filter(e=>e.method==="Input.dispatchMouseEvent").map(e=>e.params.type);
    expect(inputs.filter(e=>e==="mousePressed")).toHaveLength(1);
    expect(inputs.filter(e=>e==="mouseReleased")).toHaveLength(1);
    expect(inputs.indexOf("mousePressed")).toBeGreaterThan(inputs.lastIndexOf("mouseMoved"));
    expect(inputs.indexOf("mouseReleased")).toBeGreaterThan(inputs.indexOf("mousePressed"));
    expect(events.every(e=>!(e.params?.expression ?? "").includes(".click()"))).toBe(true);
  });

  it("blocked or changed CSS targets never receive a button press", async () => {
    const events: Array<{ method: string; params:any }> = [];
    const send=async(_t:any,method:string,params:any)=>{
      events.push({method,params});
      if (method==="Runtime.evaluate" && params?.expression?.includes("const selected = document.querySelector"))
        return {result:{value:false}};
      return {};
    };
    const result=await executeCursorCommand(send,{id:"covered-tab"},"click_cursor",{
      selector:"#hidden",x:30,y:30,steps:2,step_delay_ms:0,
      dwell_ms:0,press_ms:0,visualCursor:false,
    });
    expect(result).toContain("covered or moved");
    expect(events.filter(e=>e.method==="Input.dispatchMouseEvent").map(e=>e.params.type))
      .not.toContain("mousePressed");
  });

  it("rejects invalid dwell/press limits before any native side effects",async()=>{
    const commands:string[]=[];
    const send=async(_t:any,method:string)=>{commands.push(method);return{};};
    const target={id:"unsafe-cursor"};
    expect(await executeCursorCommand(send,target,"hover_cursor",{x:20,y:30,dwell_ms:Infinity}))
      .toContain("dwell_ms must be");
    expect(await executeCursorCommand(send,target,"click_cursor",{x:20,y:30,press_ms:2000}))
      .toContain("press_ms must be");
    expect(commands).toHaveLength(0);
  });

  it("uses one actual CDP pointer trajectory across multiple agent overlays",async()=>{
    const points: Array<{x:number;y:number}>=[];
    const send=async(_t:any,method:string,params:any)=>{
      if(method==="Input.dispatchMouseEvent"&&params?.type==="mouseMoved")
        points.push({x:params.x,y:params.y});
      return {};
    };
    const target={id:"shared-pointer"};
    setCursorPosition(target.id,{x:10,y:10},"alpha");
    setCursorPosition(target.id,{x:500,y:500},"beta");
    await dispatchHumanMouseMove(send,target,{x:120,y:130},{
      cursorId:"beta",steps:2,stepDelayMs:0,visualCursor:false,
    });
    const at=points.length;
    await dispatchHumanMouseMove(send,target,{x:220,y:230},{
      cursorId:"alpha",steps:2,stepDelayMs:0,visualCursor:false,
    });
    expect(points[at]).toEqual({x:120,y:130});
    expect(getCursorPosition(target.id,"alpha")).toEqual({x:220,y:230});
    expect(getCursorPosition(target.id,"beta")).toEqual({x:120,y:130});
  });

  it("reflects hand, text insertion and crosshair CSS cursors without intercepting pointer events",()=>{
    const script=UPDATE_CURSOR_OVERLAY_JS(200,120,false,"agent-one");
    expect(script).toContain("document.elementFromPoint");
    expect(script).toContain("data-superagent-cursor-kind");
    expect(script).toContain("'pointer'");
    expect(script).toContain("'text'");
    expect(script).toContain("'crosshair'");
  });
});
