# SuperAgent Python MCP Client

Installable Python MCP client and local stdio bridge to SuperAgent's existing remote MCP server. It forwards live tool names, input schemas, results, and error flags rather than defining a second tool registry.

## GitHub package

GitHub source: https://github.com/RudyCity/superagent/tree/python-mcp-client

One-shot Python package installation on a machine with `uv` and access to the repository:

```powershell
uv tool install 'git+https://github.com/RudyCity/superagent.git@python-mcp-client'
```

The GitHub source URL points to a dedicated branch containing **this Python package at the repository root**, not the temporary MCP tunnel endpoint. Inside the full SuperAgent repository, its original source remains under `integrations/python-mcp-client/`.

## Install

Requires Python 3.11+ and a reachable Streamable HTTP MCP endpoint. Install from the SuperAgent repository root:

```bash
uv tool install ./integrations/python-mcp-client
# Or, without a global installation: uv run --project integrations/python-mcp-client superagent-mcp-python doctor
# Or: python -m pip install -e ./integrations/python-mcp-client
```

The Python module is independent of the SuperAgent TypeScript runtime and never starts or restarts any SuperAgent service. Start the endpoint using the existing SuperAgent owner:

```bash
superagent mcp tunnel start --provider cloudflare --mcp-auth oauth
superagent mcp tunnel status
```

The successful tunnel startup log and `superagent mcp tunnel status` (or `/mcp tunnel status`) show the GitHub Python package URL and one-shot installation command first, followed by a separate `Python MCP Client (copy/paste)` section with the live MCP endpoint URL, a **PowerShell login command** that uses the bundled local Python project with `uv run`, and the subsequent `stdio bridge` command. You can copy the entire one-shot line without manually replacing `YOUR-HOST`. It does not embed OAuth bootstrap codes or Bearer tokens. The user must still grant OAuth consent in the browser. Cloudflare quick-tunnel hostnames can change after a restart, so always copy the latest URL. OpenAI private tunnel IDs are not MCP HTTP URLs; when no public HTTPS `/mcp` URL is available, only a local-loopback URL is shown with an explicit warning.

## OAuth PKCE (recommended)

```powershell
$env:SUPERAGENT_MCP_URL = "https://YOUR-HOST.trycloudflare.com/mcp"
$env:SUPERAGENT_MCP_AUTH = "oauth"
$env:SUPERAGENT_MCP_SCOPE = "mcp:tools"
superagent-mcp-python login
superagent-mcp-python doctor
superagent-mcp-python list
superagent-mcp-python call superagent_get_workspace --args "{}"
```

The first login opens an OAuth consent page. Enter the one-time bootstrap approval code **from the SuperAgent server owner's terminal** and approve. The local client receives the redirect at a temporary 127.0.0.1 callback address.

Tokens and dynamic client registration details are stored in a per-endpoint-and-scope file in the current user's `~/.superagent-r/python-mcp-client/` directory, never in the repository. Restrict that directory to your Windows user account or equivalent; on Unix-like systems the client requests private file permissions. Never share or commit its files. Refresh is automatic where supported; changing the endpoint or server's OAuth ownership may require login again.

Read-only `mcp:tools` is the default scope. Opt in to `mcp:tools mcp:tools:write` only for trusted write workflows with explicit owner permission; admin additionally requires write. Actual tool access also depends on the SuperAgent server exposure policy and project grants.

## Project grants and write access

The MCP tunnel startup and status output includes an agent-ready access workflow.
An OAuth login with `mcp:tools:write` lets a trusted client use exposed write tools,
but **does not** grant access to every registered project. Project grants are
bound to the authenticated MCP identity and selected by a stable `projectId`.

Choose the least privilege needed. The project registry and grant tools require
`mcp:tools:admin` **in addition** to `mcp:tools:write` when using OAuth.
Only the owner should approve these credentials in the browser.

```powershell
$env:SUPERAGENT_MCP_SCOPE = "mcp:tools mcp:tools:write mcp:tools:admin"
superagent-mcp-python login
superagent-mcp-python call superagent_list_projects --args '{}'
superagent-mcp-python call superagent_list_project_access --args '{}'
```

