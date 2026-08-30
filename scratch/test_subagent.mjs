// Just import subagentTools to see what happens
try {
  const mod = await import("../src/core/tools/subagentTools.js");
  console.log("Loaded subagentTools successfully");
  console.log("defineSubagentTool:", typeof mod.defineSubagentTool);
} catch (e) {
  console.error("Error loading subagentTools:", e.message);
  console.error(e.stack);
}
