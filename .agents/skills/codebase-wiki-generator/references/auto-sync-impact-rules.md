# Reference: Auto-Sync Impact Rules & File Pattern Mapping

This reference defines the comprehensive matching rules used by `sync-wiki-on-change.js` and `watch-and-sync.js` to determine which wiki documents require updates when files in the repository are modified.

---

## 🗺️ Change-to-Wiki Impact Matrix

| Codebase File Glob Pattern | Primary Wiki Target | Secondary Wiki Target | Auto-Sync Action |
|:---|:---|:---|:---|
| `apps/api/src/routes/**`<br>`apps/api/src/controllers/**`<br>`src/routes/**`<br>`app/api/**` | `03-api-and-contracts.md` | `00-index.md` | Runs `extract-api-catalog.js` and patches route tables, HTTP methods, and auth guards. |
| `packages/db/src/schema/**`<br>`packages/db/migrations/**`<br>`prisma/schema.prisma`<br>`drizzle/**` | `02-domain-models-and-data.md` | `00-index.md` | Identifies new/modified tables, updates ERD schema notes, and timestamps migration logs. |
| `package.json`<br>`pnpm-workspace.yaml`<br>`turbo.json`<br>`tsconfig*.json` | `01-architecture-overview.md` | `06-developer-onboarding.md` | Refreshes monorepo package tree, tech stack versions, and core setup prerequisites. |
| `apps/frontend/src/routes/**`<br>`apps/frontend/src/pages/**`<br>`apps/frontend/src/components/**` | `04-features-and-workflows.md` | `01-architecture-overview.md` | Updates frontend UI routing map and interactive component flows. |
| `apps/api/src/services/**`<br>`apps/api/src/routes/assistant/**`<br>`packages/ai/**` | `04-features-and-workflows.md` | `03-api-and-contracts.md` | Refreshes store copilot tools, prompt guards, and background execution logic. |
| `docker-compose*.yml`<br>`Dockerfile*`<br>`.github/workflows/**`<br>`.env.example` | `05-infrastructure-and-devops.md` | `06-developer-onboarding.md` | Updates container port mappings, env variable dictionary, and CI/CD triggers. |
| `docs/wiki/**` | *(Self-Ignored)* | *(Self-Ignored)* | Prevents infinite sync loops on documentation modifications. |

---

## ⚡ Execution Modes for Synchronization

### 1. Pre-Commit / Post-Commit Git Hooks
- Evaluates `git diff --name-only` or `git status --porcelain`.
- Runs lightweight sync before or after commits.

### 2. Live Watcher Daemon (`watch-and-sync.js`)
- Uses recursive `fs.watch`.
- Aggregates file changes within a 600ms debounce window.
- Invokes target extractors and patches markdown documents in-place.

### 3. Manual Incremental Run
- Allows passing specific modified files via `--files "file1.ts,file2.ts"`.
