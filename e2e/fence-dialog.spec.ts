import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 看板自己的弹窗（`src/plugins/fence/FenceDialog.tsx`）。
 *
 * 背景一句话：原生 `alert` / `confirm` / `prompt` 由 WebView2 自己画，页面 CSS
 * 够不到 —— 2026-09-13 用户裁决「优化一下弹窗的样式」，唯一的办法是把它们换成
 * 自己的。这个文件守的就是那个新界面。
 *
 * 为什么单开一个文件：**这里要覆盖的失败模式与菜单那条路完全不同**。菜单测的是
 * 「发出去哪条命令、参数叫什么」；弹窗测的是焦点、键盘租约、取消语义 ——
 * 全是原生框白送给我们的、现在要自己负责的东西。混在 `fence-menu.spec.ts` 里，
 * 两边的原因会互相淹没。
 *
 * ── 与其他 e2e 文件一样：一条真实输入都不发 ──────────────────────────────
 *
 * 这个环境的键盘和鼠标通道都会被宿主吞掉（`fence-menu.spec.ts` 文件头有实测记录），
 * 所以所有交互都是派发的 DOM 事件。**但有一处和那个文件不同，别照抄**：
 * 菜单在 `document` 上直接监听，所以那里可以 `document.dispatchEvent(keydown)`；
 * 弹窗的键盘处理是 React 的 `onKeyDown`（挂在渲染根容器上），
 * 事件**必须从框里的元素往上冒** —— 直接派到 `document` 上它永远收不到。
 */

const MOCK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "tauri-mock.js");

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: MOCK_PATH });
});

const MENU = '[data-testid="fence-menu"]';
const DIALOG = '[data-testid="fence-dialog"]';
const INPUT = '[data-testid="fence-dialog-input"]';
const OK = '[data-testid="fence-dialog-ok"]';
const CANCEL = '[data-testid="fence-dialog-cancel"]';
const TITLE = '[data-testid="fence-dialog-title"]';
const DETAIL = '[data-testid="fence-dialog-detail"]';

const app = (id: string) => `#fences .fence:not(#fenceRecent) .fence-app[data-id="${id}"]`;

async function openBoard(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.waitForSelector("#fences .fence-app", { timeout: 20_000 });
}

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

/** 点一个菜单项。用 `el.click()`（理由见文件头：真实鼠标在这里点不动）。 */
async function clickMenu(page: Page, id: string) {
  await page.evaluate((menuId) => {
    const el = document.querySelector<HTMLElement>(`[data-menu-id="${menuId}"]`);
    if (!el) throw new Error(`clickMenu: 菜单里没有 ${menuId}`);
    el.click();
  }, id);
}

/** 开「重命名」这条最容易复现的路：右键一个文件条目 → 点重命名。 */
async function openRenameDialog(page: Page, id = "d-cursor-0") {
  await rightClick(page, app(id), 900, 300);
  await clickMenu(page, "rename");
  await expect(page.locator(DIALOG)).toBeVisible();
}

/** 往输入框里打字。不用 `locator.fill`（同上：键盘通道是死的）。 */
async function typeInDialog(page: Page, text: string) {
  await page.evaluate(
    ({ sel, value }) => {
      const input = document.querySelector<HTMLInputElement>(sel);
      if (!input) throw new Error(`typeInDialog: 找不到 ${sel}`);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    { sel: INPUT, value: text }
  );
}

/**
 * 点框里的一个按钮。
 *
 * ⚠️ **`locator.click()` 在这里会挂死**，不是写得不好 —— 它走的是真实鼠标通道，
 * 而这个环境的鼠标和键盘一样被宿主吞掉（文件头那段；实测：日志停在
 * `performing click action` 直到 30s 超时）。所以全部走 `el.click()`。
 */
async function clickIn(page: Page, sel: string) {
  await page.evaluate((s) => {
    const el = document.querySelector<HTMLElement>(s);
    if (!el) throw new Error(`clickIn: 找不到 ${s}`);
    el.click();
  }, sel);
}

/** 在框里的某个元素上按一个键。**必须从框内派发**（文件头那段）。 */
async function pressIn(page: Page, key: string, sel = INPUT) {
  await page.evaluate(
    ({ sel, key }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`pressIn: 找不到 ${sel}`);
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true })
      );
    },
    { sel, key }
  );
}

const callsTo = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (window as unknown as { __MOCK_CALLS__: Array<{ cmd: string; args: unknown }> })
        .__MOCK_CALLS__.filter((x) => x.cmd === c)
        .map((x) => x.args),
    cmd
  );

/** 「借键盘」这条通道的有序记录，映射成 true=借 / false=还。 */
const keyboard = async (page: Page) =>
  (
    (await callsTo(page, "set_keyboard_input")) as Array<{ active: boolean }>
  ).map((a) => a.active);

// ─────────────────────────────────────────────────────────────────────────────

/**
 * **这条是这个文件里最重要的一条**：租约没到手，框根本不渲染。
 *
 * 它守的不是「顺序好看」，是 Task 15 那个真机缺陷的形状 —— 「框在那儿、打字没反应」，
 * 一个看起来完全正常的界面配一个死的输入框。把渲染排在借之后，这个状态就不存在。
 *
 * 非平凡的地方在于**要人为放慢**：`set_keyboard_input` 在 mock 里是微任务就返回的，
 * 不拖慢的话「先借后渲染」和「先渲染后借」在断言上长得一模一样，
 * 这条会变成一条永远绿的假护栏（`__MOCK_KEYBOARD_DELAY_MS__` 就是为它加的）。
 */
