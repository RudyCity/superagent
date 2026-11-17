import {describe,expect,it} from "vitest";
import {classifyLiveMcpFailure} from "../src/core/mcp/mcpLiveVerifierDiagnostics.js";

describe("attended MCP live verifier error reporting",()=>{
  it.each([
    [{code:"MCP_POLICY_DEADLINE"},"MCP_POLICY_LIVE_TIMEOUT"],
    [{code:"ETIMEDOUT"},"MCP_POLICY_LIVE_TIMEOUT"],
    [{cause:{code:"UND_ERR_CONNECT_TIMEOUT"}},"MCP_POLICY_LIVE_TIMEOUT"],
    [{status:401},"MCP_POLICY_AUTH_REJECTED"],
    [{statusCode:403},"MCP_POLICY_AUTH_REJECTED"],
    [{code:"ENOTFOUND"},"MCP_POLICY_DNS_UNAVAILABLE"],
    [{code:"EAI_AGAIN"},"MCP_POLICY_DNS_UNAVAILABLE"],
    [{code:"ECONNREFUSED"},"MCP_POLICY_CONNECTION_REFUSED"],
    [{code:"ECONNRESET"},"MCP_POLICY_CONNECTION_REFUSED"],
    [{code:"ERR_TLS_CERT_ALTNAME_INVALID"},"MCP_POLICY_TLS_REJECTED"],
    [{code:"UNABLE_TO_VERIFY_LEAF_SIGNATURE"},"MCP_POLICY_TLS_REJECTED"],
    [{status:502},"MCP_POLICY_REMOTE_FAILURE"],
    [{status:503},"MCP_POLICY_REMOTE_FAILURE"],
    [{code:"UNRELATED"},"MCP_POLICY_LIVE_FAILED"],
  ] as const)("maps a sanitized transport failure %#", (reason,code)=>{
    expect(classifyLiveMcpFailure(reason)).toBe(code);
  });

  it("never includes a message, token, URL, hostname or request body in its return value",()=>{
    const reason={
      code:"ECONNREFUSED",
      message:"Authorization: Bearer supersecret; private.host.example/mcp",
      request:{url:"https://private.host.example/mcp",headers:{Authorization:"Bearer supersecret"}},
    };
    const result=classifyLiveMcpFailure(reason);
    expect(result).toBe("MCP_POLICY_CONNECTION_REFUSED");
    expect(result).not.toMatch(/secret|host|example|Bearer|https/i);
    expect(classifyLiveMcpFailure(new Error("Authorization: Bearer supersecret")))
      .toBe("MCP_POLICY_LIVE_FAILED");
  });

  it("handles nested and circular causes in bounded time",()=>{
    const first:{cause?:unknown;code:string}={code:"UNRELATED"};
    const second:{cause?:unknown;code:string}={code:"ETIMEDOUT",cause:first};
    first.cause=second;
    expect(classifyLiveMcpFailure(first)).toBe("MCP_POLICY_LIVE_TIMEOUT");
    expect(classifyLiveMcpFailure({cause:{cause:{cause:{code:"ECONNREFUSED"}}}}))
      .toBe("MCP_POLICY_CONNECTION_REFUSED");
  });
});
