import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  handleGrepSearch,
  handleListFiles,
  handleReadFile,
  handleUnlockFile,
  handleWriteFile,
  handleWriteFiles,
} from "../src/core/mcp/tools/workspaceTools.js";
import { handleApplyPatch, handleReplaceFileContent } from "../src/core/mcp/tools/planSkillsMcpTools.js";
import { handleGitAction, handleReadDocument } from "../src/core/mcp/tools/networkContentMcpTools.js";
import { runWithMcpWorkspace } from "../src/core/mcp/tools/workspaceContext.js";

const tempRoots: string[] = [];
function fixture(): { root: string; outside: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-workspace-boundary-"));
  tempRoots.push(parent);
  const root = path.join(parent, "repo");
  const outsideDir = path.join(parent, "other-repo");
  fs.mkdirSync(root);
  fs.mkdirSync(outsideDir);
  const outside = path.join(outsideDir, "secret.txt");
  fs.writeFileSync(outside, "private marker");
  return { root, outside };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function resultText(result: any): string {
  return (result.content || []).map((part: any) => part.text || "").join("\n");
}

describe("MCP workspace root boundaries", () => {
  it("blocks read, directory listing, and grep targets outside the selected root", async () => {
    const { root, outside } = fixture();

    const read = await handleReadFile({ filePath: outside, cwd: root });
    expect(read.isError).toBe(true);
    expect(resultText(read)).toMatch(/escapes registered project root/i);

    const list = await handleListFiles({ dirPath: path.dirname(outside), cwd: root });
    expect(list.isError).toBe(true);
    expect(resultText(list)).toMatch(/escapes registered project root/i);

    const grep = await handleGrepSearch({ query: "private marker", path: path.dirname(outside), cwd: root });
    expect(grep.isError).toBe(true);
    expect(resultText(grep)).toMatch(/escapes registered project root/i);
  });

  it("blocks writes and unlock operations outside the selected root", async () => {
    const { root, outside } = fixture();
    const write = await handleWriteFile({ filePath: outside, content: "tampered", cwd: root });
    expect(write.isError).toBe(true);
    expect(resultText(write)).toMatch(/escapes registered project root/i);
    expect(fs.readFileSync(outside, "utf8")).toBe("private marker");

    const unlock = await handleUnlockFile({ filePath: outside, action: "status", cwd: root });
    expect(unlock.isError).toBe(true);
    expect(resultText(unlock)).toMatch(/escapes registered project root/i);
  });


  it("blocks document reads, git file operations, and patch mutations outside the selected root", async () => {
    const { root, outside } = fixture();
    await runWithMcpWorkspace(root, async () => {
      const document = await handleReadDocument({ filePath: outside });
      expect(document.isError).toBe(true);
      expect(resultText(document)).toMatch(/escapes registered project root/i);

      const git = await handleGitAction({ action: "add", files: [outside] });
      expect(git.isError).toBe(true);
      expect(resultText(git)).toMatch(/escapes registered project root/i);

      const replace = await handleReplaceFileContent({
        filePath: outside,
        targetContent: "private marker",
        replacementContent: "tampered",
        startLine: 1,
        endLine: 1,
      });
      expect(replace.isError).toBe(true);
      expect(resultText(replace)).toMatch(/escapes registered project root/i);

      const patch = await handleApplyPatch({
        patches: [{ filePath: outside, patchContent: "invalid patch" }],
      });
      expect(patch.isError).toBe(true);
      expect(resultText(patch)).toMatch(/escapes registered project root/i);
    });
    expect(fs.readFileSync(outside, "utf8")).toBe("private marker");
  });

  it("applies root boundaries independently to every file in a write batch", async () => {
    const { root, outside } = fixture();
    const inside = path.join(root, "created.txt");
    const result = await handleWriteFiles({
      cwd: root,
      files: [
        { filePath: inside, content: "allowed" },
        { filePath: outside, content: "blocked" },
      ],
    });

    expect(fs.readFileSync(inside, "utf8")).toBe("allowed");
    expect(fs.readFileSync(outside, "utf8")).toBe("private marker");
    expect(resultText(result)).toContain("1 succeeded, 1 failed");
    expect(resultText(result)).toMatch(/escapes registered project root/i);
  });
});
