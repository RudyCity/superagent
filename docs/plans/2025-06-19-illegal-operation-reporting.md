# Illegal Operation Reporting to Parent Agent — Implementation Plan

> **For Claude:** Use `${SUPERPOWERS_SKILLS_ROOT}/skills/collaboration/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** When a sub-agent or superagent performs an illegal operation in multi-agent mode, report it to the parent agent via a structured real-time event so the parent can take action (log, warn, pause, or kill).

**Architecture:** Add a new `illegal_operation` AgentEvent type carrying structured violation data. The child agent emits this event when an operation is blocked. The parent's event handler (in `superagentTools.ts` / `subagentTools.ts`) captures it, logs it via `appendMasterLog`, stores it in the instance's `violations` array, and optionally takes automatic action (kill after N violations).

**Tech Stack:** TypeScript, existing Agent event system, existing state management in `tools/state.ts`

---

## Task 1: Add ViolationRecord interface to types.ts

**Files:**
- Modify: `src/core/tools/types.ts`

**Step 1: Add ViolationRecord interface**

Add after the `SuperagentInstance` interface:

```typescript
export interface ViolationRecord {
  timestamp: number;
  reason: string;           // e.g. "master_direct_modify_blocked", "superagent_out_of_bounds"
  toolName: string;         // which tool was blocked
  description: string;      // human-readable description
  severity: "warning" | "critical";
  meta?: Record<string, unknown>;
}
```

**Step 2: Add `violations` field to SubagentInstance and SuperagentInstance**

Add `violations?: ViolationRecord[]` to both interfaces.

**Step 3: Verify build**

Run: `npm run build`
Expected: PASS (no TypeScript errors)

---

## Task 2: Add illegal_operation event type to Agent

**Files:**
- Modify: `src/core/agent.ts`

**Step 1: Extend AgentEvent union type**

Add a new variant:

```typescript
| { type: "illegal_operation"; violation: ViolationRecord }
```

**Step 2: Add emitViolation helper method**

Add a private method to Agent class:

```typescript
private emitViolation(reason: string, toolName: string, description: string, severity: "warning" | "critical" = "warning", meta?: Record<string, unknown>): void {
  const violation: ViolationRecord = {
    timestamp: Date.now(),
    reason,
    toolName,
    description,
    severity,
    meta,
  };
  this.onEvent({ type: "illegal_operation", violation });
}
```

**Step 3: Wire emitViolation into all 5 blocking points**

At each blocking point in `runAgentLoop()`, call `this.emitViolation(...)` right after pushing the blocked ToolResult:

1. **Master direct modify** (line ~1032): `this.emitViolation("master_direct_modify_blocked", tc.name, "...", "critical", { filePath })`
2. **Plan pending (file)** (line ~1198): `this.emitViolation("planning_pending", tc.name, "...", "warning", { filePath })`
3. **Plan pending (command)** (line ~1218): `this.emitViolation("planning_pending_command", tc.name, "...", "warning", { command })`
4. **Dangerous command denied** (line ~1238): `this.emitViolation("user_permission_denied", tc.name, "...", "critical", { command })`
5. **Superagent out-of-bounds** (line ~1258): `this.emitViolation("superagent_out_of_bounds", tc.name, "...", "critical", { worktreePath })`

**Step 4: Handle event in agent's own onEvent wrapper**

Add logging for the new event type in the constructor's onEvent wrapper:

```typescript
} else if (event.type === "illegal_operation") {
  this.writeToLogFile("ILLEGAL_OPERATION", `[${event.violation.severity}] ${event.violation.reason}: ${event.violation.description}`);
}
```

---

## Task 3: Capture illegal_operation in parent event handlers

**Files:**
- Modify: `src/core/tools/superagentTools.ts` (Superagent event handler)
- Modify: `src/core/tools/subagentTools.ts` (Subagent event handler)

**Step 1: In superagentTools.ts — invokeSuperagentTool event handler**

Add a new `else if` branch in the event callback (~line 261):

```typescript
} else if (event.type === "illegal_operation") {
  const v = event.violation;
  const icon = v.severity === "critical" ? "🚨" : "⚠️";
  logs.push(`[ILLEGAL_OP] ${icon} ${v.reason} — ${v.toolName}: ${v.description}\n`);
  // Store in instance violations array
  const inst = superagentInstances.get(superagentId);
  if (inst) {
    if (!inst.violations) inst.violations = [];
    inst.violations.push(v);
  }
  appendMasterLog(`[ILLEGAL_OP] ${icon} Superagent "${role}" (${branch}): ${v.reason} — ${v.description}`);
  notifySuperagentsChanged();
}
```

**Step 2: In subagentTools.ts — invokeSubagentTool event handler**

Add a similar branch (~line 227):

```typescript
} else if (event.type === "illegal_operation") {
  const v = event.violation;
  const icon = v.severity === "critical" ? "🚨" : "⚠️";
  closeThinkingNode();
  logs.push(`${isFirstNode ? "┌" : "├"}───[ ${icon} ILLEGAL OPERATION ]\n`);
  isFirstNode = false;
  logs.push(`│   Reason: ${v.reason}\n`);
  logs.push(`│   Tool: ${v.toolName}\n`);
  logs.push(`│   Detail: ${v.description}\n`);
  logs.push(`│\n`);
  // Store in instance violations array
  const inst = subagentInstances.get(subagentId);
  if (inst) {
    if (!inst.violations) inst.violations = [];
    inst.violations.push(v);
  }
  appendMasterLog(`[ILLEGAL_OP] ${icon} Subagent ${subagentId} (${role}): ${v.reason} — ${v.description}`);
  notifySubagentsChanged();
}
```

**Step 3: Repeat for sendMessageToSuperagentTool and sendMessageTool event handlers**

Add the same `illegal_operation` branch to the `sendMessageToSuperagentTool` (~line 937) and `sendMessageTool` (~line 472) event handlers.

---

## Task 4: Expose violations in manage tools

**Files:**
- Modify: `src/core/tools/superagentTools.ts` — manageSuperagentsTool
- Modify: `src/core/tools/subagentTools.ts` — manageSubagentsTool

**Step 1: Add "violations" action to manage_superagents**

Add a new action in the `manage_superagents` tool:

```typescript
if (action === "violations") {
  const lines: string[] = ["Superagent Violations Report:"];
  for (const [id, inst] of superagentInstances.entries()) {
    const vList = inst.violations || [];
    if (vList.length === 0) continue;
    lines.push(`\n  ${inst.role} (${inst.branch}) — ${vList.length} violation(s):`);
    for (const v of vList) {
      const icon = v.severity === "critical" ? "🚨" : "⚠️";
      const time = new Date(v.timestamp).toISOString();
      lines.push(`    ${icon} [${time}] ${v.reason}: ${v.description}`);
    }
  }
  if (lines.length === 1) lines.push("  No violations recorded.");
  return lines.join("\n");
}
```

**Step 2: Add "violations" action to manage_subagents**

Same pattern for the subagent management tool.

**Step 3: Include violation count in "list" action output**

In both tools' `list` action, append violation count:

```typescript
if (inst.violations && inst.violations.length > 0) {
  line += ` | Violations: ${inst.violations.length}`;
}
```

---

## Task 5: Build and test

**Step 1: Build**

Run: `npm run build`
Expected: No TypeScript errors

**Step 2: Run existing tests**

Run: `npm test`
Expected: All tests pass

**Step 3: Manual verification**

Verify the violation flow by checking:
- `ViolationRecord` type is exported
- AgentEvent includes `illegal_operation`
- Both parent handlers capture the event
- Manage tools expose violations

---

## Files Changed Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/core/tools/types.ts` | Modify | Add ViolationRecord, add violations field to instances |
| `src/core/agent.ts` | Modify | Add illegal_operation event, emitViolation method, wire to blocking points |
| `src/core/tools/superagentTools.ts` | Modify | Capture illegal_operation events, expose in manage tool |
| `src/core/tools/subagentTools.ts` | Modify | Capture illegal_operation events, expose in manage tool |
