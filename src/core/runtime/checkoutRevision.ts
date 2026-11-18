/** Read-only, no shell: inspect a checked-out Git HEAD, never arbitrary paths. */
import fs from "node:fs";
import path from "node:path";
const commit=/^[a-f0-9]{40}$/;
export function readCheckoutRevision(root:string):string|null {
  try {
    const dot=path.join(root,".git");
    const meta=fs.lstatSync(dot);
    if(!meta.isDirectory()||meta.isSymbolicLink())return null;
    const headPath=path.join(dot,"HEAD");
    const stat=fs.lstatSync(headPath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256)return null;
    const head=fs.readFileSync(headPath,"utf8").trim().toLowerCase();
    if(commit.test(head))return head;
    const ref=head.startsWith("ref: ")?head.slice(5):"";
    if(!/^refs\/heads\/[a-z0-9_./-]{1,170}$/.test(ref)||
       ref.includes("..")||ref.includes("//")||ref.endsWith("/"))return null;
    const location=path.join(dot,...ref.split("/"));
    try {
      const info=fs.lstatSync(location);
      if(!info.isFile()||info.isSymbolicLink()||info.size>128)return null;
      const hash=fs.readFileSync(location,"utf8").trim().toLowerCase();
      return commit.test(hash)?hash:null;
    }catch {
      // Packed refs are common after repository maintenance. Read a bounded
      // regular file only, with an exact escaped literal ref match.
      const packed=path.join(dot,"packed-refs");
      const info=fs.lstatSync(packed);
      if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)return null;
      const lines=fs.readFileSync(packed,"utf8").split("\n");
      const match=lines.find(line=>line.endsWith(" "+ref)&&commit.test(line.slice(0,40)));
      return match?match.slice(0,40):null;
    }
  }catch{return null;}
}
