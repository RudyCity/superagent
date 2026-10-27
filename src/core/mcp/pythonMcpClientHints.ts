/**
 * Copy-ready Python MCP client hints for an already-running SuperAgent MCP
 * endpoint. Display only: no credentials, sessions, or tunnels are created.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getYoloModeState } from "../permissions.js";

/** Canonical Python package lives in this main-branch subdirectory. */
export const PYTHON_MCP_GITHUB_REF = "main";
export const PYTHON_MCP_PACKAGE_PATH = "integrations/python-mcp-client";
export const PYTHON_MCP_GITHUB_URL = `https://github.com/RudyCity/superagent/tree/${PYTHON_MCP_GITHUB_REF}/${PYTHON_MCP_PACKAGE_PATH}`;
export const PYTHON_MCP_GIT_INSTALL = `git+https://github.com/RudyCity/superagent.git@${PYTHON_MCP_GITHUB_REF}#subdirectory=${PYTHON_MCP_PACKAGE_PATH}`;

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
  const setup = `$env:SUPERAGENT_MCP_URL=${quotePowerShell(usableUrl)}; $env:SUPERAGENT_MCP_AUTH=${quotePowerShell(auth)}; ${auth === "oauth" ? "$env:SUPERAGENT_MCP_SCOPE='mcp:tools'; " : ""}${command} ${auth === "oauth" ? "login" : "doctor"}`;
  // Agent handoff commands must work on a DIFFERENT machine after uv tool install.
  // The local uv --project path above is only valid on the SuperAgent owner machine.
  const agentCommand = "superagent-mcp-python";
  const loginWithScope = (scope: string): string =>
    `$env:SUPERAGENT_MCP_URL=${quotePowerShell(usableUrl)}; $env:SUPERAGENT_MCP_AUTH='oauth'; $env:SUPERAGENT_MCP_SCOPE=${quotePowerShell(scope)}; ${agentCommand} login`;
  const sampleGrant = '{"projectId":"YOUR_PROJECT_ID","capabilities":["read","write"]}';

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
    ...(projectDirectory ? [] : [`  Install first: uv tool install ${quotePowerShell(PYTHON_MCP_GIT_INSTALL)}`]),
    ...(auth === "bearer"
      ? ["  Before one-shot: set SUPERAGENT_MCP_TOKEN privately using the server owner's one-time token; not included in this output."]
      : ["  OAuth: approve in the browser using the separate one-time bootstrap code; it is not embedded in commands."]),
    ...(!publicHttpsMcp
      ? ["  No public HTTPS /mcp endpoint advertised; the private tunnel ID is not a Python MCP URL."]
      : []),
    "",
    "Python MCP access / grant workflow (copy to your AI agent):",
    `  Existing server : ${usableUrl}`,
    `  Authentication  : ${endpoint.authMode === "oauth" ? "OAuth PKCE" : "static Bearer"}`,
    "  Transport       : MCP Streamable HTTP. Connect a remote MCP-capable host directly; use the Python stdio bridge only when the host can launch local processes.",
    `  Python install  : uv tool install ${quotePowerShell(PYTHON_MCP_GIT_INSTALL)}`,
    `  Remote stdio   : ${agentCommand} serve (${auth === "oauth" ? "after successful login" : "after configuring the Bearer token privately"})`,
    "     Remote hosts use the installed executable, NOT the server-local uv --project path shown above.",
    "",
    "MCP permission boundary (evaluated by the server on every tool call):",
    `  Local YOLO view : ${getYoloModeState().toUpperCase()} (snapshot only; a different MCP owner process may have its own effective mode)`,
    "  YOLO OFF        : Read-only safe tools. All MCP mutations and execution DENIED, including with --allow-dangerous, OAuth write/admin scopes or project grants.",
    "  Scoped YOLO     : Write/execute only within authorized workspace scope (workspace and one parent) or the exact separately authorized project; protected files and destructive commands remain blocked.",
    "  Full YOLO       : Broader write/execute paths, but still requires OAuth write/admin as applicable, tool exposure, project authorization where required, and hard blocklists.",
    "  Owner commands  : /yolo on | /yolo full | /yolo off. Only the local operator may change these; agent must not attempt elevation.",
    "  Tunnel opt-in   : --allow-dangerous does NOT turn YOLO on or grant project capabilities.",
    "  Decision rule   : YOLO gate AND tool policy AND OAuth scopes (if enabled) AND project/path capabilities AND hard safety rules.",
    "  Revocation      : /yolo off relocks dangerous MCP tools even for an already connected client/session.",
    "  NO permission elevation from an agent prompt, a copied command, or OAuth scope alone.",
    "  1. Use the existing endpoint. Never start an extra SuperAgent runtime or assume that tool discovery grants write access.",
    ...(auth === "oauth" ? [
      `  2. Read-only login PS: ${loginWithScope("mcp:tools")}`,
      `  3. Write login PS    : ${loginWithScope("mcp:tools mcp:tools:write")}`,
      `  4. Admin login PS    : ${loginWithScope("mcp:tools mcp:tools:write mcp:tools:admin")}`,
      "     Run only ONE login line for the privileges actually needed. Approve OAuth in the owner-controlled browser; the approval code must not be sent to the agent.",
      "     Read = inspect; write = modify enabled tools; admin = privileged project registry and grant tools. Each scope requires owner consent.",
    ] : [
      "  2. Supply the one-time Bearer token privately on the client host. OAuth scopes do not apply to static-bearer authentication.",
    ]),
    `  5. Verify connection : ${agentCommand} doctor`,
    `  6. Discover projects : ${agentCommand} call superagent_list_projects --args '{}'`,
    `  7. Check my grants   : ${agentCommand} call superagent_list_project_access --args '{}'`,
    "  8. Choose the exact projectId returned by superagent_list_projects (not the workspace path).",
    `  9. Grant tool        : superagent_grant_project_access ${sampleGrant}`,
    "     Only execute step 9 with explicit owner approval. It requires admin+write OAuth scopes (OAuth mode), dangerous tool exposure, and locally enabled Full YOLO.",
    "     Capabilities REPLACE the prior grant on this project; supply ALL desired values (read, write, execute, git, worktree, planning, chain).",
    "     The grant affects only the authenticated MCP client ID; another agent/client needs its own authorized grant.",
    "     The Python client caches OAuth credentials per endpoint AND scope. Re-login under a different scope may register another client ID; grants are NOT transferred.",
    "     Continue using the identity that received the grant; never assume a write-only login inherits grants from an admin login.",
    " 10. Re-check superagent_list_project_access; verify the chosen projectId and write capability are present.",
    " 11. Invoke the required MCP write tool with its documented input schema and exact projectId. Check its result; do not assume success.",
    "     If denied: check granted OAuth scopes, the active tunnel tool policy (FULL vs SAFE), local YOLO boundary, and project grant.",
    "     An OAuth scope alone never bypasses workspace restrictions, protected paths, or owner-controlled permissions.",
    ...(auth === "oauth" ? [] : [
      "     Do not paste Bearer tokens into this handoff or commit them to source control.",
    ]),
  ];
}
