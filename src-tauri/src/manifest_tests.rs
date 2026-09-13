//! 命令清单解析器的测试。
//!
//! 测的不是「生成的清单对不对」（那个由 `build.rs` 每次构建自动保证），
//! 而是**解析器的自校验真的会响** —— 一道护栏如果永远不会红，它就不是护栏。
//! 全部用临时文件喂合成输入，不碰真实的 `lib.rs`。

// `include!` 已带入 `use std::path::{Path, PathBuf};`，这里不要再重复导入。
include!("../cmd_manifest.rs");

/// 写一个临时文件，返回路径。文件名带进程号 + 计数器，避免并行测试互踩。
fn tmp(name: &str) -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let p = std::env::temp_dir().join(format!(
        "desk-manifest-{}-{}-{}.rs",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed),
        name
    ));
    std::fs::write(&p, "").expect("建临时文件失败");
    p
}

fn parse_source(src: &str) -> Vec<String> {
    let p = tmp("case");
    std::fs::write(&p, src).expect("写临时文件失败");
    let r = parse_command_names(&p);
    let _ = std::fs::remove_file(&p);
    r
}

const OK_BLOCK: &str = r#"
fn f() {
    .invoke_handler(tauri::generate_handler![
        set_cursor,
        // 一条注释，不该产出名字
        fence::fence_list,
        fence::ops::fence_create,   // 行尾注释

        autostart_get,
    ])
}
"#;

#[test]
fn takes_last_path_segment_in_order() {
    assert_eq!(
        parse_source(OK_BLOCK),
        vec![
            "set_cursor".to_string(),
            "fence_list".to_string(),
            "fence_create".to_string(),
            "autostart_get".to_string(),
        ],
        "顺序必须与注册顺序一致（注释行与空行不产出），且取 `::` 最后一段"
    );
}

#[test]
fn trailing_comma_and_no_comma_both_ok() {
    assert_eq!(
        parse_source("generate_handler![\n  a,\n  b\n]\n"),
        vec!["a".to_string(), "b".to_string()]
    );
}

#[test]
#[should_panic(expected = "解析不出命令名")]
fn panics_on_unparseable_entry_instead_of_silently_skipping() {
    // 这条是本次的核心：块里出现解析不了的行必须**炸**，不能静默漏掉一条命令。
    // （旧版前端护栏的同类问题正是「扫不到就放行」。）
    parse_source("generate_handler![\n  set_cursor,\n  \"string-literal-command\",\n]\n");
}

#[test]
#[should_panic(expected = "解析不出命令名")]
fn panics_on_a_nested_call_rather_than_dropping_it() {
    parse_source("generate_handler![\n  set_cursor,\n  wrap!(other),\n]\n");
}

#[test]
#[should_panic(expected = "找不到 `generate_handler![`")]
fn panics_when_registration_is_gone() {
    parse_source("fn main() {}\n");
}

#[test]
#[should_panic(expected = "解析到 0 个命令")]
fn panics_on_empty_block() {
    parse_source("generate_handler![\n]\n");
}

#[test]
fn generated_file_on_disk_matches_the_registry() {
    // 这条**会**被 build.rs 先修好（cargo 构建脚本跑在测试之前），所以它证明不了
    // 「没有陈旧」—— 它的价值是另一个：确认生成物确实存在于源码树里、
    // 且条数与注册表一致（防住「被 .gitignore 掉」或「构建脚本静默跳过」）。
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let want = parse_command_names(&lib_rs_path(&manifest_dir));
    let out = generated_path(&manifest_dir);

    let got = std::fs::read_to_string(&out)
        .unwrap_or_else(|e| panic!("读不到 {}：{e}\n它应当随仓库入库。", out.display()));

    assert_eq!(
        got,
        render_ts(&want),
        "{} 的内容与 lib.rs 的 generate_handler! 不一致",
        out.display()
    );
}
