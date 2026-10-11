import { describe, it, expect } from "vitest";
import { APICallError, RetryError } from "ai";
import { formatError } from "../src/core/agent/AgentEvents.js";
import {
  extractErrorStatusCode,
  extractErrorResponseBody,
  isRetryableError,
} from "../src/core/agent/AgentUtils.js";

describe("Provider Error Unwrapping and Formatting", () => {
  it("extracts status code and response body from APICallError", () => {
    const apiErr = new APICallError({
      message: "Provider returned error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 502,
      responseBody: JSON.stringify({ error: { message: "Provider returned error", code: 502 } }),
    });

    expect(extractErrorStatusCode(apiErr)).toBe(502);
    expect(extractErrorResponseBody(apiErr)).toContain("Provider returned error");
  });

  it("extracts status code and response body from nested RetryError", () => {
    const apiErr = new APICallError({
      message: "Provider returned error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 502,
      responseBody: JSON.stringify({ error: { message: "Provider returned error", code: 502 } }),
    });
    const retryErr = new RetryError({
      message: "Failed after 3 attempts. Last error: Provider returned error",
      reason: "maxRetriesExceeded",
      errors: [apiErr],
    });

    expect(extractErrorStatusCode(retryErr)).toBe(502);
    expect(extractErrorResponseBody(retryErr)).toContain("502");
  });

  it("correctly identifies non-retryable 402 Payment Required even when wrapped in RetryError", () => {
    const payErr = new APICallError({
      message: "Provider returned error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 402,
      responseBody: JSON.stringify({ error: { message: "Provider returned error", code: 402 } }),
    });
    const retryErr = new RetryError({
      message: "Failed after 3 attempts. Last error: Provider returned error",
      reason: "maxRetriesExceeded",
      errors: [payErr],
    });

    expect(isRetryableError(payErr)).toBe(false);
    expect(isRetryableError(retryErr)).toBe(false);
  });

  it("correctly identifies non-retryable 401 Unauthorized even when wrapped in RetryError", () => {
    const authErr = new APICallError({
      message: "Provider returned error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 401,
      responseBody: JSON.stringify({ error: { message: "Unauthorized", code: 401 } }),
    });
    const retryErr = new RetryError({
      message: "Failed after 3 attempts. Last error: Provider returned error",
      reason: "maxRetriesExceeded",
      errors: [authErr],
    });

    expect(isRetryableError(authErr)).toBe(false);
    expect(isRetryableError(retryErr)).toBe(false);
  });

  it("formats OpenRouter 502 with metadata and hint", () => {
    const apiErr = new APICallError({
      message: "Provider returned error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 502,
      responseBody: JSON.stringify({
        error: {
          message: "Provider returned error",
          code: 502,
          metadata: { provider_name: "Anthropic", raw: "overloaded upstream" },
        },
      }),
    });
    const retryErr = new RetryError({
      message: "Failed after 3 attempts. Last error: Provider returned error",
      reason: "maxRetriesExceeded",
      errors: [apiErr],
    });

    const formatted = formatError(retryErr);
    expect(formatted).toContain("Provider returned error");
    expect(formatted).toContain("status: 502");
    expect(formatted).toContain("Anthropic: overloaded upstream");
    expect(formatted).toContain("502 Bad Gateway");
    expect(formatted).not.toContain("Failed after 3 attempts");
  });

  it("formats 402 balance depleted with helpful hint", () => {
    const apiErr = new APICallError({
      message: "Provider returned error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 402,
      responseBody: JSON.stringify({ error: { message: "Credit required", code: 402 } }),
    });

    const formatted = formatError(apiErr);
    expect(formatted).toContain("status: 402");
    expect(formatted).toContain("Provider balance or credits depleted");
  });
});
