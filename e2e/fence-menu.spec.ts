import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 15 的行为护栏：**看板上的右键菜单**。
 *
 * 为什么单开一个文件而不是往 smoke.spec.ts 里塞：smoke 是「外壳 / cmdk」那一层的，
 * 围栏行为有自己的先例（fence-watch.spec.ts / recent.spec.ts）。
 * 混在一起会让「哪一层坏了」变得难判。
 *
 * ── 为什么这个文件一条真实输入都不发 ───────────────────────────────────────
 *
 * **这个环境根本收不到真实输入。** `page.keyboard.press` 会一直挂
 * （smoke.spec.ts:11、recent.spec.ts:52 撞过，注释写的是「被宿主吞掉」），
 * 而**鼠标也是一样** —— Task 15 实测：`page.mouse.click(...)` 同样挂到超时，
 * 一次都完不成。所以本文件里所有输入都是派发的 DOM 事件：
 *
 *   · 右键    → `new MouseEvent("contextmenu", { clientX, clientY })`
 *   · 展开子菜单 → `new PointerEvent("pointerover")`（React 的 onPointerEnter 由它合成）
 *   · 点菜单项 → `el.click()`
 *   · Escape  → `document.dispatchEvent(new KeyboardEvent("keydown"))`
 *
 * 额外的好处是**确定**：`clientX/clientY` 由我们自己给，而「菜单出现在点击点
 * ±2px 内」正是本文件的验收项（菜单坐标本来就是靠 `clientX / Z` 反算的，
 * 真实鼠标的取整会让这条断言变成随机红）。
 *
 * **代价如实记**：浏览器那一层输入（真右键能否唤起 contextmenu）在 e2e 里
 * 覆盖不到，只能在真机上肉眼过。这一条要写进交付说明。
 */

const MOCK_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tauri-mock.js"
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: MOCK_PATH });
});

/** 等看板出来。与 style-audit / fence-watch 同源：面板挂在 250ms 定时器之后。 */
async function openBoard(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.waitForSelector("#fences .fence-app", { timeout: 20_000 });
}

const MENU = '[data-testid="fence-menu"]';
const SUB = '[data-testid="fence-menu-sub"]';

/**
 * 围栏区里的一个图标。
 *
 * **必须 `:not(#fenceRecent)`** ——「最近」那一行本身也是 `#fences > .fence`，
 * 里面的 `.fence-app` 用的是同一套 `data-id`。fixture 里 d-feishu-0 / d-cursor-0 /
 * d-lol-0 / d-obsidian-0 四条同时在「最近」和各自的围栏里，不过滤的话
 * `querySelector` 会挑到「最近」那一份，Playwright 的 locator 更是直接报
 * strict mode violation。
 */
const app = (id: string) => `#fences .fence:not(#fenceRecent) .fence-app[data-id="${id}"]`;

const menuItem = (page: Page, id: string) =>
  page.locator(`${MENU} [data-menu-id="${id}"]`);

/** 点一个菜单项。用 `el.click()`（recent.spec.ts 的 clickApp 同源），理由见文件头。 */
async function clickMenu(page: Page, id: string) {
  await page.evaluate((menuId) => {
    const el = document.querySelector<HTMLElement>(`[data-menu-id="${menuId}"]`);
    if (!el) throw new Error(`clickMenu: 菜单里没有 ${menuId}`);
    el.click();
  }, id);
}

/** 在某个元素上派发一次 contextmenu。`x`/`y` 就是断言里要用的那个点击点。 */
async function rightClick(page: Page, selector: string, x: number, y: number) {
  await page.evaluate(
    ({ sel, cx, cy }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`rightClick: 找不到 ${sel}`);
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: cx,
          clientY: cy,
        })
      );
    },
    { sel: selector, cx: x, cy: y }
  );
  await expect(page.locator(MENU)).toBeVisible();
}

/**
 * 展开某项的子菜单。
 *
 * 派发 `pointerover` 而不是 `page.hover()`：React 的 `onPointerEnter` 是从
 * `pointerover` 合成的（enter/leave 插件），派发它就够了；而且真实鼠标会留下
 * `:hover` 状态 —— 那是样式基线里不该出现的不确定量。`relatedTarget` 给 body，
 * 免得 React 在「从哪进来」上收到 null。
 */
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

/** mock 记录下来的调用。`__MOCK_CALLS__` 在 `invoke` 的第一行就写，命令名写错也留痕。 */
const callsTo = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (window as unknown as { __MOCK_CALLS__: Array<{ cmd: string; args: unknown }> })
        .__MOCK_CALLS__.filter((x) => x.cmd === c)
        .map((x) => x.args),
    cmd
  );

