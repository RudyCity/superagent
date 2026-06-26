# Fix Streaming Interruption (ESC and Ctrl+C) Implementation Plan

> **For Claude:** Use `d:\backup from pc asus\Documents Development\superagent\.agents\skills\collaboration\executing-plans\SKILL.md` to implement this plan task-by-task.

**Goal:** Ensure that users can reliably interrupt LLM response streaming and background operations using `ESC` or `Ctrl+C` in all terminal environments (including PowerShell/Cmd on Windows) in both single-agent and multi-agent modes.

**Architecture:**
- Make key event checks robust against raw ASCII/control characters (`\x03` for Ctrl+C and `\x1b`/`\u001b` for ESC) in TUI keyboard handlers (`useKeyboardHandler`, `useDashboardKeyboard`, and `ChatTextInput`).
- Register the single-agent instance as `masterAgentRef` in `app.tsx` so the global `SIGINT` handler can abort the single-agent in single-agent mode just as it does for the master orchestrator.

**Tech Stack:** Node.js, TypeScript, React, Ink

---

### Task 1: Update `ChatTextInput.tsx` to Robustly Handle Ctrl+C

**Files:**
- Modify: [ChatTextInput.tsx](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/components/ChatTextInput.tsx#L112-L120)

**Step 1: Write robust Ctrl+C return condition**
Update the early-return check in `useInput` to match either `input === "c"` or `input === "\x03"` when `key.ctrl` is true.

```typescript
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && (input === "c" || input === "\x03")) ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }
```

**Step 2: Save and verify compilation**
Ensure the file compiles without errors.

---

### Task 2: Robust Keyboard Handling in Single-Agent Mode

**Files:**
- Modify: [useKeyboardHandler.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/hooks/useKeyboardHandler.ts#L190-L200)

**Step 1: Define robust helper booleans**
At the very top of the `handlerRef.current` body, define:
```typescript
    const isEscape = !!(key?.escape || inputChar === "\x1b" || inputChar === "\u001b");
    const isCtrlC = !!(key?.ctrl && (inputChar === "c" || inputChar === "\x03"));
```

**Step 2: Replace all `key.escape` and `key.ctrl && inputChar === "c"` checks**
Replace all checks of `key.escape` with `isEscape`.
Replace all checks of `key.ctrl && inputChar === "c"` with `isCtrlC`.
This ensures robust ESC and Ctrl+C detection across the entire single-agent keyboard handler.

**Step 3: Save and verify compilation**
Ensure the file compiles without errors.

---

### Task 3: Robust Keyboard Handling in Dashboard (Multi-Agent) Mode

**Files:**
- Modify: [useDashboardKeyboard.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/hooks/useDashboardKeyboard.ts#L130-L140)

**Step 1: Define robust helper booleans**
At the very top of the `handlerRef.current` body, define:
```typescript
    const isEscape = !!(key?.escape || input === "\x1b" || input === "\u001b");
    const isCtrlC = !!(key?.ctrl && (input === "c" || input === "\x03"));
```

**Step 2: Replace `key.escape` and `key.ctrl && input === "c"` checks**
Replace all checks of `key.escape` with `isEscape`.
Replace all checks of `key.ctrl && input === "c"` with `isCtrlC`.
This ensures robust ESC and Ctrl+C detection across the dashboard keyboard handler.

**Step 3: Save and verify compilation**
Ensure the file compiles without errors.

---

### Task 4: Register Single-Agent as Master Agent

**Files:**
- Modify: [app.tsx](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/app.tsx)

**Step 1: Import `registerMasterAgent`**
Add `registerMasterAgent` to the static imports from `./core/tools.js` at line 22.

**Step 2: Register agent on initialization**
Inside the main `useEffect` block where `Agent` is instantiated, call `registerMasterAgent(agent)` right after setting `agent.tier = "single"`.

**Step 3: Clean up on unmount**
Inside the `useEffect` cleanup return function, call `registerMasterAgent(null)` to ensure proper lifecycle cleanup.

**Step 4: Save and verify compilation**
Ensure the file compiles without errors.

---

### Task 5: Verification and Build

**Step 1: Build the project**
Run `npm run build` to verify there are no TypeScript compilation errors.

**Step 2: Run unit tests**
Run `npm test` to ensure all tests pass.
