#!/usr/bin/env node

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Usage: superagent [options] [prompt]

Options:
  -r, --resume    Resume the last active session
  --multi         Start in Multi Superagent master orchestrator mode
  -h, --help      Show this help message and exit

Examples:
  superagent
  superagent --resume
  superagent --multi
  superagent "explain quantum computing in simple terms"
`);
  process.exit(0);
}

// Boot the main CLI logic
const { runCli } = await import("./cliMain.js");
await runCli();

export {};
