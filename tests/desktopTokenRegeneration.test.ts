import {describe,it,expect,vi} from "vitest";
import {
  parseTrayTokenTarget,regenerateTrayToken,type TokenRotationAdapter,
} from "../src/core/runtime/desktopTokenRegeneration.js";

const oneTimeCode="0123456789abcdefghijklmnopqrstuvwx";
function fake():TokenRotationAdapter & {rotateMcpBootstrap:ReturnType<typeof vi.fn>;
 copySecretToClipboard:ReturnType<typeof vi.fn>;rotateCoreMuse:ReturnType<typeof vi.fn>} {
  return {
    mcpOwnerPid:port=>port===8857?22228:null,
    rotateMcpBootstrap:vi.fn(async()=>({
      code:oneTimeCode,publicUrl:"https://trusted.example.invalid/mcp",
    })),
    copySecretToClipboard:vi.fn(async()=>true),
    rotateCoreMuse:vi.fn(async()=>({copied:true})),
  };
}
describe("SuperAgent Tray token regeneration",()=>{
  it("strictly accepts only explicit MCP bootstrap and Core-local Muse owner targets",()=>{
    expect(parseTrayTokenTarget({kind:"mcp",port:8857,pid:22228})).toMatchObject({kind:"mcp"});
    expect(parseTrayTokenTarget({kind:"muse-core",port:7888,pid:1234})).toMatchObject({kind:"muse-core"});
    for(const input of [
      null,[],{}, {kind:"cloudflare",port:8857,pid:1},
      {kind:"openai-tunnel",port:8857,pid:1},
      {kind:"muse-watch",port:9225,pid:1},
      {kind:"mcp",port:8857,pid:0},
      {kind:"mcp",port:8857,pid:1,token:"override"},
      {kind:"mcp",port:"8857",pid:1},
      {kind:"mcp",port:80,pid:1},
      {kind:"mcp",port:8857,pid:2**33},
    ]) expect(()=>parseTrayTokenTarget(input)).toThrow();
  });
  it("rejects stale owner PID before generating or copying any secret",async()=>{
    const a=fake();
    await expect(regenerateTrayToken({kind:"mcp",port:8857,pid:21164},a))
      .rejects.toThrow("identity changed");
    expect(a.rotateMcpBootstrap).not.toHaveBeenCalled();
    expect(a.copySecretToClipboard).not.toHaveBeenCalled();
  });
  it("regenerates only the one-time MCP OAuth approval code, returning code and copying locally",async()=>{
    const a=fake();
    const result=await regenerateTrayToken({kind:"mcp",port:8857,pid:22228},a);
    expect(result).toMatchObject({
      success: true,
      kind: "mcp",
      port: 8857,
      pid: 22228,
      copied: true,
      code: oneTimeCode,
    });
    expect(a.rotateMcpBootstrap).toHaveBeenCalledExactlyOnceWith(8857);
    expect(a.copySecretToClipboard).toHaveBeenCalledOnce();
    expect(a.copySecretToClipboard.mock.calls[0][0]).toContain(oneTimeCode);
    expect(a.copySecretToClipboard.mock.calls[0][0]).toContain("https://trusted.example.invalid/mcp");
    expect(result.code).toBe(oneTimeCode);
    expect(result.setupSnippet).toContain(oneTimeCode);
  });
  it("never claims code was copied when clipboard delivery fails",async()=>{
    const a=fake();
    a.copySecretToClipboard.mockResolvedValueOnce(false);
    const result=await regenerateTrayToken({kind:"mcp",port:8857,pid:22228},a);
    expect(result).toMatchObject({success:true,copied:false,code:oneTimeCode});
    expect(result.message).toContain("clipboard copy failed");
  });
  it("rejects invalid owner response and legacy unsupported rotation",async()=>{
    const a=fake();
    a.rotateMcpBootstrap.mockResolvedValueOnce({publicUrl:"https://valid.invalid/mcp",code:"bad"});
    await expect(regenerateTrayToken({kind:"mcp",port:8857,pid:22228},a))
      .rejects.toThrow("invalid OAuth");
    expect(a.copySecretToClipboard).not.toHaveBeenCalled();
    a.rotateMcpBootstrap.mockRejectedValueOnce(new Error("MCP_BOOTSTRAP_LEGACY_OWNER"));
    await expect(regenerateTrayToken({kind:"mcp",port:8857,pid:22228},a))
      .rejects.toThrow("LEGACY_OWNER");
    expect(a.copySecretToClipboard).not.toHaveBeenCalled();
  });
  it("delegates Core-local Muse bearer to its verified Core owner, without returning token",async()=>{
    const a=fake();
    const out=await regenerateTrayToken({kind:"muse-core",port:7888,pid:1234},a);
    expect(out).toMatchObject({success:true,copied:true,kind:"muse-core"});
    expect(a.rotateCoreMuse).toHaveBeenCalledExactlyOnceWith(1234);
    expect(a.rotateMcpBootstrap).not.toHaveBeenCalled();
    expect(a.copySecretToClipboard).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toMatch(/"newToken"|"bearerToken"/);
  });
});
