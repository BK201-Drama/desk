/// <reference types="vite/client" />
// ↑ 只为下面那条 `?raw` 导入提供类型（Vite 声明 `declare module '*?raw'`）。
// 用 `?raw` 而不是 `node:fs`：这个项目**没有装 `@types/node`**（tsconfig 只
// include `src`、无 `types` 字段），`import { readFileSync } from "node:fs"`
// 会让 `tsc` 报 TS2307 —— 而 `npm run build` 就是 `tsc && vite build`，
// 整个构建会挂。`?raw` 走 Vite 自己的 transform，不需要任何 node 类型。
import MOCK_SRC from "../../e2e/tauri-mock.js?raw";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../generated/commands";

/**
 * mock 与**真实命令面**的一致性。
 *
 * ── 为什么需要这条测试 ────────────────────────────────────────────────────
 *
 * `e2e/tauri-mock.js` 是一段手写的 `switch (cmd)`，而真命令面由 Rust 的
 * `generate_handler![...]` 决定（生成物 `src/generated/commands.ts`）。两边没有
 * 共同的真相源，于是会**双向漂移**：
 *
 *   · mock 多出来 → **幽灵 case**：一条后端根本不存在的命令被 mock 得好好的，
 *     测试全绿，读代码的人以为它有后端。2026-09-14 删掉的 `fence_snapshot` /
 *     `qqmusic_snapshot` 就是两条。
 *   · mock 缺一条 → 以前是 `default: return {}` 静默兜底，同日改成 `throw`，
 *     e2e 会当场红。但 e2e 只跑到**它走到的**路径，没走到的命令仍是盲区 ——
 *     所以下面把「已知未覆盖」钉成一张显式清单。
 *
 * ── 断的是什么 ──────────────────────────────────────────────────────────
 *
 * `COMMANDS` 恰好等于「mock 有 case 的」∪`KNOWN_UNMOCKED`，且两集合不相交。
 * 于是四种漂移各自有专门的断言：
 *
 *   1. 加了一条后端不存在的 case         → 幽灵，红；
 *   2. 加了一条后端命令却忘了 mock       → 既无 case 也没登记，红；
 *   3. 给清单里的命令补了 case 忘了销账   → 交集非空，红；
 *   4. 清单里留着已删除的后端命令         → 红。
 *
 * 刻意**不**用「case 数 ≥ N」这类阈值哨兵：删命令时会误报，解析被截断时又会
 * 漏报（`1 >= 1` 照样通过）。集合等式两头都堵得住。
 */

/**
 * `plugin:*` / `core:*` 是 **Tauri 自己的 IPC 通道名**，由插件运行时分发，
 * 不经 `generate_handler!` 注册 —— 所以它们本来就不该出现在 `COMMANDS` 里，
 * 是「幽灵」断言唯一的豁免。豁免范围收在下面那条 `toEqual` 里，不许整类放开。
 */
const IPC_PREFIXES = ["plugin:", "core:"];
const IPC_CASES = ["plugin:event|listen", "plugin:event|unlisten"];

/** 从 mock 源码里抠出所有 `case "xxx"`。 */
function mockCases(): string[] {
  return [...MOCK_SRC.matchAll(/case\s+"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * 后端注册了、mock 却没有 case 的命令 —— **这不是免 mock 的许可证，是一张待办清单。**
 *
 * 出现的原因只有三类，逐条写在值里（值不许留空，下面有断言）：
 *
 *   A. **前端会调，e2e 只是没走到那条交互**。补一个真实形状的 case 就把它删掉。
 *   B. **只有一条宿主 API 会调，而那条 API 当前没有消费者**（仓库里量过）。
 *   C. **全仓无调用点** —— 只在 `api.ts` 的 `PERM_COMMANDS` 白名单里登记着。
 *      这一组本身就是「命令面比实际用的宽」，留着是因为删白名单条目超出了本轮
 *      （命令面单源）的范围；要削它们是另一件事，见下面的「已知宽出」一节。
 */
const KNOWN_UNMOCKED: Record<string, string> = {
  // ── A：前端会调，e2e 没走到的交互 ──────────────────────────────────
  set_cursor: "FencePanel.tsx:381/385 悬停围栏时换光标；e2e 不产生悬停光栅结果",
  multica_app_url: "useMultica.ts:40 打开 Multica 面板时取一次 URL",
  remind_add: "RemindPanel.tsx:135 新增提醒",
  remind_toggle: "RemindPanel.tsx:65 勾选提醒",
  remind_remove: "RemindPanel.tsx:81 删除提醒",
  fence_restore: "FencePanel.tsx:197/444「还原到系统桌面」；会迁移真文件，e2e 不碰",
  qqmusic_launch: "useQqMusic.ts:96 启动 QQ 音乐",
  qqmusic_toggle: "useQqMusic.ts:61 播放/暂停",
  qqmusic_next: "useQqMusic.ts:63 下一首",
  qqmusic_prev: "useQqMusic.ts:64 上一首",

  // ── B：只有宿主 API 会调，而那条 API 没有消费者 ──────────────────────
  plugin_storage_get: "只有 api.ts:135 的 ctx.storage.get 会调；全仓无插件用 ctx.storage",
  plugin_storage_set: "只有 api.ts:141 的 ctx.storage.set 会调；同上",

  // ── C：全仓无调用点，只在白名单里登记着 ──────────────────────────────
  set_click_through: "只在 api.ts:52 的白名单里；全仓无调用点（Rust 侧自己 set_ignore_cursor_events）",
  github_set_token: "只在 api.ts:19 的白名单里；全仓无调用点（token 不由前端写入）",
  fence_status: "只在 api.ts:23 的白名单里；全仓无调用点",
  plugin_save_custom: "只在 api.ts:64 的白名单里；全仓无调用点",
  qqmusic_ensure_running: "只在 api.ts:74 的白名单里；全仓无调用点",
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
