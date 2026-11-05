import {describe,it,expect,vi} from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const script=fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/settings.js"),"utf8"
);
const original={
  version:1,autoLaunchWithSuperagent:true,notificationsEnabled:true,
  closeToTray:true,runtimeScanSeconds:20,jobsRefreshSeconds:30,
  notificationPollSeconds:15,startupPage:"jobs",
};
const workspace="D:\\project\\superagent";
const baseMuseView={
  tokenConfigured:true,tokenMask:"1234...abcd",
  tokenStorage:"dpapi-current-user",tokenPlatformProtected:true,
  groupId:"-1001234567890",museBotId:"987654321",telegramReady:true,
  workspaces:[workspace],defaultWorkspace:workspace,
  wsPort:9225,wsPath:"/muse",wsMode:"server",wsRemoteUrl:"",
  wsTokenConfigured:true,autoStartMode:"off",
  watcherActive:false,watcherTransport:null,configStale:false,
  configRevision:"cfg1",watcherConfigRevision:null,
  pollingOwnerPid:null,pollingOwnerConflict:false,ready:true,
};

function setup(options:{
  initialHash?:boolean;stored?:Record<string,unknown>;rejectSave?:boolean;
  muse?:Record<string,unknown>;
}={}) {
  const nodes=new Map<string,any>();
  const listeners=new Map<string,(event?:unknown)=>unknown>();
  const requested:Array<{name:string;args?:unknown}>=[];
  const dispatched:Array<{type:string;detail?:any}>=[];
  const pages:string[]=[];
  const confirm=vi.fn(()=>true);
  const node=(id:string)=>{
    if(!nodes.has(id)) nodes.set(id,{
      value:"",checked:false,disabled:false,textContent:"",innerHTML:"",hidden:false,
      addEventListener:(event:string,fn:(e:unknown)=>unknown)=>listeners.set(id+":"+event,fn),
    });
    return nodes.get(id);
  };
  const stored={...original,...options.stored};
  let currentMuse={...baseMuseView,...options.muse};
  const context=vm.createContext({
    document:{getElementById:node},
    window:{
      __superagentTrayHadInitialHash:options.initialHash??false,
      navigateToPage:(page:string)=>pages.push(page),
      confirm,
      __TAURI__:{
        core:{invoke:async(name:string,args?:unknown)=>{
          requested.push({name,args});
          if(name==="get_tray_settings")return stored;
          if(name==="set_tray_settings"){
            if(options.rejectSave)throw new Error("Access denied");
            return (args as any)?.settings;
          }
          if(name==="get_muse_telegram_settings")return {success:true,settings:currentMuse};
          if(name==="set_muse_telegram_settings"){
            const settings=(args as any)?.settings||{};
            currentMuse={...currentMuse,
              tokenConfigured:settings.clearBotToken!==true,
              tokenMask:settings.clearBotToken===true?"":"1234...abcd",
              tokenStorage:settings.clearBotToken===true?"none":"dpapi-current-user",
              tokenPlatformProtected:settings.clearBotToken!==true,
              groupId:settings.groupId||"",museBotId:settings.museBotId||"",
              workspaces:settings.workspaces||[],defaultWorkspace:settings.defaultWorkspace||"",
              wsPort:settings.wsPort||9225,wsPath:settings.wsPath||"/muse",
              wsMode:settings.wsMode||"server",wsRemoteUrl:settings.wsRemoteUrl||"",
              autoStartMode:settings.autoStartMode||"off",
              ready:settings.clearBotToken!==true && Boolean(settings.groupId&&settings.museBotId),
            };
            return {success:true,settings:currentMuse};
          }
          if(name==="test_muse_telegram_settings")return {
            success:true,
            test:{
              success:true,botOnline:true,username:"muse_test_bot",
              canReadGroupMessages:true,groupConfigured:true,museBotConfigured:true,
              checks:["Bot API: ONLINE","Group ID: VERIFIED","Webhook: clear"],
              message:"Telegram Doctor passed without sending a message",
            },
          };
          if(name==="regenerate_muse_ws_token"){
            currentMuse={...currentMuse,wsTokenConfigured:true};
            return {success:true,settings:currentMuse,message:"token generated"};
          }
          if(name==="apply_muse_settings"){
            currentMuse={...currentMuse,configStale:false};
            return {success:true,message:"settings applied"};
          }
          throw new Error("Unexpected native command "+name);
        }},
        event:{listen:async()=>()=>{}},
      },
      dispatchEvent:(e:{type:string;detail:any})=>{
        dispatched.push({type:e.type,detail:e.detail});
      },
      addEventListener:(event:string,fn:(e:unknown)=>unknown)=>listeners.set("window:"+event,fn),
    },
    CustomEvent:class{
      constructor(public type:string,public opts:{detail?:any}){}
      get detail(){return this.opts.detail}
    },
    Number,String,Array,Object,Boolean,Error,
  });
  vm.runInContext(script,context);
  return {node,listeners,requested,dispatched,pages,context,confirm};
}
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve))};

