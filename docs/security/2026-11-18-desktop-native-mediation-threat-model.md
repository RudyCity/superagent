# Native desktop mediation: threat model and acceptance gate

Date: 2026-11-18
Status: Design-only. **No general desktop content certification or permission bypass.**
Source: permissions-tools remediation master plan.

## Boundaries
- MCP caller: a credential-bound OAuth principal; client names and window titles are untrusted labels, never authorization.
- Core: OAuth scopes, connection Execute, project capabilities, host permanent-file-policy, schema and native operator consent remain independent AND checks at execution.
- Native Tray: OS process birth and signed executable identity, owner lease and compiled WebView resource digest must be verified independently of a responsive HTTP endpoint.
- Third-party app: window content, screenshots, UIA/AX/AT-SPI elements, browser tabs, clipboard, PDFs, terminals and file pickers may expose protected host files even if no file is explicitly opened by the MCP tool.

## Threats and negative security gates

| Threat | Required safeguard | Negative acceptance |
| --- | --- | --- |
| Protected file displayed inside app | No general screenshot, semantic window text or input under v2 until mediated provenance is proven | Protected PDF/browser tab denied without returning pixels, paths or body |
| Forged title, HWND or recycled PID | Verify executable signer/digest, process birth, HWND, owner lease and semantic revision for every request | Same title or recycled PID fails |
| Revoked grants during preflight | Re-evaluate OAuth, principal capabilities and file policy at dispatch; short-lived nonce | Revocation between preflight and input denies input |
| Different OAuth client using same tunnel URL | Bind each receipt and action to one verified principal and owner generation | Another credential cannot reuse an approval or a read receipt |
| Corrupt host policy | Default deny and redact file paths; no repair by approval spam | Corrupted registry produces POLICY_STORE_UNAVAILABLE |
| Host-native prompts and blocked app input | Separate operator consent for capture and input; no raw coordinates or clipboard bypass | Unsupported input and unattended UAC are denied |
| Spoofed, expired or replayed notification | Fixed local navigation allowlist + signed expiring incident nonce, exact request row, build and principal binding | Forged/stale incident cannot focus, acknowledge, or grant |
| Source HEAD is newer than installed binary | Verify executable digest, Core/MCP generation and Tray WebView asset build | Report source_changed_not_loaded until native attestation |

## Staged authorization
1. JS routing to a fixed Tray page and exact authenticated request row is an **untrusted UI convenience**, not a native receipt, ownership evidence, or human approval. This is partly implemented.
2. A proposed native navigation receipt MUST be signed/nonce-bound to verified Tray owner, live principal, exact incident and build, expire quickly, and carry only found/expired; no approve or deny in the route endpoint. This is NOT implemented.
3. A proposed Desktop UI broker MUST have an independent security review, verified OS-specific mediator, original file provenance enforcement, exact target lease and fresh attended approval. General inspect_window, snapshot, open, focus and arbitrary input remain DENIED. This is NOT implemented.

## Security review and release blockers
- Review and threat-test Windows UIA capture and native IPC before certifying any third-party window data.
- Test 2 principals, protected-file-in-browser, PID reuse, stale generation, revoked grants, corrupt store, cold/minimized Tray, disconnected LAN and unsupported OS; each must fail closed.
- Record SHA, installed binary signer/build digest, WebView digest, exact native receipt and device evidence. CI source compilation alone is not installed runtime verification.
- Do not kill, adopt or restart unverified Core/Guardian/Tray. No production deploy, credential mutation or permission broadening.
