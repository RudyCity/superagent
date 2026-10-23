import { test, expect } from "bun:test";
import { editYoloBlocks, blockedYoloPath, blockedYoloToolCall, listYoloBlocks } from "../src/core/yoloBlocklist.js";

test("drive and descendants blocked with component boundary", () => {
  const root = "Q:\\";
  try {
    editYoloBlocks("add", root);
    expect(blockedYoloPath("Q:\\Users\\demo.txt")).toBeTruthy();
    expect(blockedYoloToolCall({ filePath: "Q:\\Users\\demo.txt" })).toBeTruthy();
    expect(blockedYoloToolCall({ command: "type Q:\\Users\\demo.txt" })).toBeTruthy();
    expect(blockedYoloPath("R:\\Users\\demo.txt")).toBeUndefined();
  } finally {
    editYoloBlocks("remove", root);
  }
});

test("block add remove and list", () => {
  const target = "R:\\secrets";
  try {
    editYoloBlocks("add", target);
    expect(listYoloBlocks().length).toBeGreaterThan(0);
    expect(blockedYoloPath("R:\\secrets\\file.txt")).toBeTruthy();
    expect(blockedYoloPath("R:\\secrets-other\\file.txt")).toBeUndefined();
  } finally {
    editYoloBlocks("remove", target);
  }
});

test("nested batch file arguments and case insensitive Windows paths", () => {
  try {
    editYoloBlocks("add", "T:\\Private");
    expect(blockedYoloToolCall({ files: [{ filePath: "t:\\private\\nested\\secret.txt" }] })).toBeTruthy();
    expect(blockedYoloPath("T:\\PRIVATE\\nested\\secret.txt")).toBeTruthy();
    expect(blockedYoloPath("T:\\PrivateOther\\safe.txt")).toBeUndefined();
  } finally { editYoloBlocks("remove", "T:\\Private"); }
});

test("block persists between reads and can be removed", () => {
  const dir = "U:\\My Private";
  try {
    editYoloBlocks("add", dir);
    expect(listYoloBlocks().some(p => p.includes("my private"))).toBe(true);
    expect(blockedYoloToolCall({ command: 'type "U:\\My Private\\note.txt"' })).toBeTruthy();
  } finally { editYoloBlocks("remove", dir); }
  expect(blockedYoloPath("U:\\My Private\\note.txt")).toBeUndefined();
});
