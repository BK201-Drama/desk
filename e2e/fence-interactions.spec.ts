import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 围栏的三种交互（2026-09-13）：**拖拽常开 / 点标题收起 / 右键调高度**。
 *
 * 这三件事是用户直接提的三个需求，实现散在 `useFenceDnD` / `FencePanel` /
 * `contextMenuModel` 三处，而它们共用一条后端链路（`fence.json` 的
 * `entries.order` 与 `ui`）。单测能钉住纯逻辑（`moveItemAcross`、`fenceMenu`），
 * 钉不住的是**接起来之后还对不对** —— 这个文件就是那一层。
 *
 * ── 与 fence-menu.spec.ts 同一条纪律：一条真实输入都不发 ──────────────────
 *
 * 这个环境收不到真实输入：`page.keyboard.*` 与 `page.mouse.*` 都会挂到超时
 * （完整因果记在 fence-menu.spec.ts 文件头）。所以下面全部是派发的 DOM 事件，
 * 拖拽那一串也不例外（`pointerdown` → `pointermove` → `pointerup`）。
 *
 * **代价如实记**：真鼠标拖拽（含「按下后手抖一下会不会误判成拖」这类手感）
 * 在 e2e 里覆盖不到，只能真机肉眼过。这一条要写进交付说明。
 */

const MOCK_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tauri-mock.js"
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: MOCK_PATH });
});

/**
 * 等看板出来。
 *
 * **视口比别的 spec 高（1400 而不是 800）**：拖拽的落点靠
 * `document.elementFromPoint(x, y)` 找，而它只认**视口内**的点 —— 围栏竖着排了
 * 一长串，800 高的时候「工作」那一栏在折线以下，落点在视口外，
 * `elementFromPoint` 返回 null，拖拽会静默不生效（症状是「完全没有
 * fence_save_order」，很难读）。给足高度比在测试里滚 `#fences` 稳 ——
 * 滚动还会让同一次拖拽里的两个 rect 在不同时刻量到不同的值。
 */
async function openBoard(page: Page) {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto("/");
  await page.waitForSelector("#fences .fence-app", { timeout: 20_000 });
}

/**
 * 围栏区里的一个图标。**必须 `:not(#fenceRecent)`** ——「最近」那一行本身也是
 * `#fences > .fence`，里面的 `.fence-app` 用的是同一套 `data-id`
 * （fixture 里 d-cursor-0 同时在「最近」和「工具」里），不过滤会挑错那一份。
 */
const app = (id: string) => `#fences .fence:not(#fenceRecent) .fence-app[data-id="${id}"]`;
const fenceOf = (name: string) => `#fences .fence[data-name="${name}"]`;
const titleOf = (name: string) => `${fenceOf(name)} .fence-title`;
const gridOf = (name: string) => `${fenceOf(name)} .fence-grid`;

const MENU = '[data-testid="fence-menu"]';
const SUB = '[data-testid="fence-menu-sub"]';
const DIALOG = '[data-testid="fence-dialog"]';

async function clickSel(page: Page, sel: string) {
  await page.evaluate((s) => {
    const el = document.querySelector<HTMLElement>(s);
    if (!el) throw new Error(`clickSel: 找不到 ${s}`);
    el.click();
  }, sel);
}

/** 元素中心点（屏幕像素，与 `clientX` / `elementFromPoint` 同源）。 */
async function centerOf(page: Page, sel: string) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`centerOf: 找不到 ${s}`);
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      throw new Error(`centerOf: ${s} 的盒子是 0×0（被 display:none 了？）`);
    }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
}

/**
 * 一次完整的拖拽手势：`pointerdown`(源) → `pointermove`(落点) → `pointerup`。
 *
 * 三处**必须**对：
 *   · `pointerId` 全程同一个 —— hook 里每个回调头一句就是 `ev.pointerId !== p.id` 就返回。
 *   · `pointermove` 派发在 **window** 上（hook 监听的就是 window），且位移要超过
 *     `DRAG_THRESHOLD_PX`（6 屏幕像素）才会被算成拖。
 *   · 落点必须是**视口内**的真实坐标，`elementFromPoint` 靠它找目标网格。
 */
