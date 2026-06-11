import { describe, expect, it } from "vitest";
import { stripSgrMouseSequences } from "../src/app.js";

describe("stripSgrMouseSequences", () => {
  it("removes SGR mouse sequences with and without ESC", () => {
    expect(stripSgrMouseSequences("hello\x1b[<0;48;30Mworld[<0;48;30m!")).toBe("helloworld!");
  });

  it("keeps normal text", () => {
    expect(stripSgrMouseSequences("[CODE: text] keep <0;48;30M")).toBe("[CODE: text] keep <0;48;30M");
  });
});
