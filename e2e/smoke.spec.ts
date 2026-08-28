import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mockPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "tauri-mock.js");

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: mockPath });
});

test("desk shell renders board slots", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("desk-board")).toBeVisible();
  await expect(page.getByTestId("slot-left")).toBeVisible();
  await expect(page.getByTestId("slot-overlay")).toBeVisible();
});

test("cmdk opens and shows scheme composer", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("cmdk-root")).toBeAttached({ timeout: 15_000 });

  await page.evaluate(() => window.__deskOpenCmdk?.());
  await expect(page.getByTestId("cmdk-input")).toBeVisible();
  await expect(page.getByTestId("cmdk-composer")).toBeVisible();
  await expect(page.getByText("我的方案")).toBeVisible();
  await expect(page.getByTestId("cmdk-list")).toBeVisible();
});

test("cmdk lists default plugins when not searching", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("cmdk-root")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => window.__deskOpenCmdk?.());

  const list = page.getByTestId("cmdk-list");
  await expect(list.getByText("GitHub")).toBeVisible();
  await expect(list.getByText("待办")).toBeVisible();
});

test("cmdk keyboard shortcut toggles panel", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("cmdk-root")).toBeAttached({ timeout: 15_000 });

  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("cmdk-input")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cmdk-input")).not.toBeVisible();
});

test("cmdk can create a named scheme", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("cmdk-root")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => window.__deskOpenCmdk?.());

  const composer = page.getByTestId("cmdk-composer");
  await expect(composer.getByText("0/3")).toBeVisible();

  await composer.locator(".cmdk-scheme-name").fill("测试方案");
  await composer.getByRole("button", { name: "+ 新建" }).click();

  await expect(composer.getByText("1/3")).toBeVisible({ timeout: 10_000 });
  await expect(composer.getByRole("button", { name: "测试方案" })).toBeVisible();
});

test("page has no shell/react console errors on boot", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await expect(page.getByTestId("desk-board")).toBeVisible();
  await expect(page.getByTestId("cmdk-root")).toBeAttached({ timeout: 15_000 });
  await page.waitForTimeout(800);

  const critical = errors.filter((e) => {
    if (/github_snapshot|multica_snapshot|remind_list|fence_|qqmusic_/i.test(e)) return false;
    if (/favicon|React DevTools/i.test(e)) return false;
    return /React|Minified React|cmdk|DeskBridge|useLayoutConfig|Invariant/i.test(e) || e.includes("Uncaught");
  });
  expect(critical, critical.join("\n")).toEqual([]);
});
