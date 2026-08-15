# 06. Developer Onboarding & Runbooks

> [!NOTE]
> Welcome to the {{PROJECT_NAME}} engineering team! This guide will get your local environment running in under 5 minutes and teach you our coding standards.

[⬅️ Back to Master Index](./00-index.md)

---

## 1. Prerequisites & Tooling

Before starting, ensure you have the following installed:
- **Node.js**: `v20.x` or `v22.x` (LTS)
- **Package Manager**: `pnpm >= 9.x` (`corepack enable pnpm`)
- **Docker & Docker Compose**: For local PostgreSQL database
- **Git**: Configured with SSH/GPG

---

## 2. Quickstart Setup (5 Minutes)

```powershell
# 1. Clone the repository
git clone <repo-url>
cd smart-seller

# 2. Install workspace dependencies
pnpm install

# 3. Start local PostgreSQL container
docker compose up -d

# 4. Copy environment files
cp .env.example .env

# 5. Run database migrations
pnpm --filter @smart-seller/db migrate

# 6. Start fullstack development servers (API: 7100, Web: 7101)
pnpm dev
```

---

## 3. Essential Commands Cheat Sheet

| Task | Command | Description |
|:---|:---|:---|
| **Fullstack Dev** | `pnpm dev` | Starts API (`:7100`) and Frontend (`:7101`) concurrently |
| **API Only** | `pnpm dev:api` | Starts Hono backend server in watch mode |
| **Web Only** | `pnpm dev:web` | Starts Vite React frontend on port `7101` |
| **Typecheck** | `pnpm typecheck` | Validates TypeScript across all monorepo workspaces |
| **Linting** | `pnpm lint` | Runs ESLint with monorepo rules |
| **Testing** | `pnpm test` | Executes Vitest / Jest unit test suites |
| **Production Build**| `pnpm build` | Compiles API backend and bundles Vite frontend |

---

## 4. Coding Conventions & Lint Guidelines

### TypeScript & ESLint Rules
1. **`no-explicit-any`**: Always suppress with `// eslint-disable-next-line @typescript-eslint/no-explicit-any` or write a proper type.
2. **`ban-ts-comment`**: Never use `@ts-ignore`. Always use `// @ts-expect-error — <reason>`.
3. **`no-empty`**: Never leave `catch {}` empty. Always document why the error is non-fatal.
4. **Regular Expression Escaping**: In character classes `[...]`, place `-` at the start or end (e.g. `/[\d\s.()/-]/`).

### Git Commit Conventions
Follow Conventional Commits format (`type(scope): message`):
- `feat(assistant): add dynamic plan walkthrough generator`
- `fix(orders): resolve race condition in stock reservation`
- `chore(wiki): sync architecture documentation`

---

## 5. Non-Linear Debugging Runbook

When investigating bugs, follow the **Non-Linear Debugging** methodology:
1. **Bidirectional Cause-Effect Triangulation**: Trace backward from error sink and forward from user input.
2. **Multi-Hypothesis Superposition Matrix**: Formulate 2-3 competing hypotheses ($H_1, H_2, H_3$) before changing code.
3. **Bisecting Probes**: Insert targeted logging or assertions to eliminate hypotheses with maximum information gain.
