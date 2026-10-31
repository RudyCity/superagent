# MCP Independent Projects (Without Workspace Chain)

SuperAgent's MCP server can target multiple independent repositories through one MCP connection. Use a Workspace Chain only when the task truly spans multiple nodes or needs cross-workspace execution; it is not required to work with a second local repository or a standalone SSH repository.

## 1. Register projects

Register each local project once using its stable ID and absolute root:

\`\`\`json
{
  "projectId": "shop-api",
  "name": "Shop API",
  "type": "local",
  "root": "D:/work/shop-api",
  "description": "Backend API",
  "tags": ["typescript", "api"]
}
\`\`\`

Call \`superagent_register_project\` with this payload. Repeat for another project such as \`shop-web\`. The root must exist. The registry stores project metadata, not SSH passwords or private-key contents.

A standalone SSH project can be registered without a chain:

\`\`\`json
{
  "projectId": "production-api",
  "name": "Production API",
  "type": "ssh",
  "target": "ssh://deploy@example.net/srv/apps/api"
}
\`\`\`

Use an SSH key/profile already available to SuperAgent. MCP SSH operations do not open an interactive password prompt. Do not put passwords or credential-bearing query parameters in the target URI.

Use \`superagent_list_projects\` to discover registered projects and \`superagent_get_project\` to inspect one by ID.

## 2. Grant access intentionally

Registration is not permission. Project registration, update, removal, and granting access require Full YOLO to be enabled locally. A registered project outside the current Scoped YOLO scope requires an explicit grant for the authenticated MCP identity.

Use \`superagent_grant_project_access\` with the stable project ID and the minimum required capabilities:

\`\`\`json
{
  "projectId": "shop-api",
  "capabilities": ["read", "write", "git"]
}
\`\`\`

Granting access requires Full YOLO to be enabled locally and the dangerous MCP tool to be available. Access grants are stored in the SuperAgent config directory's \`project-access.json\` file and bound to the authenticated MCP identity (auth mode + subject). \`superagent_list_project_access\` lists only the current identity's grants. \`superagent_revoke_project_access\` revokes that identity's grant for one project.

Capabilities:

| Capability | Intended operations |
|---|---|
| \`read\` | Read files, list/find files, search, inspect workspace, read-only Git status/diff/log |
| \`write\` | Write batches, edit/patch files, manage file locks |
| \`execute\` | Run commands / office CLI. Commands execute with the local process or remote SSH user's OS permissions; this is not a sandbox |
| \`git\` | Stage, commit, restore, or perform other mutating Git operations |
| \`worktree\` | Manage project worktrees |
| \`planning\` | Read/update project plans and task checklists |
| \`chain\` | Manage or execute Workspace Chain operations, which retain their own Full YOLO and chain checks |

Project grants are considered only for workspace-scoped MCP tools; unrelated tools cannot inherit a project grant merely because a projectId is supplied. Granting access does not override protected \`model-config.json\` restrictions, dangerous-tool discovery rules, OAuth scopes, project-root checks, or the disabled-tool policy. Disabling/removing a project or changing its root/target revokes its existing grants.

## 3. Target each tool call by project ID

Pass \`projectId\` on each supported workspace-scoped MCP call. Relative paths are resolved under that project's root. An explicit per-call target does not change the session's default workspace.

Example read:

\`\`\`json
{
  "projectId": "shop-api",
  "files": ["src/index.ts", "src/routes/orders.ts"]
}
\`\`\`

Use it with \`superagent_read_files\`. Another call can target \`shop-web\` without switching the connection:

\`\`\`json
{
  "projectId": "shop-web",
  "dirPath": "."
}
\`\`\`

Use it with \`superagent_list_files\`. If you want subsequent calls without \`projectId\` to use a different default, call \`superagent_switch_workspace\` explicitly. On initialized HTTP MCP sessions, that default is isolated per session; stateless requests must supply a target or use a documented fixed default.

## 4. Standalone SSH support

When a registered \`type: "ssh"\` project is selected, supported MCP operations route through a dedicated SSH/SFTP connection for that project:

- \`superagent_get_workspace\`
- \`superagent_exec_command\`
- \`superagent_read_files\`
- \`superagent_write_files\`
- \`superagent_list_files\`
- \`superagent_grep_search\`
- \`superagent_find_files\`
- \`superagent_git_action\`

The provider checks that remote paths stay under the registered root and checks resolved remote paths for symlink escapes where SFTP realpath is available. Separate project IDs use separate SSH proxy/client instances and do not share a mutable target connection. Project removal, disablement, or a target change closes the cached connection.

**Important SSH execution boundary:** the root is enforced for supported file operations and as the command's working directory; arbitrary shell commands are still executed with the SSH account's operating-system privileges. The \`execute\` capability is therefore high privilege. Destructive system commands remain blocked unless Full YOLO is enabled locally. Do not treat a registered root as an OS-level container/sandbox.

Tools not implemented for standalone SSH return an explicit unsupported-capability error; they are not run against the local checkout. Use Workspace Chain only for operations that require multiple nodes or chain-specific execution.

## 5. Troubleshooting and safe defaults

- Unknown, disabled, ambiguous, unregistered, or unauthorized project targets fail closed; explicit bad targets never silently fall back to another project.
- If access is denied, inspect \`superagent_list_projects\` and \`superagent_list_project_access\`, then grant only the needed capability while the local administrator has intentionally enabled Full YOLO.
- Avoid using \`execute\` for read-only tasks. Prefer \`read\`, \`write\`, \`git\`, or \`planning\` as appropriate.
- If SSH authentication fails, configure a supported SSH key/profile first; the MCP provider intentionally does not prompt interactively.
- Workspace Chain remains a separate optional layer and retains its own node/path/permission checks.

## 6. Workspace Catalog and Discovered Projects

SuperAgent maintains a canonical read model called the **Workspace Catalog** that unifies historical sessions (`history.db`), trusted directories, active server sessions, Workspace Chains, and registered projects (`projects.json`).

### Security Sequence: Discovery != Registration != Authorization

```text
Workspace used by SuperAgent
        ↓
