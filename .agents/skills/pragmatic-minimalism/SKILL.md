---
name: pragmatic-minimalism
description: >
  Enforces lean coding, minimizes codebase footprint, and reviews/audits for over-engineering or complexity.
  Triggered by topics:
  - Core Mindset: "pragmatic minimalism", "lean coding", "simplify code", "zero code", "minimize diff", "pragmatic design".
  - Design Review: "review for complexity", "review codebase design", "find bloated logic", "is this design too complex".
  - Project Audit: "audit code complexity", "audit codebase design", "find project bloat", "codebase design check".
  - Simplification Ledger: "pragmatic debt", "simplification ledger", "shortcut list", "what did we simplify".
  - Reference Help: "minimalism help", "how do I use minimalism".
---

# ROLE & PRINCIPLE
- **Role**: Senior developer. Goal: Minimize additions, reduce codebase footprint.
- **Rule**: Code is liability. Avoid additions. Delete dead code.

# EXECUTION ROUTING
if topic == "design_review" OR intent == "review_diff":
    CALL execute_complexity_review()
elif topic == "project_audit" OR intent == "audit_repo":
    CALL execute_complexity_audit()
elif topic == "simplification_ledger" OR intent == "debt_check":
    CALL execute_simplification_ledger()
elif topic == "help" OR intent == "show_guide":
    CALL show_help_card()
else:
    CALL apply_implementation_filter()

# 1. IMPLEMENTATION FILTER (Core Mindset)
Apply filter sequentially before modifying/adding code:
1. **ELIMINATION**: Challenge task value. Cancel/refuse task if speculative.
2. **RECYCLING**: Locate similar logic. Reuse existing functions/helpers.
3. **RUNTIME_APIS**: Use built-in standard library/runtime APIs.
4. **NATIVE_CAPABILITIES**: Use native platform/browser options (e.g. standard CSS, HTML forms, DB constraints).
5. **CURRENT_PACKAGES**: Use existing project dependencies. Do not install new modules.
6. **SHORT_SYNTAX**: Simplify structures (ternaries, short-circuits, built-in array methods).
7. **MINIMAL_FOOTPRINT**: Write absolute minimum lines/files for functional requirements.

# 2. BUG RESOLUTION PATHWAY
if fixing_defect:
    CALL trace_root_cause()
    # Apply fix at the common source function.
    # NEVER wrap callers with ad-hoc checks.

# 3. COMPLEXITY REVIEW (Design Review)
Analyze diffs for architectural bloat.
Output exactly one line per issue: `[<tag>] L<line>: <reason> -> <resolution>`
*If multi-file*: `[<tag>] <file>:L<line>: <reason> -> <resolution>`

## Tags:
- `CUT`: Unused code, dead variables, speculative branches. -> Delete.
- `STANDARD`: Hand-rolled logic replacing standard library functions. -> Replace with native APIs.
- `INLINE`: Speculative wrappers (single-caller helpers, single-impl interfaces). -> Inline logic.
- `CONDENSE`: Bloated conditionals/verbose assignments. -> Simplify.
- `DEPENDENCY`: Third-party packages when native code or minor helpers suffice. -> Remove package.

# 4. COMPLEXITY AUDIT (Project Audit)
Perform repository-wide design scans:
1. **EXCLUSION**: Ignore `node_modules`, `vendor`, `dist`, `.git`.
2. **DETECTION**: Identify:
   - Unreferenced functions/classes.
   - Hand-rolled code duplicating runtime library APIs.
   - Speculative layers (e.g. single-caller helpers, single-implementation interfaces).
   - Long files with complex structures (>500 lines).
3. **PRIORITIZATION**: Sort by potential line reduction (highest first).
4. **OUTPUT**: Print clean markdown list grouped by file and priority.

# 5. SIMPLIFICATION LEDGER (Pragmatic Debt)
Scan code to index deliberate bypasses/shortcuts:
1. **TARGETS**: Find comments starting with: `// pragmatic:`, `# pragmatic:`, `// temporary-bypass:`, `# temporary-bypass:`.
2. **EXCLUSION**: Ignore `node_modules`, `vendor`, `dist`, `.git`.
3. **OUTPUT**: Print markdown table of findings:
   | File | Line | Description | Proposed Cleanup |

# 6. HELP CARD
Output reference summary card:
```
  [PRAGMATIC MINIMALISM HELP CARD]
  =================================
  Mindset   : ELIMINATE -> RECYCLE -> RUNTIME_APIS -> NATIVE -> SHORT_SYNTAX -> MINIMAL
  Review    : Diff checks using CUT, STANDARD, INLINE, CONDENSE, DEPENDENCY
  Audit     : Repository-wide over-engineering scan
  Ledger    : Indexing // pragmatic: and // temporary-bypass: comments
```
