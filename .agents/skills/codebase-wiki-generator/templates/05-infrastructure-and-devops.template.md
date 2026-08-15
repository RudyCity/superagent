# 05. Infrastructure, DevOps & Deployment

> [!NOTE]
> This document details the container infrastructure, environment variables matrix, CI/CD pipelines, logging architecture, and health monitoring of **{{PROJECT_NAME}}**.

[⬅️ Back to Master Index](./00-index.md)

---

## 1. Container Infrastructure & Topology

The development and staging environments run via Docker Compose:

```mermaid
graph TD
    classDef app fill:#e0f2fe,stroke:#0284c7,stroke-width:2px;
    classDef db fill:#fef3c7,stroke:#d97706,stroke-width:2px;

    subgraph Docker Network: smart-seller-net
        API_CONTAINER["smart-seller-api<br/>(Hono Server)<br/>Port: 7100:7100"]:::app
        DB_CONTAINER["smart-seller-db<br/>(PostgreSQL 16)<br/>Port: 5433:5432"]:::db
    end

    API_CONTAINER -->|"TCP Connection (DATABASE_URL)"| DB_CONTAINER
```

### Docker Compose Configuration
- **Database Service**: `smart-seller-db`
- **Host Port Mapping**: `5433:5432` (Development) / `5432:5432` (Production)
- **Persistent Volume**: `pgdata_smart_seller`

---

## 2. Environment Variables Matrix

| Variable Name | Required | Secret | Default (Dev) | Purpose & Usage |
|:---|:---:|:---:|:---|:---|
| `DATABASE_URL` | Yes | Yes | `postgresql://postgres:postgres@localhost:5433/smart_seller` | Primary PostgreSQL connection string |
| `PORT` | No | No | `7100` | Backend API HTTP listen port |
| `JWT_SECRET` | Yes | Yes | `dev-super-secret-key-32-chars-min` | Secret key used to sign and verify session JWTs |
| `OPENAI_API_KEY` | Optional | Yes | - | OpenAI API key for GPT-4o / embeddings |
| `ANTHROPIC_API_KEY`| Optional | Yes | - | Anthropic Claude API key for copilot reasoning |
| `GEMINI_API_KEY` | Optional | Yes | - | Google Gemini 2.5/3.0 Pro & Flash API key |
| `LARIS_API_URL` | No | No | `http://localhost:7001` | Laris.click integration endpoint (dev) |
| `LARIS_CLIENT_SECRET`| Yes | Yes | `secret_smart_seller_12345` | Webhook HMAC verification secret |

---

## 3. Log Architecture & Monitoring

Log files are stored in `apps/api/data/logs/` with automatic **5MB log rotation** (`.bak` renaming):

| Log File | Owning Flow | Description & Events Captured |
|:---|:---|:---|
| `e2e-workflow.log` | AI CS Agent | End-to-end messaging pipeline: Ingest $\rightarrow$ OCR $\rightarrow$ RAG $\rightarrow$ LLM $\rightarrow$ Dispatch |
| `ai-tools-use.log` | Store Copilot | Tool invocations: tool name, arguments, execution duration, and success payloads |
| `ai-tools-error.log`| Store Copilot | Tool execution errors, stack traces, and failover triggers |
| `ai-assistant-session.log` | Store Copilot | Session telemetry: token usage, AI provider, model selection, duration |
| `ai-prompt-io.log` | All AI Flows | Raw system prompts, context messages, and raw LLM model responses |

---

## 4. Health Check & Diagnostics Endpoints

- `GET /health`: Basic liveness check returning `{ status: "ok", timestamp: "..." }`.
- `GET /api/system/workflow-logs`: Reads recent entries from `e2e-workflow.log`.
- `GET /api/system/tool-logs`: Reads recent tool execution logs.
- `GET /platform/system/logs/prompt-io`: Platform superadmin view of AI input/output telemetry.
