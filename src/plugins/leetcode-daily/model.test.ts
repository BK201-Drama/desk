import { describe, expect, it } from "vitest";
import {
  difficultyLabel,
  normalizeDaily,
  problemUrl,
} from "./model";

describe("normalizeDaily", () => {
  it("maps snake_case fields from Rust", () => {
    const d = normalizeDaily({
      date: "2026-09-20",
      frontend_id: "1",
      title_cn: "两数之和",
      title_slug: "two-sum",
      difficulty: "EASY",
    });
    expect(d).toEqual({
      date: "2026-09-20",
      frontendId: "1",
      titleCn: "两数之和",
      titleSlug: "two-sum",
      difficulty: "EASY",
    });
  });

  it("accepts camelCase and falls back title", () => {
    const d = normalizeDaily({
      date: "2026-09-20",
      frontendId: "2",
      title: "Add Two Numbers",
      titleSlug: "add-two-numbers",
      difficulty: "Medium",
    });
    expect(d?.titleCn).toBe("Add Two Numbers");
    expect(d?.frontendId).toBe("2");
  });

  it("returns null when slug missing", () => {
    expect(normalizeDaily({ date: "2026-09-20", title_cn: "x" })).toBeNull();
  });
});

describe("problemUrl / difficultyLabel", () => {
  it("builds cn problem link", () => {
    expect(problemUrl("two-sum")).toBe("https://leetcode.cn/problems/two-sum/");
  });

  it("labels difficulty in Chinese", () => {
    expect(difficultyLabel("EASY")).toBe("简单");
    expect(difficultyLabel("Medium")).toBe("中等");
    expect(difficultyLabel("hard")).toBe("困难");
    expect(difficultyLabel("")).toBe("—");
  });
});
