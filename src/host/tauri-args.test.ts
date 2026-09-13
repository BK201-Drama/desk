import { describe, expect, it } from "vitest";
import { COMMANDS } from "../generated/commands";

/**
 * Tauri 命令的**实参名**必须 camelCase。
 *
 * `tauri-macros` 的 `WrapperAttributes` 默认 `ArgumentCase::Camel`，且**没有
 * snake_case 回退**（本仓 0 处 `rename_all`）。所以 Rust 声明 `plugin_id: String`，
 * 前端就必须传 `pluginId`；传成 `plugin_id` 的后果是运行时
 * `missing required key pluginId` —— 只在真正调用时才出现，而如果这条命令从没被
 * 用过，它就一直潜伏：`tsc` 看不见（实参是普通对象，键名只是 `string`）、
 * 单测看不见、e2e 也看不见（那两条被登记进 `KNOWN_UNMOCKED`，理由正是
 * 「全仓无插件用 `ctx.storage`」—— **那个理由把「一用就炸」一起盖住了**）。
 *
 * 调用面有**两个**，都得扫，漏一个就等于没守：
 *   1. 宿主漏斗 `api.ts` 的 `tauriInvoke("cmd", { … })`
 *   2. 插件与宿主的直呼 `invoke("cmd", { … })` / `ctx.invoke("cmd", { … })`
 *      —— 15 个插件调用点全在这里，第一版只扫了面 1，守着 2/17。
 *
 * 判据是命令名 ∈ 生成的 `COMMANDS` —— 于是同名的无关函数（任何别的 `invoke`）
 * 自动出局，不需要维护白名单。
 *
 * 已知边界：命令名必须是**字面量**。写成变量（宿主漏斗 `tauriInvoke(cmd, args)`
 * 就是）匹配不上，这是对的 —— 那正是漏斗本身。实参写成变量则是真漏，见下面
 * 「没有扫不动的调用点」。本文件不跳注释（今天 0 处命中），所以要举例就用不带
 * 下划线的名字，否则例子本身会被判成违规。
 */

const SOURCES = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const REAL = new Set<string>(COMMANDS);

/** 两个调用面：`tauriInvoke` 优先，否则 `invoke` 会被 `tauriInvoke` 的尾巴吃掉。 */
const CALL = /(\btauriInvoke|\binvoke)\s*(?:<[^>{]*>)?\(\s*"([A-Za-z0-9_]+)"/g;

export type Site = { callee: string; cmd: string; argKeys: string[] };

/** 从 `{` 配对到同层 `}`，字符串里的花括号不算。找不到闭括号返回 -1。 */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 对象体最外层的键名。**按逗号切、按括号决定层深**，所以单行缩写（`{ path }`）也认得。 */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let cur = "";
  const flush = (): void => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:,]?/.exec(cur);
    if (m && cur.trim()) keys.push(m[1]);
    cur = "";
  };
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      cur += c;
      i += 1;
      while (i < body.length && body[i] !== c) {
        cur += body[i];
        if (body[i] === "\\") {
          i += 1;
          cur += body[i] ?? "";
        }
        i += 1;
      }
      cur += c;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") depth -= 1;
    if (c === "," && depth === 0) {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return keys;
}

/** `unscannable` = 调用了真命令、传了实参，但那实参不是同一处的字面量对象。 */
export function scan(src: string): { sites: Site[]; unscannable: string[] } {
  const sites: Site[] = [];
  const unscannable: string[] = [];
  for (const m of src.matchAll(CALL)) {
    const [, callee, cmd] = m;
    if (!REAL.has(cmd)) continue;
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] === ")") continue; // 没有实参，无事可查
    if (src[i] !== ",") {
      unscannable.push(cmd);
      continue;
    }
    i += 1;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] !== "{") {
      unscannable.push(cmd);
      continue;
    }
    const end = matchBrace(src, i);
    if (end < 0) {
      unscannable.push(cmd);
      continue;
    }
    sites.push({ callee, cmd, argKeys: topLevelKeys(src.slice(i + 1, end)) });
  }
  return { sites, unscannable };
}

function collect(): { sites: Site[]; unscannable: string[]; files: string[] } {
  const sites: Site[] = [];
  const unscannable: string[] = [];
  const files: string[] = [];
  for (const [file, src] of Object.entries(SOURCES)) {
    if (file.includes(".test.")) continue;
    const r = scan(src);
    if (r.sites.length > 0) files.push(file);
    sites.push(...r.sites);
    unscannable.push(...r.unscannable.map((c) => `${file}: ${c}`));
  }
  return { sites, unscannable, files };
}

describe("Tauri 命令实参名", () => {
  const { sites, unscannable, files } = collect();

  it("两个调用面都扫到了（某一面为空 = 那面在被无声地放过）", () => {
    const byCallee = (n: string): number => sites.filter((s) => s.callee === n).length;
    const empty = [
      ["tauriInvoke", byCallee("tauriInvoke")],
      ["invoke", byCallee("invoke")],
    ].filter(([, n]) => n === 0);
    expect(
      empty.map(([n]) => n),
      `这些调用面一个实参对象都没扫到：${empty.map(([n]) => n).join(", ")} ——\n` +
        "要么它们真没了，要么 glob / 正则失配。空转的守卫比没有守卫更坏：它看起来在守。"
    ).toEqual([]);
  });

  it("没有扫不动的调用点（实参必须是同一处的字面量对象）", () => {
    expect(
      unscannable,
      `这些调用点了真命令、却把实参写成了变量或非字面量：${unscannable.join(", ")}\n` +
        "扫不动就等于没守。要么就地展开成 `{ … }` 字面量，要么扩展本文件的扫描器。"
    ).toEqual([]);
  });

  it("实参名里没有 snake_case（Tauri 只认 camelCase，且无回退）", () => {
    const bad: string[] = [];
    for (const s of sites) {
      for (const k of s.argKeys) if (k.includes("_")) bad.push(`${s.cmd} → ${k}`);
    }
    expect(
      bad,
      `这些实参名是 snake_case：${bad.join(", ")}\n` +
        "Tauri 把 Rust 侧参数名转成 camelCase 再查，snake_case 的键永远查不到 ——\n" +
        "报错是 missing required key，而且只在真正调用时才炸。"
    ).toEqual([]);
  });

  it("扫描器本身有效（拿一段人造代码验它会响）", () => {
    const cmd = "fence_launch";
    const planted = `ctx.invoke("${cmd}", { fence_id: "x" })`;
    expect(scan(planted).sites.flatMap((s) => s.argKeys)).toContain("fence_id");
    expect(scan(`ctx.invoke("${cmd}", { fenceId: "x" })`).sites[0].argKeys).toEqual(["fenceId"]);
    // 变量实参要落进 unscannable，而不是被判成「没有实参」
    expect(scan(`invoke("${cmd}", args)`).unscannable).toEqual([cmd]);
    // 同名但不在 COMMANDS 里的函数必须出局
    expect(scan(`other.invoke("not_a_real_command", { x_y: 1 })`).sites).toEqual([]);
  });

  it("覆盖面不为零（守卫不能退化成守着两行）", () => {
    expect(
      files.length,
      `只扫到 ${files.length} 个文件带实参对象：${files.join(", ")} —— 像是在守一两行而不是一层。`
    ).toBeGreaterThanOrEqual(5);
  });
});
