---
name: Superagent Planning and Task Management
description: Guide for creating valid implementation plans and task checklists using the manage_plan tool in Superagent to prevent validation errors.
when_to_use: when creating or editing an implementation plan, using the manage_plan tool, or planning features, bugs, or refactors.
version: 1.0.0
---

# Superagent Planning and Task Management

## Overview

In Superagent, implementation plans are validated before approval using strict structural checks. If a plan does not match one of the three predefined structures (Full, Quick, or Refactor), the interactive wizard will reject the plan with a validation error.

This skill ensures that you always construct plans that pass validation and synchronize successfully with the task checklist (`task.md` / `_task.md`) via the `manage_plan` tool.

**Announce at start:** "I'm using the Superagent Planning and Task Management skill to construct/sync the implementation plan."

---

## Valid Plan Templates

Your implementation plan must strictly follow one of these three templates. Do not modify the heading text of the required sections, as validation uses exact regular expression matching.

### 1. Full Template (Recommended for new features)
Use this template for standard features and tasks that require both automated and manual verification.

```markdown
# [Feature Name] Implementation Plan

## Proposed Changes
Describe the files to modify/create and the changes to be made.

- [ ] Task 1: Create new component
- [ ] Task 2: Integrate component into main layout
- [ ] Task 3: Verify implementation and provide project completion conclusion

## Verification Plan

### Automated Tests
Describe how to run automated tests (e.g., `npm test`).

### Manual Verification
Describe how to verify the changes manually (e.g., steps in the terminal or browser).
```

### 2. Quick Template (For simple fixes)
Use this template for minor fixes, style tweaks, or tasks that do not warrant complex testing architectures.

```markdown
# [Fix Name] Implementation Plan

## Proposed Changes
Describe the quick changes.

- [ ] Task 1: Fix typo in configuration file
- [ ] Task 2: Rebuild project, verify, and provide completion conclusion
```

### 3. Refactor Template (For restructuring)
Use this template for changes that focus on architecture, performance, or refactoring existing modules.

```markdown
# [Refactor Name] Implementation Plan

## Proposed Changes
Describe the code changes.

- [ ] Task 1: Extract helper function
- [ ] Task 2: Update callers of the helper function
- [ ] Task 3: Verify regressions and provide project completion conclusion

## Architecture
Describe the new design, module boundaries, or architectural shifts.
```

---

## Task Checklist Integration

The `manage_plan` tool parses your implementation plan for tasks formatted as checklist items:
- Format: `- [ ] Task description` (or `- [x]`, `- [/]`).
- These tasks are extracted and written to `task.md` (or `_task.md` depending on the agent tier).
- If no tasks are found, a default task (`- [ ] Execute implementation plan`) will be generated.
- Always include explicit, actionable tasks in the plan so they sync correctly to the task list.
- Always include a final task for verification and providing the project completion conclusion before listing changed files.

---

## How to Use the `manage_plan` Tool

Execute planning actions using the `manage_plan` tool:

### 1. Creating a Plan
Call the tool with `action: "create"` and provide the full markdown plan content in the `planContent` parameter:
```json
{
  "action": "create",
  "planContent": "# My Feature Plan\n\n## Proposed Changes\n- [ ] Task 1..."
}
```

### 2. Editing a Plan
To modify the existing implementation plan, use the `edit` action. You can either perform a full replacement by providing `planContent`, or perform an incremental find-and-replace using `targetContent` and `replacementContent`:

- Full replacement:
```json
{
  "action": "edit",
  "planContent": "# My Updated Feature Plan\n\n## Proposed Changes\n- [ ] Task 1..."
}
```

- Incremental edit:
```json
{
  "action": "edit",
  "targetContent": "- [ ] Task 1: Create new component",
  "replacementContent": "- [ ] Task 1: Create new component\n- [ ] Task 1b: Verify component tests"
}
```

### 3. Syncing Checklist Tasks
If you modified the plan file directly, synchronize it with the task checklist by calling:
```json
{
  "action": "sync"
}
```

### 4. Getting Status
To inspect the current plan path, task path, and completion status of checklist tasks, run:
```json
{
  "action": "get"
}
```

---

## Key Validation RegEx Reference

To avoid validation issues, make sure your headers match the following regexes:
- **Title**: `/^#\s+.+/m` (must start with `# ` followed by text)
- **Proposed Changes**: `/##\s+(proposed\s+changes|rencana\s+perubahan)/i`
- **Verification Plan**: `/##\s+(verification\s+plan|rencana\s+verifikasi)/i`
- **Automated Tests**: `/###\s+(automated\s+tests|test\s+otomatis)/i`
- **Manual Verification**: `/###\s+(manual\s+verification|verifikasi\s+manual|manual\s+testing)/i`
- **Architecture**: `/##\s+(architecture|arsitektur|design|desain|refactor)/i`
