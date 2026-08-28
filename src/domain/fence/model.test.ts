import { describe, expect, it } from "vitest";
import {
  matchesFenceSearch,
  moveItemAcross,
  normalizeFences,
  searchFences,
  type FenceGroup,
} from "./model";

const sample: FenceGroup[] = [
  {
    name: "游戏",
    items: [
      { id: "1", label: "英雄联盟", path: "C:/lol.exe", icon: null },
      { id: "2", label: "Other", path: "C:/o.exe", icon: null },
    ],
  },
  {
    name: "工具",
    items: [{ id: "3", label: "飞书", path: "C:/feishu.exe", icon: null }],
  },
];

describe("normalizeFences", () => {
  it("null-safe", () => {
    expect(normalizeFences(null)).toEqual([]);
  });
});

describe("matchesFenceSearch", () => {
  it("matches alias", () => {
    expect(matchesFenceSearch(sample[0].items[0], "lol")).toBe(true);
  });
});

describe("searchFences", () => {
  it("finds hits", () => {
    expect(searchFences(sample, "飞书")).toHaveLength(1);
  });
});

describe("moveItemAcross", () => {
  it("moves to another fence", () => {
    const next = moveItemAcross(sample, "1", "工具", null);
    expect(next[0].items.find((i) => i.id === "1")).toBeUndefined();
    expect(next[1].items.some((i) => i.id === "1")).toBe(true);
  });
});
