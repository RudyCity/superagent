import {describe,expect,it} from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import {resolveNativeDesktopExecutable} from "../../src/core/desktopUi/nativeExecutableIdentity.js";
describe("real OS-bound native executable attestation",()=>{
  it("attests the current process executable path and SHA256 without user metadata",async()=>{
    const id=await resolveNativeDesktopExecutable(process.pid);
    expect(id).not.toBeNull();
    expect(id!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(id!.executablePath.length).toBeGreaterThan(3);
    expect(id!.platform).toBe(process.platform==="win32"?"win32":process.platform==="darwin"?"darwin":"linux");
    const expected=crypto.createHash("sha256")
      .update(fs.readFileSync(fs.realpathSync.native(process.execPath)))
      .digest("hex");
    expect(id!.sha256).toBe(expected);
  });
  it("fails closed if PID is absent, invalid or unrelated",async()=>{
    expect(await resolveNativeDesktopExecutable(-1)).toBeNull();
    expect(await resolveNativeDesktopExecutable(Number.NaN)).toBeNull();
    expect(await resolveNativeDesktopExecutable(0)).toBeNull();
    expect(await resolveNativeDesktopExecutable(0xffffffff)).toBeNull();
  });
});
