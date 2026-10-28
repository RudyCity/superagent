import { McpActivityJournal } from "../../src/core/mcp/mcpActivityJournal.js";

const [journalPath, workerIdStr, entriesCountStr, maxBytesStr] = process.argv.slice(2);
const workerId = parseInt(workerIdStr || "1", 10);
const entriesCount = parseInt(entriesCountStr || "20", 10);
const maxBytes = parseInt(maxBytesStr || "5120", 10);

const journal = new McpActivityJournal({
  journalPath,
  maxJournalBytes: maxBytes,
  maxArchives: 3,
});

async function run() {
  for (let i = 0; i < entriesCount; i++) {
    journal.appendEntry({
      ts: Date.now(),
      pid: process.pid,
      chatLine: `Worker ${workerId} entry ${i}`,
      event: {
        type: "tool_call",
        tool: "concurrent_worker_tool",
        output: "payload ".repeat(20),
        timestamp: Date.now(),
      },
    });
    // Small sleep to interleave writes across separate OS processes
    await new Promise((r) => setTimeout(r, 2));
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(String(err) + "\n");
    process.exit(1);
  });
