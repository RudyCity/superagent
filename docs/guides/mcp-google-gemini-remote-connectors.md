# SuperAgent MCP: Google Gemini Connector and Remote HTTP MCP

**Last verified:** 2026-10-14
**Status:** implementation and automated tests completed; real Gemini account-linking still requires an interactive test in Gemini.

## Two connection directions

SuperAgent can be used in two distinct ways:

1. **Gemini → SuperAgent:** Gemini connects to SuperAgent's public MCP endpoint. This uses SuperAgent's inbound HTTP MCP server and OAuth server.
2. **SuperAgent → remote MCP:** SuperAgent connects out to an HTTP MCP endpoint (for example, a Google-related connector that exposes a compatible MCP server). This uses the outgoing Streamable HTTP client. OAuth login is optional per server.

Fixing one direction does not automatically configure the other.

## A. Connect Gemini to SuperAgen

### 1. Build and restart the version containing the compatibility fix

From the SuperAgent repository:

~~~powershell
bun run build
~~~

Then fully restart the owning SuperAgent process so it loads the newly compiled JavaScript. Building does not hot-reload modules that have already been imported. Save or stop any task owned by that process before restarting it.

When launching a fresh process, the standard MCP-only tunnel flow is:

~~~tex
/muse tunnel start --mcp --mcp-port 9227 --mcp-auth oauth
~~~

The in-process tunnel restart command is useful for rotating/recreating the MCP tunnel after new code has been loaded, but it does not itself reload already-imported source modules:

~~~tex
/muse tunnel restart --mcp --mcp-port 9227 --mcp-auth oauth
~~~

Do not stop an MCP server owned by a different process. Use **/muse tunnel list** first to inspect the owner PID and ensure it has no task that must be preserved. OAuth mode prints a public endpoint and a one-time bootstrap approval code. Treat that code as a secret; it is displayed once and is not persisted.

### 2. Add the endpoint to Gemini

Use the complete public MCP endpoint printed by SuperAgent, including /mcp, for example:

~~~tex
https://<your-public-tunnel-host>/mcp
~~~

In Gemini's custom connected-app settings, add that URL and begin account linking. Follow the browser's SuperAgent OAuth consent page and enter the one-time bootstrap code shown when the OAuth tunnel was started. Approve only the scopes and tool access you intend to grant.

A successful endpoint check alone is not proof that account linking completed. The connection is complete only after OAuth authorization, token exchange, MCP initialization, and tool discovery succeed.

### 3. Diagnose a failed account-linking attemp

The server now records safe, structured stages in:

~~~tex
~/.superagent-r/mcp-oauth-audit.jsonl
~~~

The audit file logs only timestamp, process ID, a fixed stage name, HTTP method, status code, and optional duration. It does not log request bodies, URLs or query strings, client IDs, OAuth state, authorization codes, tokens, or bootstrap codes.

| Last recorded stage | What it means / what to inspect |
|---|---|
| **mcp.endpoint_probe** with 401 | The client reached the endpoint without an accepted credential. Each probe also records `authHeader` (`absent`, `bearer`, or `other`) and, when a Bearer value was presented, an irreversible `credentialHashPrefix` (first 12 hex characters of SHA-256). Use them to separate "client sent no token" from "client sent a token this owner never issued"; the credential itself is never logged. |
| **oauth.protected_resource_metadata** | The client found the protected-resource metadata. Check that it advertises the correct **/mcp** resource and authorization server. |
| **oauth.authorization_server_metadata** | Authorization-server discovery was reached. Check the advertised authorize, token and registration endpoints. |
| **oauth.client_registration** | The server received a dynamic client registration request. |
| **oauth.authorization_request** / **oauth.authorization_decision** | The OAuth authorization page was opened and/or approved. |
| **oauth.token_request** | The token endpoint was contacted. A successful status indicates the token endpoint returned success; it does not alone prove MCP initialization. |
| **mcp.initialize** | The authenticated MCP session initialization reached SuperAgent. |
| **mcp.tools_list** | The client requested tool discovery. |
| **mcp.tools_call** | The client called a tool. |

### 4. Tokens survive an owner restart

In OAuth mode the tunnel owner keeps issuer state in an issuer-scoped directory
under `~/.superagent-r/mcp-oauth/issuer-<hash>/`, protected with Windows DPAPI
(CurrentUser). Access and refresh tokens therefore stay valid when the owner
restarts **with the same public URL**, so connected clients do not have to be
re-authorized.

- A rotated public URL is a different issuer and gets a different directory; old
  tokens are not reused and the client must be pointed at the new URL.
- Client registrations, authorization codes, and tokens are persisted as hashes
  only; raw credentials are never written.
- On hosts without DPAPI, or when the issuer state directory cannot be loaded,
  the owner reports `OAuth state: in-memory (...)` in its startup output and
  falls back to the previous behavior. Re-authorize clients after every restart
  in that case.
