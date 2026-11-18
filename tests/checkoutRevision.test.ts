import {describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {readCheckoutRevision} from "../src/core/runtime/checkoutRevision.js";
describe("read-only Git HEAD evidence",()=>{
  it("reads exact known ref without invoking Git hooks",()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"sa-revision-"));
    try {
      fs.mkdirSync(path.join(dir,".git","refs","heads"),{recursive:true});
      fs.writeFileSync(path.join(dir,".git","HEAD"),"ref: refs/heads/main\n");
      fs.writeFileSync(path.join(dir,".git","refs","heads","main"),"a".repeat(40)+"\n");
      expect(readCheckoutRevision(dir)).toBe("a".repeat(40));
      fs.writeFileSync(path.join(dir,".git","HEAD"),"ref: ../../private\n");
      expect(readCheckoutRevision(dir)).toBeNull();
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
  it("reports unavailable for no .git without calling shell or reading other files",()=>{
    expect(readCheckoutRevision(os.tmpdir())).toBeNull();
  });
});
