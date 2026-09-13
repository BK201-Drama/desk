import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * 样式审查 —— fence 重构期间「观感不许变」的机器判据。
 *
 * 原理：把 `.pane-fences` 子树的每个元素的关键 computed style 录成 golden file。
 * 任何一次改动只要让任一属性变了，这里就红，并打印「路径.属性: 旧 → 新」。
 *
 * 重录基线：UPDATE_STYLE_BASELINE=1 npm run test:style
 *   ⚠️ 重录后必须 `git diff e2e/style-baseline.json` 逐行确认每一条变化都是本次改动
 *      预期的。改不动的，说明改错了，不是基线错了。
 *
 * 跑在真实产物上：playwright.config.ts 的 webServer 是 `npm run build && npm run preview`，
 * 所以 getComputedStyle 拿到的是真级联结果。jsdom 不做布局，这些值根本不存在。
 */

// package.json 是 "type": "module"，没有 __dirname —— 和 smoke.spec.ts 一样用 fileURLToPath。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PATH = path.join(HERE, "tauri-mock.js");
const UPDATE = process.env.UPDATE_STYLE_BASELINE === "1";

// 每个状态一个文件。**不要合成一个 JSON**：playwright.config.ts 是
// `fullyParallel: true`，两个测试会跑在不同 worker 里，各自写同一个文件就会丢更新。
// 分开存还有个好处：改了一个状态不会污染另一个状态的 diff。
const baselinePath = (name: string) => path.join(HERE, `style-baseline.${name}.json`);

// 没有这一行，__TAURI_INTERNALS__ 是 undefined，整块看板都是「未接通」，
// `.pane-fences` 里一个元素都没有 —— 测试会以一种非常费解的方式失败。
test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: MOCK_PATH });
});

/**
 * 审哪些属性。**刻意不含 width / height**：
 * 尺寸是内容驱动的（工具栏多一个按钮就变宽），而所有能改变尺寸的 CSS 输入
 * —— padding / margin / gap / grid-template-* / font-size —— 都在下面。
 */
const PROPS = [
  "display", "position", "flex-direction", "align-items", "justify-content",
  "gap", "row-gap", "column-gap",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "grid-template-columns", "grid-template-rows",
  "overflow-x", "overflow-y",
  "background-color", "color",
  "border-top-width", "border-top-style", "border-top-color",
  "border-top-left-radius",
  "font-size", "font-weight", "line-height", "letter-spacing",
  "white-space", "text-overflow",
] as const;

/**
 * 快照元素数的下界。根元素选错 / 面板没挂上时，空快照会「永远通过」。
 * 实际值约 80+，这里只取一个「明显不对就拦」的水位，不追求贴边。
 */
const MIN_ELEMENTS = 40;

/**
 * 几何量白名单 —— 额外录 width / height。
 *
 * **为什么需要它**：computed style 里的 gap / padding 只覆盖「间距」，覆盖不了
 * 「盒子自己多大」。`.face` 是 `width: 24px; height: 24px`（`fence/panel.css` 的 `.fence-app .face`），
 * 而网格列是 `1fr`（列宽由容器决定）—— 把 24px 改成 20px 不会传导到
 * `grid-template-columns`，属性表一个值都不变，审计会全绿。这是纯属性快照的盲区。
 *
 * **为什么是白名单，而不是给所有元素录**：
 *   - `.head-actions` 及其按钮不录：Task 5 要往工具栏加按钮，宽度合法地变。
 *     录了它，Task 5 会产生一堆「本不该有」的 diff，把真漂移淹掉。
 *   - `span.label` / `.fence-title` / `.fence-search-row-text` 不录：文字盒子的
 *     宽度由 font metric 决定，跨 Chromium 版本会抖，容易误报。
 *
 * **只录 w / h，不录 x / y**：位置是 viewport 相对的，会把审查耦合到
 * `.pane-fences` 之外的整个页面布局上（别的面板高一点这里就红）。间距本身已经由
 * gap / padding / margin 覆盖了，位置是多余的。
 *
 * 注意 `#fences` 的**高度**间接依赖工具栏高度（它是 flex 剩下的那部分）。所以这里
 * 隐含一条要求：Task 5 的按钮必须待在原来那一行里、不把工具栏撑高。
 * 撑高了是真问题（计划里有「h2 未换行」的验收项），不算误报。
 */
