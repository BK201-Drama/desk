import { describe, expect, it } from "vitest";
import {
  buildRows,
  collectCommands,
  collectNav,
  clampSelected,
  PINNED_COMMAND_IDS,
} from "./navLogic";
import type { HostCommand } from "../../host/types";

describe("collectCommands", () => {
  const mk = (id: string, title = id): HostCommand => ({
    id,
    title,
    group: "G",
    run: () => {},
  });

  it("pins daily commands when not searching", () => {
    const all = [
      mk("remind:add", "添加待办"),
      mk("github:sync", "同步 GitHub"),
      mk("multica:open", "打开 Multica 看板"),
      mk("fence:toggle-desktop-icons", "显示 / 隐藏桌面图标"),
      mk("github:open-profile", "打开 GitHub 主页"),
    ];
    const out = collectCommands(false, [], all);
    expect(out.map((c) => c.id)).toEqual([...PINNED_COMMAND_IDS]);
  });

  it("lists all commands when searching", () => {
    const all = [mk("remind:add"), mk("github:open-profile")];
    const out = collectCommands(true, [], all);
    expect(out.map((c) => c.id)).toEqual(["remind:add", "github:open-profile"]);
  });
});

describe("collectNav", () => {
  it("lists main plugins when not searching", () => {
    const items = collectNav("", new Set(["hello"]), []);
    const plugins = items.filter((i) => i.kind === "plugin");
    expect(plugins.some((p) => p.kind === "plugin" && p.id === "github")).toBe(true);
    expect(plugins.some((p) => p.kind === "plugin" && p.id === "hello")).toBe(false);
  });

  it("filters by query", () => {
    const cmds: HostCommand[] = [
      { id: "x", title: "Alpha", group: "Desk", run: async () => {} },
    ];
    const items = collectNav("alpha", new Set(), cmds);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("cmd");
  });

  it("prepends appearance toggles", () => {
    const items = collectNav(
      "",
      new Set(),
      [],
      [{ id: "night", title: "夜间模式", group: "外观", on: true }]
    );
    expect(items[0]).toMatchObject({ kind: "toggle", id: "night", on: true });
  });

  it("filters toggles by query", () => {
    const items = collectNav(
      "夜间",
      new Set(),
      [{ id: "x", title: "Alpha", group: "Desk", run: async () => {} }],
      [{ id: "night", title: "夜间模式", group: "外观", on: false }]
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("toggle");
  });
});

describe("buildRows", () => {
  it("inserts group headers", () => {
    const rows = buildRows([
      { kind: "cmd", group: "A", cmd: { id: "1", title: "t", run: async () => {} } },
      { kind: "plugin", group: "插件", id: "github", title: "GitHub", on: true },
    ]);
    expect(rows.filter((r) => r.kind === "head")).toHaveLength(2);
  });
});

describe("clampSelected", () => {
  it("clamps to valid range", () => {
    expect(clampSelected(5, 3)).toBe(2);
    expect(clampSelected(-1, 3)).toBe(0);
    expect(clampSelected(0, 0)).toBe(0);
  });
});
