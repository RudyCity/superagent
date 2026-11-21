/**
 * Sync public Chrome and Dynamic Gateway MCP tool schemas after compilation.
 * Path arguments are handled as paths, never interpolated into shell commands.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { CHROME_MCP_TOOL_DEFS } from "../src/core/mcp/tools/chromeMcpTools.js";
import { MCP_GATEWAY_TOOL_DEFS } from "../src/core/mcp/mcpToolGateway.js";
import { PROJECT_MCP_TOOL_DEFS } from "../src/core/mcp/tools/projectTools.js";
import { CORE_LIFECYCLE_MCP_TOOL_DEFS } from "../src/core/mcp/tools/coreLifecycleMcpTools.js";
import { SERVICE_MANAGER_MCP_TOOL_DEFS } from "../src/core/mcp/tools/serviceManagerMcpTools.js";
import { DELEGATE_MCP_TOOL_DEFS } from "../src/core/mcp/tools/delegateMcpTools.js";
import { getSuperagentMcpInstructions } from "../src/core/mcp/resourcesAndPrompts.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repo, "dist", "mcp");
const home = process.env.USERPROFILE || os.homedir();
const antigravityDir = path.join(home, ".gemini", "antigravity", "mcp", "superagent");

const ALL_SYNC_TOOL_DEFS = [
  ...MCP_GATEWAY_TOOL_DEFS,
  ...CHROME_MCP_TOOL_DEFS,
  ...PROJECT_MCP_TOOL_DEFS,
  ...CORE_LIFECYCLE_MCP_TOOL_DEFS,
  ...SERVICE_MANAGER_MCP_TOOL_DEFS,
  ...DELEGATE_MCP_TOOL_DEFS,
];

function syncInto(dir: string, create: boolean): number {
  if (!create && !fs.existsSync(dir)) return 0;
  if (create) fs.mkdirSync(dir, { recursive: true });
  let count = 0;
  const valid = new Set<string>();
  for (const tool of ALL_SYNC_TOOL_DEFS) {
    // Keep the exact MCP registration schema (not a handwritten command enum).
    const target = path.join(dir, tool.name + ".json");
    valid.add(tool.name + ".json");
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
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".json") && !valid.has(file)) {
        try { fs.unlinkSync(path.join(dir, file)); } catch {}
      }
    }
  }
  return count;
}

const local = syncInto(distDir, true);
const antigravity = syncInto(antigravityDir, false);

if (fs.existsSync(antigravityDir)) {
  const instructionsTarget = path.join(antigravityDir, "instructions.md");
  const instructionsContent = getSuperagentMcpInstructions() + "\n";
  if (!fs.existsSync(instructionsTarget) || fs.readFileSync(instructionsTarget, "utf8") !== instructionsContent) {
    fs.writeFileSync(instructionsTarget, instructionsContent, "utf8");
  }
}

const srcFonts = path.join(repo, "src", "core", "motion", "assets", "fonts");
const distFonts = path.join(repo, "dist", "core", "motion", "assets", "fonts");
if (fs.existsSync(srcFonts)) {
  fs.mkdirSync(distFonts, { recursive: true });
  for (const file of fs.readdirSync(srcFonts)) {
    const source = path.join(srcFonts, file);
    const target = path.join(distFonts, file);
    if (!fs.statSync(source).isFile()) continue;
    // Windows may deny an unnecessary overwrite when a renderer has the
    // exact same destination font open. Compare contents before copying:
    // different or unreadable targets still fail rather than hiding errors.
    if (fs.existsSync(target) &&
        fs.statSync(source).size === fs.statSync(target).size &&
        fs.readFileSync(source).equals(fs.readFileSync(target))) continue;
    fs.copyFileSync(source, target);
  }
}

console.log("MCP Chrome schemas synchronized: dist=" + local + ", existing Antigravity folder=" + antigravity + ".");
