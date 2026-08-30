import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mockPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "tauri-mock.js");

async function openCmdk(page: import("@playwright/test").Page) {
  await page.locator("body").click({ position: { x: 8, y: 8 } });
  // Control+k 在部分环境会被系统/宿主吞掉，Playwright press 会一直挂起；直接派发 DOM 事件。
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await expect(page.getByTestId("cmdk-input")).toBeVisible();
}

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

  await openCmdk(page);
  await expect(page.getByTestId("cmdk-composer")).toBeVisible();
  await expect(page.getByTestId("cmdk-composer").getByText("方案")).toBeVisible();
  await expect(page.getByTestId("cmdk-list")).toBeVisible();
});

test("cmdk lists default plugins when not searching", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("cmdk-root")).toBeAttached({ timeout: 15_000 });
  await openCmdk(page);

  const list = page.getByTestId("cmdk-list");
  await expect(list.getByText("GitHub")).toBeVisible();
  await expect(list.getByText("待办")).toBeVisible();
});

test("cmdk keyboard shortcut toggles panel", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("cmdk-root")).toBeAttached({ timeout: 15_000 });

  await openCmdk(page);
  await expect(page.getByTestId("cmdk-input")).toBeVisible();

  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await expect(page.getByTestId("cmdk-input")).not.toBeVisible();
});

test("cmdk can create a named scheme", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("cmdk-root")).toBeAttached({ timeout: 15_000 });
  await openCmdk(page);

  const composer = page.getByTestId("cmdk-composer");
  await expect(composer.getByText("0/3")).toBeVisible();

  const nameInput = composer.locator(".cmdk-scheme-name");
  await expect(nameInput).toBeVisible();
  await nameInput.click({ force: true });
  await nameInput.fill("测试方案", { force: true });
  await composer.getByRole("button", { name: "+ 新建" }).click({ force: true });

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
    return /React|Minified React|cmdk|DeskBridge|DeskShell|useLayoutConfig|Invariant/i.test(e) || e.includes("Uncaught");
  });
  expect(critical, critical.join("\n")).toEqual([]);
});
