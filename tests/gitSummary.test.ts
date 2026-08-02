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
      "file2.ts": { added: 0, deleted: 0 }
    };

    const summary = getGitDiffSummary(start, end);
    expect(summary).toBe("- file1.ts: +3, -2");
  });

  it("handles new untracked files correctly", () => {
    const start: GitSnapshot = {};
    const end: GitSnapshot = {
      "newFile.ts": { added: 10, deleted: 0 }
    };

    const summary = getGitDiffSummary(start, end);
    expect(summary).toBe("- newFile.ts: +10");
  });

  it("handles negative differences (reverts/restorations) correctly", () => {
    const start: GitSnapshot = {
      "file1.ts": { added: 5, deleted: 2 }
    };
    const end: GitSnapshot = {
      "file1.ts": { added: 3, deleted: 0 }
    };

    const summary = getGitDiffSummary(start, end);
    expect(summary).toBe("- file1.ts: -2, +2");
  });

  it("returns null if there are no net changes", () => {
    const start: GitSnapshot = {
      "file1.ts": { added: 2, deleted: 1 }
    };
    const end: GitSnapshot = {
      "file1.ts": { added: 2, deleted: 1 }
    };

    expect(getGitDiffSummary(start, end)).toBeNull();
  });

  it("handles in-place modified files when line counts are unchanged but mtime changed", () => {
    const start: GitSnapshot = {
      "file1.ts": { added: 5, deleted: 3, mtime: 100 }
    };
    const end: GitSnapshot = {
      "file1.ts": { added: 5, deleted: 3, mtime: 200 }
    };

    const summary = getGitDiffSummary(start, end);
    expect(summary).toBe("- file1.ts: modified");
  });

  it("handles files discarded from the working directory / index", () => {
    const start: GitSnapshot = {
      "file1.ts": { added: 5, deleted: 2 }
    };
    const end: GitSnapshot = {};

    const summary = getGitDiffSummary(start, end);
    expect(summary).toContain("file1.ts: ");
    expect(summary).toContain("discarded (-5, +2)");
  });
});
