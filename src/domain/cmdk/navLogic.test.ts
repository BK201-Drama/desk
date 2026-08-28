import { describe, expect, it } from "vitest";
import { buildRows, collectNav, clampSelected } from "./navLogic";
import type { HostCommand } from "../../host/types";

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