async function dragApp(page: Page, fromSel: string, toSel: string) {
  const from = await centerOf(page, fromSel);
  const to = await centerOf(page, toSel);
  const vh = await page.evaluate(() => window.innerHeight);
  // 落点在视口外的话这一拖会以「什么都没发生」告终 —— 先把这句说清楚，
  // 免得后来的人对着一句「没有 fence_save_order」猜半天。
  expect(to.y, "落点在视口下方，元素点不到 —— 先调大视口").toBeLessThan(vh);

  await page.evaluate(
    ({ fromSel: fs, toSel: ts, from, to }) => {
      const el = document.querySelector(fs);
      if (!el) throw new Error(`dragApp: 找不到 ${fs}`);
      const PID = 7;
      const opts = { bubbles: true, cancelable: true, pointerId: PID, isPrimary: true };
      el.dispatchEvent(
        new PointerEvent("pointerdown", {
          ...opts,
          button: 0,
          buttons: 1,
          clientX: from.x,
          clientY: from.y,
        })
      );
      // 一步到位即可：`active` 与目标网格是在**同一个** move 里算出来的
      // （过了阈值就置 active，紧接着 elementFromPoint）。分两步只是更贴近
      // 真鼠标的轨迹，对断言没有区别。
      for (const [type, buttons] of [
        ["pointermove", 1],
        ["pointerup", 0],
      ] as const) {
        window.dispatchEvent(
          new PointerEvent(type, {
            ...opts,
            button: type === "pointerup" ? 0 : -1,
            buttons,
            clientX: to.x,
            clientY: to.y,
          })
        );
      }
    },
    { fromSel, toSel, from, to }
  );
}

/**
 * 一次**完整的鼠标点击**：`pointerdown` → `pointerup` → `click`。
 *
 * 为什么不能只 `el.click()`：真鼠标的点击**一定**带一个 pointerdown，
 * 而 `useFenceDnD` 正是靠「新手势开始」来清掉上一次拖拽留下的 `suppressClick`
 * （那个标记漏消费的症状是「拖完之后第一次点图标没反应」）。只发 click 的话
 * 这条链在 e2e 里根本不成立 —— 于是测试会自己造出一个假失败。
 */
async function clickApp(page: Page, sel: string) {
  const at = await centerOf(page, sel);
  await page.evaluate(
    ({ s, at: p }) => {
      const el = document.querySelector<HTMLElement>(s);
      if (!el) throw new Error(`clickApp: 找不到 ${s}`);
      const opts = { bubbles: true, cancelable: true, pointerId: 11, isPrimary: true };
      el.dispatchEvent(
        new PointerEvent("pointerdown", { ...opts, button: 0, buttons: 1, clientX: p.x, clientY: p.y })
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", { ...opts, button: 0, buttons: 0, clientX: p.x, clientY: p.y })
      );
      el.click();
    },
    { s: sel, at }
  );
}

/** 在元素中心派发一次 contextmenu（坐标就是断言里用的那个点）。 */
async function rightClick(page: Page, sel: string) {
  const at = await centerOf(page, sel);
  await page.evaluate(
    ({ s, x, y }) => {
      const el = document.querySelector(s);
      if (!el) throw new Error(`rightClick: 找不到 ${s}`);
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: x,
          clientY: y,
        })
      );
    },
    { s: sel, x: at.x, y: at.y }
  );
  await expect(page.locator(MENU)).toBeVisible();
}

async function clickMenu(page: Page, id: string) {
  await page.evaluate((menuId) => {
    const el = document.querySelector<HTMLElement>(`[data-menu-id="${menuId}"]`);
    if (!el) throw new Error(`clickMenu: 菜单里没有 ${menuId}`);
    el.click();
  }, id);
}

