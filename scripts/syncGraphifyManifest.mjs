import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const graphifyOut = path.join(rootDir, "graphify-out");
const rootFile = path.join(graphifyOut, ".graphify_root");

if (fs.existsSync(graphifyOut)) {
  fs.writeFileSync(rootFile, rootDir, "utf-8");
  console.log(`[graphify-sync] Synchronized .graphify_root manifest to: ${rootDir}`);
} else {
  console.log("[graphify-sync] graphify-out directory not found, skipping sync.");
}
