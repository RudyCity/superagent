# Reference: C4 Architecture & Mermaid Diagram Guidelines

Guidelines for generating clean, robust, and accessible Mermaid diagrams within codebase wiki documents.

---

## 1. Node Label Escaping & Quoting Rules

> [!CAUTION]
> Special characters like `(`, `)`, `[`, `]`, `{`, `}`, `<`, `>`, and `"` inside Mermaid node labels WILL cause syntax errors if not strictly quoted.

**Correct Syntax:**
```mermaid
graph TD
    API["API Server (Hono / Node.js)"]
    DB[("Primary Database [PostgreSQL]")]
```

**Incorrect Syntax (Breaks Rendering):**
```text
graph TD
    API[API Server (Hono / Node.js)]  <-- Syntax Error!
    DB[(Primary Database [PostgreSQL])] <-- Syntax Error!
```

---

## 2. Standard Semantic Styling Classes (`classDef`)

Always use consistent color schemes across architecture diagrams:

```mermaid
graph TD
    classDef actor fill:#dbeafe,stroke:#1d4ed8,stroke-width:2px;
    classDef client fill:#e0e7ff,stroke:#4338ca,stroke-width:2px;
    classDef service fill:#dcfce7,stroke:#15803d,stroke-width:2px;
    classDef data fill:#fef3c7,stroke:#b45309,stroke-width:2px;
    classDef ext fill:#f3e8ff,stroke:#7e22ce,stroke-width:2px;

    User["👤 User"]:::actor
    Frontend["🖥️ Web UI"]:::client
    API["⚙️ Backend API"]:::service
    Database[("🗄️ Database")]:::data
    ThirdParty["🔌 External Provider"]:::ext

    User --> Frontend
    Frontend --> API
    API --> Database
    API --> ThirdParty
```

---

## 3. Sequence Diagram Standards

1. Always enable auto-numbering: `autonumber`.
2. Define participants explicitly with clear, human-readable aliases.
3. Use solid arrows (`->>`) for synchronous requests and dashed arrows (`-->>`) for responses.

```mermaid
sequenceDiagram
    autonumber
    actor Client as User Browser
    participant API as Backend Server
    participant DB as PostgreSQL

    Client->>API: POST /api/orders (Payload)
    API->>DB: INSERT INTO orders ...
    DB-->>API: Row Created (ID: ord-123)
    API-->>Client: HTTP 201 Created
```
