import fs from "node:fs";
import path from "node:path";
import { isPathInsideOrEqual } from "../utils/serverSecurity.js";

/** Never trust lexical workspace containment when a symlink can escape the root. */
export function isCanonicalMotionWorkspaceAllowed(requested: string, roots: string[]): boolean {
  try {
    const canonicalTarget = fs.realpathSync.native(path.resolve(requested));
    if (!fs.statSync(canonicalTarget).isDirectory()) return false;
    return roots.some(root => {
      try {
        const canonicalRoot = fs.realpathSync.native(path.resolve(root));
        return isPathInsideOrEqual(canonicalRoot, canonicalTarget);
      } catch { return false; }
    });
  } catch { return false; }
}
