import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state=vi.hoisted(()=>({root:""}));
vi.mock("../src/core/config/paths.js",()=>({
  getRootConfigDir:()=>state.root,
}));

import {
  deleteRemoteAgentSecret,
  inspectRemoteAgentSecret,
  loadRemoteAgentSecret,
  storeRemoteAgentSecret,
} from "../src/core/remoteAgent/remoteAgentSecretStore.js";

describe("remote agent secret storage",()=>{
  beforeEach(()=>{
    state.root=fs.mkdtempSync(path.join(os.tmpdir(),"superagent-secret-"));
  });
  afterEach(()=>{
    fs.rmSync(state.root,{recursive:true,force:true});
  });

  it("round-trips a secret without writing its plaintext to disk",()=>{
    const secret="123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
    storeRemoteAgentSecret("muse.telegram.bot-token",secret);
    const file=path.join(state.root,"remote-agent-secrets.json");
    const raw=fs.readFileSync(file,"utf8");
    expect(raw).not.toContain(secret);
    expect(loadRemoteAgentSecret("muse.telegram.bot-token")).toBe(secret);
    const info=inspectRemoteAgentSecret("muse.telegram.bot-token");
    expect(info.configured).toBe(true);
    if(process.platform==="win32"){
      expect(info.storage).toBe("dpapi-current-user");
      expect(info.platformProtected).toBe(true);
    } else {
      expect(info.storage).toBe("file-0600");
    }
  });

  it("deletes only the requested secret",()=>{
    storeRemoteAgentSecret("muse.telegram.bot-token","test-secret-value");
    expect(deleteRemoteAgentSecret("muse.telegram.bot-token")).toBe(true);
    expect(loadRemoteAgentSecret("muse.telegram.bot-token")).toBeUndefined();
    expect(deleteRemoteAgentSecret("muse.telegram.bot-token")).toBe(false);
  });
});
