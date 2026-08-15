# 02. Domain Entities, Schemas & ERD

> [!NOTE]
> This document details the database architecture, Entity-Relationship Diagram (ERD), schema catalog, lifecycle state machines, and data retention policies.

[⬅️ Back to Master Index](./00-index.md)

---

## 1. Entity-Relationship Diagram (Mermaid ERD)

```mermaid
erDiagram
    TENANTS ||--o{ USERS : "employs"
    TENANTS ||--o{ ORDERS : "owns"
    TENANTS ||--o{ ASSISTANT_SESSIONS : "holds"
    TENANTS ||--o{ AUDIT_LOGS : "generates"
    
    ORDERS ||--|{ ORDER_ITEMS : "contains"
    ORDERS ||--o{ SHIPMENTS : "dispatches"
    
    ASSISTANT_SESSIONS ||--o{ ASSISTANT_MESSAGES : "contains"
    ASSISTANT_SESSIONS ||--o{ IMPLEMENTATION_PLANS : "proposes"
    IMPLEMENTATION_PLANS ||--o{ PLAN_TASKS : "executes"

    TENANTS {
        string id PK "tm-xxx"
        string name "Tenant Business Name"
        string plan_tier "basic | pro | enterprise"
        string status "active | suspended"
        timestamp created_at
    }

    USERS {
        string id PK
        string tenant_id FK
        string email UK
        string password_hash
        string role "SUPER_ADMIN | TENANT_ADMIN | STORE_MANAGER | CUSTOMER_AGENT"
        boolean is_active
        timestamp created_at
    }

    ORDERS {
        string id PK
        string tenant_id FK
        string customer_name
        string customer_phone
        numeric total_amount
        string status "pending | paid | processing | shipped | delivered | cancelled"
        timestamp created_at
    }

    ORDER_ITEMS {
        string id PK
        string order_id FK
        string product_id
        string product_name
        int quantity
        numeric unit_price
        numeric subtotal
    }

    ASSISTANT_SESSIONS {
        string id PK
        string tenant_id FK
        string title
        string active_plan_id
        timestamp created_at
        timestamp updated_at
    }

    ASSISTANT_MESSAGES {
        string id PK
        string session_id FK
        string role "user | assistant | system"
        text content
        jsonb tool_calls_json
        timestamp created_at
    }

    IMPLEMENTATION_PLANS {
        string id PK
        string session_id FK
        string title
        string status "proposed | approved | in_progress | completed | failed | cancelled"
        jsonb tasks_json
        text walkthrough_summary
        timestamp created_at
    }

    AUDIT_LOGS {
        string id PK
        string tenant_id FK
        string actor_id
        string action_type
        jsonb payload
        string ip_address
        timestamp created_at
    }
```

---

## 2. Core Entity Catalog

| Entity / Table Name | Primary Key | Foreign Keys | Business Responsibility | Indexing & Constraints |
|:---|:---|:---|:---|:---|
| `tenants` | `id` (string) | - | Root multi-tenancy boundary and billing tier | Index on `status`, Unique on `name` |
| `users` | `id` (string) | `tenant_id` $\rightarrow$ `tenants.id` | User accounts, credentials, and RBAC roles | Unique on `(tenant_id, email)`, Index on `role` |
| `orders` | `id` (string) | `tenant_id` $\rightarrow$ `tenants.id` | Transaction records, totals, and fulfillment state | B-Tree on `(tenant_id, created_at)`, Index on `status` |
| `order_items` | `id` (string) | `order_id` $\rightarrow$ `orders.id` | Line items and pricing snapshot per order | Index on `order_id` |
| `assistant_sessions` | `id` (string) | `tenant_id` $\rightarrow$ `tenants.id` | AI Store Copilot conversation threads | Index on `(tenant_id, updated_at DESC)` |
| `assistant_messages` | `id` (string) | `session_id` $\rightarrow$ `assistant_sessions.id` | Chat messages with structured tool call payloads | Index on `(session_id, created_at ASC)` |
| `audit_logs` | `id` (string) | `tenant_id` $\rightarrow$ `tenants.id` | Compliance, security trace & modification audit trail | Composite Index on `(tenant_id, created_at DESC)` |

---

## 3. State Machines & Status Transitions

### A. Order Fulfillment State Machine
```mermaid
stateDiagram-v2
    [*] --> Pending : Customer places order
    Pending --> Paid : Payment gateway callback
    Pending --> Cancelled : Timeout / Customer cancel
    Paid --> Processing : Warehouse confirms stock
    Processing --> Shipped : Waybill / Tracking issued
    Shipped --> Delivered : Courier delivery confirmed
    Delivered --> [*]
    Cancelled --> [*]
```

### B. AI Implementation Plan Execution State Machine
```mermaid
stateDiagram-v2
    [*] --> Proposed : AI proposes plan
    Proposed --> Approved : Store owner approves plan
    Proposed --> Cancelled : Store owner rejects plan
    Approved --> InProgress : Execution loop initiates
    InProgress --> WaitingForInput : Destructive action (askUser)
    WaitingForInput --> InProgress : User confirms
    InProgress --> Completed : All tasks finished & Walkthrough generated
    InProgress --> Failed : Unrecoverable task failure
    Completed --> [*]
    Failed --> [*]
    Cancelled --> [*]
```

---

## 4. Migrations & Database Management

Migrations are stored in `packages/db/migrations` or managed via the backend database service.

```powershell
# Run database migrations
pnpm --filter @smart-seller/db migrate

# Seed development sample data
pnpm --filter @smart-seller/db seed
```
