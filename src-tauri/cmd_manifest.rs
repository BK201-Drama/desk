// 「命令清单」的唯一解析器与渲染器。
//
// 这个文件用 `include!` 被引入 `build.rs`（以及 crate 内的测试）——
// 所以它**必须**用普通注释 `//` 而不是内层文档注释 `//!`：`include!` 把它拼进
// 一个 crate 根的中段，那个位置不允许 `//!`。
//
// 之所以是**独立文件**而不是 build.rs 里的一段：这样测试与构建脚本共享同一段源码。
// 复制出第二份解析器，正是本仓刚清理掉的那类缺陷（一个不变量写两遍，然后两份各自漂移）。
//
// 纯 `std`，不依赖任何 crate —— `build.rs` 与 lib 都要能编它。
//
// == 它解决什么 ==
//
// 命令名原先散在三处手写清单里，三处之间**没有任何校验**：
//   1. `src/lib.rs` 的 `generate_handler![...]`（真正生效的那份）
//   2. `src/host/api.ts` 的 `PERM_COMMANDS`（权限白名单）
//   3. `e2e/tauri-mock.js` 的 `case`（测试替身）
//
// 漏一处只有一个症状：**运行时**才炸（`permission denied` / mock 静默返回空），
// 而 `tsc` 与单测都看不见。现在 1 是唯一真相，2 由它生成的类型校验，3 与它对账。

use std::path::{Path, PathBuf};

/// 生成物的仓库相对位置（相对 `src-tauri/`）。
const GENERATED_REL: &str = "../src/generated/commands.ts";

pub fn generated_path(manifest_dir: &Path) -> PathBuf {
    manifest_dir.join(GENERATED_REL)
}

pub fn lib_rs_path(manifest_dir: &Path) -> PathBuf {
    manifest_dir.join("src").join("lib.rs")
}

/// 从 `lib.rs` 的 `generate_handler![...]` 解析出全部命令名，顺序与注册顺序一致。
///
/// **自校验**：块里每一条非空、非注释的行都必须产出一个合法标识符，产不出就 panic。
///
/// 这里刻意**不用**「数量 ≥ N」这类哨兵阈值。阈值两头都不对：
/// 解析被截断时 `1 >= 1` 照样通过（假阴性），正常删命令时又会误报（假阳性）。
/// 逐行问「这条为什么没产出名字」才是可判定的。
pub fn parse_command_names(lib_rs: &Path) -> Vec<String> {
    let text =
        std::fs::read_to_string(lib_rs).unwrap_or_else(|e| panic!("读不到 {}：{e}", lib_rs.display()));

    let mut it = text.lines().enumerate();

    // 1. 找到 `generate_handler![`
    let start = loop {
        match it.next() {
            Some((i, l)) if l.contains("generate_handler![") => break i,
            Some(_) => {}
            None => panic!(
                "{}：找不到 `generate_handler![`。\n\
                 命令清单是从那里解析出来的 —— 改了注册方式就必须同步改这个解析器，\
                 不能静默生成一份空清单。",
                lib_rs.display()
            ),
        }
    };

    // 2. 逐行扫到收尾的 `]`
    let mut names = Vec::new();
    for (i, raw) in it {
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with(']') {
            break;
        }
        let last = line.trim_end_matches(',').trim().rsplit("::").next().unwrap_or("");
        if !is_ident(last) {
            panic!(
                "{}:{}：解析不出命令名 —— 原文 {:?}\n\
                 块里每一条非注释行都必须是一个命令路径（`name` 或 `module::name`）。\n\
                 若这里新增了别的语法，请同步改这个解析器，**不要**静默跳过。",
                lib_rs.display(),
                i + 1,
                raw.trim()
            );
        }
        names.push(last.to_string());
    }

    assert!(
        !names.is_empty(),
        "{}：解析到 0 个命令（块没闭合？解析器坏了？）—— 拒绝生成空清单。\
         首个匹配行在第 {} 行。",
        lib_rs.display(),
        start + 1
    );
    names
}

/// 去掉 `//` 起的内容。清单里没有字符串字面量，所以不必考虑 `//` 出现在串内。
fn strip_comment(line: &str) -> &str {
    match line.find("//") {
        Some(i) => &line[..i],
        None => line,
    }
}

fn is_ident(s: &str) -> bool {
    !s.is_empty()
        && !s.chars().next().is_some_and(|c| c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 渲染 `commands.ts` 全文。**纯函数**：同样的输入必然同样的字节。
pub fn render_ts(names: &[String]) -> String {
    let mut s = String::new();
    s.push_str(
        "/**\n\
         \x20* ⚠️ **生成物 —— 不要手改。**\n\
         \x20*\n\
         \x20* 由 `src-tauri/build.rs` 从 `src-tauri/src/lib.rs` 的 `generate_handler![...]`\n\
         \x20* 解析而来（解析器在 `src-tauri/cmd_manifest.rs`）。手改会在下一次 cargo 构建时\n\
         \x20* 被原样覆盖。\n\
         \x20*\n\
         \x20* ## 为什么要有这个文件\n\
         \x20*\n\
         \x20* 命令名原先散在三处手写清单里 —— Rust 的注册表、`src/host/api.ts` 的\n\
         \x20* `PERM_COMMANDS`、`e2e/tauri-mock.js` 的 `case` —— 三者之间没有任何校验，\n\
         \x20* 漏一处只在**运行时**才炸（`permission denied` / mock 静默返回空）。\n\
         \x20*\n\
         \x20* 现在注册表是唯一真相：拼错命令名在这里是 `tsc` 错误，不是线上故障。\n\
         \x20*/\n\n",
    );
    s.push_str("export const COMMANDS = [\n");
    for n in names {
        s.push_str(&format!("  \"{n}\",\n"));
    }
    s.push_str("] as const;\n\n");
    s.push_str("export type CommandName = (typeof COMMANDS)[number];\n");
    s
}
