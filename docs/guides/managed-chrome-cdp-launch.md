# Managed Chrome CDP — attended launch

SuperAgent supports two independent Chrome transports:

- **Managed CDP:** a dedicated Chrome/Chromium process with a localhost remote
  debugging port and an isolated user-data directory, owned by the
  `BrowserProcessManager`.
- **Delegate-CDP:** an already-open Chrome profile paired using the Chrome
  Delegate extension; it needs no remote-debugging port.

Do not silently migrate a Delegate profile into Managed CDP, and do not close
a personal Chrome window in order to enable remote debugging.

## Explicit launch through an authorized SuperAgent tool

```json
{
  "name": "launch_chrome_profile",
  "arguments": {
    "remoteDebuggingPort": 9222,
    "profileName": "Default",
    "mode": "headed",
    "isolated": true,
    "url": "https://tab.ub.ac.id/"
  }
}
```

The matching MCP tool is `superagent_launch_chrome`. Launch is a **dangerous**
action requiring a separately authorized execution context. Host permanent file
policy may still refuse the request even after an MCP Connection Controls grant.
Do not bypass that host policy using an arbitrary shell or alternate transport.

The launch preflight now validates:

1. TCP port must be an integer in `1024..65535`; omitted port defaults to `9222`.
2. Per-port isolated data dir: `~/.superagent-r/chrome-debug-profile` for
   `9222`, otherwise `chrome-debug-profile-<port>`.
3. Only `Default` and `Profile N` directories within the **isolated**
   profile are accepted. A personal Chrome default data directory is rejected.
4. Initial URL must be `http://`, `https://` without embedded credentials,
   or `about:blank`. `file://`, `javascript:`, and `chrome://` are denied.
5. Binds CDP to `127.0.0.1` only. Does not enable fake camera/microphone or
   unattended screen sharing by default.

### Repeated launch and port collisions

The existing manager checks PID start identity and the CDP browser fingerprint
before reusing a process. Repeating a request with incompatible mode, profile,
directory or startup URL fails; it will not silently change an existing tab.
A foreign listener on the requested port is rejected with
`MANAGED_CDP_PORT_OCCUPIED`. It is never killed or adopted.

When a launch succeeds, the response contains the actual PID, port and
`reused` state. Use that explicit port for subsequent commands:

```json
{
  "name": "superagent_chrome_cdp",
  "arguments": {
    "command": "transport_status",
    "transport": "managed",
    "debug_port": 9222
  }
}
```

```json
{
  "name": "superagent_chrome_cdp",
  "arguments": {
    "command": "list_targets",
    "transport": "managed",
    "debug_port": 9222
  }
}
```

Do **not** count a listening TCP socket as Chrome readiness. Check
`/json/version` and the browser endpoint identity as well. If no healthy
endpoint is present, report the failure rather than claiming launch success.

### Local standalone Windows fallback

`scripts/chrome-debug.bat` is an attended fallback for port `9222`, not
a supervised browser. It now avoids the insecure `--remote-allow-origins=*`
and unattended screen-capture flags, and refuses launch when the port is in
use. For lifecycle ownership, status and safe stop, prefer the supervised
`launch_chrome_profile` tool.

## Limits and release checklist

The code alone does **not** enable a native Tray Launch button or override
ChatGPT/Gemini's permanent file policy. For full native one-click launch, a
separate operator-only Tray-to-Core control route with explicit consent and
ownership-verified stop is still needed.

Before marking the feature Runtime Verified, build and restart the local Core,
perform an attended launch on the actual target OS, check `/json/version`,
list a real HTTP(S) tab, repeat the launch to verify reuse, then test a foreign
occupied port. Never kill unrelated Chrome processes.
