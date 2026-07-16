# Tool Reliability Guide

## Goal
Reduce failed tool calls and broken edits during agent work.

## Rules
- Use `npm.cmd` from Git Bash on Windows. Avoid bare `npm`.
- Run file edits before validation commands. Do not run syntax checks in parallel with edits.
- Prefer small unique anchors. Read the target range before exact-match edits.
- If exact match fails once, re-read the range and switch to a line-range replacement.
- Use `ripgrep_search` for file or directory searches. Use `grep` only with directory paths.
- Batch related reads with `filePaths`; keep each read targeted.
- After JavaScript edits, run `npm.cmd run verify:extension-js`.
- After source edits, run `npm.cmd run build` and `npm.cmd test`.

## Common failures
- `targetContent not found`: stale text or wrong line range. Re-read, then patch current text.
- `oldString not found`: exact string changed. Re-read, use smaller anchor.
- `ENOTDIR`: grep path was a file. Use directory or `ripgrep_search`.
- `unexpected EOF while looking for matching`: bare `npm` shim under Git Bash. Use `npm.cmd`.
- `Unexpected token ')'`: closure mismatch. Roll back target file, re-apply smaller patch.

## Safe sequence
```bash
npm.cmd run verify:extension-js
npm.cmd run build
npm.cmd test
```
