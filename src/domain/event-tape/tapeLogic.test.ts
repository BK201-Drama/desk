import { describe, expect, it } from "vitest";
import { appendTapeLine, isTapeNoise, summarizeTape, tapeHeadLabel } from "./tapeLogic";

describe("isTapeNoise", () => {
  it("filters host commands and cursor chatter", () => {
    expect(isTapeNoise("host:command-x", {})).toBe(true);
    expect(isTapeNoise("invoke:ok", { cmd: "set_cursor" })).toBe(true);
    expect(isTapeNoise("plugin:mounted", { id: "x" })).toBe(false);
  });
});

describe("summarizeTape", () => {
  it("summarizes invoke", () => {
    expect(summarizeTape("invoke:ok", { cmd: "a", ms: 3 })).toBe("a 3ms");
  });
});

describe("appendTapeLine", () => {
  it("trims to max", () => {
    let lines = appendTapeLine([], { at: 1, type: "a", text: "t" }, 2);
    lines = appendTapeLine(lines, { at: 2, type: "b", text: "t" }, 2);
    lines = appendTapeLine(lines, { at: 3, type: "c", text: "t" }, 2);
    expect(lines.map((l) => l.type)).toEqual(["b", "c"]);
  });
});

describe("tapeHeadLabel", () => {
  it("shows collapsed summary", () => {
    expect(tapeHeadLabel(true, [{ at: 1, type: "x", text: "" }])).toBe("tape · 1 · x");
  });
});
