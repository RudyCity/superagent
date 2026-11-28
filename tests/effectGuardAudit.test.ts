import { describe, expect, it } from "vitest";
import { findGuardRemovals, formatReport, splitAllowlisted } from "../scripts/audit-effect-guards.js";

function history(sha: string, file: string, lines: string[], subject = "refactor(observability): log effects"): string {
  return [
    `COMMIT\t${sha}\t2026-11-21\t${subject}`,
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,2 +1,2 @@",
    ...lines,
  ].join("\n");
}

describe("effect-guard audit parsing", () => {
  it("flags a guard deleted in the file where logging was added", () => {
    const text = history("322d0b50aa", "src/app.tsx", [
      "-        process.stdin.resume();",
      '+    logCli("App component mounted", {});',
    ]);

    const findings = findGuardRemovals(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ sha: "322d0b50aa", file: "src/app.tsx" });
    expect(findings[0].removed).toEqual(["process.stdin.resume();"]);
  });

  it("ignores a guard removed without logging, and logging added without a guard", () => {
    const guardOnly = history("aaaaaaaa", "src/app.tsx", ["-    clearInterval(timer);"]);
    const logOnly = history("bbbbbbbb", "src/app.tsx", ['+    logInput("focus changed");']);

    expect(findGuardRemovals(guardOnly)).toHaveLength(0);
    expect(findGuardRemovals(logOnly)).toHaveLength(0);
  });

  it("does not pair a guard in one file with logging in another", () => {
    const text = [
      "COMMIT\taaaaaaaa\t2026-11-21\tmixed",
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "-      process.stdin.pause();",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      '+      logCli("mounted");',
    ].join("\n");

    expect(findGuardRemovals(text)).toHaveLength(0);
  });

  it("reports every commit boundary instead of merging history", () => {
    const text = [
      history("11111111", "src/one.tsx", ["-      stream.pause();", '+      logCli("x");']),
      history("22222222", "src/two.tsx", ["-      timer.setRawMode(false);", '+      logDispatch("y");']),
    ].join("\n");

    const findings = findGuardRemovals(text);
    expect(findings.map((f) => f.sha)).toEqual(["11111111", "22222222"]);
  });

  it("separates reviewed commits from blocking ones by SHA prefix", () => {
    const findings = findGuardRemovals(
      [
        history("322d0b50aa", "src/app.tsx", ["-      process.stdin.resume();", '+      logCli("x");']),
        history("deadbeef99", "src/app.tsx", ["-      process.stdin.resume();", '+      logCli("x");']),
      ].join("\n")
    );

    const { blocking, allowed } = splitAllowlisted(findings, { "322d0b50": "restored in 1.14.126" });
    expect(allowed.map((f) => f.sha)).toEqual(["322d0b50aa"]);
    expect(blocking.map((f) => f.sha)).toEqual(["deadbeef99"]);
    expect(formatReport(blocking, allowed, { "322d0b50": "restored" })).toContain("1 regression(s) found");
  });
});
