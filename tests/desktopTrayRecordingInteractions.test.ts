import { describe,expect,it,vi } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const source=readFileSync("apps/superagent-tray/ui/recordings.js","utf8");
type NodeLike=ReturnType<typeof makeNode>;
function makeNode() {
  const events=new Map<string,(event?:any)=>unknown>();
  const node={
    textContent:"",className:"",hidden:false,disabled:false,value:"",type:"",
    dataset:{} as Record<string,string>,
    children:[] as any[],
    append(...items:any[]){this.children.push(...items);},
    replaceChildren(...items:any[]){this.children=[...items];},
    addEventListener(type:string,fn:(event?:any)=>unknown){events.set(type,fn);},
    fire(type:string,event?:unknown){return events.get(type)?.(event);},
  };
  return node;
}
function findButton(node:NodeLike, label:string):NodeLike|undefined {
  if(node.textContent===label)return node;
  for(const child of node.children){
    const found=findButton(child,label);
    if(found)return found;
  }
  return undefined;
}
function mount() {
  const elements=new Map<string,NodeLike>();
  const get=(id:string)=>{
    if(!elements.has(id))elements.set(id,makeNode());
    return elements.get(id)!;
  };
  const calls:{name:string;action:string;payload:any}[]=[];
  const recordings=[{
    recordingId:"00000000-0000-4000-8000-000000000123",
    source:"native-window-exact-window",status:"saved",
    startedAt:"2026-11-17T08:00:00.000Z",hasVideo:true,
    frameCount:12,droppedFrames:1,videoBytes:4000000,
  }];
  const storage=new Map<string,string>();
  const invoke=vi.fn(async(name:string,args:{action:string;payload:any})=>{
    calls.push({name,action:args.action,payload:args.payload});
    if(args.action==="pick-project")return {projectDirectory:"/example/approved-project"};
    if(args.action==="list")return {success:true,recordings};
    return {success:true};
  });
  const window={
    __TAURI__:{core:{invoke}},
    localStorage:{
      getItem:(key:string)=>storage.get(key)||null,
      setItem:(key:string,value:string)=>{storage.set(key,value);},
    },
    setInterval:vi.fn(),
  };
  const document={
    readyState:"complete",hidden:false,
    getElementById:get,createElement:makeNode,
  };
  runInContext(source,createContext({window,document}));
  return {get,calls,invoke,recordings,storage};
}
describe("Tray Recording Manager UI behavior",()=>{
  it("requires project picker before listing, then provides private Play/ZIP/Delete controls",async()=>{
    const tray=mount();
    expect(tray.calls).toEqual([]);
    const choose=tray.get("recordings-pick");
    await choose.fire("click");
    expect(tray.calls.some(c=>c.action==="pick-project")).toBe(true);
    expect(tray.calls.some(c=>c.action==="list" &&
      c.payload.projectDirectory==="/example/approved-project")).toBe(true);
    const list=tray.get("recordings-list");
    const exportButton=findButton(list,"Export ZIP");
    const playButton=findButton(list,"Play");
    const deleteButton=findButton(list,"Delete");
    expect(exportButton).toBeTruthy();
    expect(playButton).toBeTruthy();
    expect(deleteButton).toBeTruthy();
    await exportButton!.fire("click");
    expect(tray.calls.at(-2)?.action).toBe("export-zip");
    expect(tray.calls.at(-2)?.payload).toEqual({
      projectDirectory:"/example/approved-project",
      recordingId:"00000000-0000-4000-8000-000000000123",
    });
    expect(tray.calls.at(-1)?.action).toBe("list");
    // User approval and filesystem validation remain on the native Rust side.
    expect(tray.calls.some(c=>c.action==="delete")).toBe(false);
    expect(tray.get("recordings-status").textContent).toMatch(/recording/);
  });
  it("does not offer Play or ZIP for unfinalized native recordings",async()=>{
    const tray=mount();
    tray.recordings[0].status="recording";
    tray.recordings[0].hasVideo=false;
    await tray.get("recordings-pick").fire("click");
    expect(findButton(tray.get("recordings-list"),"Export ZIP")).toBeUndefined();
    expect(findButton(tray.get("recordings-list"),"Play")).toBeUndefined();
    expect(findButton(tray.get("recordings-list"),"Stop")).toBeTruthy();
  });
});
