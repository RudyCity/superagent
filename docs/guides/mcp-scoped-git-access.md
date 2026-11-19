# Git access in SuperAgent MCP (project-scoped)

SuperAgent MCP exposes seven structured Git actions: `status`, `diff`, `log`,
`add`, `commit`, `restore` and `clean`. These are not an unrestricted
terminal or arbitrary `git <args>` interface.

## Enable all seven actions for a registered local project

1. In **SuperAgent Tray → Access Manager**, select the relevant project and
   ensure the MCP principal has the **read** and **git** project capabilities.
   This project grant does not override the host file policy.
2. Under **File & Folder** (Akses File & Folder Core), register a native host
   **allow** rule for the **actual Core/MCP worker executable identity** and
   the exact repository root. Enable **Termasuk seluruh subfolder** (recursive).
3. Grant **read**, **write**, and **delete** operations to authorize the full
   structured set. A narrower rule can allow only the relevant actions:

   | MCP Git action | Required recursive host operations |
   | --- | --- |
   | `log` (1–50 entries) | Certified as bounded metadata |
   | `status`, `diff` | read |
   | `add`, `commit` | read, write |
   | `restore`, `clean` | read, write, delete |

4. Keep existing **deny** rules for sensitive files. If any deny overlaps the
   repository for a required operation, whole-workspace Git actions fail closed
   rather than enumerate or alter those protected files.

## Operating rules

- `add`, `restore`, and `clean` require **1–50 explicit, regular,
  project-relative file paths**. No directory pathspecs, wildcard/glob
  patterns, parent traversal, symlink targets, or direct `.git` changes.
- `commit` commits only **already staged** changes. It does **not** run
  `git add -A` or stage unrelated local work.
- `clean` targets only the explicitly named untracked files, not whole
  directories or all untracked workspace content.
- Whole-workspace actions require an actual `.git` **directory within the
  registered root**. Linked worktree gitdir pointers outside the root do
  not qualify for this host-wide certification.
- OAuth scope, MCP connection approval, project capability grants, host
  executable identity, registered root, and native file policy are checked
  independently. A Git capability grant alone is not a permanent file allow.
- No automatic process restart, destructive workspace cleanup, permission
  bypass or public tunnel rotation is performed by this setting.

After updating source, rebuild and safely reload the **actual serving MCP
backend**. A Core-only restart may leave the independent MCP backend unchanged.
Check the service owner/backend PID and test a non-destructive `git log` and
`git status` before attempting writes.
