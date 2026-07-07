# Smart Search and Discovery Optimization Implementation Plan

> **For Claude:** Use `${SUPERPOWERS_SKILLS_ROOT}/skills/collaboration/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** Improve search latency by integrating in-memory file caching in grepTool and speed up workspace fingerprint generation by using git ls-files when inside Git repositories.

**Architecture:**
- Update grepTool in systemTools.ts to intercept searches using getWorkspaceCachePath, matching patterns using picomatch over the cached fileList.
- Update workspaceDiscovery.ts to check if the directory is a Git repository, retrieve files using git ls-files if so, and perform concurrent file stats to generate fingerprints rapidly.
- Write unit tests to verify both optimizations under tests/grepToolCache.test.ts and tests/workspaceDiscovery.test.ts.

---

## Proposed Changes

### Search Tools Component

#### [MODIFY] [systemTools.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/tools/systemTools.ts)
- Update `grepTool.execute` to:
  1. Retrieve the path of the workspace cache via `getWorkspaceCachePath(searchPath)`.
  2. If the cache exists and has a `fileList`, import `picomatch` dynamically.
  3. Filter the `fileList` in-memory matching `**/${include}` pattern.
  4. Map matched relative paths to absolute paths.
  5. Fall back to calling `fg` on disk if the cache is missing or fails to read.

#### [NEW] [grepToolCache.test.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/tests/grepToolCache.test.ts)
- Create unit tests that:
  1. Verify `grepTool` uses in-memory file lists when workspaceCache exists on disk, bypassing fast-glob disk traversal.
  2. Verify fallback to disk globbing when no workspaceCache is found.

---

### Workspace Discovery Component

#### [MODIFY] [workspaceDiscovery.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/workspaceDiscovery.ts)
- Add `exec` promisified wrapper from `child_process`.
- Add helper `isGitRepo(dir: string): Promise<boolean>` using `git rev-parse --is-inside-work-tree`.
- Add helper `getGitFiles(dir: string): Promise<string[]>` using `git ls-files --cached --others --exclude-standard`.
- Modify `getWorkspaceFingerprint` to:
  1. Detect if the workspace is a Git repository.
  2. If yes, query files using `getGitFiles` and filter out any path segments matched in `IGNORED_DIRS`.
  3. If no, fall back to recursive `walkDirectory`.
  4. Run `fs.promises.stat` on all files concurrently in batches of 100 to gather sizes and timestamps.
  5. Deterministically hash file names, sizes, and timestamps to construct the MD5 fingerprint.

#### [MODIFY] [workspaceDiscovery.test.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/tests/workspaceDiscovery.test.ts)
- Add unit tests verifying Git-based workspace discovery:
  1. Run `git init` in the test workspace.
  2. Write files and commit them.
  3. Call `getWorkspaceFingerprint` and verify it uses `git ls-files` to discover the workspace files.
  4. Compare the result with the non-git fallback to ensure identical outcomes.

---

## Verification Plan

### Automated Tests
- Run `npx vitest run tests/grepToolCache.test.ts`
- Run `npx vitest run tests/workspaceDiscovery.test.ts`
- Run `npm test` to ensure no regressions.
- Run `npm run build` to verify compilation.

### Manual Verification
- Run a grep search using `grepTool` inside the superagent repository and verify it executes successfully and returns expected file matches.