/** 展开某项的子菜单。派发 `pointerover`（React 的 onPointerEnter 由它合成）。 */
async function hoverItem(page: Page, id: string) {
  await page.evaluate((menuId) => {
    const el = document.querySelector(`[data-menu-id="${menuId}"]`);
    if (!el) throw new Error(`hoverItem: 找不到 ${menuId}`);
    el.dispatchEvent(
      new PointerEvent("pointerover", {
        bubbles: true,
        cancelable: true,
        relatedTarget: document.body,
      })
    );
  }, id);
  await expect(page.locator(SUB)).toBeVisible();
}

const menuLabel = (page: Page, id: string) =>
  page.locator(`${MENU} [data-menu-id="${id}"] .fence-menu-label`).innerText();

const callsTo = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (window as unknown as { __MOCK_CALLS__: Array<{ cmd: string; args: unknown }> })
        .__MOCK_CALLS__.filter((x) => x.cmd === c)
        .map((x) => x.args),
    cmd
  );

/** 某一栏的网格在 DOM / 级联里现在的样子。 */
const gridInfo = (page: Page, name: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`gridInfo: 找不到 ${sel}`);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      cls: el.className,
      rows: cs.getPropertyValue("--fence-rows").trim(),
      overflowY: cs.overflowY,
      h: Math.round(r.height),
      visible: el.getClientRects().length > 0,
    };
  }, gridOf(name));

/** 某一栏里现在有哪些图标（按 id）。 */
const itemsOf = (page: Page, name: string) =>
  page.evaluate((sel) => {
    const g = document.querySelector(sel);
    if (!g) throw new Error(`itemsOf: 找不到 ${sel}`);
    return Array.from(g.querySelectorAll<HTMLElement>(".fence-app")).map(
      (a) => a.dataset.id || ""
    );
  }, gridOf(name));

/** 「最近」那一栏的网格。它没有 `data-name`，选择器只能按 id 走。 */
const recentGrid = "#fenceRecent .fence-grid";

// ─────────────────────────────────────────────────────────────────────────────
// 1. 拖拽
// ─────────────────────────────────────────────────────────────────────────────

test("拖拽搬栏**不需要编辑态**：常态下把 Cursor 从「工具」拖进「工作」", async ({ page }) => {
  await openBoard(page);

  expect(await itemsOf(page, "工具")).toContain("d-cursor-0");
  expect(await itemsOf(page, "工作")).not.toContain("d-cursor-0");

  await dragApp(page, app("d-cursor-0"), gridOf("工作"));

  // 落盘：layout 里 d-cursor-0 归「工作」、不在「工具」了。
  // 这条断言才是「拖拽真的存下来了」—— 界面更新还能靠乐观更新装出来，这条装不出来。
  const [args] = await callsTo(page, "fence_save_order");
  const layout = (args as { layout: Array<{ name: string; ids: string[] }> }).layout;
  const idsOf = (n: string) => layout.find((l) => l.name === n)?.ids ?? [];
  expect(idsOf("工作")).toContain("d-cursor-0");
  expect(idsOf("工具")).not.toContain("d-cursor-0");

  // 界面：图标现在在「工作」那一栏里（后端返回值对齐之后的结果）
  expect(await itemsOf(page, "工作")).toContain("d-cursor-0");

  // 拆闸的判据：全程没进过编辑态。进了的话这次拖拽是「旧行为」，不是用户要的那个。
  await expect(page.locator(".board.editing")).toHaveCount(0);
});

