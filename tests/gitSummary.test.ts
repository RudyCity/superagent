import { describe, expect, it } from "vitest";
import { getGitDiffSummary, type GitSnapshot } from "../src/core/agent.js";

describe("git edits summary formatting", () => {
  it("returns null if end snapshot is null", () => {
    const start: GitSnapshot = { "file1.ts": { added: 1, deleted: 0 } };
    expect(getGitDiffSummary(start, null)).toBeNull();
  });

  it("calculates positive addition and deletion differences correctly", () => {
    const start: GitSnapshot = {
      "file1.ts": { added: 2, deleted: 1 },
      "file2.ts": { added: 0, deleted: 0 }
    };
    const end: GitSnapshot = {
      "file1.ts": { added: 5, deleted: 3 },
      "file2.ts": { added: 1, deleted: 0 }
    };

    const summary = getGitDiffSummary(start, end);
    expect(summary).toContain("- file1.ts: +3, -2");
    expect(summary).toContain("- file2.ts: +1");
  });

  it("handles new untracked files correctly", () => {
    const start: GitSnapshot = {};
    const end: GitSnapshot = {
      "new-file.ts": { added: 10, deleted: 0 }
    };

    const summary = getGitDiffSummary(start, end);
    expect(summary).toBe("- new-file.ts: +10");
  });

  it("handles negative differences (reverts/restorations) correctly", () => {
    const start: GitSnapshot = {
      "file1.ts": { added: 5, deleted: 3 }
    };
    const end: GitSnapshot = {
      "file1.ts": { added: 3, deleted: 1 }
    };

    const summary = getGitDiffSummary(start, end);
    // addedDiff = 3 - 5 = -2
    // deletedDiff = 1 - 3 = -2 (meaning 2 deleted lines were restored)
    expect(summary).toBe("- file1.ts: -2, +2");
  });

  it("returns null if there are no net changes", () => {
    const start: GitSnapshot = {
      "file1.ts": { added: 5, deleted: 3 }
    };
    const end: GitSnapshot = {
      "file1.ts": { added: 5, deleted: 3 }
    };

    expect(getGitDiffSummary(start, end)).toBeNull();
  });

  it("handles files discarded from the working directory / index", () => {
    const start: GitSnapshot = {
      "file1.ts": { added: 5, deleted: 3 }
    };
    const end: GitSnapshot = {};

    const summary = getGitDiffSummary(start, end);
    expect(summary).toBe("- file1.ts: discarded (-5, +3)");
  });
});
