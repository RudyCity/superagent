# 04. Core Business Features & Workflows

> [!NOTE]
> This document details the end-to-end operational workflows, sequence diagrams, state transitions, and business logic rules across {{PROJECT_NAME}}.

[⬅️ Back to Master Index](./00-index.md)

---

## 1. Domain Feature Map

```mermaid
graph TD
    classDef owner fill:#e0f2fe,stroke:#0284c7,stroke-width:2px;
    classDef agent fill:#f0fdf4,stroke:#16a34a,stroke-width:2px;
    classDef system fill:#fef3c7,stroke:#d97706,stroke-width:2px;

    subgraph Store Owner Copilot Layer (/assistant)
        DOC_SCAN["OCR & File Scanner<br/>(PDF, Invoices, CSV)"]:::owner
        PLAN_EXEC["Dynamic Plan Execution<br/>(11 Unified Tools)"]:::owner
        SALES_AUDIT["Sales & Inventory Analytics"]:::owner
    end

    subgraph Customer Agent Auto-Reply Layer (/agent, /inbox)
        INBOX_INGEST["WhatsApp / Channel Ingest"]:::agent
        RAG_MEMORY["Vector RAG / FAQ Match"]:::agent
        AUTO_DISPATCH["Response Dispatcher"]:::agent
    end

    subgraph Core Platform Operations
        ORDER_FLOW["Order & Payment Processing"]:::system
        TENANT_SYNC["Multi-Tenant Sync & Provisioning"]:::system
    end

    DOC_SCAN --> PLAN_EXEC
    PLAN_EXEC --> RAG_MEMORY
    INBOX_INGEST --> RAG_MEMORY
    RAG_MEMORY --> AUTO_DISPATCH
    AUTO_DISPATCH --> ORDER_FLOW
```

---

## 2. Feature Deep-Dives & Sequence Flows

### A. Store Owner Copilot & Dynamic Plan Execution

The Store Copilot enables store owners to execute complex operational workflows using 11 unified tools (`managePlans`, `manageTasks`, `manageOrders`, `shippingAssistant`, etc.).

```mermaid
sequenceDiagram
    autonumber
    actor Owner as Store Owner
    participant Web as Web Frontend (/assistant)
    participant API as Hono API Server
    participant Advisor as Assistant Advisor
    participant AI as AI Provider (Failover Router)
    participant DB as PostgreSQL

    Owner->>Web: "Analisis penjualan dan buat promo diskon 15%"
    Web->>API: POST /api/assistant/chat
    API->>DB: Load Session & Message History
    API->>AI: Stream Prompt + 11 Available Tools
    AI-->>API: Tool Call: managePlans(action='propose', tasks=[...])
    API->>DB: Save Implementation Plan (Status: Proposed)
    API-->>Web: Render PlanApprovalCard UI
    
    Owner->>Web: Click "⚡ Setujui & Jalankan Plan"
    Web->>API: POST /api/assistant/plans/:id/approve
    API->>API: runPlanExecutionLoop (Unlimited maxSteps)
    
    loop For each Plan Task
        API->>AI: Execute Next Task with Tools
        AI-->>API: Tool Execution Payload
        API->>DB: Update Task Status (in_progress -> completed)
        API->>Advisor: Supervise Task Output
    end
    
    API->>AI: Request Final Walkthrough Summary
    AI-->>API: managePlans(action='walkthrough', summary=...)
    API->>DB: Mark Plan as Completed
    API-->>Web: Render Completion Toast & Walkthrough
```

---

### B. Customer Messaging Ingestion & Auto-Reply Flow

```mermaid
sequenceDiagram
    autonumber
    actor Cust as Customer
    participant WA as WhatsApp / Meta API
    participant API as Hono Webhook Handler
    participant Guard as SanGuard Scanner
    participant RAG as Vector Memory (rMemory)
    participant LLM as Customer Auto-Reply LLM

    Cust->>WA: "Apakah produk Serum Glow ready stock?"
    WA->>API: Inbound Webhook Event
    API->>Guard: Scan & Sanitize Prompt Input
    Guard-->>API: Sanitized Clean Text
    API->>RAG: Query Knowledge Base & Product Inventory
    RAG-->>API: Return Matched Stock & FAQ Answer
    API->>LLM: Generate Brand-Voiced Reply
    LLM-->>API: "Hai Kak, Serum Glow ready stock! Silakan checkout di link..."
    API->>WA: Dispatch Outbound Message
    WA-->>Cust: Deliver Reply
```

---

## 3. Business Edge Cases & Failure Recovery

| Edge Case / Scenario | System Behavior & Mitigation |
|:---|:---|
| **AI Provider Outage (OpenAI 500 / 429)** | AI Failover Router switches dynamically to Anthropic or Gemini. If all unconfigured, falls back to deterministic execution (`executeTaskDirectly`). |
| **Destructive Store Actions (Delete/Cancel)** | AI Copilot is strictly prohibited from direct execution. Must trigger `askUser` confirmation prompt first. |
| **Malicious File Upload** | `SanCleanFiles` scanner neutralizes macros, scripts, and suspicious mime-types before OCR parsing. |
| **High Concurrency Rate Limits** | Token telemetry throttles outbound requests using sliding window rate limiter with exponential backoff. |