test("拖到空白处不落盘；而且拖过之后的**下一次点击照样启动**", async ({ page }) => {
  await openBoard(page);

  // 面板里的空白（工具栏那一带不在任何 `.fence-grid` 里）→ 没有落点 → 不发命令
  await dragApp(page, app("d-cursor-0"), ".fences-toolbar");
  expect(await callsTo(page, "fence_save_order")).toEqual([]);
  expect(await itemsOf(page, "工具")).toContain("d-cursor-0");

  // 一次成功的拖拽（这条会把 `suppressClick` 立起来）
  await dragApp(page, app("d-cursor-0"), gridOf("工作"));
  expect(await callsTo(page, "fence_save_order")).toHaveLength(1);

  // 关键的一条：`suppressClick` 只活**一次手势**。它要是漏消费，
  // 症状是「拖完之后第一次点图标没反应」—— 而那次点击本来该启动。
  await clickApp(page, app("d-feishu-0"));
  await expect.poll(async () => (await callsTo(page, "fence_launch")).length).toBeGreaterThan(0);
});

test("系统栏不可拖：sys- 项拖不动，也不发命令", async ({ page }) => {
  await openBoard(page);

  await dragApp(page, app("sys-recycle"), gridOf("工作"));

  expect(await callsTo(page, "fence_save_order")).toEqual([]);
  expect(await itemsOf(page, "系统")).toContain("sys-recycle");
  expect(await itemsOf(page, "工作")).not.toContain("sys-recycle");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 点标题收起 / 展开
// ─────────────────────────────────────────────────────────────────────────────

test("点标题收起，再点展开；收起态落盘且不闪", async ({ page }) => {
  await openBoard(page);
  expect((await gridInfo(page, "工作")).visible).toBe(true);

  await clickSel(page, titleOf("工作"));

  // 落盘：两个字段分别是「改」与「不改」—— `rows: null` 不能写成 0（0 = 回到自动）
  expect(await callsTo(page, "fence_save_ui")).toEqual([
    { name: "工作", collapsed: true, rows: null },
  ]);

  // 收起 = 网格**不渲染**（不是 `max-height: 0`）：`display: none` 让它同时
  // 「看不见」和「不占位 / 不可聚焦」。用 `getClientRects().length` 判。
  expect((await gridInfo(page, "工作")).visible, "收起后网格还在渲染").toBe(false);
  await expect(page.locator(fenceOf("工作"))).toHaveClass(/is-collapsed/);
  await expect(page.locator(`${titleOf("工作")} .fence-caret`)).toHaveClass(/is-closed/);
  // 整行是个开关，无障碍上要报出「收起了」
  await expect(page.locator(titleOf("工作"))).toHaveAttribute("aria-expanded", "false");

  // 收起的栏**够不着**：拿不到它里面任何东西 —— 这同时就是
  // 「拖不进收起的分类」的成因（没有盒子就没有 `elementFromPoint` 的落点）
  const hit = await page.evaluate((sel) => {
    const f = document.querySelector(sel)!;
    const r = f.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el ? el.closest(sel) !== null : false;
  }, gridOf("工作"));
  expect(hit, "收起的网格还能被 elementFromPoint 命中").toBe(false);

  await clickSel(page, titleOf("工作"));
  expect((await callsTo(page, "fence_save_ui"))[1]).toEqual({
    name: "工作",
    collapsed: false,
    rows: null,
  });
  expect((await gridInfo(page, "工作")).visible).toBe(true);
  await expect(page.locator(fenceOf("工作"))).not.toHaveClass(/is-collapsed/);
});

test("「最近」那一栏不是分类：点它的标题既不收起也不发命令", async ({ page }) => {
  await openBoard(page);

  const before = await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    return { h: Math.round(el.getBoundingClientRect().height), hasCaret: el.parentElement!.querySelector(".fence-caret") !== null };
  }, recentGrid);

  await clickSel(page, "#fenceRecent .fence-title");

  expect(await callsTo(page, "fence_save_ui"), "「最近」不该有显示偏好").toEqual([]);
  await expect(page.locator("#fenceRecent")).not.toHaveClass(/is-collapsed/);

  const after = await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    return { h: Math.round(el.getBoundingClientRect().height), hasCaret: el.parentElement!.querySelector(".fence-caret") !== null };
  }, recentGrid);
  expect(after.h).toBe(before.h);
  // caret 是「这一栏能收起」的视觉承诺 —— 「最近」没有这个承诺，就不该画
  expect(before.hasCaret, "「最近」那一行不该有 caret").toBe(false);
});

