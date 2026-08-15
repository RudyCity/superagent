# Reference: Domain-Driven Mapping & Clean Architecture Separation

A guide to distinguishing pure business domain logic from infrastructure adapters when documenting monorepos and backend services.

---

## 1. Clean Architecture Onion Model

```
┌────────────────────────────────────────────────────────┐
│ 1. External Frameworks & Drivers (Vite, Hono, Docker)  │
│   ┌──────────────────────────────────────────────────┐ │
│   │ 2. Interface Adapters (Controllers, Repositories)│ │
│   │   ┌────────────────────────────────────────────┐ │ │
│   │   │ 3. Application Use Cases (Order Service)   │ │ │
│   │   │   ┌──────────────────────────────────────┐ │ │ │
│   │   │   │ 4. Domain Entities & Business Rules  │ │ │ │
│   │   │   └──────────────────────────────────────┘ │ │ │
│   │   └────────────────────────────────────────────┘ │ │
│   └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

---

## 2. Documentation Separation Guidelines

| Layer | Codebase Location | Wiki Section | Content Focus |
|:---|:---|:---|:---|
| **Domain Entities** | `packages/core`, `models/`, `entities/` | `02-domain-models-and-data.md` | Pure business entities, invariant validations, and state machines. |
| **Application Use Cases**| `services/`, `features/`, `use-cases/` | `04-features-and-workflows.md` | Business workflows, task loops, AI advisors, sequence flows. |
| **Interface Adapters** | `routes/`, `controllers/`, `gateways/` | `03-api-and-contracts.md` | REST/RPC controllers, request DTOs, response schemas, error mappers. |
| **Frameworks & Infra** | `docker/`, `db/migrations/`, `configs/` | `05-infrastructure-and-devops.md` | PostgreSQL connections, Docker compose, CI/CD, log rotators. |
