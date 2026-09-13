import { describe, expect, it } from "vitest";

/**
 * 「起子进程」这件事的静态护栏。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 *
 * desk 是 **GUI 子系统**（`src-tauri/src/main.rs` 的 `windows_subsystem = "windows"`，
 * 实测 PE Subsystem=2），自己**没有控制台**。`reg.exe` / `powershell.exe` / `cmd.exe`
 * 全是**控制台程序**：父进程不带 `CREATE_NO_WINDOW` 时，Windows 会给子进程
 * **新分配一个控制台窗口** —— 界面上就是「一个黑窗一闪而过」。
 *
 * 2026-09-13 的真机缺陷正是这么来的：`hide::is_enabled()` 调 `reg query` 时漏了这个
 * flag，而它在 `fence_icons_visible` 里、那条命令又在围栏面板的 setup effect 里 ——
 * 于是**每次点围栏标题收起/展开都闪一个黑窗**。
 *
 * ── 为什么是「静态扫源码」而不是 e2e ──────────────────────────────────────
 *
 * 与 `e2e/fence-menu.spec.ts` 断言参数名同一条理由（见 `FenceContextMenu.tsx` 的
 * 那段注释）：**mock 只按命令名分发，Rust 那一侧的毛病在 e2e 里根本看不见。**
 * 一个进程标志位更是连 mock 都没有形状 —— 只能扫源码。
 *
 * 判据：`Command::new(...)` 那条**语句**里必须出现 `creation_flags`。
 * 唯一的例外是 `#[cfg(not(windows))]` 分支 —— 那里没有 Windows 控制台可谈。
 */

/**
 * 读 Rust 源码用 `import.meta.glob` 而不是 `node:fs`：本仓 tsconfig 只 `include: ["src"]`
 * 且没装 `@types/node`，`src/**` 下写 `node:fs` 会直接让 `npm run build` 的 `tsc` 挂掉
 * （2026-09-13 踩过：vitest 全绿、生产构建红）。`vite/client` 类型本仓已在
 * `src/vite-env.d.ts` 里引用，glob 也是 `src/plugins/index.ts` 的既有写法。
 */
const MODULES = import.meta.glob("/src-tauri/src/**/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as unknown as Record<string, string>;

/** 跳过字符串字面量（含 `r#"..."#` 原始串），免得里面的括号/分号搅乱配对。 */
function skipString(src: string, i: number): number {
  // 原始串：r"..." / r#"..."# / r##"..."##
  const raw = /^r(#*)"/.exec(src.slice(i, i + 8));
  if (raw) {
    const close = `"${raw[1]}`;
    const end = src.indexOf(close, i + raw[0].length);
    return end === -1 ? src.length : end + close.length;
  }
  if (src[i] !== '"') return i;
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === '"') return j + 1;
  }
  return src.length;
}

type Site = { file: string; line: number; statement: string; nonWindows: boolean };

/** 每个 `Command::new(` → 它所在的那条语句（扫到顶层 `;` 为止）。 */
function spawnSites(file: string, src: string): Site[] {
  const needle = "Command::new(";
  const sites: Site[] = [];
  let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) {
    const start = i;
    let depth = 0;
    let j = i + needle.length - 1; // 停在 `new(` 的 `(` 上
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === '"' || (ch === "r" && /^r(#*)"/.test(src.slice(j, j + 8)))) {
        j = skipString(src, j) - 1;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === ";" && depth <= 0) break;
    }
    const statement = src.slice(start, j);
    const upto = src.slice(0, start).split("\n");
    // 本行或上一行标了 cfg(not(windows)) → 这条分支上不存在 Windows 控制台。
    const prevLine = upto.length >= 2 ? upto[upto.length - 2] : "";
    const nonWindows = /cfg\(\s*not\(\s*windows\s*\)\s*\)/.test(upto[upto.length - 1] + prevLine);
    sites.push({ file, line: upto.length, statement, nonWindows });
    i = start + needle.length;
  }
  return sites;
}

const ALL = Object.entries(MODULES).flatMap(([f, src]) => spawnSites(f.replace(/^\//, ""), src));

describe("Rust 侧起子进程必须带 CREATE_NO_WINDOW", () => {
  it("扫得到全部 spawn 点（哨兵：防止 glob/遍历悄悄失效）", () => {
    // 数量不对就说明这个测试自己坏了，而不是源码干净了。
    expect(ALL.length).toBeGreaterThanOrEqual(8);
  });

  it("每个 Command::new 语句都设了 creation_flags", () => {
    const bad = ALL.filter((s) => !s.nonWindows && !s.statement.includes("creation_flags")).map(
      (s) => `${s.file}:${s.line}`
    );
    expect(
      bad,
      `这些 spawn 点没设 creation_flags —— Windows 会给子进程新分配一个控制台窗口，` +
        `界面上就是一个一闪而过的黑窗：\n  ${bad.join("\n  ")}`
    ).toEqual([]);
  });

  it("用了 0x08000000 这个值，不是别的", () => {
    for (const s of ALL) {
      if (!s.statement.includes("creation_flags")) continue;
      expect(s.statement, `${s.file}:${s.line}`).toMatch(
        /creation_flags\(\s*(CREATE_NO_WINDOW|0x08000000|0x0800_0000)/
      );
    }
  });
});
