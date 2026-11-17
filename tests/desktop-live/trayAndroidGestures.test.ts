import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync("apps/superagent-tray/ui/desktop-live-manager.js", "utf8");

type ElementStub = {
  hidden: boolean; disabled: boolean; src: string; textContent: string;
  value: string; naturalWidth: number; naturalHeight: number; className: string;
  children: ElementStub[]; dataset: Record<string,string>;
  listeners: Map<string,(event?:any)=>void>;
  addEventListener: (name:string,cb:(event?:any)=>void)=>void;
  replaceChildren: (...els:ElementStub[])=>void;
  append: (...els:ElementStub[])=>void;
  setAttribute: (name:string,value:string)=>void;
  setPointerCapture: (id:number)=>void;
  getBoundingClientRect: ()=>{left:number;top:number;width:number;height:number};
  classList: {toggle:(name:string,on:boolean)=>void;add:(name:string)=>void;remove:(name:string)=>void};
};

function setup() {
  const elements = new Map<string,ElementStub>();
  function create():ElementStub {
    const el:ElementStub = {
      hidden:false,disabled:false,src:"",textContent:"",value:"",
      naturalWidth:100,naturalHeight:200,className:"",children:[],dataset:{},
      listeners:new Map(),
      addEventListener(name,cb){this.listeners.set(name,cb);},
      replaceChildren(...children){this.children=children;},
      append(...children){this.children.push(...children);},
      setAttribute(){},setPointerCapture(){},
      getBoundingClientRect(){return {left:10,top:20,width:100,height:200};},
      classList:{toggle(){},add(){},remove(){}},
    };
    return el;
  }
  function get(id:string):ElementStub {
    if(!elements.has(id)) elements.set(id,create());
    return elements.get(id)!;
  }
  get("desktop-live-stream-img").hidden = true;
  get("page-desktop-live").hidden = false;
  const requests:Array<{name:string;action:string;payload:any}> = [];
  const frames:Array<()=>void> = [];
  let now=20_000;
  const deviceId="123e4567-e89b-12d3-a456-426614174000";
  let approved=true;
  let pauseScreen=false, pauseOpen=false;
  let releaseScreen:((value:unknown)=>void)|null=null;
  let releaseOpen:((value:unknown)=>void)|null=null;
  const item = {
    id:"lan:"+deviceId,kind:"lan-device",title:"Android test",
    application:"Android LAN Client",handle:"10.0.0.2:7777",
    status:"controlled",devicePlatform:"android",stopAction:"stop-session",
    access:{view:"device-approval-required",controller:"device-approval-required",independentlyApproved:false},
  };
  const windowStub={
    confirm:()=>true,addEventListener:()=>{},
    __TAURI__:{core:{invoke:async(name:string,{action,payload}:any)=>{
      requests.push({name,action,payload});
      if(name==="desktop_live_action" && action==="inventory")
        return {success:true,items:[item],sources:{"lan-device":"ok"}};
      if(name==="lan_support_action") {
        if(action==="open"){
          if(pauseOpen)return await new Promise(resolve=>{releaseOpen=resolve;});
          return {success:true};
        }
        if(action==="screen"){
          if(pauseScreen)return await new Promise(resolve=>{releaseScreen=resolve;});
          return {success:true,frame:{data:"AA==",width:100,height:200}};
        }
        if(action==="control_request")return {success:true,kind:payload.kind,approved,
          secondsRemaining:approved?120:0};
        if(action==="control_status")return {success:true,approved,secondsRemaining:approved?120:0};
        if(action==="control_revoke")return {success:true,approved:false};
        if(action==="input")return {success:true,result:{ok:true}};
      }
      throw Error("Unexpected command: "+name+":"+action);
    }}},
  };
  vm.runInNewContext(script,{
    document:{readyState:"complete",hidden:false,
      getElementById:get,createElement:create,querySelectorAll:()=>[],
      addEventListener:()=>{}},
    window:windowStub,Date:{now:()=>now},Math,Number,String,Error,Boolean,Promise,
    performance:{now:()=>now},
    requestAnimationFrame:(cb:()=>void)=>{frames.push(cb);return frames.length;},
    cancelAnimationFrame:()=>{},setTimeout:()=>1,clearTimeout:()=>{},
    setInterval:()=>1,clearInterval:()=>{},
    navigator:{clipboard:{writeText:async()=>{}}},
  });
  async function flush(){for(let i=0;i<6;i++)await new Promise(done=>setImmediate(done));}
  async function click(el:ElementStub){el.listeners.get("click")?.();await flush();}
  async function start(){
    await flush();
    const card=get("desktop-live-list").children[0];
    const watch=card.children[2].children[0];
    await click(watch);
    const tick=frames.shift();
    expect(tick).toBeDefined();
    tick?.();
    await flush();
    expect(get("desktop-live-stream-img").hidden).toBe(false);
  }
  async function mouse(){
    await click(get("desktop-live-stream-request-control"));
    expect(get("desktop-live-mouse-status").textContent).toContain("approved");
    // Controller consent alone never enables pointer interaction: show the input UI explicitly.
    await click(get("desktop-live-stream-toggle-control"));
    expect(get("desktop-live-stream-viewport").classList).toBeDefined();
  }
  async function keyboard(){
    await click(get("desktop-live-stream-request-keyboard"));
    expect(get("desktop-live-keyboard-status").textContent).toContain("approved");
    await click(get("desktop-live-stream-toggle-control"));
  }
  function point(type:string,x:number,y:number,id=7){
    get("desktop-live-stream-img").listeners.get(type)?.({
      pointerId:id,isPrimary:true,clientX:x,clientY:y,
    });
  }
  return {get,requests,deviceId,frames,start,mouse,keyboard,point,flush,click,
    advance:(ms:number)=>{now+=ms;},
    deny:()=>{approved=false;},
    watch:()=>get("desktop-live-list").children[0].children[2].children[0],
    setAvailable:()=>{item.status="available";},
    pauseScreen:()=>{pauseScreen=true;},
    resumeScreen:()=>{
      pauseScreen=false;
      const resolve=releaseScreen;releaseScreen=null;
      resolve?.({success:true,frame:{data:"AA==",width:100,height:200}});
    },
    pauseOpen:()=>{pauseOpen=true;},
    resumeOpen:()=>{
      pauseOpen=false;
      const resolve=releaseOpen;releaseOpen=null;
      resolve?.({success:true});
    },
    stop:()=> (windowStub as any).__superagentDesktopLiveStopStream(),
  };
}

