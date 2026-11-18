# CDP with permanent file policy v2

## Why an MCP approval is not enough

The human operator's **MCP Connection Controls → Execute** approval authorizes MCP
execution. It does not override the host's permanent file-access rules.
Browser automation must still follow the registered tool/capability policy.

There are two independent browser transports:

- **Managed**: connects to a Chrome debugging listener on a selected loopback port
  (default 127.0.0.1:9222). A normal Chrome window does not necessarily expose
  this listener.
- **Delegate**: uses an already paired Chrome Delegate extension through Core.
  No managed debugging listener is needed. If more than one profile is paired,
  choose its exact `delegateClientId`.

## Safe, read-only diagnosis (file-policy v2)

```json
{"name":"superagent_chrome_cdp","arguments":{"command":"transport_status","transport":"managed"}}
```

The response includes `reachable`, `port`, `portSource`, and, when the port
is down, a bounded `failureCode` such as `CDP_ENDPOINT_REFUSED`. Nothing is
launched or restarted. If the listener is unavailable, use the actual explicit
`debug_port` or an already connected Delegate profile.

First list the available Delegate profiles:

```json
{"name":"superagent_delegate_read_chat","arguments":{"connections":true}}
```

Then inspect a selected profile (substitute a real returned ID):

```json
{"name":"superagent_chrome_cdp","arguments":{"command":"transport_status","transport":"delegate","delegateClientId":"YOUR_REAL_PROFILE_ID"}}
```

```json
{"name":"superagent_chrome_cdp","arguments":{"command":"list_targets","transport":"delegate","delegateClientId":"YOUR_REAL_PROFILE_ID"}}
```

The certified inventory reports only HTTP(S) tabs visible to that MCP principal.
It drops `file://`, `chrome://`, extension and other non-web tabs, strips URL
userinfo, query strings and fragments, bounds titles/results, and does not expose
another principal's claimed tab. There is no tab attachment or DOM access.

## Still intentionally restricted

Under permanent file-policy v2, `navigate`, `evaluate`, `read_page`, `screenshot`,
`upload_file`, file URL browsing, and process launches **remain denied** through
this narrow certification. A page title/URL is not a general permission to read
page content. The MCP connection grant, trusted Core forwarding and principal
session checks remain independent security gates. Do not disable permanent
file policy or substitute chat YOLO for a human approval.

Changes in GitHub do not update a currently running local Core by themselves.
Pull/update the existing working copy without discarding local edits, rebuild,
restart under the Core supervisor, reconnect the MCP host if necessary, and
repeat the read-only commands above. Verify runtime before claiming success.
