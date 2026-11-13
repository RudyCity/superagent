import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const script=fs.readFileSync("apps/superagent-tray/ui/updates.js","utf8");
const html=fs.readFileSync("apps/superagent-tray/ui/index.html","utf8");
const app=fs.readFileSync("apps/superagent-tray/ui/app.js","utf8");
const native=fs.readFileSync("apps/superagent-tray/src-tauri/src/release_updates.rs","utf8");
const host=fs.readFileSync("apps/superagent-tray/src-tauri/src/main.rs","utf8");
const sha="c".repeat(64);
const item=(id:string,label:string,fileName:string,available=true)=>({
  id,label,version:id==="superagent"?"1.14.83":"1.10.1",installedVersion:null,
  state:id==="superagent"?"update_available":"installed_unknown",
  platform:"Desktop / device",fileName:available?fileName:null,
  size:available?12345678:null,sha256:available?sha:null,available,
  instructions:"Manual installation after active sessions end."
});
const example={
  currentVersion:"1.14.82",releaseVersion:"1.14.83",tag:"v1.14.83-rc.2",
  releaseUrl:"https://github.com/RudyCity/superagent/releases/tag/v1.14.83-rc.2",
  platform:"Windows x64",state:"update_available",
  assetName:"SuperAgent_1.14.83_x64-setup.exe",assetSize:100_000_000,
  sha256:sha,components:["Windows installer","Chrome Delegate"],downloadSupported:true,
  componentItems:[
    item("superagent","Tray + Core","SuperAgent_1.14.83_x64-setup.exe"),
    item("chrome-delegate","Chrome Delegate","superagent-delegate-1.10.1.zip"),
    item("chrome-sidepanel","Chrome SidePanel","superagent-sidepanel-1.0.0.zip"),
    item("android-lan","Android LAN","SuperAgent-LAN-Android-0.10.0-native-dashboard-debug.apk"),
    item("windows-lan","Windows LAN","SuperAgent-LAN-Client-0.2.0-Windows-x64-setup.exe"),
    item("linux-deb","Linux DEB","",false)
  ]
};
class FakeElement {
  textContent=""; hidden=false;disabled=false;type="";
  dataset:Record<string,string>={};className="";
  children:FakeElement[]=[];
  listeners=new Map<string,()=>void>();
  addEventListener(event:string,cb:()=>void){this.listeners.set(event,cb);}
  click(){if(!this.disabled)this.listeners.get("click")?.();}
  replaceChildren(){this.children=[];this.textContent="";}
  append(...items:FakeElement[]){this.children.push(...items);}
  get childElementCount(){return this.children.length;}
}
function createHarness(confirmation=true, release:any=example) {
  const elements=new Map<string,FakeElement>();
  const element=(id:string)=>{
    if(!elements.has(id))elements.set(id,new FakeElement());
    return elements.get(id)!;
  };
  const calls:Array<{action:string,args?:any}>=[];
  const window={
    location:{hash:"#jobs"},confirm:(_text:string)=>confirmation,
    __TAURI__:{core:{invoke:async(action:string,args?:any)=>{
      calls.push({action,args});
      if(action==="check_release_updates")return structuredClone(release);
      if(["download_release_update","download_release_component"].includes(action)){
        return {tag:release.tag,sha256:args.expectedSha256,installed:false,
          fileName:args.componentId==="android-lan"?release.componentItems[3].fileName:
            args.componentId==="chrome-delegate"?release.componentItems[1].fileName:
              release.assetName,
          filePath:"C:\\Users\\tester\\Downloads\\SuperAgent\\updates\\verified.zip"};
      }
      throw Error("UNEXPECTED_NATIVE_ACTION");
    }}},
    __superagentUpdatesRefresh:undefined as undefined|(()=>Promise<void>)
  };
  const document={getElementById:element,createElement:(_tag:string)=>new FakeElement()};
  vm.runInNewContext(script,{window,document,console},{filename:"updates.js",timeout:1000});
  return {element,calls,window,settle:()=>new Promise<void>(resolve=>setImmediate(resolve))};
}
const componentButton=(h:ReturnType<typeof createHarness>,index:number)=>{
  const row=h.element("updates-components").children[index];
  return row.children[4].children[0];
};

