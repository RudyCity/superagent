# Test Health Remediation Plan

- **Date:** 2026-10-14
- **Status:** Targeted remediation continued after the initial plan. Latest build passed; a 14-file regression group passed 100/100 tests and two additional files passed 15/15. Complete monorepo verification is still open.
- **Repository:** `D:\backup from pc asus\Documents Development\superagent`
- **Related work:** `docs/plans/2026-10-14-selfdev-default-on-development-plan.md`, `docs/plans/2026-10-14-selfdev-next-improvements-plan.md`
- **Purpose:** Track the test failures and reliability gaps discovered during Selfdev/MCP implementation, preserve root-cause evidence, and finish verification without weakening tests or overwriting unrelated work.

## 1. Executive summary

The latest verified run completed:

| Validation group | Result |
|---|---:|
| TypeScript build (`bun run build`) | Pass |
| Focused Selfdev, Agent, mode, CLI, Muse regressions | 27 files, 309 tests passed |
| MCP config, HTTP, OAuth, remote client compatibility | 8 files, 79 tests passed |
| **Combined selected verification** | **35 files, 388 tests passed** |
| Follow-up regression group (Agent/workflow, tier discovery, skills, terminal/task) | 14 files, 100 tests passed |
| Follow-up write-policy regressions | 2 files, 15 tests passed |
| Entire monorepo test suite | **Not confirmed** |

The subsequent complete-suite inventory covered 323 test files in 65 bounded batches. Its initial pass reported 61 batches green and four batches requiring follow-up (three timed out under grouped load; one reported an assertion failure). We then isolated and reran the implicated Agent/workflow, tier-toolset, skills, task, and terminal suites; the named targeted reruns are green, including the formerly failing toolset-resolution test. The complete 323-file inventory has not yet been rerun end-to-end after those changes, so the historical 61/65 result is not a full-suite pass.

**Rule:** Never report a full-suite pass from selected suites or an incomplete batch. A green build proves type-check/compilation, not full test coverage.

## 2. Test findings and current disposition

### T-01 — AgentPlanContent depends on a root-level implementation plan

- **Test:** `tests/agentPlanContent.test.ts`
- **Observed issue:** Earlier assertions changed depending on whether a real `implementation_plan.md` existed at repository root. The tested behavior was inadvertently coupled to ambient checkout contents.
- **Latest observation:** The test passed 4/4 when rerun.
- **State:** **Passed on rerun; fixture hardening recommended.**
- **Plan:**
  - [ ] Inspect its setup/teardown and all uses of the root plan path.
  - [ ] Prefer a temporary test workspace with explicit fixture contents, or stub the file-resolution seam; do not depend on a developer's real root file.
  - [ ] Include cases for no plan file, an empty plan, a valid plan, and a stale/unreadable plan.
  - [ ] Confirm cleanup restores state even if an assertion fails.
- **Acceptance:** Same result on a clean checkout and on a developer checkout that already has `implementation_plan.md`; all 4+ behavioral cases remain deterministic.

### T-02 — askQuestion robustness loop used an obsolete single-file edit contract

- **Test:** `tests/askQuestionRobustness.test.ts`
- **Observed issue:** The mock invoked `multi_replace_file_content` using legacy top-level `filePath/ReplacementChunks` fields. The runtime now disables that single-file shape and expects a batch `files[]` payload. The test mock also expected the edit tool to be available immediately instead of honoring dynamic tool discovery, so the Agent repeatedly called an invalid shape until the test timed out.
- **Changes already made:** The test now directly exercises the multi-replace tool with the required batch schema and passes JSON-string chunks through that boundary.
- **Latest observation:** 3/3 tests passed.
- **State:** **Fixed and verified.**
- **Follow-up:**
  - [x] Keep the targeted parser test aligned with the public batch schema.
  - [ ] Add a separate short Agent-loop test that exposes `list_tools/describe_tool` first and proves the Agent can discover the edit schema without repeated invalid calls.
  - [ ] Add a bounded assertion or call-count guard so a tool-call loop fails quickly with a useful message instead of hanging for 30 seconds.
- **Acceptance:** Both the parser contract and dynamic-discovery workflow are covered independently; malformed/disabled-tool calls do not make the test hang.

