import fs from "fs/promises";
import path from "path";
import { allTools } from "./src/core/tools.js";

const editTool = allTools.find(t => t.name === "edit");
const applyPatchTool = allTools.find(t => t.name === "apply_patch");

async function runTests() {
  const tempFile = path.resolve("./test_temp_file.txt");
  console.log("--- Starting Tests ---");

  // Test 1: CRLF vs LF matching and replacement
  console.log("\n[Test 1] Testing CRLF/LF and space tolerant edit...");
  const crlfContent = "line one\r\nline two   \r\nline three\r\n";
  await fs.writeFile(tempFile, crlfContent, "utf-8");

  // oldString has different line endings (LF only) and different trailing spacing
  const oldString = "line one\nline two";
  const newString = "line one modified\r\nline two modified";

  const result1 = await editTool.execute({
    filePath: tempFile,
    oldString,
    newString
  }, process.cwd());

  console.log("Result:", result1);
  const updatedContent1 = await fs.readFile(tempFile, "utf-8");
  console.log("Updated Content (escaped):\n", JSON.stringify(updatedContent1));
  if (updatedContent1.includes("line one modified") && updatedContent1.includes("line three")) {
    console.log("✅ Test 1 Passed!");
  } else {
    console.error("❌ Test 1 Failed!");
  }

  // Test 2: apply_patch unified diff parser
  console.log("\n[Test 2] Testing apply_patch search-replace hunk...");
  const patchContent = `
<<<<<<<
line one modified
line two modified
=======
line one patched
line two patched
>>>>>>>
  `.trim();

  const result2 = await applyPatchTool.execute({
    filePath: tempFile,
    patchContent
  }, process.cwd());

  console.log("Result:", result2);
  const updatedContent2 = await fs.readFile(tempFile, "utf-8");
  console.log("Updated Content (escaped):\n", JSON.stringify(updatedContent2));
  if (updatedContent2.includes("line one patched")) {
    console.log("✅ Test 2 Passed!");
  } else {
    console.error("❌ Test 2 Failed!");
  }

  // Cleanup
  await fs.unlink(tempFile);
  console.log("\n--- Tests Completed ---");
}

runTests().catch(console.error);