/** 「后端推一帧」。返回送达的回调数 —— 0 说明桥断了，不是「界面没更新」。 */
const pushFrame = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __MOCK_PUSH__: () => number }).__MOCK_PUSH__()
  );

const closeMenu = async (page: Page) => expect(page.locator(MENU)).toHaveCount(0);

// ─────────────────────────────────────────────────────────────────────────────

test("右键条目 → 菜单出现在点击点上，且不进入编辑态", async ({ page }) => {
  await openBoard(page);

  // 点在「工具」里 Cursor 那一格上（右半边面板内，远离右下角，不会被夹钳）
  await rightClick(page, app("d-cursor-0"), 900, 300);

  const box = await page.evaluate(() => {
    const m = document.querySelector('[data-testid="fence-menu"]')!;
    const r = m.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });

  // 验收项原文：菜单位置在点击点 ±2px 内。残差来自 Z 的取整（见子计划 §0）。
  expect(Math.abs(box.left - 900), `left=${box.left}`).toBeLessThanOrEqual(2);
  expect(Math.abs(box.top - 300), `top=${box.top}`).toBeLessThanOrEqual(2);
  // 点击点必须真的落在菜单里 —— 只比 left/top 的话，一个宽 0 的菜单也能通过
  expect(900 <= box.right && 300 <= box.bottom, "点击点落在菜单矩形之外").toBe(true);

  // spec §7.3：右键菜单全程不进入编辑模式
  await expect(page.locator(".board.editing")).toHaveCount(0);
});

test("点菜单外 / Escape 都能关；Escape 不会顺手清空搜索框", async ({ page }) => {
  await openBoard(page);

  // ① 点菜单外面
  await rightClick(page, app("d-cursor-0"), 900, 300);
  await page.evaluate(() => {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await closeMenu(page);

  // ② 搜索框上的右键不该出菜单（那几项在输入框上没有意义，还会顶掉原生的剪切/粘贴）
  await page.evaluate(() => {
    const input = document.querySelector(".fence-search");
    if (!input) throw new Error(".fence-search not found");
    input.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })
    );
  });
  await closeMenu(page);

  // ③ Escape 关菜单 —— 且**不能**同时把搜索框清掉（FencePanel.tsx:150 那个消费者）
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(".fence-search")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "e");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForSelector(".fence-search-row", { state: "visible", timeout: 10_000 });
  await rightClick(page, ".fence-search-panel", 900, 300);
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
    );
  });
  await closeMenu(page);
  await expect(page.locator(".fence-search")).toHaveValue("e");
});

test("文件项给全菜单；目录项没有「打开方式」；sys 项只有「打开」", async ({ page }) => {
  await openBoard(page);

  await rightClick(page, app("d-cursor-0"), 900, 300);
  for (const id of [
    "open",
    "open-with",
    "reveal",
    "cut",
    "copy",
    "rename",
    "delete",
    "send-to",
    "properties",
  ]) {
    await expect(menuItem(page, id), `文件菜单缺 ${id}`).toHaveCount(1);
  }
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
    );
  });
  await closeMenu(page);

  // 目录：属性 / 压缩在，打开方式不在
  await rightClick(page, app("d-downloads-0"), 900, 300);
  await expect(menuItem(page, "properties")).toHaveCount(1);
  await expect(menuItem(page, "send-to")).toHaveCount(1);
  await expect(menuItem(page, "open-with")).toHaveCount(0);
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
    );
  });
  await closeMenu(page);

  // sys：只剩「打开」—— 即使后端给它的 is_dir 是 true（spec §7.4）
  await rightClick(page, app("sys-recycle"), 900, 300);
  await expect(page.locator(`${MENU} [role="menuitem"]`)).toHaveCount(1);
  await expect(menuItem(page, "open")).toHaveCount(1);
  for (const forbidden of ["properties", "open-with", "rename", "delete", "send-to"]) {
    await expect(menuItem(page, forbidden), `sys 上不该有 ${forbidden}`).toHaveCount(0);
  }
});

test("「打开」走的是 doLaunch —— fence_launch 与 recent_push 都带同一个 id", async ({ page }) => {
  await openBoard(page);
  await rightClick(page, app("d-feishu-0"), 900, 300);
  await clickMenu(page, "open");
  await closeMenu(page);

  await expect
    .poll(async () => callsTo(page, "fence_launch"))
    .toEqual([{ path: "C:\\Desktop\\飞书.lnk" }]);
  // 这一条才是「菜单里的打开没有另起炉灶」的判据：不走 doLaunch 就没有 recent_push
  await expect
    .poll(async () => callsTo(page, "recent_push"))
    .toEqual([{ id: "d-feishu-0" }]);
});

