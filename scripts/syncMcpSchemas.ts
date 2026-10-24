/**
 * Sync public Chrome MCP tool schemas after compilation.
 * Path arguments are handled as paths, never interpolated into shell commands.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { CHROME_MCP_TOOL_DEFS } from "../src/core/mcp/tools/chromeMcpTools.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repo, "dist", "mcp");
const home = process.env.USERPROFILE || os.homedir();
const antigravityDir = path.join(home, ".gemini", "antigravity", "mcp", "superagent");

function syncInto(dir: string, create: boolean): number {
  if (!create && !fs.existsSync(dir)) return 0;
  if (create) fs.mkdirSync(dir, { recursive: true });
  let count = 0;
  for (const tool of CHROME_MCP_TOOL_DEFS) {
    // Keep the exact MCP registration schema (not a handwritten command enum).
    const target = path.join(dir, tool.name + ".json");
    const json = JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }, null, 2) + "\n";
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === json) continue;
    const temporary = target + "." + process.pid + ".tmp";
    try {
      fs.writeFileSync(temporary, json, "utf8");
      fs.renameSync(temporary, target);
      count++;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return count;
}

const local = syncInto(distDir, true);
const antigravity = syncInto(antigravityDir, false);

const srcFonts = path.join(repo, "src", "core", "motion", "assets", "fonts");
const distFonts = path.join(repo, "dist", "core", "motion", "assets", "fonts");
if (fs.existsSync(srcFonts)) {
  fs.mkdirSync(distFonts, { recursive: true });
  for (const file of fs.readdirSync(srcFonts)) {
    fs.copyFileSync(path.join(srcFonts, file), path.join(distFonts, file));
  }
}

console.log("MCP Chrome schemas synchronized: dist=" + local + ", existing Antigravity folder=" + antigravity + ".");