Workspace Catalog
        ↓
Discovered MCP project candidate (superagent_discover_projects)
        ↓
Explicit/controlled registration (superagent_import_discovered_project)
        ↓
Explicit capability grant (superagent_grant_project_access)
        ↓
Authorized MCP operations
```

Discovery, registration, and authorization remain strictly isolated:
1. **Discovery** is completely read-only, strips secrets/credentials, and makes zero changes to `projects.json` or capabilities.
2. **Registration / Import** writes metadata to `projects.json` after validating directory existence and Git/monorepo boundaries. It NEVER grants filesystem permissions or capabilities.
3. **Authorization** requires explicit operator action through `superagent_grant_project_access` with local Full YOLO enabled.

### Discovery vs Registry Tools

- `superagent_list_projects`: (Safe) Returns explicitly registered MCP projects from `projects.json`. Backward-compatible.
- `superagent_discover_projects`: (Safe, Read-only) Searches and enumerates candidates in the Workspace Catalog. Supports filtering by `classification`, `registered`, `available`, `trusted`, `active`, `source`, `importableOnly`, `query`, and pagination (`limit`, `offset`). Strips credentials and query secrets from legacy targets.
- `superagent_import_discovered_project`: (Dangerous) Imports a valid candidate from the Workspace Catalog into `projects.json`. Supports single-project import and dry-run validation (`dryRun: true`).
- `superagent_sync_projects`: (Dangerous) Reconciles candidates in `mode: 'dry-run'` or `mode: 'apply'` with explicit `catalogIds`.

### HTTP APIs

- `GET /api/workspaces`: Lists currently active runtime sessions (backward compatible).
- `GET /api/workspaces/catalog`: Lists durable workspace history and project catalog with query, classification, source, registered, available, and pagination filters.

### T-Line Desktop Integration Contract

The SuperAgent Core backend provides the foundation for the T-Line Project Browser:
- **Discovered**: Found in history or trusted directories with session activity, but not yet registered in `projects.json`.
- **Registered**: Present in `projects.json`, but has no MCP access grants yet.
- **Authorized**: Has explicit capability grants (`read`, `write`, `execute`, etc.) bound to the current identity.
- **Unavailable**: Missing directory or unresolvable path on disk.
- **Worktree / Temp**: Filtered out from normal project listings by default.