test("新建文本文档：命令参数正确，推一帧后新项出现在看板上", async ({ page }) => {
  await openBoard(page);

  // 空白处（围栏标题不是 .fence-app，所以是 blank 目标）
  await rightClick(page, '#fences .fence[data-name="游戏"] .fence-title', 900, 300);
  await expect(menuItem(page, "new")).toHaveCount(1);
  // 空白处没有条目，所以不该出现那些要落到具体文件上的项
  await expect(menuItem(page, "rename")).toHaveCount(0);
  await expect(menuItem(page, "paste")).toHaveCount(1);

  await hoverItem(page, "new");
  await expect(page.locator(`${SUB} [data-menu-id="new-txt"]`)).toBeVisible();
  await clickMenu(page, "new-txt");
  await closeMenu(page);

  await expect.poll(async () => callsTo(page, "fence_create")).toEqual([
    { name: "新建文本文档", kind: "txt", target: null },
  ]);

  // 后端写完了。真机上接下来由 watcher 推一帧 —— mock 里就是这一步。
  expect(await pushFrame(page), "fence:changed 没有送达（mock 的桥断了）").toBeGreaterThan(0);
  await expect(
    page.locator(app("d-new-1"))
  ).toHaveCount(1);
  await expect(
    page.locator(`${app("d-new-1")} .label`)
  ).toHaveText("新建文本文档");
});

test("重命名：prompt 的初值是 path 的文件名，提交时补回扩展名且参数名是 camelCase", async ({
  page,
}) => {
  await openBoard(page);

  const seen: { type: string; message: string; defaultValue: string }[] = [];
  page.on("dialog", (d) => {
    seen.push({ type: d.type(), message: d.message(), defaultValue: d.defaultValue() });
    void d.accept("新名字");
  });

  await rightClick(page, app("d-cursor-0"), 900, 300);
  await clickMenu(page, "rename");
  await closeMenu(page);

  await expect.poll(async () => callsTo(page, "fence_rename")).toEqual([
    // newName（不是 new_name）+ 补回了 `.lnk`。两件事各有一个坑：
    //   · 参数名写错在**真机**上是 invalid args，mock 里看不出来
    //   · 不补扩展名会把 `Cursor.lnk` 改成没有扩展名的 `Cursor`，快捷方式当场失效
    { path: "C:\\Desktop\\Cursor.lnk", newName: "新名字.lnk" },
  ]);

  expect(seen).toHaveLength(1);
  expect(seen[0].type).toBe("prompt");
  // 初值取自 path 的 basename（带 .lnk），**不是** label（label 里没有扩展名）
  expect(seen[0].defaultValue).toBe("Cursor.lnk");
});

test("删除：确认了才调，取消一次都不调", async ({ page }) => {
  await openBoard(page);

  // 取消
  page.once("dialog", (d) => void d.dismiss());
  await rightClick(page, app("d-yuque-0"), 900, 300);
  await clickMenu(page, "delete");
  await closeMenu(page);
  // 等一拍，给「万一真的发了」留出被看见的机会
  await page.waitForTimeout(200);
  expect(await callsTo(page, "fence_delete"), "取消后不该发命令").toEqual([]);

  // 确认
  page.once("dialog", (d) => void d.accept());
  await rightClick(page, app("d-yuque-0"), 900, 300);
  await clickMenu(page, "delete");
  await closeMenu(page);
  await expect
    .poll(async () => callsTo(page, "fence_delete"))
    .toEqual([{ path: "C:\\Desktop\\语雀.lnk" }]);
});

/**
 * 键盘租约 —— **Task 15 真机 bug 的回归护栏**。
 *
 * 症状（用户实测）：「重命名无法输入内容」。根因不是 `prompt` 不可用，而是
 * desk 的窗口是 `WS_EX_NOACTIVATE` 的（桌面看板刻意不抢焦点，`win_zorder.rs`），
 * 于是**原生对话框也抢不到键盘**：框照常画出来，敲进去的字进不去。
 * 修法是把搜索框那条路复用一遍 —— 菜单开着时借键盘、关掉时还，
 * 要弹对话框的动作（重命名 / 删除 / alert）再自己借一次。
 *
 * 这条测的是**顺序**，因为顺序就是正确性本身：
 *   · 借必须发生在对话框**弹出之前**（`withKeyboard` 里是 `await` 完才跑 `fn`）
 *   · 还必须在对话框**关掉之后**（`finally`），否则框一出来窗口又不可激活了
 * `__MOCK_CALLS__` 是有序日志，所以这两条都能直接读出来。
 *
 * 注意这条在 mock 里**不可能**验出「真机上到底能不能打字」（那要真键盘），
 * 它验的是「代码把租约的顺序摆对了」。真机那一下仍要用户肉眼过。
 */
