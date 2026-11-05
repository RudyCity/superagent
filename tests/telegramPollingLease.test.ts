import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mock=vi.hoisted(()=>({
  root:"",
  identities:new Map<number,string|null>(),
}));

vi.mock("../src/core/config/paths.js",()=>({
  getRootConfigDir:()=>mock.root,
}));

vi.mock("../src/core/tools/cliBridgeProcessIdentity.js",()=>({
  readProcessStartIdentity:async(pid:number)=>mock.identities.get(pid)??null,
}));

import {
  acquireTelegramPollingLease,
  inspectTelegramPollingOwner,
} from "../src/core/remoteAgent/telegramPollingLease.js";

describe("Telegram polling ownership lease",()=>{
  beforeEach(()=>{
    mock.root=fs.mkdtempSync(path.join(os.tmpdir(),"superagent-tg-lease-"));
    mock.identities.clear();
    mock.identities.set(process.pid,"win:639294394850414830");
  });
  afterEach(()=>{
    fs.rmSync(mock.root,{recursive:true,force:true});
  });

  it("permits one local owner and rejects a second owner for the same token",async()=>{
    const token="123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
    const first=await acquireTelegramPollingLease(token);
    const status=await inspectTelegramPollingOwner(token);
    expect(status).toMatchObject({active:true,pid:process.pid});

    await expect(acquireTelegramPollingLease(token))
      .rejects.toThrow("TELEGRAM_POLL_OWNER_CONFLICT");

    const files=fs.readdirSync(mock.root);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("123456789");
    expect(fs.readFileSync(path.join(mock.root,files[0]),"utf8")).not.toContain(token);

    await first.release();
    expect((await inspectTelegramPollingOwner(token)).active).toBe(false);
  });

  it("reclaims a stale lease only after process identity no longer matches",async()=>{
    const token="123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
    const hash=crypto.createHash("sha256").update(token).digest("hex").slice(0,24);
    const file=path.join(mock.root,"telegram-poll-owner-"+hash+".json");
    fs.writeFileSync(file,JSON.stringify({
      version:1,tokenHash:hash,pid:987654,
      processIdentity:"win:639111111111111111",acquiredAt:Date.now()-60_000,
    }),{mode:0o600});
    mock.identities.set(987654,null);

    const lease=await acquireTelegramPollingLease(token);
    expect(lease.pid).toBe(process.pid);
    const current=JSON.parse(fs.readFileSync(file,"utf8"));
    expect(current.processIdentity).toBe("win:639294394850414830");
    await lease.release();
  });

  it("does not steal a lease when the recorded process birth identity is still live",async()=>{
    const token="123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
    const hash=crypto.createHash("sha256").update(token).digest("hex").slice(0,24);
    const file=path.join(mock.root,"telegram-poll-owner-"+hash+".json");
    const identity="win:639111111111111111";
    fs.writeFileSync(file,JSON.stringify({
      version:1,tokenHash:hash,pid:987654,processIdentity:identity,acquiredAt:Date.now(),
    }),{mode:0o600});
    mock.identities.set(987654,identity);

    await expect(acquireTelegramPollingLease(token))
      .rejects.toThrow("TELEGRAM_POLL_OWNER_CONFLICT");
    expect(JSON.parse(fs.readFileSync(file,"utf8")).pid).toBe(987654);
  });
});
