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
 * 小数抹到 2 位：Chromium 升级带来的 font metric 抖动不算「观感变了」。
 * 正则要求小数点，所以 rgb(45, 106, 79) 里的整数不受影响。
 */
const round = (v: string) =>
  v.replace(/-?\d*\.\d+/g, (m) => String(Math.round(parseFloat(m) * 100) / 100));

type Entry = { tag: string; cls: string; props: Record<string, string> };
type Snapshot = Record<string, Entry>;

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate((props) => {
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
  }, PROPS as unknown as string[]);
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
  // 围栏面板在 250ms 定时器里挂载（useFences.ts:117-134），等元素真的出来
  await page.waitForSelector("#fences .fence-app", { timeout: 20_000 });
  // 注意：不要写 `page.evaluate(() => document.fonts.ready)` —— 它 resolve 成 FontFaceSet，
  // 跨进程序列化不过去。用 waitForFunction 判状态。
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await expect(page.locator("#fenceRecent")).toBeVisible();
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
    // Playwright 的输入动作会一直挂到超时（smoke.spec.ts:11 对 Ctrl+K 有同样的注释）。
    // 直接派发 DOM 事件：先走原生 setter 再派 input，React 的 onChange 才会认。
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>(".fence-search");
      if (!input) throw new Error(".fence-search not found");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!;
      setter.call(input, "文献");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForSelector(".fence-search-row", { state: "visible", timeout: 10_000 });
    const snap = await snapshot(page);
    expect(Object.keys(snap).length).toBeGreaterThan(MIN_ELEMENTS);
    check("search", snap);
  });
});
