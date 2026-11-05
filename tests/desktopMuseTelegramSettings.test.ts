import {beforeEach,describe,expect,it,vi} from "vitest";

const state=vi.hoisted(()=>({
  cfg:{} as Record<string,any>,
  secure:false,
}));

vi.mock("../src/core/remoteAgent/config.js",()=>({
  loadRemoteAgentConfig:()=>({...state.cfg}),
  maskToken:(value?:string)=>value ? value.slice(0,4)+"..."+value.slice(-4) : "(not configured)",
  getWatchedWorkspaces:(cfg:any)=>Array.isArray(cfg?.workspaces)&&cfg.workspaces.length
    ? [...cfg.workspaces] : [process.cwd()],
  getMuseRuntimeConfigRevision:(cfg:any)=>"rev-"+String(cfg?.groupId||"none"),
  getMuseTelegramSecretStorage:()=>({
    configured:Boolean(state.cfg.botToken),
    storage:state.secure?"dpapi-current-user":state.cfg.botToken?"legacy-plaintext":"none",
    platformProtected:state.secure,
  }),
  migrateMuseTelegramBotTokenToSecureStorage:()=>{
    state.secure=Boolean(state.cfg.botToken);
    return {configured:state.secure,storage:state.secure?"dpapi-current-user":"none",
      platformProtected:state.secure};
  },
  setMuseTelegramBotTokenSecure:(token?:string)=>{
    if(token) {
      state.cfg.botToken=token;
      state.cfg.botTokenSecretRef="muse.telegram.bot-token";
      state.secure=true;
    } else {
      delete state.cfg.botToken;
      delete state.cfg.botTokenSecretRef;
      state.secure=false;
    }
    return {...state.cfg};
  },
  updateRemoteAgentConfig:(patch:Record<string,unknown>)=>{
    for(const [key,value] of Object.entries(patch)){
      if(value===undefined) delete state.cfg[key];
      else state.cfg[key]=value;
    }
    return {...state.cfg};
  },
  generateSecureWsToken:()=>"generated_ws_token_1234567890",
}));

vi.mock("../src/core/remoteAgent/museWatcherRegistry.js",()=>({
  getMuseWatcher:()=>null,
}));

vi.mock("../src/core/remoteAgent/telegramPollingLease.js",()=>({
  inspectTelegramPollingOwner:async()=>({active:false,tokenHash:"abc"}),
}));

vi.mock("../src/core/remoteAgent/museClient.js",()=>({
  MuseClient:class{
    async getMeInfo(){
      return {ok:true,id:123456789,username:"muse_test_bot",firstName:"Muse",
        canReadGroupMessages:true};
    }
  },
}));

vi.mock("../src/core/remoteAgent/cloudflareTunnel.js",()=>({
  copyTextToClipboard:async()=>true,
}));

import {
  readMuseTelegramSettings,
  updateMuseTelegramSettings,
  testMuseTelegramSettings,
} from "../src/core/runtime/desktopMuseTelegramSettings.js";

const fullUpdate=(overrides:Record<string,unknown>={})=>({
  botToken:"",
  groupId:"-1001234567890",
  museBotId:"987654321",
  clearBotToken:false,
  workspaces:[process.cwd()],
  defaultWorkspace:process.cwd(),
  wsPort:9225,
  wsPath:"/muse",
  wsMode:"server",
  wsRemoteUrl:"",
  autoStartMode:"off",
  ...overrides,
});

describe("desktop Muse settings",()=>{
  beforeEach(()=>{
    state.cfg={
      botToken:"123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd",
      groupId:"-1001234567890",
      museBotId:"987654321",
      workspaces:[process.cwd()],
      defaultWorkspace:process.cwd(),
      wsPort:9225,
      wsPath:"/muse",
      wsMode:"server",
      wsToken:"ws_secret",
      museAutoStartMode:"off",
    };
    state.secure=false;
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      let result:any={};
      if(url.includes("/getChat?")) result={id:-1001234567890,title:"test"};
      else if(url.includes("/getChatMember?")) result={status:"member"};
      else if(url.includes("/getWebhookInfo")) result={url:""};
      return {
        ok:true,status:200,
        json:async()=>({ok:true,result}),
      } as any;
    }));
  });

  it("never returns raw credentials and reports legacy storage before migration",async()=>{
    const raw=state.cfg.botToken;
    const view=await readMuseTelegramSettings();
    expect(view.tokenConfigured).toBe(true);
    expect(view.tokenMask).toBe("1234...abcd");
    expect(view.tokenStorage).toBe("legacy-plaintext");
    expect(view).not.toHaveProperty("botToken");
    expect(JSON.stringify(view)).not.toContain(raw);
    expect(view.telegramReady).toBe(true);
    expect(view.workspaces).toEqual([process.cwd()]);
  });

  it("blank token preserves and migrates legacy token while updating all non-secret Muse settings",async()=>{
    const original=state.cfg.botToken;
    const view=await updateMuseTelegramSettings(fullUpdate({
      groupId:"-1002222222222",
      museBotId:"111222333",
      wsPort:9333,
      wsPath:"/control",
      autoStartMode:"telegram",
    }));
    expect(state.cfg.botToken).toBe(original);
    expect(state.secure).toBe(true);
    expect(state.cfg.groupId).toBe("-1002222222222");
    expect(state.cfg.museBotId).toBe("111222333");
    expect(state.cfg.wsPort).toBe(9333);
    expect(view.tokenStorage).toBe("dpapi-current-user");
    expect(view.autoStartMode).toBe("telegram");
  });

  it("explicitly clears the token without exposing the previous value",async()=>{
    const previous=state.cfg.botToken;
    const view=await updateMuseTelegramSettings(fullUpdate({clearBotToken:true}));
    expect(state.cfg.botToken).toBeUndefined();
    expect(view.tokenConfigured).toBe(false);
    expect(JSON.stringify(view)).not.toContain(previous);
  });

  it("rejects malformed IDs, unexpected fields, unsafe workspaces and malformed tokens",async()=>{
    await expect(updateMuseTelegramSettings(fullUpdate({groupId:"not-a-chat"})))
      .rejects.toThrow("Group ID");
    await expect(updateMuseTelegramSettings(fullUpdate({botToken:"bad token"})))
      .rejects.toThrow("token");
    await expect(updateMuseTelegramSettings({...fullUpdate(),command:"taskkill"}))
      .rejects.toThrow("Unexpected");
    await expect(updateMuseTelegramSettings(fullUpdate({workspaces:["relative/path"]})))
      .rejects.toThrow("absolute");
  });

  it("Telegram Doctor verifies group/membership/webhook and returns no credential",async()=>{
    const raw=state.cfg.botToken;
    const result=await testMuseTelegramSettings();
    expect(result).toMatchObject({
      success:true,
      botOnline:true,
      username:"muse_test_bot",
      groupConfigured:true,
      museBotConfigured:true,
      groupOnline:true,
      botMembership:true,
      museMembership:true,
      webhookConflict:false,
      pollingConflict:false,
    });
    expect(result.checks).toContain("Group ID: VERIFIED");
    expect(result.checks).toContain("Webhook: clear");
    expect(JSON.stringify(result)).not.toContain(raw);
  });
});
