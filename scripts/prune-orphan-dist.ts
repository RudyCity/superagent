#!/usr/bin/env bun
/**
 * Prune obsolete emitted compiler files in dist/ whose corresponding source
 * .ts/.tsx in src/ no longer exists.
 * Preserves scripts/ bundles, native helpers, and MCP schemas.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const SRC = path.join(ROOT, "src");

export function pruneOrphanDistFiles(root = ROOT): string[] {
  const dist = path.join(root, "dist");
  const src = path.join(root, "src");
  if (!fs.existsSync(dist) || !fs.existsSync(src)) return [];
  const pruned: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        const relDir = path.relative(dist, fullPath).replace(/\\/g, "/");
        if (relDir === "scripts" || relDir === "native" || relDir.startsWith("native/")) continue;
        walk(fullPath);
        try {
          if (fs.readdirSync(fullPath).length === 0) {
            fs.rmdirSync(fullPath);
          }
        } catch {}
      } else if (entry.isFile()) {
        const relPath = path.relative(dist, fullPath).replace(/\\/g, "/");
        if (relPath.startsWith("scripts/") || relPath.startsWith("native/") || relPath.startsWith("mcp/")) {
          continue;
        }
        let baseRel = "";
        if (relPath.endsWith(".d.ts.map")) {
          baseRel = relPath.slice(0, -".d.ts.map".length);
        } else if (relPath.endsWith(".d.ts")) {
          baseRel = relPath.slice(0, -".d.ts".length);
        } else if (relPath.endsWith(".js.map")) {
          baseRel = relPath.slice(0, -".js.map".length);
        } else if (relPath.endsWith(".js")) {
          baseRel = relPath.slice(0, -".js".length);
        } else {
          continue;
        }
        const candidateTs = path.join(src, ...baseRel.split("/")) + ".ts";
        const candidateTsx = path.join(src, ...baseRel.split("/")) + ".tsx";
        if (!fs.existsSync(candidateTs) && !fs.existsSync(candidateTsx)) {
          fs.unlinkSync(fullPath);
          pruned.push(relPath);
        }
      }
    }
  }

  walk(dist);
  return pruned;
}

if (import.meta.main) {
  const removed = pruneOrphanDistFiles(ROOT);
  if (removed.length > 0) {
    console.log(`[dist pruner] Removed ${removed.length} orphan files: ${removed.join(", ")}`);
  }
}