### T-03 — CLI bridge assertions unintentionally included active-artifact context

- **Test:** `tests/cliBridgeTool.test.ts`
- **Observed issue:** Some tests asserted the exact prompt content for unrelated CLI behavior but now received active-artifact instructions injected by normal runtime behavior.
- **Changes already made:** Tests that focus on unrelated CLI session behavior explicitly disable artifact injection, leaving dedicated artifact tests responsible for that feature.
- **Latest observation:** 52/52 tests passed.
- **State:** **Fixed and verified.**
- **Follow-up:**
  - [ ] Ensure at least one dedicated test still proves artifact injection works when enabled.
  - [ ] Avoid globally disabling artifacts in the test file or in production defaults.
  - [ ] Prefer assertions on the behavior under test over snapshots of unrelated dynamic prompt text.
- **Acceptance:** Tests cover both explicit artifact-enabled behavior and independent CLI behavior without ambient artifact content causing false failures.

### T-04 — CompactionStrategy pinned-count expectation was stale

- **Test:** `tests/CompactionStrategy.test.ts`
- **Observed issue:** The test expected `pinnedCount === 1`, while the strategy also anchors the active user request, making the correct count 2 for that fixture.
- **Changes already made:** Updated the expectation and documented why the active user request contributes an additional anchor.
- **Latest observation:** 9/9 tests passed.
- **State:** **Fixed and verified.**
- **Follow-up:**
  - [ ] Add/retain an assertion distinguishing explicit pins from automatic active-request anchors if metadata consumers depend on those counts.
  - [ ] Verify zero explicit pins, one explicit pin, and multiple explicit pins without making the test rely on implementation-private ordering.
- **Acceptance:** Count semantics are explicit; tests fail only if compaction pinning behavior changes, not because the fixture forgot an automatic anchor.

### T-05 — Multi-project batch read used the new schema but workspace resolution ignored it

- **Tests:** `tests/museMultiProjectWatch.test.ts`, `tests/museWebSocketTransport.test.ts`
- **Observed issue:** Read calls were migrated from a single-file `filePath/path` argument to a batch `filePaths[]` schema. The workspace resolver still inspected only single-file arguments, so a batch targeting project B could resolve to the default workspace and then fail the workspace/path boundary.
- **Changes already made:** Workspace resolution now considers the first valid entry in `filePaths` when no legacy single-path argument is supplied; the tool's workspace boundary validation remains in force. Test requests use the batch schema.
- **Latest observation:** Both files passed together, 26/26 tests.
- **State:** **Fixed and verified.**
- **Follow-up:**
  - [ ] Add explicit multi-entry cases where every batch path belongs to one project and reject mixed-project batches if that is the defined contract.
  - [ ] Cover relative path, absolute path, malformed first element, empty `filePaths`, and first path denied by workspace boundary.
  - [ ] Assert both the selected workspace and the final success/failure result, not just that the tool was called.
  - [ ] Verify ordering and per-call result correlation remain stable for multi-call WebSocket `task_batch`.
- **Acceptance:** Workspace routing is deterministic for batch input and never broadens read/write permissions to make routing pass.

### T-06 — Mode switching test assumed all write tools were always model-visible

- **Test:** `tests/modeSwitching.test.ts`
- **Observed issue:** The old expectation required `write_to_file` to be present immediately after `ContextBuilder` runs. Dynamic tool discovery intentionally presents discovery tools first and exposes a tool schema after `describe_tool`.
- **Changes already made:** The test now verifies that the write tool is initially absent, calls `describe_tool`, rebuilds context, and verifies the tool schema is then visible.
- **Latest observation:** 18/18 tests passed.
- **State:** **Fixed and verified.**
- **Follow-up:**
  - [ ] Add a guard for tool-schema discovery across mode changes (ask → implement) and ensure a previously requested schema is either retained safely or invalidated according to the actual policy.
  - [ ] Ensure tests don't bypass the public discovery workflow by directly manipulating internal discovery state.
- **Acceptance:** Test checks the intended dynamic-discovery behavior without weakening the allowlist or eagerly exposing every tool schema.

### T-07 — MCP server transport union was narrowed by the wrong discriminator, plus stale source syntax

