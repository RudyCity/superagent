import fs from "fs";
import path from "path";
import { execa } from "execa";
import { generateText } from "ai";
import { rateLimiter, concurrencyLimiter } from "./rateLimiter.js";
import { getSettings } from "./config.js";

// ─── Conflict Hunk Parsing (kept as utility) ─────────────────────────────────

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
 *
 * NOTE: This is kept as an opt-in utility. The default mergeBranch() does NOT
 * auto-resolve conflicts — it aborts and reports instead.
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
      if (getSettings().concurrencyLimit === 1) {
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

// ─── Universal Post-Merge Validation ──────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Detect leftover conflict markers in a file.
 * These should NEVER appear in a committed file.
 */
function detectConflictMarkers(filePath: string, content: string): string[] {
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^<{7}\s/.test(line)) {
      errors.push(`${filePath}:${i + 1} — Leftover conflict marker: "${line.trim().substring(0, 60)}"`);
    } else if (/^={7}$/.test(line.trim())) {
      errors.push(`${filePath}:${i + 1} — Leftover conflict separator`);
    } else if (/^>{7}\s/.test(line)) {
      errors.push(`${filePath}:${i + 1} — Leftover conflict marker: "${line.trim().substring(0, 60)}"`);
    }
  }

  return errors;
}

/**
 * Detect suspicious adjacent duplicate lines — a common sign of merge corruption
 * where the same block of code got duplicated at the same location.
 *
 * Ignores intentionally repeated lines like blank lines, comments, or closing braces.
 */
function detectDuplicateAdjacentLines(filePath: string, content: string): string[] {
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);

  // Lines that are OK to appear consecutively (intentional repetition)
  const IGNORE_PATTERNS = [
    /^\s*$/,                    // blank lines
    /^\s*[}\])>]\s*[,;]?\s*$/, // closing braces/brackets
    /^\s*<\/[a-zA-Z]/,          // JSX closing tags (e.g., </div>, </Box>)
    /^\s*[/*]/,                 // comments
    /^\s*\*/,                   // JSDoc continuation
    /^\s*#/,                    // preprocessor / shebang
    /^\s*import\s/,            // import statements
    /^\s*from\s/,              // import continuation
    /^\s*use\s/,               // React hooks
    /^\s*console\./,           // console.log etc
    /^\s*@\w+/,                // decorators (e.g., @Input, @Output)
    /^\s*\.\.\./,              // spread operators
    /^\s*export\s/,            // export statements
    /^\s*type\s/,              // type definitions
    /^\s*interface\s/,         // interface definitions
    /^\s*\*\s*@/,              // JSDoc tags (@param, @returns, etc.)
    /^\s*-\s/,                 // list items (markdown, YAML)
    /^\s*\|\s/,                // table rows (markdown)
  ];

  let consecutiveDupCount = 0;
  const maxAllowedConsecutive = 2; // Allow up to 2 consecutive identical lines

  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].trim();
    const curr = lines[i].trim();

    if (prev === curr && prev.length > 0) {
      // Check if this line is in the ignore list
      const isIgnored = IGNORE_PATTERNS.some(p => p.test(lines[i]));
      if (!isIgnored) {
        consecutiveDupCount++;
        if (consecutiveDupCount >= maxAllowedConsecutive) {
          errors.push(
            `${filePath}:${i + 1} — Suspicious duplicate adjacent lines (${consecutiveDupCount + 1}x): "${curr.substring(0, 80)}"`
          );
        }
      }
    } else {
      consecutiveDupCount = 0;
    }
  }

  return errors;
}

/**
 * Detect multiple distinct statements/elements crammed onto a single line —
 * a common corruption pattern when merge concatenates lines that should be separate.
 *
 * Examples of corruption:
 *   "const a = 1; const b = 2; const c = 3;" (3 statements on 1 line)
 *   '<button>Save</button><button>Cancel</button><button>Delete</button>' (3 elements on 1 line)
 */
