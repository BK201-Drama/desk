import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 「最近」那一行的行为护栏。
 *
 * 为什么要有这个文件：Task 8 把「最近」收进了 src/plugins/fence/recent/ 一个封闭模块，
 * 记入最近的调用点从 useFences.launch() 挪到了 FencePanel.doLaunch()。
 * 样式审查（style-audit.spec.ts）只能证明**渲染出来的 DOM 没变**，
 * 证明不了「点击之后列表内容有没有变对」—— 那是行为，不是观感。
 *
 * 计划里这条本来是手工验收（Task 8 Step 7 要 `npm run tauri dev` 点几下），
 * 而 release 版 desk 常驻导致单实例锁锁住 dev，手工那步一直是 ⚠️。
 * 这三条 e2e 是它的机器替代：比手工更严，因为断言写死了顺序。
 */

const MOCK_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tauri-mock.js"
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: MOCK_PATH });
});

/**
 * 等看板出来。和 style-audit.spec.ts 的 openBoard 同源 ——
 * 围栏面板挂在 useFences 的 250ms 定时器之后，`#fences` 一开始是不存在的。
 */
async function openBoard(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.waitForSelector("#fences .fence-app", { timeout: 20_000 });
}

/** 「最近」那一行里显示的标签，按渲染顺序。 */
const recentLabels = (page: Page) =>
  page.locator("#fenceRecent .fence-app .label").allTextContents();

/**
 * 点一个 `.fence-app`。**不用 locator.click()** —— 这个环境里 Playwright 的
 * 命中测试会被宿主吞掉，动作会一直挂到超时（`style-audit.spec.ts` 里同样的注释）。
 * `el.click()` 派发的是真的冒泡 click 事件，React 的根委托照样收得到。
 */
async function clickApp(page: Page, id: string) {
  await page.locator(`#fences .fence-app[data-id="${id}"]`).first().evaluate((el) => {
    (el as HTMLButtonElement).click();
  });
}

/** 派发一个 keydown。同理，page.keyboard.press 在这里会挂。 */
const pressKey = (page: Page, key: string) =>
  page.evaluate((k) => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true })
    );
  }, key);

/** 往受控输入里写值：原生 setter + input 事件，React 的 onChange 才认。 */
const typeInto = (page: Page, selector: string, value: string) =>
  page.evaluate(
    ({ sel, val }) => {
      const input = document.querySelector<HTMLInputElement>(sel);
      if (!input) throw new Error(`${sel} not found`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        val
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    { sel: selector, val: value }
  );

test("「最近」按磁盘顺序渲染，最多 4 条", async ({ page }) => {
  await openBoard(page);
  await expect(page.locator("#fenceRecent")).toBeVisible();
  // mock 的 RECENT_FIXTURE 顺序 = 飞书 / Cursor / 英雄联盟 / Obsidian。
  // 顺序是断言的重点：列表是「最近用过的在前」，排错了等于功能错了。
  await expect
    .poll(() => recentLabels(page))
    .toEqual(["飞书", "Cursor", "英雄联盟", "Obsidian"]);
});

test("点击围栏里的图标 → 进「最近」首位，总数仍是 4", async ({ page }) => {
  await openBoard(page);
  await expect.poll(() => recentLabels(page)).toHaveLength(4);

  // Terraria 在开局那 4 条之外，且排在 游戏 围栏里（不在 工作/工具 的最近里）
  await clickApp(page, "d-terraria-0");

  await expect.poll(() => recentLabels(page)).toEqual([
    "Terraria",
    "飞书",
    "Cursor",
    "英雄联盟",
  ]);
  // 第 5 条 Obsidian 被挤出去 —— 上限是 4，不是 5
  await expect(page.locator("#fenceRecent .fence-app")).toHaveCount(4);
});

/**
 * 键盘路径。这是计划里那条「旧版键盘启动不会记入最近」的**实测判据** ——
 * 计划对旧代码的这个说法经 `git show HEAD:src/plugins/fence/useFences.ts` 核对是错的
 * （旧 launch 里也有 recordRecent），所以这里不做「旧版会不会」的对照，
 * 只锁住「新版一定会」这个当下事实。
 */
test("搜索后回车启动 → 同样进「最近」", async ({ page }) => {
  await openBoard(page);
  await expect.poll(() => recentLabels(page)).toHaveLength(4);

  await pressKey(page, "/");
  await typeInto(page, ".fence-search", "powershell");
  await page.waitForSelector(".fence-search-row", { state: "visible", timeout: 10_000 });

  // 只命中 PowerShell 一条，所以 selected(=0) 就是指它，回车无需先按方向键
  await expect(page.locator(".fence-search-row")).toHaveCount(1);
  await pressKey(page, "Enter");

  // 搜索态下 #fences 是 hidden 的（#fenceRecent 也跟着不可见），先清掉搜索再看
  await pressKey(page, "Escape");
  await expect(page.locator("#fenceRecent")).toBeVisible();

  await expect.poll(() => recentLabels(page)).toEqual([
    "PowerShell",
    "飞书",
    "Cursor",
    "英雄联盟",
  ]);
});

/**
 * 首次运行 / 删掉 recent-launches.json 之后的那一瞬。
 * 计划的手工步骤要求「那行消失，不报错」—— 两件事都要机器验：
 *   - 元素**不存在**（不是存在但不可见：空壳会让 .fence 的圆角边框露出来）
 *   - 控制台没有报错
 */
test("最近列表为空时整行不渲染，且不报错", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __MOCK_RECENT_EMPTY__?: boolean }).__MOCK_RECENT_EMPTY__ = true;
  });
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await openBoard(page);
  // 围栏本身在（否则「不渲染」可能只是因为整块都没出来）
  await expect(page.locator("#fences .fence").first()).toBeVisible();
  await expect(page.locator("#fenceRecent")).toHaveCount(0);

  const critical = errors.filter((e) => {
    if (/github_snapshot|multica_snapshot|remind_list|fence_|qqmusic_/i.test(e)) return false;
    if (/favicon|React DevTools/i.test(e)) return false;
    return /React|Minified React|recent|Invariant/i.test(e) || e.includes("Uncaught");
  });
  expect(critical, critical.join("\n")).toEqual([]);
});