- **Affected source/tests:** `src/core/commands/mcpCliHandler.ts`, `src/core/commands/mcpCommand.ts`, `src/core/tools/mcpTools.ts`, `src/serverRoutes.ts`, `src/core/mcp/McpManager.ts`; related MCP configuration/HTTP/OAuth/client tests.
- **Observed issue:** Some callers used `"url" in config` to distinguish HTTP from stdio. In the evolving transport union, that test was not a stable discriminator; stdio and HTTP handling became difficult for TypeScript to narrow correctly. The build also surfaced an orphaned block-comment terminator and a call-site argument no longer matching the remote OAuth helper signature.
- **Changes already made:** Transport branches were narrowed from the presence/absence of `command`; the stale comment marker and obsolete helper argument were corrected.
- **Latest observation:** Build passed; the dedicated MCP config/HTTP/OAuth/client group passed 79/79 across 8 files.
- **State:** **Build and selected tests verified; transport-union hardening recommended.**
- **Follow-up:**
  - [ ] Define one explicit discriminated union contract for `stdio`, `http`, and `streamable-http`; avoid inference based on incidental optional fields.
  - [ ] Add compile-time/type-level tests or exhaustive switches for each transport kind.
  - [ ] Cover malformed config that supplies both `command` and `url`, missing HTTP URL, and invalid stdio command.
  - [ ] Keep transport-specific headers/OAuth config out of stdio branches and stdio args/env out of HTTP branches.
  - [ ] Rerun all MCP transport/auth suites after the discriminator refactor.
- **Acceptance:** One transport discriminant controls narrowing; malformed mixed config is rejected clearly; all transport-specific tests and build pass.

### T-08 — Multi-mode audit error wording drift

- **Test:** `tests/multiModeAudit.test.ts`
- **Observed issue:** Earlier assertion expected a legacy single-file edit error message, while runtime behavior reflected the rule that single-file multi-replacement is disabled in both single and multi modes.
- **Latest observation:** 9/9 tests passed on the final targeted rerun.
- **State:** **Currently passing; no extra production change planned without a new failing reproduction.**
- **Follow-up:**
  - [ ] Keep user-facing error messages stable enough for tests but assert the policy meaning rather than brittle entire strings.
  - [ ] If the message changes, update the test only after verifying the same restriction still applies in both modes.
- **Acceptance:** No assertion is loosened in a way that lets a disabled operation execute.

### T-09 — Full monorepo verification exceeded execution limits

- **Observed issue:** The full inventory contains 323 test files across 65 bounded batches. The initial broad run reported 61 passing batches and four needing follow-up (three grouped-load timeouts and one assertion failure). Isolated reruns have since passed the key affected files: masterAgentWorkflow (7/7), tierToolsetResolution (6/6), skillsTool (10/10), toolErrorStatus (3/3), task/terminal tests, and other directly related suites.
- **State:** **Open; named failures are resolved in isolated runs, but the complete batch inventory must still be replayed after the latest changes.**
- **Plan:**
  - [ ] Enumerate all test files (top-level and nested) into a stable inventory before the run; do not rely only on `tests/*.test.ts`.
  - [ ] Record the current branch/worktree state and do not reset or stash unrelated changes.
  - [ ] Divide the inventory into deterministic batches small enough to complete under the execution limit (start with 10–15 test files; lower batch size for integration/network suites).
  - [ ] Run each batch in an isolated command, recording exact file list, exit code, test/file counts, failures, and timeout.
  - [ ] For each failing batch, rerun the failing test alone, capture the first assertion/stack, and classify root cause before modifying code.
  - [ ] Fix production code only when a reproducible defect is demonstrated. If the failure is an obsolete fixture/API contract, update that fixture to the public contract and add a separate test for the new workflow.
  - [ ] Rerun each failed batch after fixes and retain the before/after evidence in this plan or a linked run report.
  - [ ] Re-run previously green batches if a shared file changes.
  - [ ] Do not skip, quarantine, or weaken tests merely to claim green. If a test genuinely needs quarantine, document the reason, owner, and exit criteria first.
  - [ ] Only mark full suite green after every enumerated test file has a final recorded result and no batch is unreported or timed out.
- **Acceptance:** Complete inventory reconciles exactly to recorded test outcomes; no batch result is missing; unresolved failures/timeouts remain visible.

