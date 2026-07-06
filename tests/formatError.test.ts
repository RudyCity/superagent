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
});
