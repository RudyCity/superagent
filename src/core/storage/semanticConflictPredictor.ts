import fs from "fs";
import path from "path";
import { checkFileLock } from "./sharedMemory.js";

export interface SemanticConflictPrediction {
  targetFile: string;
  hasConflictRisk: boolean;
  dependentLockedFiles: string[];
  riskScore: number; // 0 to 1
  reason?: string;
}

/**
 * Predicts potential conflicts without calling LLM (Zero Extra Tokens).
 * Uses static regex AST dependency graph heuristic matching.
 */
export function predictSemanticConflict(
  targetFile: string,
  sessionId?: string,
  cwd?: string
): SemanticConflictPrediction {
  const absPath = path.resolve(cwd || process.cwd(), targetFile);
  const dependentLockedFiles: string[] = [];

  // Check direct lock first
  const directCheck = checkFileLock(targetFile, sessionId, cwd);
  if (directCheck.locked) {
    return {
      targetFile: absPath,
      hasConflictRisk: true,
      dependentLockedFiles: [targetFile],
      riskScore: 1.0,
      reason: `Direct lock active by session ${directCheck.owner?.sessionId}`,
    };
  }

  // Scan imports in target file to check if imported modules are locked
  if (fs.existsSync(absPath)) {
    try {
      const content = fs.readFileSync(absPath, "utf-8");
      const importRegex = /(?:import|require)\s*\(?['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;

      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        if (importPath.startsWith(".")) {
          const dir = path.dirname(absPath);
          const candidates = [
            path.resolve(dir, importPath),
            path.resolve(dir, `${importPath}.ts`),
            path.resolve(dir, `${importPath}.tsx`),
            path.resolve(dir, `${importPath}.js`),
            path.resolve(dir, `${importPath}/index.ts`),
          ];

          for (const cand of candidates) {
            const relCand = path.relative(cwd || process.cwd(), cand);
            const candCheck = checkFileLock(relCand, sessionId, cwd);
            if (candCheck.locked) {
              dependentLockedFiles.push(relCand);
            }
          }
        }
      }
    } catch {}
  }

  if (dependentLockedFiles.length > 0) {
    return {
      targetFile: absPath,
      hasConflictRisk: true,
      dependentLockedFiles,
      riskScore: 0.7,
      reason: `Target imports ${dependentLockedFiles.length} file(s) currently locked by another session.`,
    };
  }

  return {
    targetFile: absPath,
    hasConflictRisk: false,
    dependentLockedFiles: [],
    riskScore: 0,
  };
}