test("键盘租约：开菜单借、关菜单还；对话框弹出前租约必须已在手上", async ({ page }) => {
  await openBoard(page);
  const keyboard = () => callsTo(page, "set_keyboard_input");

  // ① 右键打开 → 借（菜单是键盘界面：Esc 要能关）
  await rightClick(page, app("d-cursor-0"), 900, 300);
  await expect.poll(keyboard).toEqual([{ active: true }]);

  // ② Escape 关掉 → 还（不还的话看板从此点一下就抢焦点）
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
    );
  });
  await closeMenu(page);
  await expect.poll(keyboard).toEqual([{ active: true }, { active: false }]);

  // ③ 重命名：把「借/还」与「命令」拼成一条有顺序的时间线
  page.once("dialog", (d) => void d.accept("新名字"));
  await rightClick(page, app("d-cursor-0"), 900, 300);
  await clickMenu(page, "rename");
  await expect.poll(async () => callsTo(page, "fence_rename")).toHaveLength(1);

  const timeline = await page.evaluate(() =>
    (
      window as unknown as {
        __MOCK_CALLS__: Array<{ cmd: string; args: { active?: boolean } }>;
      }
    ).__MOCK_CALLS__
      .filter((c) => c.cmd === "set_keyboard_input" || c.cmd === "fence_rename")
      .map((c) =>
        c.cmd === "fence_rename" ? "rename" : c.args.active ? "借" : "还"
      )
  );

  // 读法：借(开菜单) → 还(Esc) → 借(再开) → 还(pick 先关菜单) → 借(弹框前) → rename → 还(框关了)
  expect(timeline.join(" ")).toBe("借 还 借 还 借 rename 还");
  // 单把最关键的那一步再钉一次：rename 之前紧邻的那次键盘操作必须是「借」
  expect(timeline[timeline.indexOf("rename") - 1]).toBe("借");

  // ④ 时序：搜索框**失焦**排下的那个释放，不能把菜单刚借到的租约还掉。
  //    真实顺序是「先失焦（释放排进 0ms 定时器）→ 再派发 contextmenu（借）」，
  //    定时器后跑就会把租约还掉 —— 菜单开着，Esc 与原生对话框又都失效。
  //    FencePanel 的 `onBlur` 里那道 `menuOpenRef` 闸就是为这个存在的。
  //
  //    ⚠️ 三步必须在**同一个任务**里做完：中间一旦 `await` 回一趟 Node，
  //    那个 0ms 定时器就先跑了，释放排在借之前 —— 那时没有 bug 可测，
  //    这条会变成一条永远绿的假护栏（第一版就是这么写错的）。
  const before = (await keyboard()).length;
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(".fence-search")!;
    input.focus(); // 聚焦本身借一次键盘
    input.blur(); // 释放排进 0ms 定时器，此刻还没跑
    const el = document.querySelector(
      '#fences .fence:not(#fenceRecent) .fence-app[data-id="d-cursor-0"]'
    );
    if (!el) throw new Error("找不到 d-cursor-0");
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 900,
        clientY: 300,
      })
    );
  });
  await expect(page.locator(MENU)).toBeVisible();
  // 等那个定时器**真的跑过**再断言，否则这条会在定时器之前通过，同样等于没测
  await page.waitForTimeout(80);
  const seq = (await keyboard()).slice(before).map((a) => (a as { active: boolean }).active);
  // 没有那道闸的话这里会是 [true, false, true]：「失焦的释放」把菜单的租约还掉了
  expect(seq, "失焦的释放把菜单的租约还掉了").toEqual([true, true]);
});

test("推来新的一帧会关掉菜单（不让它拿一个已经失效的 path 去发命令）", async ({ page }) => {
  await openBoard(page);
  await rightClick(page, app("d-yuque-0"), 900, 300);

  expect(await pushFrame(page)).toBeGreaterThan(0);
  await closeMenu(page);
  // 关掉之后不该留下任何菜单节点（子菜单一并消失）
  await expect(page.locator(SUB)).toHaveCount(0);
});