describe("Desktop Live scoped Android pointer and keyboard regression",()=>{
  it("keeps view-only gestures inert until a separate mouse grant",async()=>{
    const ui=setup();await ui.start();
    ui.point("pointerdown",60,120);ui.point("pointerup",60,120);
    await ui.flush();
    expect(ui.requests.some(x=>x.action==="input")).toBe(false);
  });

  it("sends one approved tap inside the image and ignores letterboxing",async()=>{
    const ui=setup();await ui.start();await ui.mouse();
    ui.point("pointerdown",60,120);ui.point("pointerup",60,120);
    await ui.flush();
    expect(ui.requests.filter(x=>x.action==="input")).toHaveLength(1);
    expect(ui.requests.find(x=>x.action==="input")?.payload)
      .toMatchObject({deviceId:ui.deviceId,kind:"tap",x:0.5,y:0.5});
    ui.point("pointerdown",500,500);ui.point("pointerup",500,500);
    await ui.flush();
    expect(ui.requests.filter(x=>x.action==="input")).toHaveLength(1);
  });

  it("maps deliberate drag to one bounded swipe, not an extra tap",async()=>{
    const ui=setup();await ui.start();await ui.mouse();
    ui.point("pointerdown",60,180);ui.advance(550);ui.point("pointerup",60,40);
    await ui.flush();
    const input=ui.requests.filter(x=>x.action==="input");
    expect(input).toHaveLength(1);
    expect(input[0].payload).toMatchObject({
      deviceId:ui.deviceId,kind:"swipe",x:0.5,y:0.8,endX:0.5,endY:0.1,durationMs:550,
    });
  });

  it("denies stale frames, canceled pointers, mismatched pointer IDs and stopped sessions",async()=>{
    const ui=setup();await ui.start();await ui.mouse();
    ui.point("pointerdown",60,120);ui.point("pointercancel",60,120);
    ui.point("pointerup",60,120);
    ui.point("pointerdown",60,120,3);ui.point("pointerup",60,120,4);
    await ui.flush();
    expect(ui.requests.some(x=>x.action==="input")).toBe(false);
    ui.advance(3001);
    ui.point("pointerdown",60,120);ui.point("pointerup",60,120);
    await ui.flush();
    expect(ui.requests.some(x=>x.action==="input")).toBe(false);
    await ui.stop();
    ui.point("pointerdown",60,120);ui.point("pointerup",60,120);
    await ui.flush();
    expect(ui.requests.some(x=>x.action==="input")).toBe(false);
  });

  it("denies rejected controller approval and oversized/control-character keyboard text",async()=>{
    const ui=setup();await ui.start();ui.deny();
    await ui.click(ui.get("desktop-live-stream-request-control"));
    ui.point("pointerdown",60,120);ui.point("pointerup",60,120);
    await ui.flush();
    expect(ui.requests.some(x=>x.action==="input")).toBe(false);
    const input=ui.get("desktop-live-stream-type-input");
    input.value="a".repeat(161);
    await ui.click(ui.get("desktop-live-stream-type-send"));
    expect(ui.requests.some(x=>x.action==="input")).toBe(false);
  });

  it("discards an outstanding old frame after a human stops the stream",async()=>{
    const ui=setup();await ui.start();await ui.mouse();
    ui.pauseScreen();
    const next=ui.frames.shift();
    expect(next).toBeDefined();
    next?.();
    await ui.flush();
    await ui.stop();
    ui.resumeScreen();
    await ui.flush();
    expect(ui.get("desktop-live-stream-img").hidden).toBe(true);
    expect(ui.get("desktop-live-stream-img").src).toBe("");
    ui.point("pointerdown",60,120);ui.point("pointerup",60,120);
    await ui.flush();
    expect(ui.requests.some(x=>x.action==="input")).toBe(false);
  });

  it("closes a superseded Android support session and rejects duplicate starts",async()=>{
    const ui=setup();await ui.flush();
    ui.setAvailable();
    ui.pauseOpen();
    const watch=ui.watch();
    await ui.click(watch);
    await ui.click(watch);
    expect(ui.requests.filter(x=>x.action==="open")).toHaveLength(1);
    await ui.stop();
    ui.resumeOpen();
    await ui.flush();
    expect(ui.requests.filter(x=>x.action==="close")).toHaveLength(1);
    expect(ui.get("desktop-live-stream-img").hidden).toBe(true);
  });

  it("requires keyboard scope and sends bounded text without mouse scope",async()=>{
    const ui=setup();await ui.start();
    const field=ui.get("desktop-live-stream-type-input");
    field.value="Text";
    await ui.click(ui.get("desktop-live-stream-type-send"));
    expect(ui.requests.some(x=>x.action==="input")).toBe(false);
    await ui.keyboard();
    field.value="a".repeat(161);
    await ui.click(ui.get("desktop-live-stream-type-send"));
    field.value="unsafe\ntext";
    await ui.click(ui.get("desktop-live-stream-type-send"));
    expect(ui.requests.some(x=>x.action==="input")).toBe(false);
    field.value="Safe text";
    await ui.click(ui.get("desktop-live-stream-type-send"));
    expect(ui.requests.filter(x=>x.action==="input")).toHaveLength(1);
    expect(ui.requests.find(x=>x.action==="input")?.payload)
      .toMatchObject({deviceId:ui.deviceId,kind:"text",text:"Safe text"});
    await ui.stop();
    expect(field.value).toBe("");
  });
});
