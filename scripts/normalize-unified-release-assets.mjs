#!/usr/bin/env node
/**
 * Normalize only GitHub Actions upload-artifact's known Linux path layout.
 * The Linux multi-path upload preserves deb/ and appimage/ subdirectories,
 * unlike the Windows/macOS single-file artifacts. Fail on duplicates, symlinks,
 * unexpected members, or missing files; the next gate validates all 11 assets.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(process.argv[2] ?? path.join(repo,"downloaded-assets"));
const version=JSON.parse(fs.readFileSync(path.join(repo,"package.json"),"utf8")).version;
function insist(ok, message) { if(!ok)throw Error("RELEASE_LAYOUT_INVALID: "+message); }
insist(fs.existsSync(root) && fs.lstatSync(root).isDirectory() &&
  !fs.lstatSync(root).isSymbolicLink(),"download directory unavailable or unsafe");

for(const [dir, filename] of [
  ["deb",`SuperAgent_${version}_amd64.deb`],
  ["appimage",`SuperAgent_${version}_amd64.AppImage`],
]){
  const nested = path.join(root,dir);
  const direct = path.join(root,filename);
  const hasNested=fs.existsSync(nested);
  const hasDirect=fs.existsSync(direct);
  insist(hasNested !== hasDirect,"expected exactly one location for "+filename);
  if(!hasNested) {
    const stat=fs.lstatSync(direct);
    insist(stat.isFile() && !stat.isSymbolicLink(),"unsafe direct package "+filename);
    continue;
  }
  const dirStat=fs.lstatSync(nested);
  insist(dirStat.isDirectory() && !dirStat.isSymbolicLink(),"unsafe Linux artifact dir "+dir);
  const items=fs.readdirSync(nested);
  insist(items.length===1 && items[0]===filename,
    "unexpected Linux artifact members in "+dir+": "+JSON.stringify(items));
  const source=path.join(nested,filename);
  const stat=fs.lstatSync(source);
  insist(stat.isFile() && !stat.isSymbolicLink(),"unsafe Linux package "+filename);
  fs.renameSync(source,direct);
  fs.rmdirSync(nested);
  console.log("NORMALIZED_LINUX_RELEASE_ARTIFACT",dir,filename,stat.size);
}
console.log("RELEASE_LINUX_LAYOUT_VERIFIED",version);