const GEOMETRY = [
  "#fences", // 围栏区整体：宽度 = 面板内宽，最基本的布局不变量
  ".fence", // 单个围栏：高度反映 --fence-rows
  ".fence-grid",
  ".fence-app", // height: var(--fence-row)
  ".face", // 24px —— 这就是当初的盲区
  ".fence-search-list", // 搜索结果列表：高度 = 行数 × 行高 + gap
  ".fence-search-row", // 搜索结果行
  // 标题栏上的收起箭头（2026-09-13 加）。它是 `display: inline-flex` 且宽高写死
  // 7px —— **不受 font metric 影响**（所以不触发上面「文字盒子不录」那条），
  // 而它恰恰是唯一能撑高 `.fence-title` 行盒的东西：`.fence-title` 自己不在
  // 白名单里（文字盒子），可 `.fence` 在 —— caret 长高了会透过 `.fence` 的
  // `rect-h` 露出来。录它，是为了让「caret 从 7px 变成 12px」当场红，
  // 而不是等到某天发现标题栏胖了一圈。
  ".fence-caret",
  // 弹窗。**这里是对上面那条「尺寸是内容驱动的」的刻意例外**：
  // `.fence-menu` 的宽度由菜单项字数决定，所以它不在白名单里；弹窗反过来 ——
  // 它是块固定尺寸的卡片（panel.css 里写死 288px），宽高都不该跟着标题字数走。
  // 不录的话，「把 288px 改成 320px」在属性表里一个值都不变（padding / font-size
  // 都没动），正是 `.face` 那个盲区的翻版。
  //
  // 代价认下来：`rect-h` 里含输入框的**固有高度**，那是 font metric 派生的 ——
  // 将来升 Playwright（连带 Chromium）时这里可能出现 1~2px 的假红。
  // 看到时先量一遍真机观感，别直接重录基线：宽高都在这一条里，`rect-w` 那半边
  // 正是要守的东西，整条删掉就把它一起丢了。
  ".fence-dialog",
].join(", ");

/**
 * ⚠️ `getBoundingClientRect()` 的数值比 CSS 里写的大 —— 别以为是错了。
 *
 * `html, body { zoom: var(--desk-zoom) }`（`styles.css` 里的 `zoom` 规则，`--desk-zoom: 1.28`），
 * zoom 套在**两层**选择器上，复合成 1.28² = **1.6384**。所以：
 *   `.fence-app .face` 写 `width: 24px` → 录到 `39.31px`
 *   `.fence-search-row .face` 写 `32px`  → 录到 `52.42px`
 *
 * 这不影响审查（数值是确定的），但读 diff 时必须知道：**几何量是缩放后的**，
 * 想反推 CSS 里的值要除以 1.6384。
 */

/**
 * 小数抹到 2 位：Chromium 升级带来的 font metric 抖动不算「观感变了」。
 * 正则要求小数点，所以 rgb(45, 106, 79) 里的整数不受影响。
 */
const round = (v: string) =>
  v.replace(/-?\d*\.\d+/g, (m) => String(Math.round(parseFloat(m) * 100) / 100));

