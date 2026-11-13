#!/usr/bin/env node
/** Strict, tag-scoped inventory verifier before publishing the unified prerelease. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const base=path.resolve(process.argv[2]||path.join(root,"downloaded-assets"));
function assert(ok,message){if(!ok)throw new Error("UNIFIED_RELEASE_INVALID: "+message);}
const project=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
const version=project.version;
assert(/^\d+\.\d+\.\d+$/.test(version),"invalid project version");
const tray=JSON.parse(fs.readFileSync(path.join(root,"apps/superagent-tray/src-tauri/tauri.conf.json"),"utf8"));
assert(tray.version===version,"Core / Tray version mismatch");
const lan=JSON.parse(fs.readFileSync(path.join(root,"apps/superagent-lan-windows/src-tauri/tauri.conf.json"),"utf8"));
assert(/^\d+\.\d+\.\d+$/.test(lan.version),"invalid LAN Windows version");
const gradle=fs.readFileSync(path.join(root,"apps/superagent-lan-android/app/build.gradle"),"utf8");
const androidVersion=gradle.match(/\bversionName\s+'([^']+)'/)?.[1];
assert(androidVersion && /^[a-zA-Z0-9._-]+$/.test(androidVersion),"invalid Android versionName");
const delegate=JSON.parse(fs.readFileSync(path.join(root,"chrome-extension-delegate/manifest.json"),"utf8"));
const sidepanel=JSON.parse(fs.readFileSync(path.join(root,"chrome-extension/manifest.json"),"utf8"));
const exts=[["delegate",delegate,"SuperAgent Delegate (ChatGPT)"],["sidepanel",sidepanel,"SuperAgent Chrome SidePanel"]];
const coreNames=[
  `SuperAgent_${version}_x64-setup.exe`,
  `SuperAgent_${version}_aarch64.dmg`,
  `SuperAgent_${version}_amd64.deb`,
  `SuperAgent_${version}_amd64.AppImage`,
];
const otherNames=[
  `SuperAgent-LAN-Client-${lan.version}-Windows-x64-setup.exe`,
  `SuperAgent-LAN-Android-${androidVersion}-debug.apk`,
  `SuperAgent-LAN-Android-${androidVersion}-metadata.json`,
];
const extNames=exts.flatMap(([kind,manifest])=>[
  `superagent-${kind}-${manifest.version}.zip`,
  `superagent-${kind}-${manifest.version}.receipt.json`,
]);
const expected=[...coreNames,...otherNames,...extNames].sort();
assert(fs.existsSync(base)&&fs.lstatSync(base).isDirectory(),"artifact directory missing");
const actual=fs.readdirSync(base).sort();
assert(JSON.stringify(actual)===JSON.stringify(expected),
  "expected exact inventory: "+JSON.stringify(expected)+"; found "+JSON.stringify(actual));
const digest=p=>crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
for(const name of expected){
  const p=path.join(base,name),stat=fs.lstatSync(p);
  assert(stat.isFile()&&!stat.isSymbolicLink(),"not a regular file: "+name);
  const minimum=/\.(exe|dmg|deb|AppImage)$/.test(name)?20_000_000:/\.apk$/.test(name)?1_000_000:/\.zip$/.test(name)?1000:100;
  assert(stat.size>=minimum,"file too small: "+name+" ("+stat.size+")");
}
const metadata=JSON.parse(fs.readFileSync(path.join(base,otherNames[2]),"utf8"));
assert(metadata.applicationId==="click.superagent.lanclient","unexpected Android package id");
assert(metadata.variantName==="debug","expected Android debug APK metadata");
assert(metadata.elements?.length===1&&metadata.elements[0].versionName===androidVersion,
  "Android version mismatch");
for(const [kind,manifest,label] of exts){
  assert(manifest.manifest_version===3,"invalid MV3 manifest: "+kind);
  const stem=`superagent-${kind}-${manifest.version}`;
  const receipt=JSON.parse(fs.readFileSync(path.join(base,stem+".receipt.json"),"utf8"));
  assert(receipt.component===label&&receipt.version===manifest.version&&
    receipt.archive===stem+".zip"&&receipt.sha256===digest(path.join(base,stem+".zip")),
    "extension release receipt mismatch: "+stem);
  assert(Object.keys(receipt.packagedFiles||{}).length>3,"extension packaged file list empty: "+stem);
}
console.log("UNIFIED_RELEASE_INVENTORY_VERIFIED",expected.length,"assets",version,
  "LAN",lan.version,"Android",androidVersion,"Delegate",delegate.version,
  "SidePanel",sidepanel.version);
for(const name of expected)console.log(digest(path.join(base,name))+"  "+name);