To grant the connected identity access to a particular project, first find its
actual `projectId` from the project list. With explicit owner consent, the
server must expose dangerous tools and have **Full YOLO enabled locally**:

```powershell
superagent-mcp-python call superagent_grant_project_access --args '{"projectId":"YOUR_PROJECT_ID","capabilities":["read","write"]}'
superagent-mcp-python call superagent_list_project_access --args '{}'
```

`superagent_grant_project_access` **replaces** the current capabilities for
the same identity and project. Include every required capability (`read`,
`write`, `execute`, `git`, `worktree`, `planning`, `chain`); do not blindly
grant all of them. The agent should then call tools with this exact
`projectId`, inspect the tool schema, and verify each result.

Project grants are tied to the authenticated OAuth **client ID**. The Python
client caches registrations and tokens separately per endpoint **and scope**.
Changing the requested scope may create a different client ID, so the earlier
grant will **not** automatically transfer to a new write-only login. Continue
using the owner-approved identity that actually received the grant, and never
assume a new authorization is an automatic downgrade that preserves access.
No scope or grant bypasses protected paths or the server policy. Never
forward owner approval codes, tokens, or cached credential files to agents.

---
## Existing static Bearer tunnel

For a SuperAgent tunnel started in `static-bearer` mode:

```powershell
$env:SUPERAGENT_MCP_AUTH = "bearer"
$env:SUPERAGENT_MCP_TOKEN = "<temporary-token-from-owner-terminal>"
python -m superagent_mcp_client doctor
```

Supply the token through a private environment or secret store, **never in the URL or a shared host configuration**. A token printed once by SuperAgent cannot be retrieved from status.

## Local stdio MCP configuration

After `login` succeeds, add a local subprocess to a host that supports stdio MCP. Resolve `python` to the Python environment where the module was installed (for `uv tool`, use its generated `superagent-mcp-python` executable instead).

```json
{
  "mcpServers": {
    "superagent": {
      "command": "superagent-mcp-python",
      "args": ["serve"],
      "env": {
        "SUPERAGENT_MCP_URL": "https://YOUR-HOST.trycloudflare.com/mcp",
        "SUPERAGENT_MCP_AUTH": "oauth",
        "SUPERAGENT_MCP_SCOPE": "mcp:tools"
      }
    }
  }
}
```

The stdio bridge must run on a computer with Python and network access to the endpoint. No secrets are written to stdout. Authentication must be initialized via `login` before starting the stdio bridge; the OAuth access token can refresh in the background when valid refresh credentials exist. An MCP tool call is sent once and is not automatically replayed across connection failures.

**Z.ai and similar services:** different interfaces expose different MCP host capabilities. If the service supports remote HTTPS Streamable HTTP connectors, connect the public SuperAgent `/mcp` endpoint directly and complete OAuth in its interface; no Python proxy is needed. If it can launch local MCP commands, use the stdio example. If the service only exposes an online chat page with no MCP extension or local code execution, it cannot run this Python module directly. The package does not create or require an API key for Z.ai.

## Use from a Python application

```python
import asyncio
from superagent_mcp_client.client import connect
from superagent_mcp_client.config import Config

async def main():
    async with connect(Config.from_env()) as client:
        tools = await client.list_tools()
        print([tool.name for tool in tools.tools])
        result = await client.session.call_tool("superagent_get_workspace", {})
        print(result.model_dump(mode="json"))

asyncio.run(main())
```

`doctor` makes an authenticated MCP connection and lists tools; it does not merely check whether a port is open.

## Troubleshooting

- OAuth 401 or missing consent: rerun `login` with the current URL and approve from the server-owner terminal.
- Endpoint unreachable: check `superagent mcp tunnel status` and the owning process; do not start a second permanent SuperAgent runtime to fix it.
- Tool missing: check live `list` output and server tool/project policy.
- Host without local stdio support: use its direct remote MCP connector where available.