function detectLineMerging(filePath: string, content: string): string[] {
  const warnings: string[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip short lines, comments, strings
    if (line.length < 60) continue;
    if (/^\s*[/*#]/.test(line)) continue;

    // Count semicolons that suggest merged statements (not in strings)
    const semicolonCount = (line.match(/;\s*(const |let |var |if |for |while |return |function |class |import |export )/g) || []).length;
    if (semicolonCount >= 2) {
      warnings.push(
        `${filePath}:${i + 1} — Possible line merging: ${semicolonCount + 1} statements on one line`
      );
    }

    // Count repeated tag-like patterns suggesting merged markup
    const tagPattern = /<[a-zA-Z][a-zA-Z0-9]*[\s>]/g;
    const tagMatches = line.match(tagPattern) || [];
    if (tagMatches.length >= 3 && line.length > 80) {
      warnings.push(
        `${filePath}:${i + 1} — Possible line merging: ${tagMatches.length} opening tags on one line`
      );
    }
  }

  return warnings;
}

/**
 * Detect duplicate attributes on the same element — a common merge corruption
 * where attributes from both sides get concatenated.
 *
 * Example: 'class="foo" class="bar"' or 'id="a" id="b"'
 */
function detectDuplicateAttributes(filePath: string, content: string): string[] {
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);

  // Match attribute patterns like: name="value" or name='value' or name=value
  const attrPattern = /\b([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*["'][^"']*["']/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const attrs: string[] = [];
    let match;

    attrPattern.lastIndex = 0;
    while ((match = attrPattern.exec(line)) !== null) {
      const attrName = match[1].toLowerCase();
      // Skip data-* and style properties which can legitimately repeat
      if (attrName.startsWith("data-") || attrName === "style") continue;

      if (attrs.includes(attrName)) {
        errors.push(
          `${filePath}:${i + 1} — Duplicate attribute "${attrName}" on same line: "${line.trim().substring(0, 80)}"`
        );
      }
      attrs.push(attrName);
    }
  }

  return errors;
}

/**
 * Sanity check: compare the expected diff size vs actual diff size.
 * If the merge produces a diff that's >3x larger than the sum of both branch diffs,
 * something is probably wrong.
 */
async function diffSanityCheck(cwd: string, branchName: string): Promise<string[]> {
  const warnings: string[] = [];

  try {
    // Get the diff between the merge base and the branch (expected changes)
    const { stdout: branchDiff } = await execa(
      "git", ["diff", "--stat", `HEAD...${branchName}`],
      { cwd }
    );

    // Get the staged diff (what merge actually produced)
    const { stdout: stagedDiff } = await execa(
      "git", ["diff", "--stat", "--cached"],
      { cwd }
    );

    // Parse line counts from --stat output
    const parseStatLines = (stat: string): number => {
      const match = stat.match(/(\d+) insertion/);
      return match ? parseInt(match[1], 10) : 0;
    };

    const branchInsertions = parseStatLines(branchDiff);
    const stagedInsertions = parseStatLines(stagedDiff);

    // If staged diff is >3x the branch diff, something is fishy
    if (branchInsertions >= 10 && stagedInsertions > branchInsertions * 3) {
      warnings.push(
        `Diff sanity check: staged diff has ${stagedInsertions} insertions but branch only has ${branchInsertions}. ` +
        `This is ${Math.round(stagedInsertions / branchInsertions)}x larger than expected — possible merge corruption.`
      );
    }
  } catch {
    // diff commands may fail in some edge cases — don't block on that
  }

  return warnings;
}

/**
 * Run project-level validation using the project's own build/test/lint scripts.
 * This is the most reliable universal check — defer to the project's own tooling.
 */
async function runProjectValidation(cwd: string): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return { errors, warnings };
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (!pkg.scripts) return { errors, warnings };

    if (pkg.scripts.build) {
      try {
        await execa("npm", ["run", "build"], { cwd, timeout: 120000 });
      } catch (err: any) {
        errors.push(`Build failed: ${err.message?.substring(0, 300) || "unknown error"}`);
      }
    }

    if (pkg.scripts.test) {
      try {
        await execa("npm", ["test"], { cwd, timeout: 120000 });
      } catch (err: any) {
        errors.push(`Tests failed: ${err.message?.substring(0, 300) || "unknown error"}`);
      }
    }

    if (pkg.scripts.lint) {
      try {
        await execa("npm", ["run", "lint"], { cwd, timeout: 60000 });
      } catch (err: any) {
        // Lint failures are warnings, not hard errors
        warnings.push(`Lint warnings: ${err.message?.substring(0, 200) || "unknown"}`);
      }
    }
  } catch {
    // package.json parsing failure — skip
  }

  return { errors, warnings };
}

/**
 * Run all universal post-merge validation checks on changed files.
 *
 * This is the main entry point — call this AFTER `git merge --no-commit`
 * and BEFORE `git commit`. If validation fails, the merge should be aborted.
 */
export async function validatePostMerge(
  cwd: string,
  branchName: string,
  changedFiles: string[]
): Promise<ValidationResult> {
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  // 1. Content-level checks on each changed file
  for (const relFile of changedFiles) {
    const fullPath = path.resolve(cwd, relFile);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const content = fs.readFileSync(fullPath, "utf-8");

      // Conflict marker detection (HARD ERROR)
      const markerErrors = detectConflictMarkers(relFile, content);
      allErrors.push(...markerErrors);

      // Duplicate adjacent lines (HARD ERROR)
      const dupErrors = detectDuplicateAdjacentLines(relFile, content);
      allErrors.push(...dupErrors);

      // Duplicate attributes (HARD ERROR)
      const attrErrors = detectDuplicateAttributes(relFile, content);
      allErrors.push(...attrErrors);

      // Line merging detection (WARNING)
      const mergeWarnings = detectLineMerging(relFile, content);
      allWarnings.push(...mergeWarnings);
    } catch {
      // File read failure — skip
    }
  }

  // 2. Diff sanity check (WARNING)
  const sanityWarnings = await diffSanityCheck(cwd, branchName);
  allWarnings.push(...sanityWarnings);

  // 3. Project-level validation using project's own tooling (HARD ERROR)
  const projectResult = await runProjectValidation(cwd);
  allErrors.push(...projectResult.errors);
  allWarnings.push(...projectResult.warnings);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

// ─── Line-Based Merge Resolution (Safe Fallback) ──────────────────────────────

/**
 * Attempts safe line-based conflict resolution for a single file.
 * Only resolves trivially safe conflicts:
 *   - One side is empty (deletion vs modification) → take non-empty side
 *   - Both sides are identical → take either
 *   - One side is a line-subset of the other → take the superset
 *
 * Returns true if ALL conflicts in the file were resolved, false otherwise.
 */
export function tryLineBasedResolution(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    let content = fs.readFileSync(filePath, "utf-8");

  const hunks = parseConflictHunks(content);
  if (hunks.length === 0) return true;

  // Resolve from bottom to top to preserve indices
  for (let i = hunks.length - 1; i >= 0; i--) {
    const hunk = hunks[i];
    const ourLines = hunk.ourSide.split("\n").filter(l => l.trim().length > 0);
    const theirLines = hunk.theirSide.split("\n").filter(l => l.trim().length > 0);

    let resolved: string | null = null;

    // Case 1: One side is empty → take the other
    if (ourLines.length === 0 && theirLines.length > 0) {
      resolved = hunk.theirSide;
    } else if (theirLines.length === 0 && ourLines.length > 0) {
      resolved = hunk.ourSide;
    }
    // Case 2: Both sides identical → take either
    else if (hunk.ourSide.trim() === hunk.theirSide.trim()) {
      resolved = hunk.ourSide;
    }
    // Case 3: One side is a subset of the other → take the superset
    else {
      const ourSet = new Set(ourLines.map(l => l.trim()));
      const theirSet = new Set(theirLines.map(l => l.trim()));
      const ourIsSubset = ourLines.every(l => theirSet.has(l.trim()));
      const theirIsSubset = theirLines.every(l => ourSet.has(l.trim()));

      if (ourIsSubset && theirLines.length > ourLines.length) {
        resolved = hunk.theirSide;
      } else if (theirIsSubset && ourLines.length > theirLines.length) {
        resolved = hunk.ourSide;
      }
    }

    if (resolved === null) {
      // Cannot safely resolve this conflict — bail out
      return false;
    }

    content = content.substring(0, hunk.startIndex) + resolved + "\n" + content.substring(hunk.endIndex);
  }

  fs.writeFileSync(filePath, content, "utf-8");
  return true;
  } catch {
    return false;
  }
}

// ─── MasterAgent ──────────────────────────────────────────────────────────────

/**
 * Master Agent that orchestrates concurrent Main Agents and merges their results.
 *
 * Merge strategy (v2 — safe by default):
 *   1. git merge --no-commit
 *   2. If conflicts: try line-based safe resolution, then validate, then commit.
 *      If line-based fails: ABORT and report (no LLM auto-resolve).
 *   3. If clean: run universal post-merge validation
 *   4. If validation fails: ABORT and report
 *   5. If validation passes: commit
 */
export class MasterAgent {
  private model: any;

  /**
   * Detailed error/warning messages from the last mergeBranch() call.
   * Read this after a failed merge to understand why it failed.
   */
  public lastMergeErrors: string[] = [];
  public lastMergeWarnings: string[] = [];

  constructor(model: any) {
    this.model = model;
  }

  /**
   * Merges a feature branch into the current branch.
   * Returns:
   *   - "merged"           if the branch was successfully merged
   *   - "already-merged"   if the branch is already an ancestor of HEAD (nothing to do)
   *   - false              if the merge failed (conflicts or validation failure)
   */
  public async mergeBranch(branchName: string, targetFiles: string[]): Promise<"merged" | "already-merged" | false> {
    const cwd = process.cwd();
    this.lastMergeErrors = [];
    this.lastMergeWarnings = [];

    try {
      // Pre-check: is the branch already an ancestor of HEAD?
      try {
        await execa("git", ["merge-base", "--is-ancestor", branchName, "HEAD"], { cwd });
        return "already-merged";
      } catch (ancestorErr: any) {
        if (ancestorErr.exitCode !== 1) {
          // Some other git error — let it propagate to merge below
        }
      }

      // Run git merge without committing
      await execa("git", ["merge", "--no-commit", branchName], { cwd });

      // ── Post-merge validation BEFORE commit ────────────────────────────
      const validation = await validatePostMerge(cwd, branchName, targetFiles);

      if (!validation.valid) {
        // Validation failed — abort the merge
        this.lastMergeErrors = [
          `Post-merge validation FAILED for branch "${branchName}":`,
          ...validation.errors.map(e => `  ❌ ${e}`),
          ...validation.warnings.map(w => `  ⚠️ ${w}`),
        ];
        this.lastMergeWarnings = validation.warnings;

        console.error(`[MERGE VALIDATION FAIL] ${this.lastMergeErrors.join("\n")}`);

        try {
          await execa("git", ["merge", "--abort"], { cwd });
        } catch (abortErr) {
          // If abort fails, try reset
          try {
            await execa("git", ["reset", "--merge"], { cwd });
          } catch {}
        }

        return false;
      }

      // Log warnings even on success
      if (validation.warnings.length > 0) {
        console.warn(
          `[MERGE VALIDATION WARN] Branch "${branchName}":\n` +
          validation.warnings.map(w => `  ⚠️ ${w}`).join("\n")
        );
      }

      // Validation passed — commit the merge
      await execa("git", ["commit", "-m", `Merge branch '${branchName}' via Master Agent`], { cwd });
      return "merged";

    } catch (err: any) {
      // Check if this is a merge conflict
      let isConflict = false;
      let conflictedFiles: string[] = [];
      try {
        const { stdout } = await execa("git", ["diff", "--name-only", "--diff-filter=U"], { cwd });
        if (stdout.trim().length > 0) {
          isConflict = true;
          conflictedFiles = stdout.trim().split("\n").filter(Boolean);
        }
      } catch {
        // diff failed
      }

      if (isConflict) {
        // ── Try safe line-based resolution before aborting ──────────────
        let allResolved = true;
        const resolvedFiles: string[] = [];
        const unresolvedFiles: string[] = [];

        for (const file of conflictedFiles) {
          const fullPath = path.resolve(cwd, file);
          const success = tryLineBasedResolution(fullPath);
          if (success) {
            resolvedFiles.push(file);
          } else {
            unresolvedFiles.push(file);
            allResolved = false;
          }
        }

        if (allResolved) {
          // Line-based resolution succeeded — validate before committing
          try {
            await execa("git", ["add", "-A"], { cwd });

            const validation = await validatePostMerge(cwd, branchName, targetFiles);
            if (validation.valid) {
              await execa("git", ["commit", "-m", `Merge branch '${branchName}' (line-based resolution) via Master Agent`], { cwd });
              this.lastMergeWarnings = [
                ...validation.warnings,
                `Used line-based conflict resolution for: ${resolvedFiles.join(", ")}`,
              ];
              console.warn(
                `[MERGE LINE-BASED] Branch "${branchName}" merged with line-based resolution.\n` +
                `Resolved: ${resolvedFiles.join(", ")}\n` +
                validation.warnings.map(w => `  ⚠️ ${w}`).join("\n")
              );
              return "merged";
            } else {
              // Validation failed after line-based resolution — abort
              this.lastMergeErrors = [
                `Line-based conflict resolution succeeded but post-merge validation FAILED:`,
                ...validation.errors.map(e => `  ❌ ${e}`),
                `Merge aborted. Manual resolution required.`,
              ];
              console.error(`[MERGE LINE-BASED FAIL] ${this.lastMergeErrors.join("\n")}`);
            }
          } catch (postResolveErr: any) {
            this.lastMergeErrors = [
              `Error after line-based resolution: ${postResolveErr.message}`,
            ];
          }
        } else {
          // Line-based resolution failed — spawn conflict-resolver subagent
          console.log(`[INFO] Line-based resolution failed. Spawning programmatic conflict-resolver subagent for branch "${branchName}"...`);
          try {
            const { Agent } = await import("./agent.js");
            const { defaultSubagentToolset } = await import("./tools/toolsets.js");

            const conflictResolverPrompt = `You are a conflict-resolver agent.
Your sole task is to resolve Git merge conflicts in the following conflicted file(s) in this repository:
${conflictedFiles.map(f => `- ${f}`).join("\n")}

Instructions:
1. Examine the conflicted files and look for git conflict markers (<<<<<<<, =======, >>>>>>>).
2. Understand the changes from both the current branch (HEAD) and the incoming branch (${branchName}).
3. Edit the file(s) to resolve the conflicts cleanly, keeping the correct logic from both branches where appropriate, and completely remove all conflict markers.
4. Run validation (e.g. 'npm run build' or check files) to ensure the code compiles and is free of syntax errors.
5. Report back when all conflicts are resolved.`;

            const conflictAgent = new Agent(
              (ev) => {
                if (ev.type === "tool_start") {
                  console.log(`[conflict-resolver] [TOOL:START] ${ev.toolCall.name} - ${ev.description}`);
                } else if (ev.type === "tool_end") {
                  const status = ev.toolResult.isError ? "FAIL" : "OK";
                  console.log(`[conflict-resolver] [TOOL:${status}] ${ev.toolResult.name}`);
                } else if (ev.type === "error") {
                  console.error(`[conflict-resolver] [ERROR] ${ev.message}`);
                }
              },
              async () => true, // auto-approve non-destructive tools
              async (q, opts) => (opts && opts[0]) ?? "", // auto-answer questions
              conflictResolverPrompt,
              defaultSubagentToolset,
              cwd
            );

            conflictAgent.tier = "subagent";
            conflictAgent.subagentType = "conflict-resolver";
            conflictAgent.delegationDepth = 2;
            conflictAgent.planState = "APPROVED"; // stateless executor

            await conflictAgent.sendMessage("Please resolve the Git merge conflicts now.");

            // Check if conflict markers are gone in all conflicted files
            let allMarkersResolved = true;
            for (const file of conflictedFiles) {
              const fullPath = path.resolve(cwd, file);
              if (fs.existsSync(fullPath)) {
                const content = fs.readFileSync(fullPath, "utf-8");
                if (content.includes("<<<<<<<") || content.includes("=======") || content.includes(">>>>>>>")) {
                  allMarkersResolved = false;
                  break;
                }
              }
            }

            if (allMarkersResolved) {
              console.log("[INFO] Conflict-resolver subagent successfully removed all conflict markers. Verifying post-merge...");
              await execa("git", ["add", "-A"], { cwd });
              const validation = await validatePostMerge(cwd, branchName, targetFiles);
              if (validation.valid) {
                await execa("git", ["commit", "-m", `Merge branch '${branchName}' (resolved via conflict-resolver subagent) via Master Agent`], { cwd });
                this.lastMergeWarnings = [
                  ...validation.warnings,
                  `Resolved conflicts via subagent for: ${conflictedFiles.join(", ")}`,
                ];
                return "merged";
              } else {
                console.error("[ERROR] Post-merge validation failed after conflict-resolver subagent run.");
              }
            } else {
              console.error("[ERROR] Conflict-resolver subagent failed to remove all conflict markers.");
            }
          } catch (agentErr: any) {
            console.error(`[ERROR] Exception in conflict-resolver subagent: ${agentErr.message}`);
          }

          // Fallback if resolver agent failed
          this.lastMergeErrors = [
            `Merge conflict detected for branch "${branchName}".`,
            `Conflicted files:`,
            ...conflictedFiles.map(f => `  - ${f}`),
            ...(resolvedFiles.length > 0
              ? [`Line-based resolution succeeded for: ${resolvedFiles.join(", ")}`]
              : []),
            `Could NOT safely resolve: ${unresolvedFiles.join(", ")}`,
            `Auto-resolution is DISABLED for complex conflicts to prevent corruption.`,
            `Please resolve conflicts manually and retry the merge.`,
          ];
          console.error(`[MERGE CONFLICT] ${this.lastMergeErrors.join("\n")}`);
        }

        try {
          await execa("git", ["merge", "--abort"], { cwd });
        } catch (abortErr) {
          try {
            await execa("git", ["reset", "--merge"], { cwd });
          } catch {}
        }

        return false;
      } else {
        // Not a conflict — some other git or validation error
        this.lastMergeErrors = [
          `Merge error for branch "${branchName}": ${err.message}`,
        ];

        console.error(`[MERGE ERROR] ${this.lastMergeErrors.join("\n")}`);

        try {
          await execa("git", ["merge", "--abort"], { cwd });
        } catch {
          try {
            await execa("git", ["reset", "--merge"], { cwd });
          } catch {}
        }

        return false;
      }
    }
  }
}
