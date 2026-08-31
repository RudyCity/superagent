import { describe, it, expect } from "vitest";
import { formatError } from "../src/core/agent.js";

describe("formatError", () => {
  it("should format a simple Error object", () => {
    const err = new Error("Simple error message");
    expect(formatError(err)).toBe("Simple error message");
  });

  it("should extract status and text from a top-level error object", () => {
    const err = {
      message: "API error",
      statusCode: 400,
      text: "Raw response body content",
    };
    expect(formatError(err)).toBe(
      "API error (status: 400) - response body snippet: \"Raw response body content\""
    );
  });

  it("should recursively extract status, responseBody, and cause from a nested error chain", () => {
    const rootCause = {
      message: "Upstream request failed",
      status: 502,
      responseBody: "<html>Bad Gateway</html>",
    };
    const err = new Error("Failed after 3 attempts. Last error: Upstream request failed", {
      cause: rootCause,
    });
    
    const formatted = formatError(err);
    expect(formatted).toContain("Failed after 3 attempts. Last error: Upstream request failed");
    expect(formatted).toContain("(status: 502)");
    expect(formatted).toContain("response body snippet: \"<html>Bad Gateway</html>\"");
  });

  it("should format string or other non-object inputs", () => {
    expect(formatError("Plain string error")).toBe("Plain string error");
    expect(formatError(null)).toBe("Unknown error");
    expect(formatError(undefined)).toBe("Unknown error");
  });

  it("should unwrap a nested error.details JSON blob and surface the real cause", () => {
    // Mirrors the shape returned by OpenAI-compatible providers that wrap
    // upstream errors as a stringified JSON inside `error.details`. The outer
    // wrapper is just "Backend request failed with status 400" and hides the
    // real reason.
    const realCause = { type: "error", error: { type: "invalid_request_error", message: "Model id 'MiniMaxAI/MiniMax-M3' is ambiguous: matched multiple models" } };
    const wrapped = {
      message: "Backend request failed with status 400",
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          message: "Backend request failed with status 400",
          type: "backend_error",
          code: 400,
          details: JSON.stringify(realCause),
        },
      }),
    };
    const formatted = formatError(wrapped);
    expect(formatted).toContain("Backend request failed with status 400");
    expect(formatted).toContain("(status: 400)");
    // The inner upstream message should now be surfaced.
    expect(formatted).toMatch(/\[upstream:.*ambiguous: matched multiple models/);
    // And the friendly hint should be appended.
    expect(formatted).toContain("[hint: check the active preset's model name");
  });

  it("should extend the response body snippet to 600 chars (was 150)", () => {
    const longBody = "x".repeat(800);
    const err = {
      message: "API error",
      statusCode: 400,
      text: longBody,
    };
    const formatted = formatError(err);
    // Snippet should now contain up to 600 chars before the "..." marker.
    expect(formatted).toContain("x".repeat(600));
    expect(formatted).toContain("...");
  });

  it("should NOT add the hint when the 400 is unrelated to model ids", () => {
    const err = {
      message: "Backend request failed with status 400",
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          message: "Backend request failed with status 400",
          type: "backend_error",
          code: 400,
          details: JSON.stringify({ error: { message: "Invalid API key" } }),
        },
      }),
    };
    const formatted = formatError(err);
    expect(formatted).not.toContain("[hint: check the active preset");
    // The upstream message should still be surfaced.
    expect(formatted).toMatch(/\[upstream:.*Invalid API key/);
  });
});