describe("Unified verified component updates",()=>{
  it("wires native check and independent component download without shell privileges",()=>{
    for(const fragment of [
      'id="nav-updates"','id="page-updates"','id="updates-check"',
      'id="updates-download"','src="./updates.js"',
    ])expect(html).toContain(fragment);
    expect(app).toContain('"updates"');
    expect(app).toContain("window.__superagentUpdatesRefresh?.()");
    expect(host).toContain("release_updates::check_release_updates");
    expect(host).toContain("release_updates::download_release_update");
    expect(host).toContain("release_updates::download_release_component");
    expect(native).toContain("UPDATE_RELEASE_CHANGED_SINCE_REVIEW");
    expect(native).toContain("UPDATE_DOWNLOAD_HASH_OR_SIZE_MISMATCH");
    expect(native).toContain("UPDATE_COMPONENT_NOT_ALLOWED");
    expect(native).toContain("fs::hard_link");
    expect(native).not.toContain("Command::new");
    expect(script).not.toContain(".innerHTML");
  });
  it("shows six independent component statuses with unknown installed version",async()=>{
    const h=createHarness();
    expect(h.calls).toHaveLength(0);
    await h.window.__superagentUpdatesRefresh?.();
    expect(h.calls.map(x=>x.action)).toEqual(["check_release_updates"]);
    expect(h.element("updates-release-version").textContent).toBe("1.14.83");
    expect(h.element("updates-state").textContent).toBe("Update available");
    const cards=h.element("updates-components").children;
    expect(cards).toHaveLength(6);
    expect(cards[1].children[1].textContent).toContain("Installed Unknown");
    expect(cards[3].children[0].children[0].textContent).toBe("Android LAN");
    expect(componentButton(h,5).disabled).toBe(true);
    expect(componentButton(h,1).disabled).toBe(false);
  });
  it("requires explicit independent confirmation before Chrome extension download",async()=>{
    const declined=createHarness(false);
    await declined.window.__superagentUpdatesRefresh?.();
    componentButton(declined,1).click();
    await declined.settle();
    expect(declined.calls).toHaveLength(1);
    const approved=createHarness(true);
    await approved.window.__superagentUpdatesRefresh?.();
    componentButton(approved,1).click();
    await approved.settle();
    expect(approved.calls.map(x=>x.action))
      .toEqual(["check_release_updates","download_release_component"]);
    expect(approved.calls[1].args)
      .toEqual({componentId:"chrome-delegate",expectedTag:example.tag,expectedSha256:sha});
    expect(approved.element("updates-downloaded").hidden).toBe(false);
    expect(approved.element("updates-feedback").textContent).toContain("no running services");
  });
  it("supports Android independently without installing APK automatically",async()=>{
    const h=createHarness();
    await h.window.__superagentUpdatesRefresh?.();
    componentButton(h,3).click();
    await h.settle();
    expect(h.calls[1].args.componentId).toBe("android-lan");
    expect(h.calls.every(c=>!c.action.includes("install"))).toBe(true);
  });
  it("preserves legacy main installer manual download contract",async()=>{
    const h=createHarness();
    await h.window.__superagentUpdatesRefresh?.();
    h.element("updates-download").click();
    await h.settle();
    expect(h.calls.map(c=>c.action)).toEqual(["check_release_updates","download_release_update"]);
    expect(h.calls[1].args).toEqual({expectedTag:example.tag,expectedSha256:sha});
    expect(h.element("updates-downloaded").hidden).toBe(false);
  });
  it("disables missing or unverified packages",async()=>{
    const modified=structuredClone(example);
    modified.componentItems[4]={...modified.componentItems[4],
      available:false,sha256:null,fileName:null};
    const h=createHarness(true,modified);
    await h.window.__superagentUpdatesRefresh?.();
    componentButton(h,4).click();
    await h.settle();
    expect(h.calls).toHaveLength(1);
    expect(componentButton(h,4).disabled).toBe(true);
  });
});
