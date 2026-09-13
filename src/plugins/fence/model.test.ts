import { describe, expect, it } from "vitest";
import {
  ROWS_MAX,
  applyLayout,
  clampRows,
  gridClass,
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
      { id: "1", label: "英雄联盟", path: "C:/lol.exe", icon: null, isDir: false },
      { id: "2", label: "Other", path: "C:/o.exe", icon: null, isDir: false },
    ],
    collapsed: false,
    rows: 0,
  },
  {
    name: "工具",
    items: [{ id: "3", label: "飞书", path: "C:/feishu.exe", icon: null, isDir: false }],
    collapsed: false,
    rows: 0,
  },
];

describe("normalizeFences", () => {
  it("null-safe", () => {
    expect(normalizeFences(null)).toEqual([]);
  });

  it("is_dir 缺字段 / 写成字符串都算「不是目录」", () => {
    const [f] = normalizeFences([
      { name: "文件夹", items: [
        { id: "a", label: "下载", path: "C:/下载", icon: null, is_dir: true },
        { id: "b", label: "无字段", path: "C:/b", icon: null },
        { id: "c", label: "字符串", path: "C:/c", icon: null, is_dir: "true" },
      ] },
    ]);
    expect(f.items.map((i) => i.isDir)).toEqual([true, false, false]);
  });

  /**
   * 显示偏好（2026-09-13）的**读**。三条一起钉：缺字段、写成字符串、越界。
   * 与 `is_dir` 是同一条规矩 —— 只认字面 `true`，其余一切走默认值。
   */
  it("collapsed 缺字段 / 写成字符串都算「没收起」，rows 越界回落到自动", () => {
    const [f] = normalizeFences([
      {
        name: "游戏",
        items: [],
        collapsed: "true", // 字符串不算
        rows: 99, // 越界（后端读取时也会夹，这里是第二道）
      },
    ]);
    expect(f.collapsed).toBe(false);
    expect(f.rows).toBe(ROWS_MAX);

    const [g] = normalizeFences([{ name: "工具", items: [] }]);
    expect(g.collapsed).toBe(false);
    expect(g.rows).toBe(0);
  });

  it("collapsed: true 与合法 rows 原样读进来", () => {
    const [f] = normalizeFences([{ name: "工作", items: [], collapsed: true, rows: 3 }]);
    expect(f.collapsed).toBe(true);
    expect(f.rows).toBe(3);
  });
});

describe("clampRows / gridClass", () => {
  it("0 与非法值都是「自动」，其余夹在 1..ROWS_MAX", () => {
    expect([clampRows(0), clampRows(-2), clampRows(NaN), clampRows("3")]).toEqual([0, 0, 0, 0]);
    expect([clampRows(1), clampRows(3), clampRows(99), clampRows(2.7)]).toEqual([1, 3, ROWS_MAX, 2]);
  });

  it("自动时**原样**返回 fence-grid，不拼尾随空格", () => {
    // 多一个尾随空格就是样式审查里的一处假 diff（它把 className 原文录进基线）
    expect(gridClass(0)).toBe("fence-grid");
    expect(gridClass(3)).toBe("fence-grid rows-3");
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

  /**
   * 跨栏拖拽**不许顺手改显示偏好**。`moveItemAcross` 是 `{...f, items}` 重建 group 的，
   * 今天靠展开运算符保真 —— 这条把「保真」变成回归测试：哪天有人把它改写成
   * `{ name: f.name, items }`，收起的围栏会在拖一下之后自己展开。
   */
  it("preserves collapsed / rows", () => {
    const src: FenceGroup[] = [
      { ...sample[0], collapsed: true, rows: 4 },
      { ...sample[1], collapsed: false, rows: 2 },
    ];
    const next = moveItemAcross(src, "1", "工具", null);
    expect(next[0].collapsed).toBe(true);
    expect(next[0].rows).toBe(4);
    expect(next[1].rows).toBe(2);
  });
});

describe("applyLayout", () => {
  /** 同一件事的第二个落点：按 layout 重排之后，显示偏好也得原样在。 */
  it("preserves collapsed / rows", () => {
    const src: FenceGroup[] = [{ ...sample[0], collapsed: true, rows: 5 }, sample[1]];
    const next = applyLayout(src, [
      { name: "游戏", ids: ["2", "1"] },
      { name: "工具", ids: ["3"] },
    ]);
    expect(next[0].items.map((i) => i.id)).toEqual(["2", "1"]);
    expect(next[0].collapsed).toBe(true);
    expect(next[0].rows).toBe(5);
  });
});