type Entry = { tag: string; cls: string; props: Record<string, string> };
type Snapshot = Record<string, Entry>;

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(({ props, geometry }) => {
    const root = document.querySelector<HTMLElement>(".pane-fences");
    if (!root) return {};
    const out: Record<string, { tag: string; cls: string; props: Record<string, string> }> = {};
    // 键里带上 class：Task 17 排查漂移时全靠读这些路径，
    // `div:nth-child(1)>div:nth-child(2)` 这种没法看。
    const seg = (el: Element, i: number) => {
      // id 认结构：#fences / #fenceRecent 都是 className="fence" 的 div，
      // 光看 class 认不出哪个是哪个。
      const id = el.id ? `#${el.id}` : "";
      const cls =
        typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\s+/).join(".")
          : "";
      // data-name 让 `.fence` 能一眼认出是哪个围栏，不然只有 nth-child
      const dn = el.getAttribute("data-name");
      return `${el.tagName.toLowerCase()}${id}${cls}${
        dn ? `[data-name=${dn}]` : ""
      }:nth-child(${i + 1})`;
    };
    const walk = (el: Element, key: string) => {
      const cs = getComputedStyle(el);
      const rec: Record<string, string> = {};
      for (const p of props) rec[p] = cs.getPropertyValue(p);
      // 几何：白名单里的盒子额外录 w / h。见文件上方 GEOMETRY 的注释。
      // 不渲染的元素（搜索态里 `#fences` 是 display:none）跳过 —— 否则会录一堆
      // 0×0，看着有护栏其实是空的。跳过是安全的：键「从无到有」本身就是一处 diff，
      // 所以某个元素该不该渲染，也在审查范围内。
      if (el.matches(geometry) && el.getClientRects().length > 0) {
        const r = el.getBoundingClientRect();
        rec["rect-w"] = `${r.width}px`;
        rec["rect-h"] = `${r.height}px`;
      }
      out[key] = {
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === "string" ? el.className : "",
        props: rec,
      };
      Array.prototype.forEach.call(el.children, (child: Element, i: number) => {
        walk(child, `${key}>${seg(child, i)}`);
      });
    };
    walk(root, ":root");
    return out;
  }, { props: PROPS as unknown as string[], geometry: GEOMETRY });
}

function normalize(snap: Snapshot): Snapshot {
  const out: Snapshot = {};
  for (const [key, v] of Object.entries(snap)) {
    const props: Record<string, string> = {};
    for (const [pk, pv] of Object.entries(v.props)) props[pk] = round(pv);
    out[key] = { tag: v.tag, cls: v.cls, props };
  }
  return out;
}

