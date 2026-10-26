# SuperAgent Python MCP Client

Installable Python MCP client and local stdio bridge to SuperAgent's existing remote MCP server. It forwards live tool names, input schemas, results, and error flags rather than defining a second tool registry.

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

Use the actual public HTTPS URL ending in `/mcp` from status. Cloudflare quick-tunnel hostnames can change after a restart.

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
