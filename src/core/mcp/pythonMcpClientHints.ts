/**
 * Copy-ready Python MCP client hints for an already-running SuperAgent MCP
 * endpoint. Display only: no credentials, sessions, or tunnels are created.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Dedicated GitHub branch with the installable Python package at its root. */
export const PYTHON_MCP_GITHUB_REF = "python-mcp-client";
export const PYTHON_MCP_GITHUB_URL = `https://github.com/RudyCity/superagent/tree/${PYTHON_MCP_GITHUB_REF}`;
export const PYTHON_MCP_GIT_INSTALL = `git+https://github.com/RudyCity/superagent.git@${PYTHON_MCP_GITHUB_REF}`;

export interface PythonMcpClientEndpoint {
  publicUrl: string;
  localUrl: string;
  authMode: "oauth" | "static-bearer";
}

function quotePowerShell(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function bundledPythonProject(): string | null {
  const directory = fileURLToPath(new URL("../../../integrations/python-mcp-client/", import.meta.url));
  return fs.existsSync(path.join(directory, "pyproject.toml")) ? directory : null;
}

export function formatPythonMcpClientHints(
  endpoint: PythonMcpClientEndpoint,
  projectDirectory: string | null = bundledPythonProject(),
): string[] {
  // An opaque tunnel ID such as openai-tunnel://... is not an HTTP URL.
  // Fall back to loopback only when no actual public HTTPS MCP URL exists.
  function validEndpoint(value: string, publicOnly: boolean): string | null {
    try {
      const url = new URL(value);
      if (publicOnly ? url.protocol !== "https:" : url.protocol !== "http:") return null;
      if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
      if (!url.pathname.endsWith("/mcp")) return null;
      if (!publicOnly && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
      return url.href;
    } catch {
      return null;
    }
  }
  const publicHttpsMcp = validEndpoint(endpoint.publicUrl, true);
  const usableUrl = publicHttpsMcp || validEndpoint(endpoint.localUrl, false);
  if (!usableUrl) return [];

  const auth = endpoint.authMode === "oauth" ? "oauth" : "bearer";
  const command = projectDirectory
    ? `uv run --project ${quotePowerShell(projectDirectory)} superagent-mcp-python`
    : "superagent-mcp-python";
  const setup = `$env:SUPERAGENT_MCP_URL=${quotePowerShell(usableUrl)}; $env:SUPERAGENT_MCP_AUTH=${quotePowerShell(auth)}; ${command} ${auth === "oauth" ? "login" : "doctor"}`;

  return [
    "",
    "Python MCP Client (GitHub):",
    `  Package URL : ${PYTHON_MCP_GITHUB_URL}`,
    `  Install PS  : uv tool install ${quotePowerShell(PYTHON_MCP_GIT_INSTALL)}`,
    "  Remote package installation requires GitHub access and uv on the client machine.",
    "",
    "Python MCP Client (copy/paste):",
    `  MCP URL     : ${usableUrl}${publicHttpsMcp ? "" : " (local machine only)"}`,
    `  One-shot PS : ${setup}`,
    `  Stdio bridge: ${command} serve`,
    ...(projectDirectory ? [] : ["  Install first: uv tool install ./integrations/python-mcp-client (from the repository root)"]),
    ...(auth === "bearer"
      ? ["  Before one-shot: set SUPERAGENT_MCP_TOKEN privately using the server owner's one-time token; not included in this output."]
      : ["  OAuth: approve in the browser using the separate one-time bootstrap code; it is not embedded in commands."]),
    ...(!publicHttpsMcp
      ? ["  No public HTTPS /mcp endpoint advertised; the private tunnel ID is not a Python MCP URL."]
      : []),
  ];
}
