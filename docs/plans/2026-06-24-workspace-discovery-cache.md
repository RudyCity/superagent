# Smart Workspace Discovery Implementation Plan

> **For Claude:** Use `${SUPERPOWERS_SKILLS_ROOT}/skills/collaboration/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** Speed up Superagent startup and subsequent searches (glob/grep) by caching the workspace structure and configuration context using a fast directory fingerprint (hash of paths + sizes + timestamps).

**Architecture:** A new `workspaceDiscovery.ts` module will walk the codebase recursively (excluding ignored dirs) to calculate a quick MD5 fingerprint. A JSON cache under `~/.superagent-r/workspace-caches/` will store the file tree structure, `agents.md`, and `package.json` content; on startup, if the fingerprint matches, it loads context instantly, injecting it into the system prompt and intercepting search tools (glob) to use the in-memory cache.

**Tech Stack:** TypeScript, Node.js `fs` APIs, `crypto` (for hashing), `picomatch` (for cached glob filtering).

---

## Proposed Changes

### Core System

#### [NEW] [workspaceDiscovery.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/workspaceDiscovery.ts)
- Create a workspace scanner utility.
- Expose `getWorkspaceFingerprint(dir: string)`: Walks directory recursively (ignoring `.git`, `node_modules`, `.worktrees`, `dist`, `vendor`, `.agents`), returning sorted array of `{ path, size, mtimeMs }` and a combined MD5 fingerprint.
- Expose `discoverWorkspace(dir: string)`:
  1. Computes current fingerprint.
  2. Resolves cache path under `~/.superagent-r/workspace-caches/<hashed-workdir-path>.json`.
  3. If cache file exists and fingerprint matches → returns cached context and `isIdentical: true`.
  4. If fingerprint differs or no cache exists → performs partial diff, reads modified/new files (like `agents.md`, `package.json`), updates cache file list/metadata, writes cache, and returns `isIdentical: false`.
- Expose `injectWorkspaceOverview(systemPrompt: string, cache: WorkspaceCache)`: Appends cached workspace files and configuration overview dynamically to the system prompt if the fingerprint is identical.

#### [MODIFY] [agent.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/agent.ts)
- Import `discoverWorkspace` and `injectWorkspaceOverview` from `workspaceDiscovery.ts`.
- In `Agent.runAgentLoop()`, on the first iteration of a session, perform workspace discovery and retrieve the cache.
- Print diagnostic log messages: `[SYS] Workspace identical to previous session. Using cached context.` or `[SYS] Workspace changed. Performed partial scan. Updated cache.`
- Inject the cached codebase layout summary directly into the prompt to give the agent immediate context, skipping the need for it to invoke `globTool`.

#### [MODIFY] [systemTools.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/tools/systemTools.ts)
- Import workspace cache accessor from `workspaceDiscovery.ts`.
- Modify `globTool.execute` to check if a valid workspace cache exists for the CWD.
- If a cache exists, perform glob filtering in-memory using `picomatch` over the cached `fileList` and return the result instantly, bypassing disk traversal entirely.

---

### Task 1: Create Workspace Discovery Utility

**Files:**
- Create: `src/core/workspaceDiscovery.ts`
- Test: `tests/workspaceDiscovery.test.ts`

**Step 1: Write the failing test**
Create a test file `tests/workspaceDiscovery.test.ts` verifying:
1. Walking a directory returns sorted file metadata list.
2. Fingerprint remains identical for same files, changes if a file is modified/created/deleted.
3. Cache serialization and partial update logic.

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/workspaceDiscovery.test.ts`
Expected: FAIL (module not found or functions undefined)

**Step 3: Write minimal implementation**
Implement the directory walking, fingerprint hashing, and cache serialization logic in `src/core/workspaceDiscovery.ts`.

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/workspaceDiscovery.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add src/core/workspaceDiscovery.ts tests/workspaceDiscovery.test.ts
git commit -m "feat: add workspace discovery and fingerprinting utility"
```

---

### Task 2: Implement Agent Startup Cache Hook & Prompt Injection

**Files:**
- Modify: `src/core/agent.ts`
- Test: `tests/agentWorkspaceCache.test.ts`

**Step 1: Write the failing test**
Create a test verifying that when the agent runs, it calls `discoverWorkspace`, prints the correct cached context log message, and includes the file summary in its active system prompt.

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/agentWorkspaceCache.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**
Integrate `discoverWorkspace` and prompt injection into `Agent.runAgentLoop()`.

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/agentWorkspaceCache.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add src/core/agent.ts tests/agentWorkspaceCache.test.ts
git commit -m "feat: hook workspace discovery and prompt injection on agent startup"
```

---

### Task 3: Intercept globTool searches using Workspace Cache

**Files:**
- Modify: `src/core/tools/systemTools.ts`
- Test: `tests/globToolCache.test.ts`

**Step 1: Write the failing test**
Create a test verifying that `globTool` uses the cache if available and returns matched files correctly without running the disk-glob subprocess, and falls back to normal globbing if no cache exists.

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/globToolCache.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**
Modify `globTool` execution to intercept with cached file matching via `picomatch` when a valid cache signature is present.

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/globToolCache.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add src/core/tools/systemTools.ts tests/globToolCache.test.ts
git commit -m "feat: intercept globTool with in-memory workspace cache"
```

---

## Verification Plan

### Automated Tests
- Run all workspace discovery tests: `npx vitest run tests/workspaceDiscovery.test.ts tests/agentWorkspaceCache.test.ts tests/globToolCache.test.ts`
- Run the full test suite: `npm test`
- Build verification: `npm run build`

### Manual Verification
- Start `superagent` in single/multi-agent mode on a project.
- Verify that on the first session start, it prints `[SYS] Workspace scanned and cached.` (or similar).
- Close and reopen the session immediately. Verify it prints `[SYS] Workspace identical to previous session. Using cached context.` and starts up instantly.
- Modify/touch a file, reopen the session, and verify that it detects the change and prints `[SYS] Workspace changed. Performed partial scan. Updated cache.`.
