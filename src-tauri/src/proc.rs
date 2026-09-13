//! 全仓**唯一**允许起子进程的地方。
//!
//! ── 为什么要有这个模块 ────────────────────────────────────────────────────
//!
//! desk 是 **GUI 子系统**（`main.rs` 的 `windows_subsystem = "windows"`）
//! 而 `reg.exe` / `powershell.exe` / `cmd.exe` / `tasklist.exe` 全是**控制台程序**。
//! 父进程不带 `CREATE_NO_WINDOW`（`0x08000000`）时，Windows 会给子进程
//! **新分配一个控制台窗口** —— 界面上就是「一个黑窗一闪而过」。
//!
//! 2026-09-13 的真机缺陷正是这么来的：`fence::hide::is_enabled()` 漏了这个 flag,
//! 而它挂在围栏面板的 setup effect 里,于是**每次点围栏标题收起/展开都闪一次**。
//!
//! 修那一处只用了 1 行。但当时全仓已经在 **11 个地方**重复声明/硬编码同一个常量,
//! 于是「补上漏掉的那一处」并没有消除**漏掉的可能性** —— 只消除了这一次。
//! 加一层静态护栏能拦住下一次,但那是拿一个机制去补一个结构问题;
//! 而且那种护栏会盯着 `Command::new(...)` 这条语句的字面形状,
//! 反而会**惩罚**「抽一个公共 helper」这个正确做法。
//!
//! 所以这里换个方向:**让漏掉这件事在结构上不可表示**。
//! 起进程只有 `command` / `detached` 两条路,flag 在模块内部一次设好,
//! 调用点无从遗漏,调用点也就无从重复。

use std::process::Command;

/// 不为子进程分配控制台窗口 —— 这条不是可有可无的美化,见本模块顶部。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
/// 子进程不继承父进程的控制台,也不随父进程退出而退出。
#[cfg(windows)]
const DETACHED: u32 = 0x00000008;

/// 起一个子进程。**这是本仓起进程的正常入口** —— 直接 `Command::new` 会漏 flag。
pub(crate) fn command(program: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new(program);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

/// 起一个**脱离** desk 生命周期的子进程,同样不弹窗。
/// 目前只有 `qqmusic://` 协议唤起用它 —— 那个进程要活过 desk 自己。
pub(crate) fn detached(program: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new(program);
        c.creation_flags(CREATE_NO_WINDOW | DETACHED);
        c
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                rs_files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }

    /// 「起子进程」只能发生在本模块。
    ///
    /// 这条断言**不规定本模块内部怎么写** —— 加 helper、改签名、换写法都不会让它红。
    /// 它只管边界:出了 `proc.rs` 就不该有第二个 spawn 入口。
    /// （上一版护栏长在前端测试里、盯的是 `Command::new` 那条语句的字面形状,
    /// 于是「抽一个公共 helper」这个正确重构反而会让它红 —— 那层护栏本身就是腐蚀。）
    ///
    /// 它是个**廉价的绊线**,不是证明:注释里提到 `Command::new(` 会误报
    /// （读起来很直白,改个措辞即可),`use std::process::Command as C` 这类改名会漏报。
    /// 真正的保障是「本模块只有两条 spawn 路径」这个结构本身。
    #[test]
    fn only_this_module_spawns_processes() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rs_files(&src, &mut files);
        // 哨兵:遍历器自己坏掉时(读不到目录 / 认不出扩展名)不能伪装成「源码干净了」。
        assert!(
            files.len() >= 10,
            "只遍历到 {} 个 .rs 文件,遍历器坏了 —— 这条断言已经失去意义",
            files.len()
        );

        let mut offenders = Vec::new();
        for f in &files {
            if f.file_name().is_some_and(|n| n == "proc.rs") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(f) else {
                continue;
            };
            for (i, line) in text.lines().enumerate() {
                if line.contains("Command::new(") {
                    offenders.push(format!("{}:{}", f.display(), i + 1));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "这些地方绕过了 proc —— Windows 会给子进程新分配一个控制台窗口,\
             界面上就是一个一闪而过的黑窗。请改用 crate::proc::command / proc::detached:\n  {}",
            offenders.join("\n  ")
        );
    }
}
