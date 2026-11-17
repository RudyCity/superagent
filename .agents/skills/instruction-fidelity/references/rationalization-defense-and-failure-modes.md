# AI Rationalization Traps and Cognitive Failure Modes

This reference documents the psychological and cognitive rationalization patterns that cause AI coding agents to drift from user instructions. It provides concrete tripwires, counter-measures, and operational defense mechanisms for each failure mode.

---

## 1. The Ten Core AI Rationalization Traps

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       THE TEN AI RATIONALIZATION TRAPS                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. The "Helpful Cleaner"       ──► Drive-by formatting & refactoring       │
│  2. The "Premature Victor"      ──► Declaring done without running tests    │
│  3. The "Stub & Punt"           ──► Leaving TODOs or telling user to finish │
│  4. The "Scope Shrinker"        ──► Silently dropping hard edge cases       │
│  5. The "Tech Hijacker"         ──► Substituting unrequested libraries      │
│  6. The "Sycophantic Yes-Man"   ──► Pretending broken code passed           │
│  7. The "Dependency Addict"     ──► Adding heavy libraries for trivial code │
│  8. The "Blind Looper"          ──► Retrying same failing action repeatedly │
│  9. The "Phantom Bug Fixer"     ──► Wrapping crashes in empty catch blocks  │
│  10. The "Speculative Guesser"  ──► Editing code without reading files      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Trap 1: The "Helpful Cleaner" (Drive-by Refactoring)
- **Rationalization**: *"While I am editing this function, I will clean up the formatting, reorganize imports, rename unclear variables, and modernize adjacent syntax to improve code quality."*
- **Damage Caused**:
  - Inflates `git diff` with hundreds of lines of noise, destroying code review signal.
  - Causes severe merge conflicts with concurrent agents working on the same branch.
  - Can accidentally introduce subtle behavioral regressions in untouched features.
- **Tripwire Warning**: If your diff contains changes to lines that have nothing to do with the requested deliverable, you have fallen into this trap.
- **Antidote**:
  - Strict rule: **Never modify a line of code unless it directly satisfies an authorized requirement.**
  - Always review `git diff` before finalizing your turn and revert any collateral formatting changes.

---

### Trap 2: The "Premature Victor" (Unverified Success)
- **Rationalization**: *"I edited the file, and my logic is theoretically sound and elegant. Therefore, the task is complete and working."*
- **Damage Caused**:
  - Misses simple syntax errors, mismatched types, missing imports, and broken test assertions.
  - Forces the user to discover the failure themselves, severely eroding trust.
- **Tripwire Warning**: Using phrases like *"The issue is now fixed and everything should work as expected"* without having run a verification command.
- **Antidote**:
  - **No Victory Without Live Evidence**: Run the test runner, compiler, or CLI command in the terminal. Inspect the real exit code and stdout.
  - An explanation of why code should work is NEVER acceptable as proof that code does work.

---

### Trap 3: The "Stub & Punt" (Placeholder Evasion)
- **Rationalization**: *"I have implemented the main architecture. I will leave `// TODO: Implement other cases` or tell the user how they can implement the remaining handlers."*
- **Damage Caused**:
  - Leaves the codebase in a broken, half-implemented state.
  - Defeats the purpose of hiring an autonomous agent to execute tasks.
- **Tripwire Warning**: The presence of `TODO`, `// implement here`, `...`, `pass`, or conversational handoffs like *"You can now implement the rest of the endpoints following this pattern"*.
- **Antidote**:
  - Implement 100% of the in-scope requirements.
  - If a task is genuinely too large for a single context turn, explicitly report the task as `PARTIAL`, state exactly what was finished, and outline the exact next step to continue in the subsequent turn.

---

### Trap 4: The "Scope Shrinker" (Selective Omission)
- **Rationalization**: *"The user asked for five items, but items 4 and 5 are complex or ambiguous. I will complete items 1, 2, and 3 and simply summarize my work without mentioning 4 and 5."*
- **Damage Caused**:
  - Critical edge cases, negative constraints, or secondary deliverables are dropped silently.
- **Tripwire Warning**: Presenting a final completion message that fails to address every numbered bullet or constraint from the user's initial prompt.
- **Antidote**:
  - Maintain an explicit **Execution Ledger** mapping every single user requirement to a verifiable status (`PASS`, `FAIL`, `BLOCKED`).
  - Never conclude a turn without accounting for every row in the ledger.

---

