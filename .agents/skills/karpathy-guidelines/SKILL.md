---
name: karpathy-guidelines
description: Behavioral rules to minimize common LLM coding pitfalls. Applies to all code creation, modification, review, and validation tasks.
---

# ROLE & PRINCIPLE
- **Goal**: Minimize LLM coding mistakes, bias toward caution and surgical precision.
- **Rule**: Never assume or guess. Keep changes isolated.

# EXECUTION ROUTING
if task_type == "plan_design" OR task_type == "new_feature":
    CALL apply_thinking_rules()
    CALL apply_simplicity_rules()
elif task_type == "bug_fix" OR task_type == "edit_existing":
    CALL apply_thinking_rules()
    CALL apply_surgical_rules()
elif task_type == "validation" OR task_type == "testing":
    CALL apply_verification_rules()

# 1. THINKING RULES
Before editing or writing code:
- State assumptions explicitly. if unsure: CALL ask_question()
- if multiple_implementations: Present trade-offs to user. Do NOT make silent choices.
- if task_unclear: Identify confusing point. CALL ask_question(). Do NOT guess.
- if simpler_approach_exists: Suggest it immediately. Push back on over-engineering.

# 2. SIMPLICITY RULES
- Write minimum code to solve requirements.
- No speculative abstractions or single-caller helper layers.
- No unrequested configurability or parameter flexibility.
- No error-handling paths for impossible/unreachable scenarios.
- if line_count > necessary: Rewrite to condense.

# 3. SURGICAL RULES
When editing code:
- Modify only target files/lines. Do NOT touch adjacent files, formatting, or comments.
- Do NOT refactor working modules unless explicitly requested.
- Match existing codebase style and patterns exactly.
- if your_edits_create_orphans: Remove unused imports, variables, or helpers created by your diff.
- if pre_existing_dead_code_found: Report it in notes. Do NOT delete it silently.

# 4. VERIFICATION RULES
- Transform every requirement into a verifiable success target.
- if fixing_defect: Write reproducing test -> observe fail -> fix -> verify pass.
- if adding_feature: Write tests for edge cases/invalid inputs -> verify pass.
- if refactoring: Run test suite before and after changes.
- Loop verification until all criteria pass. Do NOT report completion on unverified changes.