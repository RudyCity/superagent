# 03. API Catalog & Interface Contracts

> [!NOTE]
> This document provides the complete REST/RPC API specifications, authentication requirements, request/response payload schemas, error formats, and webhook integration guidelines.

[⬅️ Back to Master Index](./00-index.md)

---

## 1. Authentication & Security Headers

All protected API endpoints require JWT authentication and multi-tenant scoping headers:

| Header Name | Format / Example | Description |
|:---|:---|:---|
| `Authorization` | `Bearer <jwt_token>` | Standard Bearer JWT containing user identity & roles |
| `x-tenant-id` | `tm-xxxx` | Active tenant workspace context (validated against token claims) |
| `Content-Type` | `application/json` | Standard JSON payload format |
| `x-signature` | `sha256=<hex>` | Required for external webhook verification (HMAC-SHA256) |

---

## 2. Standardized Error Response Format

All error responses adhere to standard HTTP status codes and return a structured JSON body:

```json
{
  "success": false,
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "The requested order with ID 'ord-123' does not exist.",
    "details": [
      { "field": "orderId", "issue": "Invalid format or non-existent entity" }
    ],
    "timestamp": "2026-08-15T07:30:00Z"
  }
}
```

| HTTP Status | Error Code | Common Cause |
|:---|:---|:---|
| `400 Bad Request` | `VALIDATION_ERROR` | Schema validation failed on query, params, or body |
| `401 Unauthorized` | `UNAUTHORIZED` | Missing, expired, or invalid JWT Bearer token |
| `403 Forbidden` | `FORBIDDEN` | User role lacks sufficient permissions (RBAC) |
| `404 Not Found` | `NOT_FOUND` | Target entity does not exist within the tenant scope |
| `409 Conflict` | `CONFLICT` | Unique constraint violation (e.g. duplicate email/SKU) |
| `500 Internal Error` | `INTERNAL_SERVER_ERROR` | Unhandled backend exception or database failure |

---

## 3. Automated Route Catalog Inventory

<!-- API_CATALOG_START -->
| Method | Endpoint Route | Auth Guard | Description | Source File |
|:---|:---|:---|:---|:---|
| `POST` | `/api/auth/login` | Public | Authenticates store user and returns JWT token | [auth.ts:24](file:///apps/api/src/routes/auth.ts#L24) |
| `GET` | `/api/assistant/sessions` | Tenant Admin | Retrieves all active AI assistant sessions for tenant | [assistant.ts:45](file:///apps/api/src/routes/assistant.ts#L45) |
| `POST` | `/api/assistant/chat` | Tenant Admin | Sends prompt to store copilot and executes plan loop | [assistant.ts:89](file:///apps/api/src/routes/assistant.ts#L89) |
| `GET` | `/api/orders` | Store Manager | Lists orders with pagination, status filter, and date range | [orders.ts:32](file:///apps/api/src/routes/orders.ts#L32) |
| `POST` | `/api/orders` | Store Manager | Creates a new order and reserves product stock | [orders.ts:68](file:///apps/api/src/routes/orders.ts#L68) |
| `POST` | `/webhooks/laris` | HMAC Signature | Receives partner and payment subscription callbacks | [webhooks.ts:18](file:///apps/api/src/routes/webhooks.ts#L18) |
<!-- API_CATALOG_END -->

---

## 4. Key Endpoint Contracts & Payloads

### A. AI Assistant Chat Stream (`POST /api/assistant/chat`)

**Request Payload:**
```json
{
  "sessionId": "sess-987",
  "prompt": "Analisis performa penjualan 7 hari terakhir dan buatkan draf diskon untuk produk terlaris.",
  "attachments": []
}
```

**Response Stream:**  
Server-Sent Events (SSE) or chunked JSON containing assistant text parts, collapsible action badges for tool calls, and plan approval cards.

---

### B. Order Creation (`POST /api/orders`)

**Request Payload:**
```json
{
  "customerName": "Rudi Pratama",
  "customerPhone": "08123456789",
  "shippingAddress": "Jl. Sudirman No. 45, Jakarta Selatan",
  "items": [
    { "productId": "prod-001", "quantity": 2, "unitPrice": 150000 }
  ],
  "paymentMethod": "qris"
}
```

**Response (HTTP 201 Created):**
```json
{
  "success": true,
  "data": {
    "orderId": "ord-88192",
    "totalAmount": 300000,
    "status": "pending",
    "paymentUrl": "https://pay.smart-seller.com/invoice/ord-88192",
    "createdAt": "2026-08-15T07:30:00Z"
  }
}
```
