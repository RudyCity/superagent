import {afterEach,describe,expect,it,vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseNewTrayConnection,createTrayConnection,type TrayCreationAdapter,
} from "../src/core/runtime/trayConnectionCreation.js";

const corePort=7888;
afterEach(()=>vi.unstubAllEnvs());
const fake = () => ({
  registerMcpClient:vi.fn(async()=>{}),
  createMcpTunnel:vi.fn(async()=>({pid:301,endpoint:"https://mcp.example.invalid/mcp",provider:"cloudflare"})),
  createCoreTunnel:vi.fn(async()=>({pid:302,endpoint:"https://rest.example.invalid"})),
  createMuseTunnel:vi.fn(async()=>({pid:303,endpoint:"wss://muse.example.invalid/muse"})),
});
describe("SuperAgent Tray new connection validation",()=>{
  it("parses only four explicit connection kinds with their expected fields",()=>{
    expect(parseNewTrayConnection({
      kind:"mcp-client",name:"safe-mcp",url:"https://mcp.example.org/mcp",oauth:true,
    },corePort)).toMatchObject({kind:"mcp-client",oauth:true});
    expect(parseNewTrayConnection({
      kind:"mcp-tunnel",port:9227,provider:"cloudflare",
    },corePort)).toEqual({kind:"mcp-tunnel",port:9227,provider:"cloudflare"});
    expect(parseNewTrayConnection({
      kind:"mcp-tunnel",port:9227,provider:"openai",tunnelId:"tunnel_0123456789abcdef",
    },corePort)).toMatchObject({provider:"openai"});
    expect(parseNewTrayConnection({
      kind:"core-tunnel",port:corePort,
    },corePort)).toEqual({kind:"core-tunnel",port:corePort});
    expect(parseNewTrayConnection({
      kind:"muse-tunnel",port:9225,
    },corePort)).toEqual({kind:"muse-tunnel",port:9225});
  });
  it("rejects arbitrary CLI/options, embedded credentials, query secrets and unsafe origins",()=>{
    const base={kind:"mcp-client",name:"trusted",url:"https://mcp.example.org/mcp",oauth:true};
    for (const raw of [
      {...base, command:"powershell.exe"},
      {...base,url:"https://bob:secret@mcp.example.org/mcp"},
      {...base,url:"https://mcp.example.org/mcp?token=sensitive"},
      {...base,url:"https://mcp.example.org/mcp#secret"},
      {...base,url:"http://192.168.1.10:3000/mcp"},
      {...base,url:"file:///secrets"},
      {...base,name:"../danger"},
      {...base,oauth:"true"},
      {kind:"mcp-tunnel",provider:"cloudflare",port:8857,allowDangerous:true},
      {kind:"mcp-tunnel",provider:"cloudflare",port:8857,tunnelId:"tunnel_0123456789abcdef"},
      {kind:"mcp-tunnel",provider:"openai",port:8857,tunnelId:"not-valid"},
      {kind:"core-tunnel",port:9999},
      {kind:"muse-tunnel",port:7888},
      {kind:"muse-tunnel",port:9225,workspace:"C:\\secret"},
      {kind:"muse-tunnel",port:"9225"},
      {kind:"shell",command:"rm"},
      null,[],
    ]) expect(()=>parseNewTrayConnection(raw,corePort)).toThrow();
  });
  it("does not start anything if validation fails",()=>{
    const ops=fake();
    expect(()=>parseNewTrayConnection({kind:"mcp-tunnel",port:9227,provider:"powershell"},corePort)).toThrow();
    expect(ops.createMcpTunnel).not.toHaveBeenCalled();
  });
  it("creates each typed operation through its intended owner, with unprivileged results",async()=>{
    const ops=fake();
    const client=await createTrayConnection(parseNewTrayConnection({
      kind:"mcp-client",name:"docs",url:"https://docs.example.org/mcp",oauth:true
    },corePort),ops as TrayCreationAdapter);
    expect(client).toMatchObject({success:true,kind:"mcp-client",state:"configured"});
    expect(client).not.toHaveProperty("endpoint");
    expect(ops.registerMcpClient).toHaveBeenCalledTimes(1);
    const mcp=await createTrayConnection(parseNewTrayConnection({
      kind:"mcp-tunnel",port:9227,provider:"cloudflare",
    },corePort),ops as TrayCreationAdapter);
    expect(mcp).toMatchObject({success:true,port:9227,pid:301,
      endpoint:"https://mcp.example.invalid/mcp"});
    expect(ops.createMcpTunnel).toHaveBeenCalledTimes(1);
    const rest=await createTrayConnection({kind:"core-tunnel",port:7888},ops as TrayCreationAdapter);
    expect(rest).toMatchObject({kind:"core-tunnel",state:"running",pid:302});
    const muse=await createTrayConnection({kind:"muse-tunnel",port:9225},ops as TrayCreationAdapter);
    expect(muse).toMatchObject({kind:"muse-tunnel",state:"running",pid:303});
    expect(ops.createMuseTunnel).toHaveBeenCalledTimes(1);
    const exposed=[client,mcp,rest,muse];
    for(const value of exposed){
      expect(value).not.toHaveProperty("bootstrapCode");
      expect(value).not.toHaveProperty("wsToken");
      expect(value).not.toHaveProperty("apiKey");
      expect(value).not.toHaveProperty("bearerToken");
    }
  });
  it("persists an external MCP client in an isolated real model config without replacing existing clients",async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"sa-tray-mcp-config-"));
    vi.stubEnv("SUPERAGENT_CONFIG_DIR",root);
    try{
      const first=await createTrayConnection({
        kind:"mcp-client",name:"remoteA",url:"https://example.org/mcp",oauth:true
      });
      expect(first).toMatchObject({success:true,state:"configured"});
      await createTrayConnection({
        kind:"mcp-client",name:"remoteB",url:"https://other.example.org/mcp",oauth:false
      });
      const saved=JSON.parse(fs.readFileSync(path.join(root,"model-config.json"),"utf8"));
      expect(saved.mcpServers.remoteA).toMatchObject({
        transport:"http",url:"https://example.org/mcp",oauth:true
      });
      expect(saved.mcpServers.remoteB).toMatchObject({
        transport:"http",url:"https://other.example.org/mcp",oauth:false
      });
      await expect(createTrayConnection({
        kind:"mcp-client",name:"RemoteA",url:"https://attacker.example.org/mcp",oauth:true
      })).rejects.toThrow("already configured");
      const after=JSON.parse(fs.readFileSync(path.join(root,"model-config.json"),"utf8"));
      expect(after.mcpServers.remoteA.url).toBe("https://example.org/mcp");
    }finally{fs.rmSync(root,{recursive:true,force:true})}
  });

  it("rejects concurrent creation rather than opening a duplicate tunnel",async()=>{
    let finish!: (v:{pid:number;endpoint:string;provider:string})=>void;
    const ops=fake();
    ops.createMcpTunnel.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
    const request=parseNewTrayConnection({kind:"mcp-tunnel",port:9300,provider:"cloudflare"},corePort);
    const first=createTrayConnection(request,ops as TrayCreationAdapter);
    await expect(createTrayConnection(request,ops as TrayCreationAdapter)).rejects.toThrow("already in progress");
    finish({pid:55,endpoint:"https://new.example.org/mcp",provider:"cloudflare"});
    expect((await first).success).toBe(true);
    expect(ops.createMcpTunnel).toHaveBeenCalledTimes(1);
  });
  it("releases the creation lock if the official owner rejects startup",async()=>{
    const ops=fake();
    ops.createCoreTunnel.mockRejectedValueOnce(new Error("Port already owned"));
    await expect(createTrayConnection({kind:"core-tunnel",port:corePort},ops as TrayCreationAdapter)).rejects.toThrow("Port already owned");
    expect((await createTrayConnection({kind:"core-tunnel",port:corePort},ops as TrayCreationAdapter)).success).toBe(true);
  });
});
