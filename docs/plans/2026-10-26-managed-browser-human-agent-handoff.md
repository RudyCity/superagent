# Native managed browser human/agent handoff

A T-Line-owned Chrome CDP target can be held by a human or controlled by an authorized agent. `POST /api/browser/managed/control` is a locally authenticated desktop endpoint, not a public control API. A request is validated against a currently registered managed target with matching fingerprint and live page; a coordinator lock serializes the hold with Core CDP writes.

While a human hold exists, `withCdpTargetWrite` fails closed before invoking agent operations. Reads do not require write privileges. `mode: "agent"` releases the hold only for the same native-verified Chrome generation. No agent credentials are issued to the desktop. An external process connecting straight to an unauthenticated Chrome debugging port bypasses this coordinator, so CDP must remain local and protected.

Test: `bun test tests/managedBrowserControl.test.ts`. Packaged UI and real agent concurrency acceptance is not yet certified. No CAPTCHA bypass is attempted.
