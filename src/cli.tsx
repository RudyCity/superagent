#!/usr/bin/env node

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Usage: superagent [options] [prompt]

Options:
  -r, --resume      Resume the last active session
  --multi           Start in Multi Superagent master orchestrator mode
  -s, --server [P]  Start API server for Chrome Extension (default port: 3000)
  -h, --help        Show this help message and exit

Examples:
  superagent
  superagent --resume
  superagent --multi
  superagent --server 3000
  superagent "explain quantum computing in simple terms"
`);
  process.exit(0);
}

const serverIndex = process.argv.findIndex(arg => arg === "--server" || arg === "-s");
if (serverIndex !== -1) {
  let port = 3000;
  if (serverIndex + 1 < process.argv.length) {
    const nextArg = process.argv[serverIndex + 1];
    const parsed = parseInt(nextArg, 10);
    if (!isNaN(parsed) && parsed > 0) {
      port = parsed;
    }
  }
  const { runServer } = await import("./server.js");
  await runServer(port);
} else {
  // Boot the main CLI logic
  const { runCli } = await import("./cliMain.js");
  await runCli();
}

export {};

