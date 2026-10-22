import { readFile } from "node:fs/promises";

if (!process.versions.bun) throw new Error("Extension syntax validation requires Bun");
const transpiler = new Bun.Transpiler({ loader: "js", target: "browser" });
const files = [
  "chrome-extension/background.js",
  "chrome-extension/content.js",
  "chrome-extension/main-world.js",
  "chrome-extension/sidepanel-browser.js",
  "chrome-extension/sidepanel-history.js",
  "chrome-extension/sidepanel-markdown.js",
  "chrome-extension/sidepanel-monitor.js",
  "chrome-extension/sidepanel.js",
];

let failed = false;
for (const file of files) {
  try {
    // Parsing/transpilation must never execute Chrome extension code in Bun.
    // Unlike Node's --check, Bun 1.4.x may execute the script under --check.
    const code = await readFile(file, "utf8");
    transpiler.transformSync(code);
    console.log("OK", file);
  } catch (error) {
    failed = true;
    console.error("FAIL", file, error instanceof Error ? error.message : String(error));
  }
}
if (failed) process.exitCode = 1;
else console.log(`Verified ${files.length} extension JavaScript files without executing browser globals.`);