test("落盘失败就回滚并弹窗，不留下一个假装的收起态", async ({ page }) => {
  await openBoard(page);
  await page.evaluate(() => {
    (window as unknown as { __MOCK_SAVE_UI_THROWS__: boolean }).__MOCK_SAVE_UI_THROWS__ = true;
  });

  await clickSel(page, titleOf("工作"));

  await expect(page.locator(DIALOG)).toBeVisible();
  // 回滚了：界面必须回到**展开**。不回滚的话用户看着一个「已经收起」的栏，
  // 重启之后它自己又展开了，而且中间没有任何提示。
  expect((await gridInfo(page, "工作")).visible, "落盘失败后没有回滚").toBe(true);
  await expect(page.locator(fenceOf("工作"))).not.toHaveClass(/is-collapsed/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 右键标题 → 高度
// ─────────────────────────────────────────────────────────────────────────────

test("右键标题出**围栏**菜单（收起 / 高度），后面接上空白菜单那几组", async ({ page }) => {
  await openBoard(page);
  await rightClick(page, titleOf("工作"));

  expect(await menuLabel(page, "collapse")).toBe("收起");
  expect(await menuLabel(page, "rows")).toBe("高度（自动）");
  // 标题也是看板的一部分：右键它不该比右键空地**少拿到**东西
  expect(await menuLabel(page, "paste")).toBe("粘贴");

  await hoverItem(page, "rows");
  for (const n of [1, 2, 3, 4, 5]) {
    await expect(page.locator(`${SUB} [data-menu-id="rows-${n}"]`)).toBeVisible();
  }
  await expect(page.locator(`${SUB} [data-menu-id="rows-auto"]`)).toBeVisible();
});

test("调高度：5 个图标挤进 1 行 → 盒子变矮，「自动」再变回来", async ({ page }) => {
  await openBoard(page);

  // 「游戏」5 个图标 ÷ 4 列 = 内容 2 行，默认 `--fence-rows: 3`（panel.css:366-369）
  // → 盒子是内容撑的 2 行。压到 1 行才看得出变化。（用「工作」看不出：4 个图标
  // 本来就只占 1 行，而 `.fence-grid` 的高度是内容撑的 + `max-height` 封顶。）
  const before = await gridInfo(page, "游戏");
  expect(before.rows).toBe("3");

  await rightClick(page, titleOf("游戏"));
  await hoverItem(page, "rows");
  await clickMenu(page, "rows-1");

  expect(await callsTo(page, "fence_save_ui")).toEqual([
    { name: "游戏", collapsed: null, rows: 1 },
  ]);
  const small = await gridInfo(page, "游戏");
  expect(small.rows).toBe("1");
  expect(small.cls).toContain("rows-1");
  expect(small.h, `1 行的盒子没有变矮：${before.h} → ${small.h}`).toBeLessThan(before.h);

  // 「自动」= 回到默认：类名回到**裸的** `fence-grid`（尾部不许多一个空格 ——
  // 样式审查把 className 原文录进基线，多一个空格就是一处 diff）
  await rightClick(page, titleOf("游戏"));
  await hoverItem(page, "rows");
  await clickMenu(page, "rows-auto");
  expect((await callsTo(page, "fence_save_ui"))[1]).toEqual({
    name: "游戏",
    collapsed: null,
    rows: 0,
  });
  const back = await gridInfo(page, "游戏");
  expect(back.cls.trim()).toBe("fence-grid");
  expect(back.rows).toBe("3");
  expect(back.h).toBe(before.h);
});

/**
 * 这一条钉的是那个 **CSS 陷阱**：`工作` / `系统` / 最近 在 panel.css:370-374
 * 是 `overflow-y: hidden` —— 只把行数调大而不改 `overflow`，多出来的行会被
 * **裁掉**而不是滚动（症状是「调了高度反而少看见东西」）。`.rows-N` 那条规则
 * 必须把两者写进同一个选择器，并且优先级压过那 3 个类的那条。
 */
test("调高度要连 overflow 一起翻：`工作` 默认 hidden，设成 2 行后能滚", async ({ page }) => {
  await openBoard(page);
  expect((await gridInfo(page, "工作")).overflowY).toBe("hidden");

  await rightClick(page, titleOf("工作"));
  await hoverItem(page, "rows");
  await clickMenu(page, "rows-2");

  const after = await gridInfo(page, "工作");
  expect(after.rows).toBe("2");
  expect(after.overflowY, "行数调大了却还是 hidden —— 多出来的行会被裁掉").toBe("auto");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 两条回归（2026-09-13 实测出来的）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次**分两跳**的拖拽：先经过 `via`（一个网格 → 立 `targetFence`），再落到 `to`。
 *
 * 为什么需要它：`dragApp` 只发**一个** move，位移与落点是同一个点。而真鼠标的
 * 轨迹是连续的 —— 「拖起来之后再横移到标题条上松手」这种落点，用单跳复现不出来。
 */
async function dragAppVia(page: Page, fromSel: string, viaSel: string, toSel: string) {
  const from = await centerOf(page, fromSel);
  const via = await centerOf(page, viaSel);
  const to = await centerOf(page, toSel);
  await page.evaluate(
    ({ fromSel: fs, from, via, to }) => {
      const el = document.querySelector(fs);
      if (!el) throw new Error(`dragAppVia: 找不到 ${fs}`);
      const PID = 7;
      const opts = { bubbles: true, cancelable: true, pointerId: PID, isPrimary: true };
      el.dispatchEvent(
        new PointerEvent("pointerdown", { ...opts, button: 0, buttons: 1, clientX: from.x, clientY: from.y })
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { ...opts, button: -1, buttons: 1, clientX: via.x, clientY: via.y })
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { ...opts, button: -1, buttons: 1, clientX: to.x, clientY: to.y })
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", { ...opts, button: 0, buttons: 0, clientX: to.x, clientY: to.y })
      );
    },
    { fromSel, from, via, to }
  );
}

/**
 * 围栏面板**静止时不该空转**。
 *
 * `FencePanel` 那个 setup effect 里有两条一次性读取：`autostart_get` 与
 * `fence_icons_visible`。它们的语义是「进面板时读一次」，不是「每次渲染读一次」。
 *
 * 实测（2026-09-13）：依赖数组里放了 `useFences` 每次渲染新建的 `loadFences`
 * 箭头 → effect 每次渲染都重跑；而**当时** mock 的 `autostart_get` 没有 case、落到
 * `default: return {}`，**每次都是一个新对象** → `setAutostartOn({})` 无法让 React
 * bail out → 再渲染 → effect 再跑。闭环成立之后看板静止不动也在**每秒四万多次**
 * 地打 IPC（实测 5 秒累计 22.4 万条，`autostart_get` 与 `fence_icons_visible`
 * 各 11.2 万，严格 1:1）。真机上那是每秒四万多次注册表读。
 *
 * ⚠️ 2026-09-14：mock 补了 `autostart_get` 的 case、返回真机的 `true`（原始值）。
 * 那个「每次新对象」的**放大器没了** —— 这条断言从此只拦得住「依赖数组不稳 +
 * 另有东西持续触发渲染」的组合，单靠它发现不了依赖数组退化。改 `useFences` /
 * `FencePanel` 的依赖数组时别只信这条测试。
 *
 * 断言的是**这两条不再增长**，不是「总调用数不变」—— 别的插件有合法的定时轮询
 * （`sys_res_snapshot` 就会自己涨），拿总数断言会变成一个假失败。
 */
test("围栏面板静止时不空转：两条一次性读取不随渲染重复发", async ({ page }) => {
  await openBoard(page);
  // 启动期（fence_list / 抽图标）不算，从第 1 秒起看「静止期」
  await page.waitForTimeout(1000);

  const countOf = () =>
    page.evaluate(() => {
      const calls = (window as unknown as { __MOCK_CALLS__: Array<{ cmd: string }> }).__MOCK_CALLS__;
      const n = (c: string) => calls.filter((x) => x.cmd === c).length;
      return { autostart: n("autostart_get"), icons: n("fence_icons_visible") };
    });

  const a = await countOf();
  await page.waitForTimeout(1500);
  const b = await countOf();

  expect(
    b.autostart - a.autostart,
    `autostart_get 在静止的 1.5 秒里又发了 ${b.autostart - a.autostart} 次 —— effect 在自转`
  ).toBe(0);
  expect(
    b.icons - a.icons,
    `fence_icons_visible 在静止的 1.5 秒里又发了 ${b.icons - a.icons} 次 —— effect 在自转`
  ).toBe(0);
});

/**
 * 拖拽收尾的那一下 `click` **不该同时把围栏收起来**。
 *
 * `useFenceDnD` 在真拖成功之后立 `suppressClick`，注释里写明它的用途是
 * 「吃掉属于这次拖拽的那一下 click」（`useFenceDnD.ts:44-51`）。但它只被
 * `.fence-app` 的 `tryLaunch` 消费 —— 而**拖到标题条上松手**时，浏览器那一下
 * click 的落点是 `.fence-title`，它的 `onClick` 直接 `applyUi(...collapsed 取反)`。
 * 于是「横向拖一个图标、松手时指针压在标题上」= 搬栏 + 那一栏被收起，
 * 用户看到的是内容**猛地展开／收起**。落盘失败的话还会叠一个弹窗（`设置没存上`）。
 *
 * 真鼠标的轨迹在 e2e 里发不出来（见文件头），所以这里显式补发那一下 click ——
 * 浏览器在 pointerup 之后就是会发它，补发是对真实行为的**忠实**还原，不是造数据。
 */
test("拖拽落点在标题条上时，收尾那一下 click 不该把这一栏收起", async ({ page }) => {
  await openBoard(page);

  // 先经过「工作」的网格（立 targetFence = 工作），再落到「工作」的标题上松手
  await dragAppVia(page, app("d-cursor-0"), gridOf("工作"), titleOf("工作"));

  // 拖拽本身要真的发生 —— 否则这条测试会因为「什么都没拖」而假绿
  expect(await callsTo(page, "fence_save_order"), "拖拽没生效，这条就测不到 click").toHaveLength(1);

  // 浏览器在 pointerup 之后补发的那个 click，落点就是标题条
  await clickSel(page, titleOf("工作"));

  expect(
    await callsTo(page, "fence_save_ui"),
    "拖拽收尾的 click 被当成了「点标题收起」—— 搬个图标顺手把栏收起来了"
  ).toEqual([]);
  expect((await gridInfo(page, "工作")).visible, "「工作」被误收起了").toBe(true);
});

test("收起与高度是两个独立字段：收起之后高度照旧记着", async ({ page }) => {
  await openBoard(page);

  await rightClick(page, titleOf("游戏"));
  await hoverItem(page, "rows");
  await clickMenu(page, "rows-4");
  await clickSel(page, titleOf("游戏")); // 收起

  expect(await callsTo(page, "fence_save_ui")).toEqual([
    { name: "游戏", collapsed: null, rows: 4 },
    { name: "游戏", collapsed: true, rows: null },
  ]);
  // 收起态下网格不渲染（所以量不到），但 `rows` 这个偏好没被抹掉 ——
  // 展开回来还是 4 行。两条命令各带一个 `null`，就是为了不互相覆盖。
  await clickSel(page, titleOf("游戏"));
  expect((await gridInfo(page, "游戏")).cls).toContain("rows-4");
});
