import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import {
  certifiedDelegateWebAction, certifiedRemoteWebUrl,
} from "../src/core/tools/browserFilePolicyCertification.js";
import { registeredFileToolGate, getPermanentFileToolReadiness } from "../src/core/tools/registeredFileToolGate.js";
import { getGatewayInitiallyAdvertisedTools } from "../src/core/mcp/mcpToolGateway.js";
import { MCP_TOOL_CLASSIFICATION } from "../src/core/mcp/mcpToolPolicy.js";
import { CHROME_MCP_TOOL_DEFS, handleDelegateWebMcpTool } from "../src/core/mcp/tools/chromeMcpTools.js";
import { delegateMcpObservation } from "../src/core/mcp/tools/delegateMcpTools.js";

const client="delegate_client123";
const target="delegate:"+client+":42";
const token="not-a-real-lease-capability-1234";
const base={command:"claim_target",transport:"delegate",delegateClientId:client,targetId:target};
const certified=(args: Record<string, unknown>)=>
  certifiedDelegateWebAction({name:"superagent_chrome_cdp_web",args});

describe("narrow direct Delegate web workflow",()=>{
  it("is eagerly advertised, dangerous and explicitly scoped; observation remains safe",()=>{
    const listed=getGatewayInitiallyAdvertisedTools(CHROME_MCP_TOOL_DEFS as any);
    expect(listed.some(x=>x.name==="superagent_chrome_cdp_web")).toBe(true);
    expect(MCP_TOOL_CLASSIFICATION.superagent_chrome_cdp_web).toBe("dangerous");
    expect(getPermanentFileToolReadiness("superagent_chrome_cdp_web")).toBe("action_dependent");
    expect(MCP_TOOL_CLASSIFICATION.superagent_chrome_cdp_observe).toBe("safe");
    expect(certified(base)).toBe(true);
    expect(certified({...base,command:"release_target",sessionToken:token})).toBe(true);
    expect(certified({...base,command:"heartbeat_session",sessionToken:token})).toBe(true);
    expect(certified({...base,command:"session_participants",sessionToken:token})).toBe(true);
    expect(certified({...base,command:"snapshot",sessionToken:token})).toBe(true);
    expect(certified({...base,command:"read_page",sessionToken:token})).toBe(true);
    expect(certified({...base,command:"navigate",sessionToken:token,expectedRevision:0,url:"https://example.org/path"})).toBe(true);
    expect(certified({...base,command:"click",sessionToken:token,expectedRevision:0,selector:"#submit"})).toBe(true);
    expect(certified({...base,command:"type",sessionToken:token,expectedRevision:1,index:2,text:"hello"})).toBe(true);
  });

  it("rejects non-web and local-network origins",()=>{
    for (const url of [
      "file:///home/user/secret", "chrome://settings", "data:text/html,hello",
      "javascript:alert(1)", "http://localhost:3000/", "https://127.0.0.1/a",
      "http://192.168.1.1", "http://10.0.0.8", "https://[::1]/",
      "http://private.internal/", "http://example.test", "https://example.local",
      "https://alice:password@example.org/", "https://example.org\\@127.0.0.1/",
      "about:blank", "http://intranet",
    ])expect(certifiedRemoteWebUrl(url),url).toBe(false);
    expect(certifiedRemoteWebUrl("https://example.org/?q=1")).toBe(true);
    expect(certifiedRemoteWebUrl("http://staging.example.org/")).toBe(true);
  });

  it("rejects unexpected arguments, mixed profiles, stale/missing lease state, file and raw CDP actions",()=>{
    const valid={...base,command:"navigate",sessionToken:token,expectedRevision:2,url:"https://example.org"};
    for (const args of [
      {...base,command:"evaluate",payload:"{}"},
      {...base,command:"upload_file",files:["/tmp/secret"]},
      {...base,command:"get_cookies"},
      {...base,command:"execute_terminal",text:"cat ~/.ssh/id_rsa"},
      {...base,payload:"{}"},
      {...base,agentId:"spoofed"},
      {...base,transport:"managed"},
      {...base,delegateClientId:"another_client_1"},
      {...base,targetId:"delegate:another_client_1:42"},
      {...base,targetId:"delegate:"+client+":0"},
      {...base,targetId:"delegate:"+client+":999999999999"},
      {...base,command:"navigate",url:"https://example.org"},
      {...valid,expectedRevision:-1},
      {...valid,expectedRevision:1.5},
      {...valid,url:"file:///secret"},
      {...valid,url:"http://localhost:5000/admin"},
      {...valid,outputPath:"/tmp/secret"},
      {...valid,files:["/tmp/a"]},
      {...base,command:"snapshot"},
      {...base,command:"release_target",sessionToken:"short"},
      {...base,command:"click",sessionToken:token,expectedRevision:0},
      {...base,command:"click",sessionToken:token,expectedRevision:0,index:0},
      {...base,command:"click",sessionToken:token,expectedRevision:0,index:1,selector:"body"},
      {...base,command:"type",sessionToken:token,expectedRevision:0,selector:"#x"},
      {...base,command:"type",sessionToken:token,expectedRevision:0,selector:"#x",text:"x".repeat(10001)},
    ])expect(certified(args as Record<string,unknown>),JSON.stringify(args).slice(0,250)).toBe(false);
  });

  it("does not bypass the active permanent file registry or allow nested action escalation",()=>{
    const identity={platform:process.platform==="win32"?"win32":process.platform==="darwin"?"darwin":"linux",
      executablePath:process.execPath,sha256:"f".repeat(64)} as const;
    const registry=()=>({version:2 as const,defaultEffect:"deny" as const,rules:[]});
    const gate=(name:string,args:Record<string,unknown>)=>registeredFileToolGate(
      {name,args},process.cwd(),{registry,identity:()=>identity});
    const valid={...base,command:"click",sessionToken:token,expectedRevision:0,selector:"#ok"};
    expect(gate("superagent_chrome_cdp_web",valid)).toBeNull();
    expect(gate("superagent_tool_execute",{name:"superagent_chrome_cdp_web",arguments:valid})).toBeNull();
    expect(gate("superagent_tool_execute",{name:"superagent_chrome_cdp_web",
      arguments:{...valid,command:"evaluate",payload:"alert(1)"}})).toMatch(/not certified/);
    expect(gate("superagent_chrome_cdp_web",{...valid,files:["/private/.env"]})).toMatch(/not certified/);
    expect(gate("superagent_chrome_cdp_web",{...valid,transport:"managed"})).toMatch(/not certified/);
    expect(gate("superagent_chrome_cdp",{...valid,command:"upload_file"})).toMatch(/not certified/);
  });

  it("denies an invalid direct action before any browser forwarding",async()=>{
    const response=await handleDelegateWebMcpTool({...base,command:"evaluate",payload:"1+1"});
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toBe("DELEGATE_WEB_ARGUMENTS_NOT_CERTIFIED");
  });

  it("redacts typed text, secret lease and URL in Delegate audit records",()=>{
    const raw={...base,command:"type",sessionToken:token,expectedRevision:4,
      selector:"input[name=password]",text:"a private password"};
    const inspected=delegateMcpObservation("superagent_chrome_cdp_web",raw)!;
    expect(inspected.args).toMatchObject({delegateTool:"superagent_chrome_cdp_web",
      command:"type",contentRedacted:true,profileSpecified:true,tabSpecified:true});
    expect(JSON.stringify(inspected.args)).not.toContain(token);
    expect(JSON.stringify(inspected.args)).not.toContain("a private password");
    const nested=delegateMcpObservation("superagent_tool_execute",
      {name:"superagent_chrome_cdp_web",arguments:raw})!;
    expect(nested.args.contentRedacted).toBe(true);
  });

  it("does not expose data/javascript/blob pages through the Delegate extension policy",()=>{
    const filename=path.resolve(process.cwd(),"chrome-extension-delegate/cdpPolicy.js");
    const context=vm.createContext({});
    vm.runInContext(fs.readFileSync(filename,"utf8"),context);
    const policy=(context as any).DelegateCdpPolicy;
    for(const url of ["data:text/html,a","blob:https://example.org/abc",
      "javascript:alert(1)","file:///private","chrome://settings",
      "chrome-extension://x/index.html","devtools://inspector"])
      expect(policy.privileged(url),url).toBe(true);
    expect(policy.privileged("https://example.org/a")).toBe(false);
    expect(policy.privileged("about:blank")).toBe(false);
    for(const url of ["about:blank","http://localhost:3000","http://127.0.0.1:9222",
      "https://192.168.1.2/secret","file:///tmp/secret","blob:https://example.org/x",
      "https://user:password@example.org/"])
      expect(()=>policy.assertCertifiedWebUrl(url),url).toThrow();
    expect(()=>policy.assertCertifiedWebUrl("https://example.org/page")).not.toThrow();
  });
});
