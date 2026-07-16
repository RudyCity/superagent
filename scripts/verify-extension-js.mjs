import { spawnSync } from "node:child_process";

const files = [
  "chrome-extension/background.js",
  "chrome-extension/content.js",
  "chrome-extension/main-world.js",
  "chrome-extension/sidepanel-browser.js",
  "chrome-extension/sidepanel-history.js",
  "chrome-extension/sidepanel-markdown.js",
  "chrome-extension/sidepanel-monitor.js",
  "chrome-extension/sidepanel.js"
];

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0) {
    console.log(`OK ${file}`);
    continue;
  }
  failed = true;
  console.error(`FAIL ${file}`);
  if (result.stderr) console.error(result.stderr.trim());
  if (result.stdout) console.error(result.stdout.trim());
}

if (failed) process.exit(1);
console.log(`Verified ${files.length} extension JavaScript files.`);
