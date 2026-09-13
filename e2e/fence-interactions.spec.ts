import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 围栏的三种交互：**拖拽常开 / 点标题收起 / 右键调高度**。单测只钉得住纯逻辑，
 * 钉不住接起来之后对不对 —— 这个文件是那一层。
 * ⚠️ **本环境 `page.keyboard.*` 与 `page.mouse.*` 都会挂到超时**，所以下面全部是派发的
 * DOM 事件；真鼠标的手感（按下后手抖会不会误判成拖）覆盖不到，只能真机肉眼过。
 */

const MOCK_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tauri-mock.js"
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: MOCK_PATH });
});

/**
 * **视口比别的 spec 高（1400）**：拖拽落点靠 `elementFromPoint` 找，它只认**视口内**的点 ——
 * 落点在视口外时返回 null，拖拽会**静默不生效**（症状是「完全没有 fence_save_order」）。
 */
async function openBoard(page: Page) {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto("/");
  await page.waitForSelector("#fences .fence-app", { timeout: 20_000 });
}

/** 围栏区里的一个图标。**必须 `:not(#fenceRecent)`**：「最近」那行用同一套 `data-id`，不过滤会挑错。 */
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

/** 一次完整的拖拽手势。三处**必须**对：`pointerId` 全程同一个；`pointermove` 派发在
 * **window** 上且位移超过 `DRAG_THRESHOLD_PX`；落点必须**视口内**。 */
