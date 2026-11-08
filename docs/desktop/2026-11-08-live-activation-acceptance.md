# Native Desktop UI: live MCP activation gate

The Windows native GUI and isolated HTTP MCP end-to-end suites pass. The shared long-lived MCP service must separately advertise the desktop tool and successfully execute its read-only probe before live activation can be claimed.

The live acceptance command never reloads, restarts, drains, or modifies a service. It requires explicit opt-in and an existing OAuth access token authorized to discover and invoke the dangerous tool. Put credentials in the process environment, not command arguments, commit messages, or logs.

Required environment variables:

- SUPERAGENT_DESKTOP_UI_LIVE_ACCEPTANCE=1
- SUPERAGENT_DESKTOP_MCP_URL=https://verified-existing-host.example/mcp
- SUPERAGENT_DESKTOP_MCP_ACCESS_TOKEN (operator-authorized OAuth bearer token)
- SUPERAGENT_DESKTOP_MCP_PORT=9227 (optional local owner-management port)

Run: bun scripts/desktop-ui-mcp-live-verify.ts

The command checks independent read-only owner snapshots (status and doctor), matching owner PID, backend generation, public URL, and backend health. It then uses a real public MCP SDK client over HTTP, runs tools/list, demands superagent_desktop_ui, and executes only probe. It reports PASS only after every gate succeeds; it does not print the access token or any screenshot.

On 2026-11-08 the shared owner had nine MCP sessions and at least one in-flight request. One doctor response was degraded while other snapshots said active, and later doctor recovered. No live reload occurred. This script is a post-activation verification gate, not permission to mutate the shared service. Before URL-stable backend reload, verify owner identity, active requests, source checkout stability, and operator approval.

The isolated HTTP acceptance is enabled by SUPERAGENT_DESKTOP_UI_LIVE_MCP_E2E=1 and runs with bun --bun x vitest run tests/desktop-ui-live-mcp. It does not certify the shared owner. macOS and Ubuntu require separate native host tests.

## Reproducible acceptance scheduling

Run the normal unit and MCP transport suites independently of native input checks. Tests that create foreground WinForms fixtures compete for the same desktop, even when they run in separate files. The input E2E is intentionally fail-closed on a focus loss; do not reinterpret TARGET_NOT_ACTIVE as a successful click.

On a dedicated, idle Windows desktop, run the combined host suite with Vitest file parallelism disabled:

SUPERAGENT_DESKTOP_UI_LIVE_MCP_E2E=1 SUPERAGENT_DESKTOP_UI_READONLY_E2E=1 SUPERAGENT_DESKTOP_UI_NATIVE_E2E=1 bun --bun x vitest run tests/desktop-ui tests/desktop-ui-integration tests/desktop-ui-activation tests/desktop-ui-live-mcp tests/desktop-ui-windows-e2e --no-file-parallelism

If another application takes foreground focus, the host input test must fail; repeat acceptance only after making the test desktop exclusive, never by disabling the foreground security check.
