import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrayManagementPassword } from "../../src/core/desktopUi/trayManagementPassword.js";

const dirs:string[]=[];
function setup(now=Date.now()) {
  const dir=mkdtempSync(join(tmpdir(),"sa-tray-password-"));
  dirs.push(dir);
  const path=join(dir,"password.json");
  return {path, store:new TrayManagementPassword(path,()=>now)};
}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

describe("Tray password is a separate host-only management secret",()=>{
  it("requires strong password and persists only a salted scrypt digest",()=>{
    const {store,path}=setup();
    expect(store.status()).toEqual({configured:false,remoteEnabled:false});
    expect(()=>store.set({newPassword:"short"})).toThrow("PASSWORD_MINIMUM_12_REQUIRED");
    const password="This-Is-A-Unique-Password-2026!";
    expect(store.set({newPassword:password})).toEqual({configured:true,remoteEnabled:false});
    const raw=readFileSync(path,"utf8");
    expect(raw).not.toContain(password);
    expect(raw).toContain('"algorithm":"scrypt-v1"');
    expect(store.verify("invalid","password-test-1")).toBe(false);
    expect(store.verify(password,"password-test-1")).toBe(true);
    expect(()=>store.set({newPassword:"Change-Me-Forever-2027!"})).toThrow("INVALID_CURRENT_PASSWORD");
    expect(store.set({currentPassword:password,newPassword:"Change-Me-Forever-2027!"}).configured).toBe(true);
    expect(store.verify(password,"password-test-2")).toBe(false);
    expect(store.verify("Change-Me-Forever-2027!","password-test-2")).toBe(true);
  });
  it("rate-limits incorrect guesses and never unlocks when no password exists",()=>{
    const {store}=setup();
    expect(store.verify("Very-long-passphrase-123","wrong-only-1")).toBe(false);
    store.set({newPassword:"Successful-Password-123"});
    for(let i=0;i<5;i++)expect(store.verify("Wrong-Password-0123","ratelimit-1")).toBe(false);
    expect(store.verify("Successful-Password-123","ratelimit-1")).toBe(false);
  });
});
