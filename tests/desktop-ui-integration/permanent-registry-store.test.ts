import {describe,expect,it} from "vitest";
import {mkdtempSync,rmSync,writeFileSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {readPermanentAccessRegistry} from "../../src/core/desktopUi/permanentRegistryStore.js";
const ROOT=()=>mkdtempSync(path.join(tmpdir(),"superagent-permanent-access-"));
const filename="desktop-access-registry.json";
describe("permanent registry read-side defense",()=>{
  it("uses the legacy path ONLY for absent v2; rejects a corrupt existing v2 with deny-all",()=>{
    const dir=ROOT();
    try {
      expect(readPermanentAccessRegistry({configDir:dir})).toBeNull();
      writeFileSync(path.join(dir,filename),"{broken");
      expect(readPermanentAccessRegistry({configDir:dir})).toEqual({version:2,defaultEffect:"deny",rules:[]});
      writeFileSync(path.join(dir,filename),JSON.stringify({version:2,defaultEffect:"allow",rules:[]}));
      expect(readPermanentAccessRegistry({configDir:dir})).toEqual({version:2,defaultEffect:"deny",rules:[]});
      writeFileSync(path.join(dir,filename)," ".repeat(130000));
      expect(readPermanentAccessRegistry({configDir:dir})).toEqual({version:2,defaultEffect:"deny",rules:[]});
      writeFileSync(path.join(dir,filename),JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
      expect(readPermanentAccessRegistry({configDir:dir})).toEqual({version:2,defaultEffect:"deny",rules:[]});
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it("rejects symlink registry and relative config path",()=>{
    const dir=ROOT();
    try{
      const outside=path.join(dir,"outside.json");
      writeFileSync(outside,JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
      try {
        symlinkSync(outside,path.join(dir,filename));
        expect(readPermanentAccessRegistry({configDir:dir})).toEqual({version:2,defaultEffect:"deny",rules:[]});
      }catch {/* Windows may forbid symlink creation. */}
      expect(readPermanentAccessRegistry({configDir:"relative"})).toEqual({version:2,defaultEffect:"deny",rules:[]});
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});