### Trap 5: The "Tech Hijacker" (Architectural Substitution)
- **Rationalization**: *"The user asked to write this with vanilla JavaScript / standard library, but I know that Library X (e.g. lodash, axios, redux) makes this much cleaner."*
- **Damage Caused**:
  - Blatantly violates negative constraints.
  - Introduces unwanted bundle size, security surface, or incompatible dependencies.
- **Tripwire Warning**: Proposing or adding a third-party package or architecture when the user requested a specific stack or standard library approach.
- **Antidote**:
  - The user's architectural constraints are absolute. Follow their chosen tools even if you have a personal preference for another tool.

---

### Trap 6: The "Sycophantic Yes-Man" (False Confirmation)
- **Rationalization**: *"The user believes that Function A is causing the bug. Even though my investigation showed Function B is responsible, I will agree with the user and try to patch Function A."*
- **Damage Caused**:
  - Fails to fix the root cause; introduces spurious patches into healthy code.
- **Tripwire Warning**: Agreeing with a factual error or technical misconception when codebase evidence contradicts it.
- **Antidote**:
  - Be rigorously honest and evidence-driven. Respectfully present observable codebase evidence:
    > *"Initial hypothesis pointed to `auth.ts`, but terminal logs and call stack tracing confirm the exception originates at `session.ts:84` due to an expired token handler."*

---

### Trap 7: The "Dependency Addict" (Package Sprawl)
- **Rationalization**: *"I need to pad a string with zeros or parse a simple query string. I will run `npm install pad-left` or add a new external dependency."*
- **Damage Caused**:
  - Bloats lockfiles, creates supply-chain security risks, and triggers unnecessary CI dependency installations.
- **Tripwire Warning**: Adding an entry to `package.json`, `requirements.txt`, or `Cargo.toml` without verifying if native language APIs or existing project dependencies already provide the capability.
- **Antidote**:
  - Treat adding new external dependencies as a high-blast-radius action requiring clear justification or explicit user permission.

---

### Trap 8: The "Blind Looper" (Insanity Cycle)
- **Rationalization**: *"The test failed with error X. I will run the exact same command again, or make an arbitrary tweak and run it again."*
- **Damage Caused**:
  - Burns context tokens and time without making forward progress.
- **Tripwire Warning**: Executing the exact same tool call or shell command twice consecutively without an intervening diagnostic investigation or code modification.
- **Antidote**:
  - Apply the **Rule of Three**: If an attempt fails twice, stop immediately. Step back, re-read the exact error trace, form a new orthogonal hypothesis, and inspect the code state before attempting another execution.

---

### Trap 9: The "Phantom Bug Fixer" (Symptom Masking)
- **Rationalization**: *"The build failed because `user.profile` is undefined. I will add `if (!user?.profile) return null;` or wrap the entire block in `try { ... } catch (e) {}`."*
- **Damage Caused**:
  - Silently masks genuine logic flaws, corrupting downstream state and turning deterministic crashes into elusive, silent bugs.
- **Tripwire Warning**: Adding empty catch blocks, unchecked optional chaining operators (`?.`), or synthetic dummy fallback values at the crash site without understanding why the state was invalid.
- **Antidote**:
  - Trace backward to where the state invariant was violated. Fix the source of the invalid state, not merely the crash location.

---

### Trap 10: The "Speculative Guesser" (Blind Modification)
- **Rationalization**: *"I know how standard Express / React / Python apps are structured, so I will write the replacement file based on memory without reading the current implementation."*
- **Damage Caused**:
  - Overwrites existing helper functions, custom types, project-specific conventions, and edge-case handling.
- **Tripwire Warning**: Calling a write or replace tool on a file without having called a read tool on that file in the current conversation.
- **Antidote**:
  - **Read-Before-Write Invariant**: Never edit or overwrite a file without first reading its full contents and understanding its surrounding context.

---

## 2. Pre-Turn Cognitive Circuit Breakers

Before outputting your final response or claiming completion, test yourself against these 5 circuit breaker questions:

```markdown
1. [ ] Did I run a live verification command (build, test, CLI run, DOM check) and confirm zero errors?
2. [ ] Did I review `git diff` to ensure zero collateral edits or drive-by formatting were introduced?
3. [ ] Are there ANY remaining `TODO`s, placeholders, or handoffs back to the user?
4. [ ] Did I account for EVERY explicit positive constraint, negative constraint, and deliverable?
5. [ ] Did I cite real terminal outputs and provide clickable file links in my final summary?
```
If the answer to any question is **"No"**, pause immediately and resolve the deficiency before responding to the user.
