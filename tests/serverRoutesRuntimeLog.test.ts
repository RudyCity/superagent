import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverRoutesSource = readFileSync(path.join(repoRoot, "src", "serverRoutes.ts"), "utf8");

// Text guards are assembled from fragments so this file never matches the
// patterns it forbids elsewhere in the repository.
const WARN_PREFIX = "[WARN] ";
const RESUME_WARNING_CALL = `console.warn(\`${WARN_PREFIX}\${resumeWarning}\`)`;
const RESUME_WARNING_REPLACEMENT = `serverRuntimeLog("warn", \`${WARN_PREFIX}\${resumeWarning}\`)`;
const DAG_CATCH_REPLACEMENT = `catch((error) => serverRuntimeLog("error", "[Motion] DAG execution failed:", error))`;
const FORBIDDEN_DAG_CATCH = ".catch(" + "console.error)";

describe("serverRoutes runtime logging policy", () => {
  it("imports serverRuntimeLog from the shared runtime log module", () => {
    expect(serverRoutesSource).toContain('from "./core/utils/runtimeLog.js"');
    expect(serverRoutesSource).toMatch(/import\s*\{[^}]*\bserverRuntimeLog\b[^}]*\}\s*from\s*"\.\/core\/utils\/runtimeLog\.js";/);
  });

  it("routes the session resume warning through serverRuntimeLog", () => {
    expect(serverRoutesSource).toContain(RESUME_WARNING_REPLACEMENT);
  });

  it("routes Motion DAG execution failures through serverRuntimeLog", () => {
    expect(serverRoutesSource).toContain(DAG_CATCH_REPLACEMENT);
  });

  it("no longer bypasses the policy with raw console calls", () => {
    expect(serverRoutesSource).not.toContain(FORBIDDEN_DAG_CATCH);
    expect(serverRoutesSource).not.toContain(RESUME_WARNING_CALL);
  });
});