- A **401 with `authHeader: "absent"`** immediately after `oauth.token_request`
  means the client never attached its token; a **401 with a repeated
  `credentialHashPrefix`** means it keeps replaying a token this owner no longer
  knows (typically cached against a previous issuer). Remove and re-add the
  client connection, then retry.

The MCP endpoint supports HEAD probing. An unauthenticated HEAD /mcp returns a 401 response with WWW-Authenticate and no body, which lets a client discover OAuth without allocating an MCP session. An authenticated HEAD returns 204 with no body and no session allocation. Both the root and path-specific RFC 9728 metadata routes are supported.

If Gemini still says “account linking required” and the audit file shows no requests at all, confirm that the custom app URL is correct, the tunnel is reachable, and your running SuperAgent process has loaded the current build. Google may also gate custom Connected Apps by account eligibility or region; this is separate from the local MCP implementation and must be confirmed in the Gemini UI for the account being tested.

## B. Connect SuperAgent to a remote HTTP MCP server

Remote connections support the MCP SDK's Streamable HTTP transport. Existing stdio entries remain supported.

### Preferred command

Inside an active SuperAgent chat:

~~~tex
/mcp add-http google-connector https://<remote-mcp-host>/mcp --oauth
~~~

Omit --oauth only when the remote server does not use OAuth (for example, when it accepts a configured bearer header).

### Equivalent model configuration

~~~json
{
  "mcpServers": {
    "google-connector": {
      "transport": "http",
      "url": "https://<remote-mcp-host>/mcp",
      "oauth": true
    }
  }
}
~~~

For OAuth-protected endpoints, SuperAgent uses the MCP SDK OAuth flow, opens the system browser, receives the callback on a loopback-only local listener, verifies the OAuth state, exchanges the authorization code, and reconnects to discover tools. The server remains in a “waiting for OAuth approval” state until the callback completes; it must not be reported as connected before discovery succeeds.

OAuth client information, refresh/access tokens, the PKCE verifier and discovery state are stored encrypted in:

~~~tex
~/.superagent-r/mcp-oauth-credentials.enc
~~~

If decryption fails, or an old unencrypted file is found, SuperAgent fails closed rather than silently using plaintext credentials. Back up this file only as an encrypted secret and keep the encryption key/config directory protected.

For a remote server that uses a static bearer token, put the token in an environment variable and refer to the variable by name in configuration. Do not put the token itself in model-config.json:

~~~json
{
  "mcpServers": {
    "internal-mcp": {
      "transport": "http",
      "url": "https://<remote-mcp-host>/mcp",
      "headersFromEnv": {
        "Authorization": "INTERNAL_MCP_BEARER"
      }
    }
  }
}
~~~

The environment variable must be present in the SuperAgent process environment. For an Authorization header, set the variable to the complete header value, for example `Bearer your-token-value`. When OAuth is enabled, do not configure a competing static Authorization header; the OAuth client must manage that header.

For non-interactive CLI configuration:

~~~powershell
superagent mcp add-http google-connector https://<remote-mcp-host>/mcp --oauth
superagent mcp lis
~~~

The standalone CLI writes configuration; restart SuperAgent or reload MCP connections in the active session to apply it.

### Troubleshooting outgoing OAuth

- **A browser opens but the connection remains pending:** complete or cancel the consent screen. On success the callback is state-checked and tools are discovered asynchronously. If it remains pending after callback, inspect the connection status and OAuth audit stages.
- **Loopback callback cannot bind:** another process may occupy the stable per-server callback port. Stop the conflicting process and retry. The callback listener binds only to 127.0.0.1.
- **401 without a browser:** set oauth to true for a server that supports the standard MCP OAuth flow, or configure headersFromEnv for a static bearer server.
- **OAuth metadata/DCR unsupported:** the remote endpoint must implement a compatible OAuth discovery/registration flow. This implementation does not bypass a provider's own account permissions or consent requirements.
- **A tool isn't available:** use /mcp list to confirm the remote connection is connected and that the namespaced tool appears. Tools are registered into SuperAgent's configured toolsets only after remote discovery succeeds.

## Security notes

- Treat public MCP tunnel URLs, OAuth bootstrap codes, bearer tokens, and encrypted credential storage as security-sensitive.
- Keep the MCP server in safe/read-only mode unless write/command capabilities are intentionally needed and the additional risk is understood.
- Do not paste raw OAuth URLs, tokens, PKCE values or unredacted browser/network traces into issue reports.
- The automated local tests cover protocol behavior, not Google account eligibility or an actual Gemini UI sign-in. Before declaring Gemini linking fixed for a particular account, perform the real flow and confirm that mcp.initialize and mcp.tools_list are recorded.
