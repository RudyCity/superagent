import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const version=JSON.parse(fs.readFileSync("package.json","utf8")).version;
const deb=`SuperAgent_${version}_amd64.deb`;
const appimage=`SuperAgent_${version}_amd64.AppImage`;
function invoke(root:string){
  return spawnSync("node",["scripts/normalize-unified-release-assets.mjs",root],{
    cwd:process.cwd(),encoding:"utf8",timeout:10000,
  });
}
function tempDir(){return fs.mkdtempSync(path.join(os.tmpdir(),"superagent-release-layout-"));}
function nested(root:string){
  fs.mkdirSync(path.join(root,"deb"));
  fs.mkdirSync(path.join(root,"appimage"));
  fs.writeFileSync(path.join(root,"deb",deb),"deb-payload");
  fs.writeFileSync(path.join(root,"appimage",appimage),"appimage-payload");
}

describe("Unified GitHub Release Linux artifact path normalization",()=>{
  it("flattens only expected DEB and AppImage paths preserved by upload-artifact",()=>{
    const root=tempDir();
    try {
      nested(root);
      fs.writeFileSync(path.join(root,"SuperAgent_WIN-setup.exe"),"leave untouched");
      const result=invoke(root);
      expect(result.status,result.stderr).toBe(0);
      expect(fs.readFileSync(path.join(root,deb),"utf8")).toBe("deb-payload");
      expect(fs.readFileSync(path.join(root,appimage),"utf8")).toBe("appimage-payload");
      expect(fs.existsSync(path.join(root,"deb"))).toBe(false);
      expect(fs.existsSync(path.join(root,"appimage"))).toBe(false);
      expect(fs.readFileSync(path.join(root,"SuperAgent_WIN-setup.exe"),"utf8")).toBe("leave untouched");
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });

  it("allows already-flat verified layout without altering files",()=>{
    const root=tempDir();
    try{
      fs.writeFileSync(path.join(root,deb),"deb");
      fs.writeFileSync(path.join(root,appimage),"appimage");
      const result=invoke(root);
      expect(result.status,result.stderr).toBe(0);
      expect(fs.readFileSync(path.join(root,deb),"utf8")).toBe("deb");
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });

  it("fails closed on duplicate packages instead of choosing one silently",()=>{
    const root=tempDir();
    try{
      nested(root);
      fs.writeFileSync(path.join(root,deb),"duplicate");
      const result=invoke(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("RELEASE_LAYOUT_INVALID");
      expect(fs.readFileSync(path.join(root,"deb",deb),"utf8")).toBe("deb-payload");
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });

  it("rejects unexpected files or incorrect release-version names",()=>{
    for(const unexpected of ["extraneous.txt",`SuperAgent_0.0.0_amd64.deb`]){
      const root=tempDir();
      try{
        nested(root);
        fs.writeFileSync(path.join(root,"deb",unexpected),"malicious");
        const result=invoke(root);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("unexpected Linux artifact members");
      }finally{fs.rmSync(root,{recursive:true,force:true});}
    }
  });
});