/** 逐路径 diff，输出「路径.属性: 旧 → 新」。比 expect().toEqual 的默认报错可读得多。 */
function diff(expected: unknown, actual: unknown, prefix = ""): string[] {
  if (expected === actual) return [];
  const both =
    expected && actual && typeof expected === "object" && typeof actual === "object";
  if (!both) return [`${prefix}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`];
  const keys = new Set([
    ...Object.keys(expected as object),
    ...Object.keys(actual as object),
  ]);
  const out: string[] = [];
  for (const k of keys) {
    out.push(...diff((expected as never)[k], (actual as never)[k], prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

function check(name: string, snap: Snapshot) {
  const got = normalize(snap);
  const file = baselinePath(name);
  if (UPDATE) {
    writeFileSync(file, JSON.stringify(got, null, 2) + "\n");
    return;
  }
  const want = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Snapshot) : null;
  if (!want) {
    throw new Error(
      `基线缺少 e2e/style-baseline.${name}.json。先跑 UPDATE_STYLE_BASELINE=1 npm run test:style`
    );
  }
  const d = diff(normalize(want), got);
  expect(d.slice(0, 40).join("\n"), `「${name}」样式漂移 ${d.length} 处`).toBe("");
}

async function openBoard(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  // 过渡进行中的 computed 值不是稳定值
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
  // 围栏面板在 250ms 定时器里挂载（`useFences` 里那个 250ms 定时器），等元素真的出来
  await page.waitForSelector("#fences .fence-app", { timeout: 20_000 });
  // 注意：不要写 `page.evaluate(() => document.fonts.ready)` —— 它 resolve 成 FontFaceSet，
  // 跨进程序列化不过去。用 waitForFunction 判状态。
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await expect(page.locator("#fenceRecent")).toBeVisible();
}

/**
 * 在「工具」围栏的 Cursor 上开右键菜单（Task 15 的两个菜单态都要它）。
 *
 * 两点是**为了可复现**而不是随手写的：
 *   · `:not(#fenceRecent)` —— 那一行的 `.fence-app` 用的是同一套 `data-id`，
 *     不过滤的话 querySelector 会挑到「最近」那一份（同一个条目，但位置不同）。
 *   · 点击点写死 (900, 300) —— 菜单坐标由 JS 按实测缩放写成内联样式，
 *     不固定点击点就录不到确定的值（而且在右下角会被 clamp 拉回去）。
 */
async function openContextMenu(page: Page) {
  await page.evaluate(() => {
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
  // 摆位是在 useLayoutEffect 里完成的：先在 visibility:hidden 下量尺寸再定位。
  // 等它可见 = 等摆位完成，否则录到的是一份还没定位的菜单。
  await expect(page.locator('[data-testid="fence-menu"]')).toBeVisible();
}

test.describe("样式审查（fence 重构护栏）", () => {
  test("默认态", async ({ page }) => {
    await openBoard(page);
    await expect(page.locator("#fenceRecent .fence-app")).toHaveCount(4);
    const snap = await snapshot(page);
    expect(Object.keys(snap).length, "快照元素太少，根元素八成选错了").toBeGreaterThan(
      MIN_ELEMENTS
    );
    check("default", snap);
  });

  test("搜索态", async ({ page }) => {
    await openBoard(page);
    // 不要用 locator.fill / keyboard.type —— 这个环境的键盘通道会被宿主吞掉，
    // Playwright 的输入动作会一直挂到超时（`smoke.spec.ts` 的 `openCmdk` 对 Ctrl+K 有同样的注释）。
    // 直接派发 DOM 事件：先走原生 setter 再派 input，React 的 onChange 才会认。
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>(".fence-search");
      if (!input) throw new Error(".fence-search not found");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!;
      // 查询词挑「命中多行」的，不是挑好听的。只命中 1 行的话搜索态的几何量
      // 只有 2 个值（1 行 + 1 个 .face），等于空护栏。固定 fixture 里含 "e" 的
      // 标签有 5 个：counter-strike 2 / Terraria / Cursor / PowerShell / Obsidian。
      setter.call(input, "e");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForSelector(".fence-search-row", { state: "visible", timeout: 10_000 });
    const snap = await snapshot(page);
    expect(Object.keys(snap).length).toBeGreaterThan(MIN_ELEMENTS);
    check("search", snap);
  });

  /**
   * 警告态 —— Task 5 新增的 UI。它不在重构前那两个状态里，必须单开一个状态录，
   * 否则 `.fence-warn` 会永远待在护栏外面（GOAL §4.5）。
   *
   * 触发方式：让 mock 的 `fence_icons_visible` 抛错。这是**唯一**能让这条横条出现的
   * 条件（图标正常处于隐藏态不算错误），所以录到的就是真实观感。
   *
   * addInitScript 的执行顺序 = 注册顺序，所以在 beforeEach 的 MOCK_PATH 之后再挂一个
   * 只设标志的脚本即可 —— mock 里的 invoke 是运行时才读这个标志的。
   */
  test("警告态（桌面图标开关读写失败）", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __MOCK_ICONS_VISIBLE_THROWS__?: boolean })
        .__MOCK_ICONS_VISIBLE_THROWS__ = true;
    });
    await openBoard(page);
    await expect(page.locator(".fence-warn")).toBeVisible();
    const snap = await snapshot(page);
    expect(Object.keys(snap).length).toBeGreaterThan(MIN_ELEMENTS);
    // 这个状态存在的意义就是那条横条。录不到它 = 录了个假的警告态。
    expect(
      Object.keys(snap).some((k) => k.includes("fence-warn")),
      "警告条没进快照，warn 态等于空护栏"
    ).toBe(true);
    check("warn", snap);
  });

  /**
   * 右键菜单态 —— Task 15 新增的 UI，必须单开状态录（GOAL §4.5）。
   *
   * 选中**文件**条目（d-cursor-0）而不是空白或 sys：文件那一档的项最多
   * （打开 / 打开方式 / 在资源管理器中显示 / 剪切 / 复制 / 重命名 / 删除 /
   * 发送到 ▸ / 属性），一个状态就把菜单项、分隔线、子菜单入口全录进去了。
   *
   * 点击点固定 (900, 300)：菜单是 `position: fixed` 且坐标由 JS 写成内联样式，
   * 只有固定点击点才能录到确定的值。`rect-w/h` 也不受影响 —— GEOMETRY 白名单里
   * 没有 `.fence-menu`（它的宽度是内容驱动的，`min-width` 已由 padding /
   * font-size 这些属性间接覆盖了）。
   */
  test("右键菜单态", async ({ page }) => {
    await openBoard(page);
    await openContextMenu(page);
    const snap = await snapshot(page);
    expect(Object.keys(snap).length).toBeGreaterThan(MIN_ELEMENTS);
    // 这个状态存在的意义就是那个菜单。录不到它 = 录了个假的菜单态。
    expect(
      Object.keys(snap).some((k) => k.includes("fence-menu")),
      "菜单没进快照，menu 态等于空护栏"
    ).toBe(true);
    check("menu", snap);
  });

  /**
   * 子菜单展开态。**必须单独录**：子菜单只在悬停时渲染，它那套
   * padding / border / background / min-width 在 `menu` 态里一个元素都没有。
   */
  test("右键菜单 · 子菜单展开态", async ({ page }) => {
    await openBoard(page);
    await openContextMenu(page);
    // 用派发 pointerover 而不是 page.hover()：真实鼠标会把 :hover 带到
    // 条目上，录到的 background-color 就取决于鼠标最后停在哪 —— 那是不确定量。
    await page.evaluate(() => {
      const el = document.querySelector('[data-menu-id="send-to"]');
      if (!el) throw new Error("菜单里没有 send-to");
      el.dispatchEvent(
        new PointerEvent("pointerover", {
          bubbles: true,
          cancelable: true,
          relatedTarget: document.body,
        })
      );
    });
    await expect(page.locator('[data-testid="fence-menu-sub"]')).toBeVisible();
    const snap = await snapshot(page);
    expect(Object.keys(snap).length).toBeGreaterThan(MIN_ELEMENTS);
    expect(
      Object.keys(snap).some((k) => k.includes("fence-menu-sub")),
      "子菜单没进快照，menu-sub 态等于空护栏"
    ).toBe(true);
    check("menu-sub", snap);
  });

  /**
   * 重命名弹窗态 —— 2026-09-13 新增的 UI（用户裁决：「优化一下弹窗的样式」）。
   * 它取代了原生 `prompt`，所以必须单开一个状态录（GOAL §4.5），
   * 否则那套 padding / border / background 全在护栏之外。
   *
   * 触发方式就是真人的那两下：右键一个文件条目 → 点「重命名」。**此时菜单已经关了**
   * （`pick` 是先关菜单再跑动作），所以这个状态里只有弹窗，没有菜单 ——
   * 两个都想要的话得再开一个状态，而那样录到的组合真机上不存在。
   *
   * 录到的是**输入框已自动聚焦并全选**的样子：那是这个界面唯一可能出现的形态。
   * 聚焦态只改 `outline`（不在 PROPS 里），所以基线对「文档有没有焦点」不敏感 ——
   * 这是 panel.css 里那条 ⚠️ 的用意。
   */
  test("重命名弹窗态", async ({ page }) => {
    await openBoard(page);
    await openContextMenu(page);
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-menu-id="rename"]');
      if (!el) throw new Error("菜单里没有 rename");
      el.click();
    });
    await expect(page.locator('[data-testid="fence-dialog"]')).toBeVisible();
    const snap = await snapshot(page);
    expect(Object.keys(snap).length).toBeGreaterThan(MIN_ELEMENTS);
    expect(
      Object.keys(snap).some((k) => k.includes("fence-dialog")),
      "弹窗没进快照，dialog 态等于空护栏"
    ).toBe(true);
    check("dialog", snap);
  });

  /**
   * 收缩态 —— 2026-09-13 新增的 UI（用户裁决：「分类要能点击收缩展开」）。
   * 与 warn / menu / dialog 三态同款：不单开一个状态录，那套
   * `is-collapsed` / `fence-caret.is-closed` / `.fence-grid { display: none }`
   * 就永远待在护栏外面（GOAL §4.5）。
   *
   * **为什么用 `__MOCK_UI_PRESET__` 而不是「点一下标题」**：样式审查要的是**确定的
   * 一帧**，而点击走到的是「乐观更新 → invoke → 对齐」那条链，中间夹着一帧还没
   * 收起的画面。点击这条路已经由 `fence-interactions.spec.ts` 管着（那才是它该管的），
   * 这里只管观感。开关在 mock 里是**推迟到第一次 invoke** 才生效的 —— 见那边的 ⚠️。
   */
  test("收缩态", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __MOCK_UI_PRESET__?: unknown }).__MOCK_UI_PRESET__ = {
        游戏: { collapsed: true },
      };
    });
    await openBoard(page);
    const game = page.locator('#fences .fence[data-name="游戏"]');
    await expect(game).toHaveClass(/is-collapsed/);
    // 箭头得是「收起」那个朝向，不然录到的是「收起了，箭头还说能收」的错误组合
    await expect(game.locator(".fence-caret")).toHaveClass(/is-closed/);
    const snap = await snapshot(page);
    expect(Object.keys(snap).length).toBeGreaterThan(MIN_ELEMENTS);
    expect(
      Object.keys(snap).some((k) => k.includes("fence-caret")),
      "caret 没进快照，收缩态等于空护栏"
    ).toBe(true);
    check("collapsed", snap);
  });

  /**
   * 自定义高度态 —— 2026-09-13 新增的 UI（用户裁决：「分类高度可以自定义」）。
   *
   * **两个围栏各录一条，因为 `--fence-rows` 能坏在两个不同的地方**：
   *   · 「游戏」`rows: 1` —— 内容 5 项 = 2 行，压到 1 行，**高度真的会变**。
   *     这一条守的是「`--fence-rows` 传下去没有」：`--fence-rows` 本身不在 PROPS 里，
   *     没有这条的话，「`.rows-1` 被 styles.css 的按名规则盖回去」在属性表上
   *     一个值都不变 —— 正是 `.face` 那个盲区的翻版。
   *   · 「工作」`rows: 3` —— 内容才 4 项（1 行），**高度不变**，但它的
   *     `overflow-y` 会从 styles.css 写死的 `hidden` 翻成 `auto`。
   *     这一条守的是那条 CSS 陷阱（工作 / 系统 / 最近 三个是按名 `hidden` 的）。
   * 只录一个的话，另一半坏了照样全绿。
   */
  test("自定义高度态", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __MOCK_UI_PRESET__?: unknown }).__MOCK_UI_PRESET__ = {
        游戏: { rows: 1 },
        工作: { rows: 3 },
      };
    });
    await openBoard(page);
    // `rows-N` 是面板 CSS 打的（styles.css 只认按名的 `--fence-rows`），
    // 等它出现 = 等「自定义」这条路真的接上了，不是等一个巧合。
    await expect(page.locator('#fences .fence[data-name="游戏"] .fence-grid')).toHaveClass(
      /rows-1/
    );
    await expect(page.locator('#fences .fence[data-name="工作"] .fence-grid')).toHaveClass(
      /rows-3/
    );
    const snap = await snapshot(page);
    expect(Object.keys(snap).length).toBeGreaterThan(MIN_ELEMENTS);
    expect(
      Object.keys(snap).some((k) => k.includes("rows-1")) &&
        Object.keys(snap).some((k) => k.includes("rows-3")),
      "两个自定义高度的网格没进快照，rows 态等于空护栏"
    ).toBe(true);
    check("rows", snap);
  });
});
