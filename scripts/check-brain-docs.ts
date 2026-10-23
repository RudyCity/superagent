import fs from "node:fs";
import path from "node:path";
const root=path.resolve(import.meta.dir,"..");
const readme=fs.readFileSync(path.join(root,"README.md"),"utf8").replace(/\r\n/g,"\n");
const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
const tick=String.fromCharCode(96);
function section(start:string,end:string){
 const a=readme.indexOf(start), b=readme.indexOf(end,a+start.length);
 if(a<0||b<0)throw Error("README missing section "+start+" / "+end);
 return readme.slice(a,b);
}
function check(condition:unknown,message:string){if(!condition)throw Error("README: "+message);}
function fences(content:string,name:string){
 check(content.split("\n").filter(line=>/^\s*```/.test(line)).length%2===0,"Unbalanced code fences: "+name);
}
const install=section("### Installation","### Usage");
const opening=tick.repeat(3)+"bash\n", closing="\n"+tick.repeat(3);
const a=install.indexOf(opening), b=install.indexOf(closing,a+opening.length);
check(a>=0&&b>a,"Installation bash block absent");
check(!install.slice(a,b).includes("On Windows,"),"Windows prose inside bash block");
const windowsNote="On Windows, an older npm global installation";
if(install.includes(windowsNote)){
 check(install.indexOf(windowsNote)>b,"Windows launcher guidance belongs outside the shell block");
}
for(const k of ["build","runtime:smoke"]){
 check(typeof pkg.scripts?.[k]==="string","script missing "+k);
}
for(const command of ["bun run build","bun run runtime:smoke"]){
 check(install.includes(command),"command not documented "+command);
}
if(install.includes(windowsNote)){
 for(const k of ["doctor:launcher","repair:launcher"]){
  check(typeof pkg.scripts?.[k]==="string","Windows launcher command has no matching package script "+k);
  check(install.includes("bun run "+k),"Windows launcher command undocumented "+k);
 }
}
fences(install,"installation");
const brain=section("### Brain — Autonomous Scratch, Multi-Agent Tasks and Recovery","### Keyboard Shortcuts");
fences(brain,"Brain");
for(const command of ["/brain help","/brain task.reconcile","/brain artifact.recover","/scratch","delegate.promote.batch","task.credential.status/rotate/revoke"]){
 check(brain.includes(command),"Brain command missing "+command);
}
for(const m of brain.matchAll(/\]\(([^)]+)\)/g)){
 const dest=decodeURIComponent(m[1]).split("#")[0];
 if(!dest||/^(https?:|mailto:)/i.test(dest))continue;
 const filename=path.resolve(root,dest);
 check(filename.startsWith(root+path.sep)&&fs.existsSync(filename),"broken Brain README link "+dest);
}
for(const name of ["scripts/sync-brain-runtime.ts","scripts/verify-brain-release.ts","src/core/commands/commandCatalog.ts"]){
 check(fs.existsSync(path.join(root,name)),"missing referenced file "+name);
}
console.log("PASS SuperAgent README code fences, Bun examples, Brain links and commands.");
