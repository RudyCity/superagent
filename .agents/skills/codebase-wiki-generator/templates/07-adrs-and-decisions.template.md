# 07. Architecture Decision Records (ADRs)

> [!NOTE]
> This document records significant architectural decisions, context, rationale, and consequences for **{{PROJECT_NAME}}**.

[⬅️ Back to Master Index](./00-index.md)

---

## 📜 ADR Index

| ADR ID | Title | Status | Date | Decision Summary |
|:---|:---|:---:|:---:|:---|
| [ADR-001](#adr-001-postgresql-as-sole-system-database) | PostgreSQL as Sole System Database | **Accepted** | 2026-08-01 | Replaced SQLite with centralized PostgreSQL for all environments |
| [ADR-002](#adr-002-dynamic-multi-provider-ai-routing) | Dynamic Multi-Provider AI Routing | **Accepted** | 2026-08-05 | Implemented runtime failover across OpenAI, Gemini & Anthropic |
| [ADR-003](#adr-003-strict-3-way-ai-domain-segregation) | Strict 3-Way AI Domain Segregation | **Accepted** | 2026-08-10 | Segregated Store Copilot, Customer Auto-Reply, and Playground |

---

## ADR-001: PostgreSQL as Sole System Database

### Context & Problem Statement
Previously, the system supported multiple database adapters including SQLite for local development. This led to schema divergence, unsupported concurrency locks, and migration incompatibilities between development and production.

### Considered Options
1. Keep dual SQLite (dev) + PostgreSQL (prod) support.
2. Adopt PostgreSQL via Docker Compose for all development and production environments.

### Decision Outcome
**Adopted Option 2**: Standardized exclusively on PostgreSQL.
- **Positive Consequences**: Single source of truth, exact migration consistency, native JSONB support, zero divergence bugs.
- **Negative Consequences**: Developers must have Docker installed locally.

---

## ADR-002: Dynamic Multi-Provider AI Routing

### Context & Problem Statement
Relying on a single AI provider causes availability risks during upstream provider outages or rate limits.

### Decision Outcome
**Accepted**: Built `@workspace/ai-provider-modules` to support dynamic fallback across OpenAI, Gemini, Anthropic, DeepSeek, and Groq with fast-fail deterministic execution when unconfigured.

---

## ADR-003: Strict 3-Way AI Domain Segregation

### Context & Problem Statement
Mixing internal store copilot instructions with customer-facing chat logic creates prompt leaks and authorization vulnerabilities.

### Decision Outcome
**Accepted**: Strict separation into 3 distinct flows:
1. **Store Copilot (`/assistant`)**: Operational business copilot for store owners.
2. **Customer Agent (`/agent`, `/inbox`)**: Customer auto-replies across WhatsApp/IG.
3. **Playground (`/playground`)**: Store owner prompt simulation sandbox.

---

## 📝 Blank ADR Template (MADR Format)

```markdown
## ADR-00X: [Short Title]

### Context & Problem Statement
[Describe the context and problem being solved]

### Considered Options
1. [Option 1]
2. [Option 2]

### Decision Outcome
**Chosen Option**: [Option Name]
- **Positive Consequences**: [Benefits]
- **Negative Consequences**: [Tradeoffs]
```