async function dragApp(page: Page, fromSel: string, toSel: string) {
  const from = await centerOf(page, fromSel);
  const to = await centerOf(page, toSel);
  const vh = await page.evaluate(() => window.innerHeight);
  // 落点在视口外的话这一拖会以「什么都没发生」告终 —— 先把这句说清楚。
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

/** 一次**完整的鼠标点击**：`pointerdown` → `pointerup` → `click`。
 * 不能只 `el.click()`：`useFenceDnD` 靠「新手势开始」清掉上次拖拽留下的 `suppressClick` ——
 * 只发 click 的话这条链不成立，测试会自己造出一个假失败。 */
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

/** 在元素中心派发一次 contextmenu。 */
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

/** 某一栏的网格现在的样子（DOM 类名 + 级联值 + 盒子高度）。 */
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

/** 某一栏里现在有哪些图标。 */
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

// ── 1. 拖拽 ──────────────────────────────────────────────────────────────────

test("拖拽搬栏**不需要编辑态**：常态下把 Cursor 从「工具」拖进「工作」", async ({ page }) => {
  await openBoard(page);

  expect(await itemsOf(page, "工具")).toContain("d-cursor-0");
  expect(await itemsOf(page, "工作")).not.toContain("d-cursor-0");

  await dragApp(page, app("d-cursor-0"), gridOf("工作"));

  // 落盘：这条断言才是「拖拽真的存下来了」—— 界面更新还能靠乐观更新装出来，这条装不出来。
  const [args] = await callsTo(page, "fence_save_order");
  const layout = (args as { layout: Array<{ name: string; ids: string[] }> }).layout;
  const idsOf = (n: string) => layout.find((l) => l.name === n)?.ids ?? [];
  expect(idsOf("工作")).toContain("d-cursor-0");
  expect(idsOf("工具")).not.toContain("d-cursor-0");

  expect(await itemsOf(page, "工作")).toContain("d-cursor-0");

  // 拆闸的判据：进了编辑态的话这次拖拽就是「旧行为」，不是用户要的那个。
  await expect(page.locator(".board.editing")).toHaveCount(0);
});

test("拖到空白处不落盘；而且拖过之后的**下一次点击照样启动**", async ({ page }) => {
  await openBoard(page);

  // 面板空白（工具栏那一带不在任何 `.fence-grid` 里）→ 没有落点 → 不发命令
  await dragApp(page, app("d-cursor-0"), ".fences-toolbar");
  expect(await callsTo(page, "fence_save_order")).toEqual([]);
  expect(await itemsOf(page, "工具")).toContain("d-cursor-0");

  // 一次成功的拖拽（这条会把 `suppressClick` 立起来）
  await dragApp(page, app("d-cursor-0"), gridOf("工作"));
  expect(await callsTo(page, "fence_save_order")).toHaveLength(1);

  // 关键：`suppressClick` 只活**一次手势**，漏消费的症状是「拖完之后第一次点图标没反应」。
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

// ── 2. 点标题收起 / 展开 ─────────────────────────────────────────────────────

test("点标题收起，再点展开；收起态落盘且不闪", async ({ page }) => {
  await openBoard(page);
  expect((await gridInfo(page, "工作")).visible).toBe(true);

  await clickSel(page, titleOf("工作"));

  // 落盘：`rows: null` 不能写成 0（0 = 回到自动）
  expect(await callsTo(page, "fence_save_ui")).toEqual([
    { name: "工作", collapsed: true, rows: null },
  ]);

  // 收起 = 网格**不渲染**（不是 `max-height: 0`），所以用 `getClientRects().length` 判
  expect((await gridInfo(page, "工作")).visible, "收起后网格还在渲染").toBe(false);
  await expect(page.locator(fenceOf("工作"))).toHaveClass(/is-collapsed/);
  await expect(page.locator(`${titleOf("工作")} .fence-caret`)).toHaveClass(/is-closed/);
  await expect(page.locator(titleOf("工作"))).toHaveAttribute("aria-expanded", "false");

  // 收起的栏**够不着** —— 这同时就是「拖不进收起的分类」的成因（没盒子就没落点）
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
  // 回滚了：界面必须回到**展开** —— 不回滚的话用户看着一个「已收起」的栏，重启后又自己展开。
  expect((await gridInfo(page, "工作")).visible, "落盘失败后没有回滚").toBe(true);
  await expect(page.locator(fenceOf("工作"))).not.toHaveClass(/is-collapsed/);
});

// ── 3. 右键标题 → 高度 ──────────────────────────────────────────────────────

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

  // 「游戏」5 个图标 ÷ 4 列 = 内容 2 行，默认 3 行 → 盒子是内容撑的 2 行，压到 1 行才看得出变化
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

  // 「自动」= 类名回到**裸的** `fence-grid`（尾部不许多空格 —— 样式基线录的是 className 原文）
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
 * 这一条钉的是那个 **CSS 陷阱**：`工作` / `系统` / 最近 是 `overflow-y: hidden` —— 只把行数
 * 调大而不改 `overflow`，多出来的行会被**裁掉**而不是滚动。`.rows-N` 必须把两者写进同一个选择器。
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

// ── 4. 两条回归 ──────────────────────────────────────────────────────────────

/** 一次**分两跳**的拖拽（`dragApp` 只发一个 move，复现不出「拖起来之后再横移」的轨迹）。 */
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
 * 围栏面板**静止时不该空转**：`FencePanel` setup effect 里的 `autostart_get` 与
 * `fence_icons_visible` 是「进面板读一次」，不是「每次渲染读一次」。
 * ⚠️ mock 给 `autostart_get` 补上 case 之后，当年那个「每次返回新对象」的放大器没了 ——
 * 这条从此只拦得住「依赖数组不稳 + 另有东西持续触发渲染」的组合，改依赖数组时**别只信它**。
 * 断言的是**这两条不再增长**，不是总数不变（别的插件有合法的定时轮询）。
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
 * `suppressClick` 只被 `.fence-app` 的 `tryLaunch` 消费；拖到标题条上松手时那一下 click 的
 * 落点是 `.fence-title`，onClick 直接 `applyUi(...collapsed 取反)` —— 于是「横向拖一个图标、
 * 松手时指针压在标题上」= 搬栏 + 那一栏被收起。真鼠标轨迹在 e2e 里发不出来（见文件头），
 * 所以显式补发那一下 click（浏览器在 pointerup 之后就是会发它，是**忠实**还原，不是造数据）。
 */
test("拖拽落点在标题条上时，收尾那一下 click 不该把这一栏收起", async ({ page }) => {
  await openBoard(page);

  // 先经过「工作」的网格（立 targetFence = 工作），再落到「工作」的标题上松手
  await dragAppVia(page, app("d-cursor-0"), gridOf("工作"), titleOf("工作"));

  // 拖拽本身要真的发生 —— 否则这条会因为「什么都没拖」而假绿
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
  // 收起态下网格不渲染（量不到），但 `rows` 没被抹掉 —— 展开回来还是 4 行。
  await clickSel(page, titleOf("游戏"));
  expect((await gridInfo(page, "游戏")).cls).toContain("rows-4");
});
