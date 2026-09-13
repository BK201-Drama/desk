import { describe, expect, it } from "vitest";

/**
 * Tauri 命令的**实参名**必须 camelCase。
 *
 * `tauri-macros` 的 `WrapperAttributes` 默认 `ArgumentCase::Camel`，源码注释写着
 * "we always convert to camelCase"，而且**没有 snake_case 回退** —— 只有显式写
 * `#[tauri::command(rename_all = "snake_case")]` 才会变（本仓 0 处）。
 *
 * 所以 Rust 声明 `plugin_id: String`，前端就必须传 `pluginId`。传成 `plugin_id`
 * 的后果是运行时 `missing required key pluginId` —— 这个错**只在真正调用时才出现**，
 * 而调用它的命令如果恰好从没被用过，就会一直潜伏：
 *
 * - `tsc` 看不见（`invoke` 的实参是个普通对象字面量，键名是 `string`）
 * - 单测看不见；e2e 也看不见 —— 那两条被登记进 `KNOWN_UNMOCKED`，理由正是
 *   「**全仓无插件用 `ctx.storage`**」。`plugin_storage_get/set` 就是这么躺了很久的：
 *   **那个理由把「一用就炸」也一起盖住了。**
 *
 * 局限：只扫 `tauriInvoke("cmd", { ... })` 这种**同一行起手**的字面量对象。
 * 拆成变量再传就漏了 —— 但漏了会触发下面「对象数不为零」之外的
 * 逐文件覆盖断言，不会静默。
 */

const SOURCES = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

type Hit = { file: string; body: string };

function invokeArgObjects(): Hit[] {
  const out: Hit[] = [];
  for (const [file, src] of Object.entries(SOURCES)) {
    if (file.includes(".test.")) continue;
    const re = /tauriInvoke(?:<[^>]*>)?\(\s*"[^"]+"\s*,\s*\{([^}]*)\}/g;
    for (const m of src.matchAll(re)) out.push({ file, body: m[1] });
  }
  return out;
}

/** 从实参对象体里取键名：抓行首的 `名字,` 或 `名字:`（shorthand 没有冒号）。 */
function argNames(body: string): string[] {
  return [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,:]/gm)].map((m) => m[1]);
}

describe("Tauri 命令实参名", () => {
  const hits = invokeArgObjects();

  it("扫到的实参对象数不为零（正则失配 = 这个文件变空转）", () => {
    expect(
      hits.length,
      "一个带实参对象的 tauriInvoke 调用都没扫到 —— 要么它们真没了，要么 glob/正则失配了。\n" +
        "空转的守卫比没有守卫更坏：它看起来在守。"
    ).toBeGreaterThan(0);
  });

  it("实参名里没有 snake_case（Tauri 只认 camelCase，且无回退）", () => {
    const bad: string[] = [];
    for (const h of hits) {
      for (const name of argNames(h.body)) {
        if (name.includes("_")) bad.push(`${h.file}: ${name}`);
      }
    }
    expect(
      bad,
      `这些实参名是 snake_case：${bad.join(", ")}\n` +
        "Tauri 会把 Rust 侧参数名转成 camelCase 再查，snake_case 的键永远查不到 ——\n" +
        "报错是 missing required key，而且只在真正调用时才炸。"
    ).toEqual([]);
  });
});