## 3. Execution order

1. [x] Preserve the current code/test changes and prove build + selected regression groups.
2. [x] Fix and verify the explicit API/fixture mismatches found in askQuestion, CLI artifact tests, compaction, Muse batch reads, and mode discovery.
3. [x] Rerun the named failures and the MCP compatibility group.
4. [ ] Harden the `agentPlanContent` fixture against ambient root artifacts.
5. [ ] Add separate discovery-loop and multi-workspace edge-case regression tests.
6. [ ] Stabilize explicit MCP transport discriminants.
7. [ ] Replay all 65 inventoried full-suite batches after the latest fixes, recording the result for every file.
8. [ ] Update this plan with final counts and any remaining exceptions.

## 4. Commands for the verification gate

From the repository root:

```sh
bun run build

bun x vitest run \
  tests/selfdev \
  tests/selfdevAgentLifecycle.integration.test.ts \
  tests/selfdevAndGatewaySuite.test.ts \
  tests/agent.test.ts \
  tests/agentAbortInterrupt.test.ts \
  tests/agentWorkspaceCache.test.ts \
  tests/agentOptimizations.test.ts \
  tests/modeSwitching.test.ts \
  tests/agentPlanContent.test.ts \
  tests/askQuestionRobustness.test.ts \
  tests/cliBridgeTool.test.ts \
  tests/CompactionStrategy.test.ts \
  tests/museMultiProjectWatch.test.ts \
  tests/museWebSocketTransport.test.ts \
  tests/multiModeAudit.test.ts

bun x vitest run \
  tests/configSchema.test.ts \
  tests/mcpHttpTransport.test.ts \
  tests/mcpOAuthRoutes.test.ts \
  tests/mcpOAuthAudit.test.ts \
  tests/mcpRemoteClient.test.ts \
  tests/remoteMcpOAuthProvider.test.ts \
  tests/mcpChatgptCompatibility.test.ts \
  tests/mcpExtendedTools.test.ts
```

These commands are the current focused gates, not a substitute for the full suite. Keep each full-suite batch under the execution time limit and record its inventory.

## 5. Rules for changing tests

- Prefer testing the documented/public tool schema over old implementation details.
- A timeout must be diagnosed: capture tool-call count, selected tool names, and the first repeated failure; don't just raise the timeout.
- Disable unrelated features only at the individual test boundary and preserve dedicated coverage for the feature being disabled.
- Keep workspace/path permission checks active in all fixtures; never make a routing test pass by granting a broad path allowlist.
- Update expected counters only after documenting their meaning and observing the code path that increments them.
- Avoid snapshots of full generated prompts when testing a small unrelated behavior; assert the relevant section or explicitly control feature flags.
- Any new transport/config branch must have an invalid-input test and a positive test for every supported transport.
- No commit is part of this plan unless separately requested.

## 6. Definition of done

- [x] Build passes.
- [x] Current selected regression gate passes: 388 tests across 35 test files in two groups.
- [x] All specifically identified runtime/schema regressions listed above were retested; resolved cases pass.
- [x] Follow-up 14-file Agent/workflow/tier/skills/task/terminal regression group passed 100/100.
- [x] Batch-write task artifact defaults allow routine task-file updates while preserving explicit overwrite=false; verified by tests.
- [ ] Replay the full inventoried 323-file suite and record all final outcomes.
- [ ] `agentPlanContent` uses isolated test fixtures and remains deterministic under a developer root plan.
- [ ] Dynamic tool-discovery and batch multi-project edge cases have dedicated tests.
- [ ] Transport config has an explicit discriminated-union contract and invalid-config coverage.
- [ ] Every repository test file is inventoried and gets a completed result from the full-suite run.
- [ ] Any remaining failures are either fixed with a demonstrated root cause or documented as unresolved, without silent skips.
- [ ] Final report distinguishes selected regression results from full-suite status.

---
**Current bottom line:** build is green; the follow-up 14-file regression group passed 100/100 tests, bulk write tests passed 7/7, and Master write-allowlist tests passed 8/8. Task artifact batch writes now overwrite by default while still honoring explicit overwrite=false. Named test failures pass isolated reruns; the complete 323-file, 65-batch suite remains unconfirmed until replayed.
