/**
 * Generate T-Line's Brain runtime from canonical SuperAgent Core sources.
 * Run before release; use --check in CI to block semantic drift.
 * No dependency on a sibling workspace at T-Line runtime.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BRAIN_SUGGESTIONS, BRAIN_SUGGESTION_DESCRIPTIONS } from "../src/core/commands/commandCatalog.js";

const superRoot = path.resolve(import.meta.dir, "..");
const tline = path.resolve(import.meta.dir, "../../t-line/backend/src");
const modules = [
  { source: "brainSessionLock.ts", imports: [] },
  { source: "brainObservability.ts", imports: [] },
  { source: "brainAgentCredentials.ts", imports: [
      ["import { inspectBrainSession } from \"./brainWorkspace.js\";", "import { inspectBrainSession } from \"./brainRuntimeCompat\";"],
      ["import { inspectBrainTask } from \"./brainTasks.js\";", "import { inspectBrainTask } from \"./brainTasks\";"],
      ["import { assertNoSymlink } from \"./brainStorageManager.js\";", "import { assertNoSymlink } from \"./brainStorageManager\";"],
      ["import { withBrainSessionLock } from \"./brainSessionLock.js\";", "import { withBrainSessionLock } from \"./brainSessionLock\";"],
    ] },
  { source: "brainTasks.ts", imports: [
      ["import { inspectBrainSession } from \"./brainWorkspace.js\";", "import { inspectBrainSession } from \"./brainRuntimeCompat\";"],
      ["import { assertNoSymlink, validateDestination, brainStorageUsage, hasActiveBrainDelegation } from \"./brainStorageManager.js\";", "import { assertNoSymlink, validateDestination, brainStorageUsage, hasActiveBrainDelegation } from \"./brainStorageManager\";"],
      ["import { withBrainSessionLock } from \"./brainSessionLock.js\";", "import { withBrainSessionLock } from \"./brainSessionLock\";"],
      ["import { getRootConfigDir } from \"../config/paths.js\";", "import { getRootConfigDir } from \"./brainRuntimeCompat\";"],
    ] },
  { source: "brainLaunchRecovery.ts", imports: [
      ["import { getRootConfigDir } from \"../config/paths.js\";", "import { getRootConfigDir } from \"./brainRuntimeCompat\";"],
      ["import { inspectBrainSession } from \"./brainWorkspace.js\";", "import { inspectBrainSession } from \"./brainRuntimeCompat\";"],
      ["import { assertNoSymlink } from \"./brainStorageManager.js\";", "import { assertNoSymlink } from \"./brainStorageManager\";"],
      ["import { inspectBrainTask, recordBrainTaskDelegation, updateBrainTask, finishBrainTaskLaunch } from \"./brainTasks.js\";", "import { inspectBrainTask, recordBrainTaskDelegation, updateBrainTask, finishBrainTaskLaunch } from \"./brainTasks\";"],
    ] },
  { source: "brainStorageManager.ts", imports: [
      ["import { getRootConfigDir } from '../config/paths.js';\nimport { inspectBrainSession, listBrainSessions } from './brainWorkspace.js';",
       "import { getRootConfigDir, inspectBrainSession, listBrainSessions } from './brainRuntimeCompat';"],
      ["import { withBrainSessionLock } from './brainSessionLock.js';",
       "import { withBrainSessionLock } from './brainSessionLock';"],
    ]},
  { source: "brainTransfers.ts", imports: [
      ["import { inspectBrainSession } from \"./brainWorkspace.js\";", "import { inspectBrainSession } from \"./brainRuntimeCompat\";"],
      ["import { getRootConfigDir } from \"../config/paths.js\";", "import { getRootConfigDir } from \"./brainRuntimeCompat\";"],
      ["import { brainStorageUsage, validateDestination, assertNoSymlink } from \"./brainStorageManager.js\";",
       "import { brainStorageUsage, validateDestination, assertNoSymlink } from \"./brainStorageManager\";"],
      ["import { withBrainSessionLock } from \"./brainSessionLock.js\";",
       "import { withBrainSessionLock } from \"./brainSessionLock\";"],
    ]},
  { source: "brainIndex.ts", imports: [
      ["import { getRootConfigDir } from \"../config/paths.js\";", "import { getRootConfigDir } from \"./brainRuntimeCompat\";"],
      ["import { inspectBrainSession, listBrainSessions, listBrainFiles } from \"./brainWorkspace.js\";",
       "import { inspectBrainSession, listBrainSessions, listBrainFiles } from \"./brainRuntimeCompat\";"],
      ["import { assertNoSymlink, validateDestination } from \"./brainStorageManager.js\";",
       "import { assertNoSymlink, validateDestination } from \"./brainStorageManager\";"],
    ]},
];
const check = process.argv.includes("--check");
const hashes: Record<string,string> = {};
for (const item of modules) {
  const canonical = path.join(superRoot, "src", "core", "brain", item.source);
  const destination = path.join(tline, item.source);
  let body = fs.readFileSync(canonical,"utf8").replace(/\r\n/g,"\n");
  for (const [oldText, newText] of item.imports) {
    if (!body.includes(oldText)) throw new Error(`Core import changed in ${item.source}; update T-Line compatibility adapter.`);
    body = body.replace(oldText,newText);
  }
  if (body.includes("../config/paths.js") || body.includes("./brainWorkspace.js")) {
    throw new Error("Unresolved core-only import in " + item.source);
  }
  const generated =
    `// GENERATED FROM SuperAgent src/core/brain/${item.source}; DO NOT EDIT.\n` +
    "// Regenerate using bun scripts/sync-brain-runtime.ts\n" + body;
  hashes[item.source] = crypto.createHash("sha256").update(generated).digest("hex");
  if (check) {
    if (!fs.existsSync(destination) ||
      fs.readFileSync(destination,"utf8").replace(/\r\n/g,"\n") !== generated) {
      throw new Error(`${item.source} is out of sync with Core.`);
    }
  } else {
    if (!fs.existsSync(tline)) throw new Error("Sibling T-Line backend unavailable.");
    fs.writeFileSync(destination,generated);
  }
}
const suggestionPath = path.resolve(tline, "../../frontend/src/generated/brainCommandSuggestions.json");
const suggestionData = JSON.stringify({
  schemaVersion: 1,
  commands: BRAIN_SUGGESTIONS.map(command => ({
    command,
    description: BRAIN_SUGGESTION_DESCRIPTIONS[command] || "Session Brain — " + command.slice("/brain ".length),
  })),
}, null, 2) + "\n";
const suggestionHash = crypto.createHash("sha256").update(suggestionData).digest("hex");
if (check) {
  if (!fs.existsSync(suggestionPath) || fs.readFileSync(suggestionPath, "utf8").replace(/\r\n/g, "\n") !== suggestionData) {
    throw new Error("T-Line Brain command suggestions are out of sync with Core.");
  }
} else {
  fs.mkdirSync(path.dirname(suggestionPath), {recursive:true});
  fs.writeFileSync(suggestionPath,suggestionData);
}
const manifestPath = path.join(tline, "brain-runtime-manifest.json");
const manifest = JSON.stringify({schemaVersion:1, files:hashes, commandSuggestionsSha256:suggestionHash}, null, 2) + "\n";
if (check) {
  if (!fs.existsSync(manifestPath) || fs.readFileSync(manifestPath,"utf8").replace(/\r\n/g,"\n") !== manifest) {
    throw new Error("T-Line Brain manifest is out of sync.");
  }
} else fs.writeFileSync(manifestPath, manifest);
console.log(check ? "T-Line Brain Core runtime synchronized." : "Generated T-Line Brain Core storage, transfers, and index.");
