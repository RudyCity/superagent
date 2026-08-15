# 01. System Architecture & C4 Topology

> [!NOTE]
> This document details the high-level system architecture, C4 context and container diagrams, monorepo structure, and core technical design principles of **{{PROJECT_NAME}}**.

[⬅️ Back to Master Index](./00-index.md)

---

## 1. C4 Model — System Context (Level 1)

The Context Diagram illustrates the boundary of {{PROJECT_NAME}} and how external users and systems interact with it.

```mermaid
graph TD
    classDef user fill:#e0e7ff,stroke:#4338ca,stroke-width:2px;
    classDef core fill:#dcfce7,stroke:#15803d,stroke-width:2px;
    classDef ext fill:#fef3c7,stroke:#b45309,stroke-width:2px;

    AdminUser["👤 Store Admin / Manager<br/>[Role: TENANT_ADMIN]"]:::user
    PlatformSuperAdmin["👑 Platform Superadmin<br/>[Role: SUPER_ADMIN]"]:::user
    Customer["💬 End Customer<br/>[WhatsApp / Web]"]:::user

    subgraph System Boundary
        SmartSeller["🏢 {{PROJECT_NAME}} Platform<br/>[Core Web & API System]"]:::core
    end

    subgraph External Systems
        AIProvider["🤖 AI Providers<br/>[OpenAI, Anthropic, Gemini]"]:::ext
        PaymentGateways["💳 Payment Gateways<br/>[Midtrans, Xendit]"]:::ext
        MessagingChannels["📱 Messaging Channels<br/>[Meta Cloud API / WA]"]:::ext
    end

    AdminUser -->|"Manages store, reviews AI, audits analytics"| SmartSeller
    PlatformSuperAdmin -->|"Configures tenants, plans & AI failover"| SmartSeller
    Customer -->|"Sends inquiries & places orders"| MessagingChannels
    MessagingChannels -->|"Webhooks & inbound events"| SmartSeller
    SmartSeller -->|"Generates smart replies & tools"| AIProvider
    SmartSeller -->|"Creates payment links & webhooks"| PaymentGateways
```

---

## 2. C4 Model — Container Architecture (Level 2)

The Container Diagram shows the high-level executable components, data stores, and communication protocols.

```mermaid
graph TD
    classDef client fill:#dbeafe,stroke:#1d4ed8,stroke-width:2px;
    classDef server fill:#dcfce7,stroke:#16a34a,stroke-width:2px;
    classDef db fill:#fef3c7,stroke:#d97706,stroke-width:2px;
    classDef cache fill:#ffedd5,stroke:#ea580c,stroke-width:2px;

    subgraph Client Layer
        WebUI["🖥️ Web Frontend<br/>(React 19 + Vite + TanStack Router)<br/>Port: 7101"]:::client
    end

    subgraph Backend Services Layer
        HonoAPI["⚙️ Backend API Server<br/>(Hono.js + TypeScript + Node.js)<br/>Port: 7100"]:::server
    end

    subgraph Data & Storage Layer
        PostgresDB[("🗄️ Primary PostgreSQL DB<br/>(Single Source of Truth)<br/>Port: 5433 (dev)")]:::db
        VectorStore[("🧠 Vector Memory / RAG<br/>(Embeddings & FAQ Store)")]:::db
    end

    WebUI -->|"HTTP REST / JSON<br/>Bearer JWT Auth"| HonoAPI
    HonoAPI -->|"SQL Queries / Migrations<br/>Connection Pool"| PostgresDB
    HonoAPI -->|"Similarity Search<br/>Knowledge Vector Search"| VectorStore
```

---

## 3. Technology Stack Matrix

| Layer / Concern | Technology Selection | Rationale & Tradeoffs |
|:---|:---|:---|
| **Web Frontend** | React 19, Vite 7, TanStack Router & Query v5 | Maximum performance, fine-grained routing, and optimistic UI mutations |
| **Styling & UI** | Tailwind CSS v4, Radix UI Primitives, Lucide Icons | Accessible, responsive, zero-runtime CSS footprint |
| **Backend API** | Hono.js on Node.js runtime | Ultra-lightweight, high throughput, TypeScript native |
| **Primary Database** | PostgreSQL (`DATABASE_URL`) | ACID compliance, robust multi-tenancy, relational integrity |
| **AI Integration** | Dynamic Multi-Provider Routing (OpenAI, Gemini, Anthropic) | Token telemetry, failover resilience, zero-vendor lock-in |
| **Security & Scanning** | File Scanner & Prompt Injection Sanitizer | Defense-in-depth against malicious uploads and prompt leaks |

---

## 4. Architectural & Design Principles

1. **PostgreSQL as Single Source of Truth**:  
   All tenant records, user permissions, AI configurations, conversations, and audit logs are stored centrally in PostgreSQL.
2. **Strict Multi-Tenant Segregation**:  
   Every tenant query is scoped by `tenant_id` at the database level with role-based access control (RBAC).
3. **Decoupled AI Tool Ecosystem**:  
   Store copilot capabilities are modularized into separate, pure-functional tools (`managePlans`, `manageTasks`, `manageOrders`, `shippingAssistant`, etc.).
4. **Resilient Fast-Fail & Fallback Routing**:  
   When AI keys are unconfigured or fail, background tasks seamlessly fall back to deterministic execution without blocking the user.
