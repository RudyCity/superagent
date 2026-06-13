import fs from "fs";
import path from "path";
import { execa } from "execa";
import { generateText } from "ai";
import { rateLimiter, concurrencyLimiter } from "./rateLimiter.js";

interface ConflictHunk {
  fullMatch: string;
  ourSide: string;
  theirSide: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Parses Git merge conflict markers in a file.
 */
export function parseConflictHunks(content: string): ConflictHunk[] {
  const regex = /<<<<<<<[^\n]*\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>[^\n]*/g;
  const hunks: ConflictHunk[] = [];
  let match;

  while ((match = regex.exec(content)) !== null) {
    hunks.push({
      fullMatch: match[0],
      ourSide: match[1],
      theirSide: match[2],
      startIndex: match.index,
      endIndex: regex.lastIndex,
    });
  }

  return hunks;
}

/**
 * Resolves conflicts in a file by feeding only conflict hunks + surrounding context
 * to the LLM, conserving context window tokens.
 */
export async function resolveFileConflicts(
  filePath: string,
  model: any // LLM Model instance
): Promise<boolean> {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, "utf-8");

  const hunks = parseConflictHunks(content);
  if (hunks.length === 0) return true;

  // Resolve from bottom to top to preserve indices
  for (let i = hunks.length - 1; i >= 0; i--) {
    const hunk = hunks[i];
    
    // Extract context: 20 lines before and after
    const linesBefore = content.substring(0, hunk.startIndex).split("\n").slice(-20).join("\n");
    const linesAfter = content.substring(hunk.endIndex).split("\n").slice(0, 20).join("\n");

    const prompt = `You are a Senior Merge Conflict Resolver. Resolve the following merge conflict hunk.
You are given the lines before the conflict, the conflict hunk (our changes vs their changes), and the lines after.

--- LINES BEFORE ---
${linesBefore}

--- CONFLICT HUNK ---
<<<<<<< (Our Version)
${hunk.ourSide}
======= (Their Version)
${hunk.theirSide}
>>>>>>>

--- LINES AFTER ---
${linesAfter}

Provide the resolved code for the CONFLICT HUNK only. Output ONLY the resolved code block. Do not include markdown code block syntax (like \`\`\`), explanation, or preamble.`;

    // Shared rate limiting check
    let concurrencyAcquired = false;
    try {
      if (process.env.SUPERAGENT_MAX_CONCURRENCY === "1") {
        await concurrencyLimiter.acquire();
        concurrencyAcquired = true;
      }
      await rateLimiter.acquire(1);

      const { text } = await generateText({
        model,
        prompt,
      });

      const resolvedBlock = text.trim();
      content = content.substring(0, hunk.startIndex) + resolvedBlock + "\n" + content.substring(hunk.endIndex);
    } finally {
      if (concurrencyAcquired) {
        concurrencyLimiter.release();
      }
    }
  }

  fs.writeFileSync(filePath, content, "utf-8");
  return true;
}

/**
 * Master Agent that orchestrates concurrent Main Agents and merges their results.
 */
export class MasterAgent {
  private model: any;

  constructor(model: any) {
    this.model = model;
  }

  public async mergeBranch(branchName: string, targetFiles: string[]): Promise<boolean> {
    try {
      // Run git merge
      await execa("git", ["merge", branchName], { cwd: process.cwd() });
      return true;
    } catch (err: any) {
      // Git merge failed due to conflicts
      let hasUnresolved = false;
      try {
        for (const file of targetFiles) {
          const fullPath = path.resolve(process.cwd(), file);
          if (fs.existsSync(fullPath)) {
            const resolved = await resolveFileConflicts(fullPath, this.model);
            if (!resolved) hasUnresolved = true;
          }
        }
      } catch (resolutionError: any) {
        // Conflict resolution failed (e.g. LLM API call error)
        // Abort the git merge to restore the working directory state
        try {
          await execa("git", ["merge", "--abort"], { cwd: process.cwd() });
        } catch (abortErr) {
          // Ignore failures to abort
        }
        return false;
      }

      if (hasUnresolved) {
        try {
          await execa("git", ["merge", "--abort"], { cwd: process.cwd() });
        } catch (abortErr) {}
        return false;
      }

      // Add files and finish merge commit
      try {
        await execa("git", ["add", "-A"], { cwd: process.cwd() });
        await execa("git", ["commit", "-m", `Merge branch '${branchName}' and resolved conflicts via Master Agent`], {
          cwd: process.cwd(),
        });
        return true;
      } catch (commitErr) {
        try {
          await execa("git", ["merge", "--abort"], { cwd: process.cwd() });
        } catch (abortErr) {}
        return false;
      }
    }
  }
}
