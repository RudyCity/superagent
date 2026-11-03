# Delegate v1.5.0 — Automatic one-safe-tab guard

## Scope

- Repo: `RudyCity/superagent`, branch `main`; no worktree.
- Extension: `chrome-extension-delegate` only.
- Default ON in the active Chrome profile; normal and incognito contexts
  handled independently.
- Existing Delegate RPC protocol, pairing and client routing unchanged.

## Behavior

On extension startup and tab create/update/activate/remove events, collect
ChatGPT tabs in the current Chrome profile. Read-only DOM inspection checks
for active generation, draft text, dialog, pending attachment, or loading.
Pick a deterministic primary; close only safe-to-close redundant tabs,
re-checking URL, foreground change and DOM immediately before each close.
Never close or navigate during RPC in-flight. If an existing tab is
loading/unverified, defer the whole group rather than choosing the wrong
primary. Live browser smoke uncovered a navigation-complete/DOM-ready
race; eight bounded short retries plus the existing 30-second service
worker alarm now recover without reloading pages. Never close a pinned or
audible tab. If multiple protected tabs remain, keep them and continue to
require explicit `tabId` on Delegate RPC calls.

Diagnostics are available via the extension popup's tab count and the
trusted worker's `get_status().status.tabPolicy`. No message content is
returned by inspect_tab.

## Verification

`tests/delegateTabSingleton.test.ts` covers one-tab normalization,
protected drafts/generation, loading and pinned tabs, foreground tab races,
incognito isolation, disabled/busy state, and lifecycle watchers.

`tests/delegateContent.test.ts` adds DOM safety probes for empty tabs,
drafts, generation, finished chats and unverified chats.

Release `scripts/release-delegate.mjs` includes the new bundled
`tabSingleton.js` with versioned deterministic archive receipt.

This is a tested implementation, not a claim that a live user Chrome
profile was forcibly normalized: existing tabs may have unsent content.

## Verified results (2026-11-04)

- `bun run verify:delegate`: **PASS**, 74/74 tests in 6 suites.
- `bun run verify:extension-js`: **PASS**, 20 Chrome extension JS files.
- `bun run build`: **PASS** (Bun 1.4.2; SuperAgent 1.14.62).
- `bun run release:delegate`: **PASS**, seven allowlisted extension files.
- ZIP SHA-256: `f94c749c1d991c18e33ef282329339eacfc6118b97e2c50eaa6ef443bb274077`.
- Live Chrome auto-close not executed against existing user tabs; only
  isolated simulated Chrome tab lifecycle and DOM tests were run.


## Live Chrome smoke (same user-profile, no chat message sent)

- Existing ChatGPT tab `1217725633` preserved.
- Created disposable duplicate ChatGPT tab `1217725656` (inactive).
- First browser check observed `not_loaded`; cleanup correctly deferred.
- Detected missing DOM-ready retry from real browser, fixed with bounded
  retries and the periodic alarm.
- After extension reload, `chrome.tabs.query` reported **only original
  tab `1217725633`**, Delegate connection still `connected`,
  manifest version `1.5.0`, `remainingTabs:1`, no protected tabs.
- No ChatGPT messages submitted, no user conversations reloaded.
- Follow-up polish keeps `lastClosedTabIds` and timestamp visible across
  subsequent one-tab checks in the popup for 5 minutes.
