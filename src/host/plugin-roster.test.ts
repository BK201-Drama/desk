import { describe, expect, it } from "vitest";
import {
  EXTENDED_PLUGINS,
  MAIN_PLUGINS,
  PLUGIN_LABEL,
} from "../plugins/cmdk/constants";
import { ALL_KNOWN_PLUGINS } from "./schemeLogic";

/**
 * 插件目录 ↔ 名册的一致性。
 *
 * 抓的是 `sys-res` 那种**静默掉队**：插件做完了、manifest 在、后端三套预设都认识它，
 * 但名册里没有它 → 命令面板列不出、搜不到，方案编辑器也认不出 → **用户没有任何入口
 * 把这个面板打开**，而 `tsc`、单测、e2e、样式审查全部照绿。
 *
 * 它藏了很久还有一个原因：`sys-res` 被三套预设默认列入 disabled，所以
 * 「面板没显示」看起来完全正常 —— 只有当你想手动打开它时才会发现根本无处可点。
 */

const manifests = import.meta.glob("../plugins/*/manifest.json", {
  eager: true,
  import: "default",
}) as Record<string, { id?: string }>;

/** 目录名以 `_` 开头的不是插件（见 `src/plugins/index.ts` 文件头）。 */
function dirName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 2] ?? "";
}

function pluginIds(): string[] {
  return Object.entries(manifests)
    .filter(([path]) => !dirName(path).startsWith("_"))
    .map(([path, m]) => {
      if (!m?.id) throw new Error(`manifest 读不出 id：${path}`);
      return m.id;
    })
    .sort();
}

/**
 * 不在名册里的插件 —— **不是免登记的许可证，是一张待办清单**：每条写明为什么。
 */
const ROSTER_EXEMPT: Record<string, string> = {
  cmdk: "命令面板自己。它的开关就是面板本身，列进「插件」组等于让用户把自己正开着的面板关掉。",
};

describe("插件名册与真实插件目录一致", () => {
  const ids = pluginIds();
  const labeled = new Set(Object.keys(PLUGIN_LABEL));
  const listed = new Set<string>([...MAIN_PLUGINS, ...EXTENDED_PLUGINS]);
  const known = new Set<string>(ALL_KNOWN_PLUGINS);

  it("扫到的插件数不为零（glob 失配会让这个文件整体变空转）", () => {
    expect(ids.length).toBeGreaterThan(5);
  });

  it("每个插件目录都在 PLUGIN_LABEL 里（漏了 = 命令面板列不出、也搜不到）", () => {
    const missing = ids.filter((id) => !labeled.has(id) && !(id in ROSTER_EXEMPT));
    expect(
      missing,
      `这些插件没有标签，命令面板里列不出也搜不到：${missing.join(", ")}\n` +
        "在 PLUGIN_LABEL 补一行，或加进 ROSTER_EXEMPT 并写清理由。"
    ).toEqual([]);
  });

  it("每个插件目录都在 MAIN 或 EXTENDED 里（都不在 = 没有入口打开它）", () => {
    const missing = ids.filter((id) => !listed.has(id) && !(id in ROSTER_EXEMPT));
    expect(
      missing,
      `这些插件不在任何名单里：${missing.join(", ")}\n` +
        "注意：MAIN 是无条件全列的，EXTENDED 会被预设的 disabled 过滤掉 —— " +
        "**默认 disabled 的插件放进 EXTENDED 等于永远不显示**，那类必须放 MAIN。"
    ).toEqual([]);
  });

  it("每个插件目录都在 ALL_KNOWN_PLUGINS 里（漏了 = 方案编辑器两条 chip 轨对不上）", () => {
    const missing = ids.filter((id) => !known.has(id) && !(id in ROSTER_EXEMPT));
    expect(
      missing,
      `这些插件不在 ALL_KNOWN_PLUGINS 里：${missing.join(", ")}\n` +
        "它喂的是方案编辑器的「已保存」轨，而「当前」轨走的是实际挂载的插件 —— " +
        "两边名单一分叉，用户会以为方案没存住。"
    ).toEqual([]);
  });

  it("豁免表里没有已经登记的条目（清单不许过期）", () => {
    const stale = Object.keys(ROSTER_EXEMPT).filter(
      (id) => labeled.has(id) && listed.has(id) && known.has(id)
    );
    expect(stale, `这些已经登记了，请从 ROSTER_EXEMPT 删掉：${stale.join(", ")}`).toEqual([]);
  });

  it("豁免表里没有不存在的插件（清单本身不许腐烂）", () => {
    const bogus = Object.keys(ROSTER_EXEMPT).filter((id) => !ids.includes(id));
    expect(bogus, `ROSTER_EXEMPT 里有不存在的插件：${bogus.join(", ")}`).toEqual([]);
  });

  it("豁免表每条都写了理由（空白理由 = 又一个沉默）", () => {
    const empty = Object.entries(ROSTER_EXEMPT)
      .filter(([, why]) => !why.trim())
      .map(([id]) => id);
    expect(empty, `这些条目没写理由：${empty.join(", ")}`).toEqual([]);
  });
});
