import {describe,it,expect} from "vitest";
import {compareProcessBirth,verifyWindowsProcessBirth}
  from "../src/core/runtime/mcpProcessBirth.js";
describe("R1 process birth identity",()=>{
 it("matches only process birth before lease issuance with a narrow startup window",()=>{
  expect(compareProcessBirth(1_792_983_500_000,1_792_983_496_000)).toBe("matched");
  expect(compareProcessBirth(1_792_983_500_000,1_792_983_470_000)).toBe("matched");
  expect(compareProcessBirth(1_792_983_500_000,1_792_983_469_999)).toBe("mismatch");
  expect(compareProcessBirth(1_792_983_500_000,1_792_983_501_000)).toBe("mismatch");
 });
 it("refuses unverifiable OS or invalid start timestamps",()=>{
  expect(compareProcessBirth(1_792_983_500_000,null)).toBe("unverified");
  expect(compareProcessBirth(0,1_792_983_500_000)).toBe("unverified");
  expect(verifyWindowsProcessBirth(-1,Date.now())).toBe("unverified");
  expect(verifyWindowsProcessBirth(Number.NaN,Date.now())).toBe("unverified");
 });
 it("can read its own Windows PID birth without requiring process termination",()=>{
  if(process.platform!=="win32")return;
  // process uptime may exceed 30s by this point; do not assume it is new.
  const birth = verifyWindowsProcessBirth(process.pid,Date.now());
  expect(["matched","mismatch"]).toContain(birth);
 });
});