test("租约没到手不渲染：借键盘这条 IPC 在路上时，屏幕上不该有框", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __MOCK_KEYBOARD_DELAY_MS__?: number }).__MOCK_KEYBOARD_DELAY_MS__ = 300;
  });
  await openBoard(page);

  await rightClick(page, app("d-cursor-0"), 900, 300);
  await clickMenu(page, "rename");

  // 往「借」的路上看：这三次 IPC（开菜单借 / 关菜单还 / 框自己借）各要 300ms，
  // 150ms 时框连影子都不该有。
  await page.waitForTimeout(150);
  await expect(page.locator(DIALOG), "租约还没到手就渲染了 —— 真机上这一刻打不进字").toHaveCount(
    0
  );

  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 5_000 });
  // 框出现的同一刻输入框就该握着焦点，不然「看得见、打不进」还是会发生
  await expect(page.locator(INPUT)).toBeFocused();
});

test("Escape 取消：不发命令、框关掉、租约还回来", async ({ page }) => {
  await openBoard(page);
  await openRenameDialog(page);

  await pressIn(page, "Escape");
  await expect(page.locator(DIALOG)).toHaveCount(0);

  await page.waitForTimeout(200); // 给「万一发了命令」留一拍
  expect(await callsTo(page, "fence_rename")).toEqual([]);
  const kb = await keyboard(page);
  expect(kb[kb.length - 1], "框关掉了，租约该还").toBe(false);
});

test("回车 = 主按钮：提交并补回扩展名", async ({ page }) => {
  await openBoard(page);
  await openRenameDialog(page);

  await typeInDialog(page, "新名字");
  await pressIn(page, "Enter");
  await expect(page.locator(DIALOG)).toHaveCount(0);

  await expect.poll(async () => callsTo(page, "fence_rename")).toEqual([
    { path: "C:\\Desktop\\Cursor.lnk", newName: "新名字.lnk" },
  ]);
});

test("输入框清空时主按钮禁用，回车也发不出命令", async ({ page }) => {
  await openBoard(page);
  await openRenameDialog(page);

  await typeInDialog(page, "   ");
  await expect(page.locator(OK)).toBeDisabled();
  // 按钮禁用只拦鼠标 —— 回车走的是 `submit()`，得自己再判一次
  await pressIn(page, "Enter");
  await expect(page.locator(DIALOG), "空名字不该把框关掉").toBeVisible();
  expect(await callsTo(page, "fence_rename")).toEqual([]);
});

test("点遮罩（框外面）算取消", async ({ page }) => {
  await openBoard(page);
  await openRenameDialog(page);

  await page.evaluate((sel) => {
    const ov = document.querySelector(sel)!;
    // target === currentTarget 才是「点在外面」；派在遮罩自己身上正是这个情形
    ov.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  }, DIALOG);

  await expect(page.locator(DIALOG)).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(await callsTo(page, "fence_rename")).toEqual([]);
});

/**
 * 后端报错 → 弹窗报信。真机上这条只有后端出错才走得到，所以在 mock 里用
 * `__MOCK_FAIL_CMDS__` 主动制造（与 `__MOCK_ICONS_VISIBLE_THROWS__` 同一套路）。
 *
 * 顺带钉住 alert 那一档的形状：**没有取消**（它只报信，不提问），原文进 `detail`。
 */
test("命令失败 → 自己的 alert：只有「知道了」，错误原文在 detail 里", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __MOCK_FAIL_CMDS__?: string[] }).__MOCK_FAIL_CMDS__ = ["fence_delete"];
  });
  await openBoard(page);

  await rightClick(page, app("d-yuque-0"), 900, 300);
  await clickMenu(page, "delete");

  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(page.locator(TITLE)).toHaveText("操作失败");
  await expect(page.locator(DETAIL)).toContainText("fence_delete");
  await expect(page.locator(CANCEL), "alert 不该有取消按钮").toHaveCount(0);
  await expect(page.locator(OK)).toHaveText("知道了");

  await clickIn(page, OK);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  const kb = await keyboard(page);
  expect(kb[kb.length - 1], "报信的框关掉之后租约也要还").toBe(false);
});

/**
 * 弹窗自己的 Escape **不能顺手清空搜索框**：`FencePanel.tsx` 在 `document` 上
 * 还挂着一个 Escape（清搜索）。这是 `FenceContextMenu` 里那条注释的同款坑
 * ——「按一下少了两样东西」。菜单那边用捕获阶段抢，这边用 `stopPropagation`
 * 拦住冒泡，两条都得有护栏。
 */
test("搜索态下开弹窗：Escape 只关框，不清搜索框", async ({ page }) => {
  await openBoard(page);
  await page.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      '.head-actions button[aria-label="搜索图标"]'
    );
    if (!btn) throw new Error("找不到搜索图标按钮");
    btn.click();
  });
  await page.waitForSelector(".fence-search", { state: "visible", timeout: 5_000 });
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(".fence-search")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "e");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForSelector(".fence-search-row", { state: "visible", timeout: 10_000 });

  await rightClick(page, ".fence-search-row", 900, 300);
  await clickMenu(page, "rename");
  await expect(page.locator(DIALOG)).toBeVisible();

  await pressIn(page, "Escape");
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(".fence-search"), "Escape 顺手把搜索清了").toHaveValue("e");
});
