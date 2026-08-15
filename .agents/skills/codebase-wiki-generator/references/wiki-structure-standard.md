# Reference: Wiki Structure & Documentation Standard

Defines file naming conventions, folder taxonomy, link structures, and content formatting requirements for all generated wiki pages.

---

## 1. Directory & File Naming Conventions

All wiki files must follow the numeric prefix scheme:

```text
docs/wiki/
├── 00-index.md
├── 01-architecture-overview.md
├── 02-domain-models-and-data.md
├── 03-api-and-contracts.md
├── 04-features-and-workflows.md
├── 05-infrastructure-and-devops.md
├── 06-developer-onboarding.md
└── 07-adrs-and-decisions.md
```

### Rules:
- Lowercase with hyphens (`01-architecture-overview.md`).
- Two-digit prefix (`00`, `01`, `02`, ...) to ensure natural alphabetical and reading order in IDE file explorers and GitHub web UI.
- Every page (except `00-index.md`) MUST include a breadcrumb link at the top: `[⬅️ Back to Master Index](./00-index.md)`.

---

## 2. Linking & Source Code Reference Standards

When referencing code in markdown:
- Use clickable file links with line numbers: `[auth.ts:45](file:///apps/api/src/routes/auth.ts#L45-L60)`.
- Use relative markdown links between wiki pages: `[02-domain-models-and-data.md](./02-domain-models-and-data.md#1-entity-relationship-diagram-mermaid-erd)`.
- Do not use absolute local paths like `C:\Users\...` in committed markdown files.

---

## 3. GitHub-Flavored Callout Alerts

Use alerts sparingly to highlight key technical takeaways:
- `> [!NOTE]` — General background context or domain rules.
- `> [!TIP]` — Performance tips, CLI shortcuts, or best practices.
- `> [!IMPORTANT]` — Essential requirements, security constraints, or prerequisites.
- `> [!WARNING]` — Deprecation notices, rate limit constraints, or breaking change risks.
- `> [!CAUTION]` — High-risk destructive actions or database mutation risks.
