/// <reference types="vite/client" />
// ↑ 只为下面那条 `?raw` 导入提供类型（Vite 声明 `declare module '*?raw'`）。
// ⚠️ 用 `?raw` 而不是 `node:fs`：本仓**没有装 `@types/node`**，`node:fs` 会让 `tsc`
// 报 TS2307，而 `npm run build` 就是 `tsc && vite build` —— 整个构建会挂。
import MOCK_SRC from "../../e2e/tauri-mock.js?raw";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../generated/commands";

/**
 * mock 与**真实命令面**的一致性：`COMMANDS` == 「mock 有 case 的」∪ `KNOWN_UNMOCKED`。
 *
 * ⚠️ 抓的是**幽灵 case** —— 一条后端根本不存在的命令被 mock 得好好的，测试全绿，
 * 读代码的人以为它有后端。反方向（后端有、mock 没有）靠 `KNOWN_UNMOCKED` 登记。
 */

/**
 * `plugin:*` / `core:*` 是 **Tauri 自己的 IPC 通道名**，不经 `generate_handler!` 注册，
 * 所以它们本来就不该出现在 `COMMANDS` 里 —— 幽灵断言的唯一豁免，不许整类放开。
 */
const IPC_PREFIXES = ["plugin:", "core:"];
const IPC_CASES = ["plugin:event|listen", "plugin:event|unlisten"];

function mockCases(): string[] {
  return [...MOCK_SRC.matchAll(/case\s+"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * 后端注册了、mock 却没有 case 的命令 —— **这不是免 mock 的许可证，是一张待办清单**：
 * 值必须写清为什么可以不 mock（下面有断言）；补上真实形状的 case 就把它删掉。
 * 只写文件名，**不写行号** —— 行号一改就漂，写在这儿等于埋假信息。
 *
 * ⚠️ 值的语义**到此为止**：它回答「e2e 为什么不碰它」，不回答「它对不对」。
 * 这两句话在 `plugin_storage_get` / `plugin_storage_set` 上重合过一次 —— 理由
 * 「全仓无插件用 `ctx.storage`」一字不假，而命令自己把实参写成了 `plugin_id`
 * （Tauri 只认 `pluginId`），有插件一用就是 `missing required key`。
 * **「没被调用」不等于「没问题」**。这类实参名的对错现在由 `tauri-args.test.ts`
 * 全量兜着（全仓 47 个调用点），所以那 7 条「全仓无调用点」也**不是**免检区。
 */
const KNOWN_UNMOCKED: Record<string, string> = {
  set_cursor: "FencePanel.tsx 悬停围栏时换光标；e2e 不产生悬停光栅结果",
  multica_app_url: "useMultica.ts 打开 Multica 面板时取一次 URL",
  remind_add: "RemindPanel.tsx 新增提醒",
  remind_toggle: "RemindPanel.tsx 勾选提醒",
  remind_remove: "RemindPanel.tsx 删除提醒",
  fence_restore: "FencePanel.tsx 两处「还原到系统桌面」；会迁移真文件，e2e 不碰",
  qqmusic_launch: "useQqMusic.ts 启动 QQ 音乐",
  qqmusic_toggle: "useQqMusic.ts 播放/暂停",
  qqmusic_next: "useQqMusic.ts 下一首",
  qqmusic_prev: "useQqMusic.ts 上一首",
  plugin_storage_get: "只有 api.ts 的 ctx.storage.get 会调；全仓无插件用 ctx.storage",
  plugin_storage_set: "只有 api.ts 的 ctx.storage.set 会调；同上",
  set_click_through: "只在 api.ts 的白名单里；全仓无调用点（Rust 侧自己 set_ignore_cursor_events）",
  github_set_token: "只在 api.ts 的白名单里；全仓无调用点（token 不由前端写入）",
  fence_status: "只在 api.ts 的白名单里；全仓无调用点",
  plugin_save_custom: "只在 api.ts 的白名单里；全仓无调用点",
  qqmusic_ensure_running: "只在 api.ts 的白名单里；全仓无调用点",
};

describe("mock 与真实命令面一致", () => {
  const cases = mockCases();
  const appCases = cases.filter((c) => !IPC_PREFIXES.some((p) => c.startsWith(p)));
  const ipcCases = cases.filter((c) => IPC_PREFIXES.some((p) => c.startsWith(p)));
  const commandSet = new Set<string>(COMMANDS);
  const mockSet = new Set(appCases);

  it("mock 里每个 case 都是一条后端真有的命令（无幽灵）", () => {
    const ghosts = appCases.filter((c) => !commandSet.has(c));
    expect(
      ghosts,
      `mock 里有后端不存在的 case：${ghosts.join(", ")}\n` +
        "要么删除，要么它其实是 Tauri 的 IPC 通道名（那就该带 plugin:/core: 前缀）。"
    ).toEqual([]);
  });

  it("每条后端命令要么被 mock 覆盖，要么在 KNOWN_UNMOCKED 里显式登记", () => {
    const uncovered = COMMANDS.filter(
      (c) => !mockSet.has(c) && !(c in KNOWN_UNMOCKED)
    );
    expect(
      uncovered,
      `这些命令既没有 mock case、也没登记进 KNOWN_UNMOCKED：${uncovered.join(", ")}\n` +
        "在 e2e 里调它们会直接 throw。补一个写出真实形状的 case，" +
        "或者登记进来并写清为什么可以不 mock。"
    ).toEqual([]);
  });

  it("KNOWN_UNMOCKED 里没有已经补上 case 的条目（清单不许过期）", () => {
    const stale = Object.keys(KNOWN_UNMOCKED).filter((c) => mockSet.has(c));
    expect(
      stale,
      `这些已经补了 case，请从 KNOWN_UNMOCKED 删掉：${stale.join(", ")}`
    ).toEqual([]);
  });

  it("KNOWN_UNMOCKED 里没有后端不存在的命令（清单本身不许腐烂）", () => {
    const bogus = Object.keys(KNOWN_UNMOCKED).filter((c) => !commandSet.has(c));
    expect(
      bogus,
      `KNOWN_UNMOCKED 里有后端不存在的命令：${bogus.join(", ")}`
    ).toEqual([]);
  });

  it("KNOWN_UNMOCKED 每条都写了理由（空白理由 = 又一个沉默）", () => {
    const empty = Object.entries(KNOWN_UNMOCKED)
      .filter(([, why]) => !why.trim())
      .map(([cmd]) => cmd);
    expect(empty, `这些条目没写理由：${empty.join(", ")}`).toEqual([]);
  });

  it("Tauri 插件 IPC 通道名是固定那一小撮，不许当幽灵的挡箭牌", () => {
    expect(ipcCases.slice().sort()).toEqual(IPC_CASES);
  });
});
