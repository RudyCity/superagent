// Test just subagentTools loading
console.log("Starting import of subagentTools...");
try {
  const mod = await import("../src/core/tools/subagentTools.js");
  console.log("subagentTools loaded");
  console.log("defineSubagentTool:", typeof mod.defineSubagentTool);
  console.log("manageSubagentsTool:", typeof mod.manageSubagentsTool);
} catch (e) {
  console.error("Error:", e.message);
  console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
}
