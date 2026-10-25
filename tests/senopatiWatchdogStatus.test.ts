import {describe,it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {readSenopatiWatchdogStatus} from "../src/core/senopatiWatchdogStatus.js";

function fixture(test:(file:string,write:(overrides?:Record<string,unknown>)=>void)=>void):void {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"senopati-watch-status-"));
  const file=path.join(dir,"watchdog.json");
  const write=(overrides:Record<string,unknown>={})=>{
    fs.writeFileSync(file,JSON.stringify({
      version:1,pid:process.pid,nonce:"a".repeat(32),
      updatedAt:Date.now(),modelPid:12345,healthy:true,...overrides,
    }));
  };
  try {test(file,write);} finally {fs.rmSync(dir,{recursive:true,force:true});}
}

describe("Senopati watchdog status fail-closed freshness",()=>{
  it("accepts a recent heartbeat for an alive owner",()=>{
    fixture((file,write)=>{
      write();
      expect(readSenopatiWatchdogStatus(file)).toMatchObject({
        pid:process.pid,alive:true,heartbeatFresh:true,healthy:true,
        modelPid:12345,
      });
    });
  });
  it("does not report a stale owner healthy even if its PID exists",()=>{
    fixture((file,write)=>{
      write({updatedAt:Date.now()-30_000});
      expect(readSenopatiWatchdogStatus(file)).toMatchObject({
        alive:false,heartbeatFresh:false,healthy:false,
      });
    });
  });
  it("rejects a future-dated heartbeat rather than treating it as fresh",()=>{
    fixture((file,write)=>{
      write({updatedAt:Date.now()+15_000});
      expect(readSenopatiWatchdogStatus(file)).toMatchObject({
        alive:false,heartbeatFresh:false,healthy:false,
      });
    });
  });
  it("does not promote stored healthy status when its owner is dead",()=>{
    fixture((file,write)=>{
      write({pid:2147483600});
      expect(readSenopatiWatchdogStatus(file)).toMatchObject({
        alive:false,heartbeatFresh:true,healthy:false,
      });
    });
  });
  it("refuses invalid owner metadata",()=>{
    fixture((file,write)=>{
      write({nonce:"invalid"});
      expect(readSenopatiWatchdogStatus(file)).toBeNull();
    });
  });
});
