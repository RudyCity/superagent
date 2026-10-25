import { readFile, readdir } from "node:fs/promises";

if (!process.versions.bun) throw new Error("Extension syntax validation requires Bun");
const transpiler = new Bun.Transpiler({ loader: "js", target: "browser" });
const files = (await Promise.all(
  ["chrome-extension", "chrome-extension-remote"].map(async (directory) =>
    (await readdir(directory))
      .filter((file) => file.endsWith(".js"))
      .map((file) => directory + "/" + file)
  )
)).flat().sort();

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