describe("SuperAgent Tray Settings UI",()=>{
  it("packages all Tray and Muse control fields",()=>{
    const html=fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"),"utf8");
    for(const id of [
      "page-settings","tray-settings-form","settings-save","settings-defaults",
      "settings-auto-launch","settings-notifications","settings-close-to-tray",
      "settings-runtime-scan","settings-jobs-refresh","settings-notification-poll",
      "settings-startup-page","muse-telegram-settings-form","muse-telegram-bot-token",
      "muse-telegram-group-id","muse-telegram-bot-id","muse-token-storage",
      "muse-workspace-input","muse-workspace-add","muse-workspace-remove",
      "muse-workspace-list","muse-default-workspace","muse-ws-mode","muse-ws-port",
      "muse-ws-path","muse-ws-remote-url","muse-ws-token-regenerate",
      "muse-auto-start","muse-config-stale","muse-telegram-test","muse-apply-restart"
    ]) expect(html).toContain(`id="${id}"`);
  });

  it("loads native Tray preferences and startup page",async()=>{
    const ui=setup({stored:{autoLaunchWithSuperagent:false,runtimeScanSeconds:60,
      notificationsEnabled:false,startupPage:"runtime"}});
    await flush();
    expect(ui.node("settings-auto-launch").checked).toBe(false);
    expect(ui.node("settings-notifications").checked).toBe(false);
    expect(ui.node("settings-runtime-scan").value).toBe("60");
    expect(ui.pages).toEqual(["runtime"]);
  });

  it("never overrides an explicit existing deep link",async()=>{
    const ui=setup({initialHash:true,stored:{startupPage:"runtime"}});
    await flush();
    expect(ui.pages).toEqual([]);
  });

  it("saves only recognized Tray preference keys",async()=>{
    const ui=setup();await flush();
    ui.node("settings-auto-launch").checked=false;
    ui.node("settings-notifications").checked=false;
    ui.node("settings-close-to-tray").checked=false;
    ui.node("settings-runtime-scan").value="120";
    ui.node("settings-jobs-refresh").value="60";
    ui.node("settings-notification-poll").value="30";
    ui.node("settings-startup-page").value="history";
    await ui.listeners.get("tray-settings-form:submit")!({preventDefault(){}});
    const save=ui.requested.find(r=>r.name==="set_tray_settings");
    expect((save?.args as any).settings).toEqual({
      ...original,autoLaunchWithSuperagent:false,notificationsEnabled:false,
      closeToTray:false,runtimeScanSeconds:120,jobsRefreshSeconds:60,
      notificationPollSeconds:30,startupPage:"history",
    });
  });

  it("loads secure Muse state and saves the expanded Muse contract without echoing token",async()=>{
    const ui=setup();await flush();
    expect(ui.node("muse-telegram-bot-token").value).toBe("");
    expect(ui.node("muse-telegram-token-hint").textContent).toContain("1234...abcd");
    expect(ui.node("muse-token-storage").textContent).toContain("DPAPI");
    expect(ui.node("muse-default-workspace").value).toBe(workspace);
    expect(ui.node("muse-ws-port").value).toBe("9225");

    ui.node("muse-telegram-bot-token").value="123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
    ui.node("muse-telegram-group-id").value="-1002222222222";
    ui.node("muse-telegram-bot-id").value="111222333";
    ui.node("muse-ws-path").value="/control";
    ui.node("muse-auto-start").value="telegram";
    await ui.listeners.get("muse-telegram-settings-form:submit")!({preventDefault(){}});

    const save=ui.requested.find(r=>r.name==="set_muse_telegram_settings");
    expect(save).toMatchObject({args:{settings:{
      botToken:"123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd",
      groupId:"-1002222222222",museBotId:"111222333",clearBotToken:false,
      workspaces:[workspace],defaultWorkspace:workspace,
      wsPort:9225,wsPath:"/control",wsMode:"server",wsRemoteUrl:"",
      autoStartMode:"telegram",
    }}});
    expect(ui.node("muse-telegram-bot-token").value).toBe("");
  });

  it("runs Telegram Doctor without a message-send action",async()=>{
    const ui=setup();await flush();
    await ui.listeners.get("muse-telegram-test:click")!();
    expect(ui.requested.some(r=>r.name==="test_muse_telegram_settings")).toBe(true);
    expect(ui.node("muse-telegram-doctor").innerHTML).toContain("Group ID: VERIFIED");
    expect(ui.requested.some(r=>/send/i.test(r.name))).toBe(false);
  });

  it("supports workspace editing and WS token generation",async()=>{
    const ui=setup();await flush();
    ui.node("muse-workspace-input").value="D:\\project\\cika";
    await ui.listeners.get("muse-workspace-add:click")!();
    expect(ui.node("muse-workspace-list").innerHTML).toContain("D:\\project\\cika");
    await ui.listeners.get("muse-ws-token-regenerate:click")!();
    expect(ui.requested.some(r=>r.name==="regenerate_muse_ws_token")).toBe(true);
    expect(ui.node("muse-ws-token-status").textContent).toContain("configured");
  });

  it("enables Apply & Restart only for stale running settings",async()=>{
    const ui=setup({muse:{watcherActive:true,watcherTransport:"telegram",
      configStale:true,watcherConfigRevision:"old"}});
    await flush();
    expect(ui.node("muse-apply-restart").disabled).toBe(false);
    await ui.listeners.get("muse-apply-restart:click")!();
    expect(ui.requested.some(r=>r.name==="apply_muse_settings")).toBe(true);
  });

  it("invalid Tray intervals fail locally and do not reach native storage",async()=>{
    const ui=setup();await flush();
    ui.node("settings-runtime-scan").value="1";
    await ui.listeners.get("tray-settings-form:submit")!({preventDefault(){}});
    expect(ui.requested.filter(r=>r.name==="set_tray_settings")).toHaveLength(0);
    expect(ui.node("settings-feedback").textContent).toContain("NOT saved");
  });

  it("Restore Defaults previews without writing until explicit Save",async()=>{
    const ui=setup({stored:{autoLaunchWithSuperagent:false,closeToTray:false,runtimeScanSeconds:120}});
    await flush();
    await ui.listeners.get("settings-defaults:click")!();
    expect(ui.node("settings-auto-launch").checked).toBe(true);
    expect(ui.node("settings-close-to-tray").checked).toBe(true);
    expect(ui.requested.filter(r=>r.name==="set_tray_settings")).toHaveLength(0);
  });

  it("does not falsely report Tray save success on native failure",async()=>{
    const ui=setup({rejectSave:true});await flush();
    const previous=ui.dispatched.length;
    await ui.listeners.get("tray-settings-form:submit")!({preventDefault(){}});
    expect(ui.dispatched.length).toBe(previous);
    expect(ui.node("settings-feedback").textContent).toContain("NOT saved");
    expect(ui.node("settings-save").disabled).toBe(false);
  });
});
