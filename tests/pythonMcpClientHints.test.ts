import { describe, expect, it } from "vitest";
import { formatPythonMcpClientHints, PYTHON_MCP_GITHUB_URL, PYTHON_MCP_GIT_INSTALL } from "../src/core/mcp/pythonMcpClientHints.js";

describe("MCP tunnel Python client copy-ready instructions", () => {
  const oauth = {
    publicUrl: "https://example.trycloudflare.com/mcp",
    localUrl: "http://127.0.0.1:9227/mcp",
    authMode: "oauth" as const,
  };

  it("prints a public MCP URL and a complete PowerShell one-shot setup", () => {
    const lines = formatPythonMcpClientHints(oauth, "D:\\Projects\\SuperAgent Workspace\\integrations\\python-mcp-client");
    const output = lines.join("\n");
    expect(output).toContain("MCP URL     : https://example.trycloudflare.com/mcp");
    expect(PYTHON_MCP_GITHUB_URL).toBe("https://github.com/RudyCity/superagent/tree/python-mcp-client");
    expect(PYTHON_MCP_GIT_INSTALL).toBe("git+https://github.com/RudyCity/superagent.git@python-mcp-client");
    expect(output).toContain(`Package URL : ${PYTHON_MCP_GITHUB_URL}`);
    expect(output).toContain(`Install PS  : uv tool install '${PYTHON_MCP_GIT_INSTALL}'`);
    expect(output.indexOf("Package URL")).toBeLessThan(output.indexOf("MCP URL"));
    expect(output).toContain("$env:SUPERAGENT_MCP_URL='https://example.trycloudflare.com/mcp'");
    expect(output).toContain("$env:SUPERAGENT_MCP_AUTH='oauth'");
    expect(output).toContain("uv run --project 'D:\\Projects\\SuperAgent Workspace\\integrations\\python-mcp-client' superagent-mcp-python login");
    expect(output).toContain("Stdio bridge:");
    expect(output).toContain("superagent-mcp-python serve");
    expect(output).not.toContain("http://127.0.0.1:9227/mcp");
  });

  it("escapes PowerShell single quotes in package paths", () => {
    const output = formatPythonMcpClientHints(oauth, "D:\\O'Neil Projects\\python").join("\n");
    expect(output).toContain("uv run --project 'D:\\O''Neil Projects\\python'");
  });

  it("never embeds bootstrap secrets or bearer tokens in generated command", () => {
    const output = formatPythonMcpClientHints(
      { ...oauth, authMode: "static-bearer" },
      null,
    ).join("\n");
    expect(output).toContain("$env:SUPERAGENT_MCP_AUTH='bearer'");
    expect(output).toContain("superagent-mcp-python doctor");
    expect(output).toContain("set SUPERAGENT_MCP_TOKEN privately");
    expect(output).not.toContain("SUPERAGENT_MCP_TOKEN=");
    expect(output).not.toContain("bootstrap approval code");
  });

  it("uses loopback for an opaque private tunnel ID and marks it as local-only", () => {
    const output = formatPythonMcpClientHints({
      publicUrl: "openai-tunnel://tunnel_0123456789abcdef",
      localUrl: "http://127.0.0.1:9227/mcp",
      authMode: "oauth",
    }, null).join("\n");
    expect(output).toContain("MCP URL     : http://127.0.0.1:9227/mcp (local machine only)");
    expect(output).toContain("No public HTTPS /mcp endpoint advertised");
    expect(output).not.toContain("openai-tunnel://");
  });

  it("rejects unsafe endpoints and credentials in URLs rather than copying them", () => {
    const result = formatPythonMcpClientHints({
      publicUrl: "https://user:password@example.com/mcp",
      localUrl: "http://external-host.example.com/mcp",
      authMode: "oauth",
    }, null);
    expect(result).toEqual([]);
    expect(formatPythonMcpClientHints({
      ...oauth, publicUrl: "https://example.com/mcp?token=secret",
    }, null).join("\n")).not.toContain("secret");
  });

  it("allows the already installed local executable without a repository folder", () => {
    const output = formatPythonMcpClientHints(oauth, null).join("\n");
    expect(output).toContain("superagent-mcp-python login");
    expect(output).toContain("Install first: uv tool install");
  });

  it("explains OAuth write/admin consent and project grants as separate steps", () => {
    const output = formatPythonMcpClientHints(oauth, null).join("\n");
    expect(output).toContain("$env:SUPERAGENT_MCP_SCOPE='mcp:tools'");
    expect(output).toContain("$env:SUPERAGENT_MCP_SCOPE='mcp:tools mcp:tools:write'");
    expect(output).toContain("$env:SUPERAGENT_MCP_SCOPE='mcp:tools mcp:tools:write mcp:tools:admin'");
    expect(output).toContain("superagent_list_projects");
    expect(output).toContain("superagent_list_project_access");
    expect(output).toContain('superagent_grant_project_access {"projectId":"YOUR_PROJECT_ID","capabilities":["read","write"]}');
    expect(output).toContain("locally enabled Full YOLO");
    expect(output).toContain("Capabilities REPLACE the prior grant");
    expect(output).toContain("another agent/client needs its own");
    expect(output).toContain("grants are NOT transferred");
    expect(output).toContain("never assume a write-only login inherits grants");
    expect(output).toContain("Connect a remote MCP-capable host directly");
    expect(output).toContain("Remote stdio   : superagent-mcp-python serve");
    expect(output).toContain("server-local uv --project path");
    expect(output).toContain("MCP permission boundary");
    expect(output).toContain("YOLO OFF        : Read-only safe tools");
    expect(output).toContain("Scoped YOLO     : Write/execute only within authorized workspace scope");
    expect(output).toContain("Full YOLO       : Broader write/execute paths");
    expect(output).toContain("--allow-dangerous does NOT turn YOLO on");
    expect(output).toContain("/yolo off relocks dangerous MCP tools");
    expect(output).toContain(`Install first: uv tool install '${PYTHON_MCP_GIT_INSTALL}'`);
  });

  it("does not suggest OAuth login commands for static Bearer connections", () => {
    const output = formatPythonMcpClientHints({ ...oauth, authMode: "static-bearer" }, null).join("\n");
    expect(output).not.toContain("Read-only login PS:");
    expect(output).not.toContain("Write login PS");
    expect(output).not.toContain("Admin login PS");
    expect(output).toContain("OAuth scopes do not apply to static-bearer authentication");
    expect(output).not.toContain("SUPERAGENT_MCP_TOKEN=");
  });
});
