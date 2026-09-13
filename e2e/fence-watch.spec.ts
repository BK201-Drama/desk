import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 13 的行为护栏：**后端推来一帧新看板，前端当场换掉**。
 *
 * 为什么要有这个文件：真桌面在 desk 外面被改动（资源管理器里新建 / 删除 / 改名）
 * 之后，看板必须自己跟上 —— 在 Task 13 之前它是冷启动那一刻的快照，
 * 唯一的「刷新」是重启 desk（用户 2026-09-13 实测：「我在桌面外面添加文件夹，
 * 居然没有立刻在桌面里展示出来」）。
 *
 * 链路有四段，缺一段就整条不通，而 cargo test 只能覆盖到第三段：
 *   Rust `app.emit("fence:changed")` → `bootstrap.ts` 的 `listen` 桥 → 进程内总线
 *   → `useFences` 的 `ctx.on` → `setFences`
 * 这里从**第二段**开始验：手工派发一次后端事件，看它能不能走到第五段。
 * （第一段由 `fence::watch` 的单测 + 真机验收覆盖；mock 里没有 Rust。）
 *
 * ⚠️ 顺带把 mock 的一个旧洞补上了：`plugin:event|listen` 原先直接 `return 1`，
 * 连回调都不存 —— 也就是说在 e2e 里**任何后端事件都送不到前端**。
 * 之前没人发现，是因为唯一两个 `listen` 消费者（`desk:toggle-edit` /
 * `desk:open-cmdk`）都没有 e2e 用例。
 */

const MOCK_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tauri-mock.js"
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: MOCK_PATH });
});

/** 等看板出来。和 recent.spec.ts 的 openBoard 同源 —— 围栏面板挂在 250ms 定时器之后。 */
async function openBoard(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.waitForSelector("#fences .fence-app", { timeout: 20_000 });
}

/**
 * 造一帧「真桌面变了」的看板并派发。
 *
 * 改动刻意选成两件不同的事，好把「换掉」和「合并」区分开：
 *   + 新增一个文件夹（真机上就是用户在桌面上新建文件夹）
 *   - 少了「任务管理器」（真机上就是用户把它删了 / 改名了）
 * 如果前端只是把新数据并进旧数据，第二条断言会红。
 */
async function emitNewFolder(page: Page, icon: string | null) {
  return page.evaluate((iconPath: string | null) => {
    const w = window as unknown as {
      __FENCE_FIXTURE__: () => Array<{
        name: string;
        items: Array<{ id: string; label: string; path: string; icon: string | null }>;
      }>;
      __deskEmit: (event: string, payload: unknown) => number;
    };
    const fx = w.__FENCE_FIXTURE__();
    const tools = fx.find((f) => f.name === "工具");
    if (!tools) throw new Error("fixture 里没有「工具」围栏");
    tools.items = tools.items.filter((i) => i.id !== "d-taskmgr-0");
    tools.items.push({
      id: "user:新文件夹",
      label: "新文件夹",
      path: "C:\\Desktop\\新文件夹",
      icon: iconPath,
    });
    // 返回值 = 实际送达的回调数。桥断了这里就是 0，第一条断言会当场红。
    return w.__deskEmit("fence:changed", fx);
  }, icon);
}

/**
 * 围栏区里的一个图标。
 *
 * **必须 `:not(#fenceRecent)`** —— 「最近」那一行本身也是 `#fences > .fence`，
 * 里面的 `.fence-app` 用的是同一套 data-id。不过滤的话，
 * 「最近」里出现过的 id 会被数成 2 个（`d-lol-0` 就是），断言会莫名其妙地红。
 */
const boardItem = (page: Page, id: string) =>
  page.locator(`#fences .fence:not(#fenceRecent) .fence-app[data-id="${id}"]`);

/**
 * `.face` 的 inline style —— 图标的落点。
 *
 * 取整个 style 字符串而不是 `style.backgroundImage`：`fenceIconStyle` 在没图标时
 * 返回的是 **`background` 简写**（渐变），而简写会把 `backgroundImage` 一起写掉，
 * 所以「没图标」时 `style.backgroundImage` 不是空串而是那段渐变 —— 拿它当判据会永远为真。
 * 判据用 `url(`：有图标的唯一形式。
 */
const faceStyle = (page: Page) =>
  page
    .locator('#fences .fence:not(#fenceRecent) .fence-app[data-id="user:新文件夹"] .face')
    .evaluate((el) => el.getAttribute("style") ?? "");

test("后端推来新看板 → 前端换掉旧的那一帧", async ({ page }) => {
  await openBoard(page);

  // 开局：任务管理器在（fixture 里 工具 有 4 项）
  await expect(boardItem(page, "d-taskmgr-0")).toHaveCount(1);

  const delivered = await emitNewFolder(page, null);

  // 事件真的送到了前端。这是「桥断没断」的判据 —— 少了它，
  // 后面就算全绿也可能只是因为断言恰好对着一份没变的 DOM。
  expect(delivered, "fence:changed 没有送达任何监听者（bootstrap 的桥或 useFences 的订阅断了）").toBeGreaterThan(0);

  await expect(boardItem(page, "user:新文件夹")).toHaveCount(1);
  await expect(
    page.locator('#fences .fence-app[data-id="user:新文件夹"] .label')
  ).toHaveText("新文件夹");

  // 被删掉的那项必须**消失** —— 证明是整帧替换，不是往旧列表里追加
  await expect(boardItem(page, "d-taskmgr-0")).toHaveCount(0);
});

/**
 * 两拍的第二拍：图标是异步补的（后端一次 PowerShell 抽一个），
 * 所以同一个项会先以「空方块」出现，随后被换成真图标。
 * 前端要能原地换掉 —— 它不轮询，只认推来的帧。
 */
test("第二拍：同一个项从空方块换成真图标", async ({ page }) => {
  await openBoard(page);

  await emitNewFolder(page, null);
  await expect(boardItem(page, "user:新文件夹")).toHaveCount(1);
  expect(await faceStyle(page), "第一拍应当还没有图标（占位渐变，没有 url()）").not.toContain(
    "url("
  );

  await emitNewFolder(page, "/icons/user_新文件夹.png");
  await expect.poll(() => faceStyle(page)).toContain("user_新文件夹.png");
  expect(await faceStyle(page)).toContain("url(");
});

/**
 * 反向护栏：没变化的那部分不该被动。
 * 推送是整帧替换，所以「工具」以外的围栏即使内容一样也应该还在 ——
 * 这条挡住的是「payload 解析错了，只剩一半围栏」这类事故。
 */
test("推送一帧不会波及没有变化的围栏", async ({ page }) => {
  await openBoard(page);
  await expect(boardItem(page, "d-lol-0")).toHaveCount(1);

  await emitNewFolder(page, null);

  await expect(boardItem(page, "d-lol-0")).toHaveCount(1);
  await expect(boardItem(page, "sys-recycle")).toHaveCount(1);
});

/** 推送一份**空**看板：桌面被清空时前端不该报错、也不该留残影。 */
test("推送空看板不报错且不留残影", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await openBoard(page);
  await expect(boardItem(page, "d-lol-0")).toHaveCount(1);

  await page.evaluate(() => {
    (window as unknown as { __deskEmit: (e: string, p: unknown) => number }).__deskEmit(
      "fence:changed",
      []
    );
  });

  await expect(page.locator('#fences .fence-app')).toHaveCount(0);
  expect(errors, errors.join("\n")).toEqual([]);
});
