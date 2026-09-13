import { describe, expect, it } from "vitest";

/**
 * 注释里**不许**出现「文件名 + 行号」的引用。
 *
 * 为什么这是一条硬规矩，而不是洁癖：
 *
 * 行号不是标识符，它**在任何人改任何一行时都会变** —— 包括纯注释的改动。
 * 本仓实测过一次：`6883d32`（「压缩注释」）一行逻辑都没动，只是删了注释行，
 * 就让 `ops.rs` 的三处引用（`split_name` / `with_ext` / `rename_in`）全部指错，
 * 而 `tsc`、单测、e2e、样式审查**全绿**。等你顺着注释找过去，落点已经是对不上的
 * 另一段代码了 —— 那比没有注释更坏，它在骗人。
 *
 * 正确写法是引**符号**：`ops::rename_in`、`FencePanel` 的 `doLaunch`、
 * `fence/panel.css` 的 `.fence-app .face`。符号被改名会**编译失败 / 搜不到**，
 * 是响的；行号漂移是哑的。
 *
 * 想看符号在哪一行？编辑器里点一下就有，不需要把行号写死在文本里。
 */

const SOURCES = import.meta.glob(
  [
    "../**/*.{ts,tsx,css,js,jsx,mjs,cjs}",
    "../../e2e/**/*.{ts,js}",
    "../../src-tauri/src/**/*.rs",
    "!../**/node_modules/**",
    "!../../e2e/node_modules/**",
    "!../../src-tauri/target/**",
    "!../**/dist/**",
  ],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;

/**
 * ⚠️ 写成转义片段，是为了让**本文件自己的源码**不含未转义的引用文本 ——
 * 否则扫描器会扫到自己那一行（`paths.rs` 那条守卫第一版就是这么炸的）。
 */
const CITE = new RegExp(
  "[A-Za-z0-9_./\\\\-]+\\.(?:rs|tsx|ts|css|jsx|js|mjs|cjs)[:：]\\d+"
);

const RUST_EXT = /\.rs$/;

/** 这一行是不是注释行。判据取「行首标记」，不做跨行块注释状态机 —— 够用且不会误判。 */
function isComment(trimmed: string, rust: boolean): boolean {
  if (rust && (trimmed.startsWith("//") || trimmed.startsWith("*"))) return true;
  return trimmed.startsWith("//") || trimmed.startsWith("*");
}

/** 返回该文件里所有「注释行含 file:line 引用」的位置，形如 `路径:行号`。 */
function offending(file: string, src: string): string[] {
  const rust = RUST_EXT.test(file);
  const out: string[] = [];
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (!isComment(t, rust)) return;
    if (CITE.test(line)) out.push(`${file}:${i + 1}`);
  });
  return out;
}

describe("注释不许引用行号", () => {
  const files = Object.entries(SOURCES);

  it("三棵树都扫到了（某一棵为空 = 那棵树在被无声地放过）", () => {
    // 分树断言，而不是笼统的「文件数 > N」—— 后者靠 ts/tsx 就能满足，
    // Rust 那棵**悄悄空掉也照样绿**。上一版就是这么写的，等于没守。
    // 键是**相对本文件**的路径，形态有三种：同目录 `./api.ts`、往上一级
    // `../plugins/…`、往上两级 `../../e2e/…`。所以 `./` 就是本文件所在的 `src/host/`。
    const byTree = (p: string) => files.filter(([f]) => f.includes(p)).length;
    const trees: Array<[string, number]> = [
      ["./（src/host）", files.filter(([f]) => f.startsWith("./")).length],
      ["/plugins/", byTree("/plugins/")],
      ["/e2e/", byTree("/e2e/")],
      ["/src-tauri/src/", byTree("/src-tauri/src/")],
    ];
    const empty = trees.filter(([, n]) => n === 0).map(([p]) => p);
    expect(
      empty,
      `这些树的文件数为 0：${empty.join(", ")} —— glob 没伸进去，那棵树的坏引用会被无声放过。\n` +
        "空转的守卫比没有守卫更坏：它看起来在守。"
    ).toEqual([]);
  });

  it("扫描器本身有效（拿一段人造注释验它会响）", () => {
    // 样本用拼接构造：本文件自己的源码里不出现这段文本，省得上面那条 glob 扫到自己。
    const planted = "// 见 " + ["ops", "rs"].join(".") + ":" + "123";
    expect(offending("fake.rs", planted)).toEqual(["fake.rs:1"]);
    // 反向：符号引用不许被误报
    expect(offending("fake.rs", "// 见 `ops::rename_in` 与 `.fence-app .face`")).toEqual([]);
  });

  it("没有任何一条注释用 file:line 指向别处", () => {
    const bad = files.flatMap(([f, src]) => offending(f, src));
    expect(
      bad,
      `这些注释引用了行号：${bad.join(", ")}\n` +
        "行号会在任何一次改动（哪怕是删注释）时漂移，而所有闸门都是绿的 —— 等你顺着找过去，\n" +
        "落点已经是另一段代码。改引**符号**：`ops::rename_in`、`FencePanel` 的 `doLaunch`、\n" +
        "`fence/panel.css` 的 `.face` —— 符号改名会编译失败，是响的。\n" +
        "（确实要指某个历史版本的某一行？写明提交号 + 符号名，别写当前行号。）"
    ).toEqual([]);
  });
});
