//! 构建脚本：除 `tauri_build::build()` 外，从 `src/lib.rs` 的 `generate_handler![...]`
//! 生成 `../src/generated/commands.ts`（前端与 e2e 测试替身靠它知道有哪些命令）。
//! 解析器在 `cmd_manifest.rs`，用 `include!` 引入而不是复制第二份。

include!("cmd_manifest.rs");

fn main() {
    tauri_build::build();

    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 未设置"));

    // 注册表一变就重跑。发出这条之后 cargo 不再默认「任何文件变动都重跑」，影响输出的输入都要列全。
    println!("cargo:rerun-if-changed=src/lib.rs");

    let names = parse_command_names(&lib_rs_path(&manifest_dir));
    let ts = render_ts(&names);

    let out = generated_path(&manifest_dir);
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|e| panic!("建 {} 失败：{e}", parent.display()));
    }

    // 内容相同就不写 —— 免得每次构建都刷新 mtime，让 vite / vitest 的 watch 无谓重跑。
    let unchanged = std::fs::read_to_string(&out).is_ok_and(|old| old == ts);
    if !unchanged {
        std::fs::write(&out, ts).unwrap_or_else(|e| panic!("写 {} 失败：{e}", out.display()));
        println!(
            "cargo:warning=已重新生成 {}（{} 条命令）",
            out.display(),
            names.len()
        );
    }
}
