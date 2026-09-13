//! Windows「显示桌面图标」全局开关（HKCU\...\Explorer\Advanced\HideIcons）的生命周期管理。
//! 这是新版围栏唯一还碰系统的地方 —— 所有写入都收敛在本文件内。

use std::path::{Path, PathBuf};

const REG_PATH: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";

/// 从 `reg query` 的输出里取出 HideIcons 的值。
/// 只认行首第一个 token 恰好是 `HideIcons` 的行 —— 同一 key 下还有 HideFileExt 等 DWORD。
fn parse_hide_icons(stdout: &str) -> Option<bool> {
    for line in stdout.lines() {
        let mut it = line.split_whitespace();
        if it.next() != Some("HideIcons") {
            continue;
        }
        let Some(_ty) = it.next() else { continue }; // REG_DWORD
        let Some(raw) = it.next() else { continue };
        let n = match raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
            Some(hex) => i64::from_str_radix(hex, 16).ok(),
            None => raw.parse::<i64>().ok(),
        };
        let Some(n) = n else { continue };
        return Some(n != 0);
    }
    None
}

/// Hide all desktop icons (including Recycle Bin / This PC shell icons).
pub(crate) fn set_desktop_icons_hidden(hidden: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let value = if hidden { "1" } else { "0" };
        let status = crate::proc::command("reg")
            .args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced",
                "/v",
                "HideIcons",
                "/t",
                "REG_DWORD",
                "/d",
                value,
                "/f",
            ])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("reg HideIcons failed".into());
        }
        // refresh desktop icons
        let _ = crate::proc::command("ie4uinit.exe")
            .arg("-show")
            .status();
        let _ = crate::proc::command("Rundll32.exe")
            .args(["user32.dll,UpdatePerUserSystemParameters"])
            .status();
        // Force explorer to re-read Advanced\HideIcons
        let _ = crate::proc::command("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(New-Object -ComObject Shell.Application).ToggleDesktop(); Start-Sleep -Milliseconds 200; (New-Object -ComObject Shell.Application).ToggleDesktop()",
            ])
            .status();
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = hidden;
        Err("Windows only".into())
    }
}

/// 当前 HideIcons 的值。`None` 表示该值在注册表里不存在（等价于未隐藏）。
///
/// ⚠️ desk 是 **GUI 子系统**（`main.rs` 的 `windows_subsystem = "windows"`，
/// 实测 PE Subsystem=2），**自己没有控制台可继承**，而 `reg.exe` 是**控制台程序** ——
/// 父进程不带 `CREATE_NO_WINDOW` 时，Windows 会给它**新分配一个控制台窗口**，
/// 界面上就是一个「黑窗一闪而过」。
///
/// 2026-09-13 的真机缺陷就是漏在这里：这条命令经 `fence_icons_visible`
/// （`mod.rs`）挂在围栏面板的 setup effect 里，于是**每次点围栏标题收起/展开都闪一次**。
/// 这个 flag 现在由 `crate::proc` 统一设置 —— 本文件不再自己带，也就不可能再漏。
/// 平台实现分**两处**写（`#[cfg]` 落在函数上）：这样 cfg 表达的是
/// 「两个平台各有实现」，而不是「这里有个空标记」——后者读起来像是漏了代码，
/// 前者读起来就是全部事实。行为与合并写法一字不差。
#[cfg(windows)]
pub(crate) fn is_enabled() -> Result<Option<bool>, String> {
    let out = crate::proc::command("reg")
        .args(["query", REG_PATH, "/v", "HideIcons"])
        .output()
        .map_err(|e| format!("reg query 启动失败：{e}"))?;
    if !out.status.success() {
        return Ok(None);
    }
    Ok(parse_hide_icons(&String::from_utf8_lossy(&out.stdout)))
}

/// 非 Windows 上没有 `HideIcons` 这个值 —— 语义上等价于「从没隐藏过」。
#[cfg(not(windows))]
pub(crate) fn is_enabled() -> Result<Option<bool>, String> {
    Ok(None)
}

pub(crate) fn enable() -> Result<(), String> {
    set_desktop_icons_hidden(true)
}

pub(crate) fn disable() -> Result<(), String> {
    set_desktop_icons_hidden(false)
}

// ── 逃生口的持久化标志 ──────────────────────────────────────────────────────
// spec §6.2 第 3 条：不依赖 desk 进程健康、不依赖注册表状态，只要用户能看见看板
// 就能一键把桌面图标要回来。标志文件存在 = 用户明确要求「显示桌面图标」。
//
// 用独立文件而不是 fence.json，是为了让本功能独立于 Task 6 的 meta v2 上线。
//
// 读写拆成「纯函数收路径」+「薄封装解析真路径」两层：下面两个纯函数能拿临时目录
// 单测，**不会去碰真实的 %LOCALAPPDATA%\desk\icons-visible** ——
// 单测里误建那个文件会让 desk 以为用户要求显示图标，是个很隐蔽的副作用。

fn flag_exists_at(p: &Path) -> bool {
    p.exists()
}

fn set_flag_at(p: &Path, v: bool) -> Result<(), String> {
    if v {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(p, b"1").map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(p) {
            Ok(()) => Ok(()),
            // 不存在 = 已经是目标状态，不算错
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

fn visible_flag_path() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("no local app data")?;
    Ok(base.join("desk").join("icons-visible"))
}

/// 用户是否明确要求「显示桌面图标」。
/// 读不到路径 / 文件不存在都算「没要求」—— 逃生口的默认值是「不干预」。
pub(crate) fn user_wants_visible() -> bool {
    visible_flag_path().map(|p| flag_exists_at(&p)).unwrap_or(false)
}

pub(crate) fn set_user_wants_visible(v: bool) -> Result<(), String> {
    set_flag_at(&visible_flag_path()?, v)
}

// ── 优先级：三个来源 → 一个结论 ────────────────────────────────────────────
//
// 改这一段之前先读这里，别再往调用点加判断。
//
// 以前「谁说了算」只活在 `recover_orphan_hidden_state` 里几个 `if` 的**先后顺序**
// 加一段注释里：新加一个读取者（或把两个 `if` 调个位置）就能把优先级弄反，
// 而且没有任何测试会响。现在它是一个**值**，读它的人只能拿到结论。

/// 「桌面图标该不该隐藏」的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HideIntent {
    /// 用户按过逃生开关。**优先级最高**：注册表里的 1 和 `owned` 都盖不过它。
    UserWantsVisible,
    /// 没有人认领这个状态 → 该隐藏；若注册表里已经有 `HideIcons=1`，那是残留，该清。
    Unclaimed,
    /// `fence.json` 的 `hide.owned` 记着「这个 1 是我们收的」→ 别动它。
    OwnedByUs,
}

impl HideIntent {
    /// 结论允许 desk 去隐藏（或维持隐藏）桌面图标吗？
    pub(crate) fn allows_hiding(self) -> bool {
        !matches!(self, HideIntent::UserWantsVisible)
    }
}

/// 三个持久化来源 → 一个结论。**hide 状态优先级的唯一出处。**
///
/// 优先级（spec §6.2 第 3 条）：
///   1. 标志文件 `%LOCALAPPDATA%\desk\icons-visible`（`flag`）—— **恒赢**。
///      它是逃生口的唯一权威：不依赖 desk 进程健康、不依赖注册表、不依赖
///      `fence.json`。所以 `owned` 哪怕是过期的 true 也压不过它 —— 压得过的话，
///      用户按了开关但图标仍被收着，逃生口就失效了。
///   2. `fence.json` 的 `hide.owned`（`owned`）—— 没有用户意愿时才算数。
///   3. 注册表当前值 —— **不是参数**。它是「现在到底隐藏着没有」这个**事实**，
///      不是「谁说了算」。唯一的读取者 `recover_orphan_hidden_state` 先确认它是 1
///      （没有 1 就没有可恢复的东西 —— 那是**前置条件**，不是优先级的一档），
///      再来问这里。把它做成参数会把一次 `reg` 子进程塞回归结路径。
///
/// 输入空间就是 `flag × owned` 这 4 种，`classify_covers_all_inputs` 逐条钉着。
pub(crate) fn classify(flag: bool, owned: bool) -> HideIntent {
    if flag {
        HideIntent::UserWantsVisible
    } else if owned {
        HideIntent::OwnedByUs
    } else {
        HideIntent::Unclaimed
    }
}

/// 「现在允许隐藏吗？」—— 冷启动路径的窄问法，**只读标志文件**。
///
/// 不给它读 `owned`：两个调用点（`hide_desktop_icons_on_start` 和它 spawn 的线程）
/// 都在首屏路径上，而 `allows_hiding()` 只对 `UserWantsVisible` 返回 false ——
/// 多读一次 `fence.json` 不改变结论。参数凑齐了却不影响结论，就是下一个要拆的层。
pub(crate) fn may_hide() -> bool {
    flag_allows_hiding(user_wants_visible())
}

/// `may_hide` 的纯核心（可单测，不碰真实标志文件）。
fn flag_allows_hiding(flag: bool) -> bool {
    classify(flag, false).allows_hiding()
}

/// 逃生开关：把「用户要 visible 吗」这一个选择**同时**写到三个来源上。
///
/// 三处必须一起变，缺一个用户的选择就会跟别的机制打架：
///   - 注册表 `HideIcons`：立刻兑现。
///   - 标志文件 `icons-visible`：让 `fence_list` 的启动隐藏路径（`may_hide`）
///     不再去动 `HideIcons`。**这个文件是逃生口的唯一权威** —— 必须独立于 desk
///     进程健康与注册表状态而存在（spec §6.2 第 3 条），所以哪怕 `fence.json`
///     坏了也不影响它被读到。
///   - `fence.json` 的 `hide.owned`：让启动时的孤儿自检知道这个 `HideIcons` 有主。
///     只置位不清除的话，「visible=true 但 owned 仍是 true」这条过期记录会把孤儿
///     自检的判据带偏（v1 里这是 `vault.json` 的 `hide_icons_applied`，Task 12 随
///     vault 读路径搬到了 `meta::HideState`）。
///
/// 写入端放在这个文件里，是为了和 `classify` 的读取端**同处一室**：三个来源的
/// 写法和读法改一个就能看见另一个。顺序沿用原样（注册表 → 标志 → 记账）。
pub(crate) fn apply_user_choice(visible: bool) -> Result<(), String> {
    if visible {
        disable()?;
    } else {
        enable()?;
    }
    set_user_wants_visible(visible)?;

    let mut m = crate::fence::meta::load()?;
    if m.hide.owned != !visible {
        m.hide.owned = !visible;
        crate::fence::meta::save(&m)?;
    }
    Ok(())
}

/// INV-3 兜底：注册表里是 1，但本地没有任何认领它的接管记录 → 说明上次异常退出
/// 且状态已无人负责。主动置 0，宁可少隐藏一次，也不让系统停在无人认领的改造状态。
///
/// 返回 true 表示执行了恢复。
pub(crate) fn recover_orphan_hidden_state() -> Result<bool, String> {
    // 前置条件：注册表里没有 1，就没有「可恢复的东西」。这不是优先级的一档 ——
    // 优先级（用户意愿 vs 认领记录）全部在 `classify` 里。
    if is_enabled()? != Some(true) {
        return Ok(false);
    }
    // 读不到 fence.json（不存在 / 坏了）按「没有认领」处理，和 v1 的 `if let Ok` 一致。
    let owned = crate::fence::meta::load()
        .map(|m| m.hide.owned)
        .unwrap_or(false);

    match classify(user_wants_visible(), owned) {
        // 用户明确按过「显示桌面图标」→ 这个 1 一定是残留，不用再看别的证据。
        // 没有认领记录 → 也是残留。两种都是「这个 1 不是我们要的」，清掉。
        HideIntent::UserWantsVisible | HideIntent::Unclaimed => {
            disable()?;
            Ok(true)
        }
        // 「这个 1 是我收的」→ 有主人，不动。
        HideIntent::OwnedByUs => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::{flag_exists_at, parse_hide_icons, set_flag_at};

    // ── 优先级（#4）────────────────────────────────────────────────────────
    // 这 4 条以前都不存在：优先级只活在一个 `if` 的先后顺序加一段注释里，
    // 把两个 `if` 调个位置没有任何测试会红。现在调换 → 这里必红。

    /// 输入空间就是 `flag × owned` 这 4 种（`reg` 不是参数，见 `classify` 的注释）。
    #[test]
    fn classify_covers_all_inputs() {
        use super::{classify, HideIntent::*};
        assert_eq!(classify(true, true), UserWantsVisible);
        assert_eq!(classify(true, false), UserWantsVisible);
        assert_eq!(classify(false, true), OwnedByUs);
        assert_eq!(classify(false, false), Unclaimed);
    }

    /// **标志文件优先** —— 这条以前只是一段注释。
    /// `owned` 是过期的 true 时（用户按过逃生口、但认领记录没清掉）也必须让位，
    /// 否则用户按了「显示桌面图标」图标仍被收着，逃生口就是失效的。
    #[test]
    fn flag_beats_ownership() {
        use super::{classify, HideIntent};
        for owned in [true, false] {
            assert_eq!(
                classify(true, owned),
                HideIntent::UserWantsVisible,
                "标志文件在时必须压过 owned={owned}"
            );
        }
    }

    /// `may_hide()` 那条窄路径（只看标志）不许和完整 `classify` 的结论漂移 ——
    /// 两个入口读的是同一份状态，任何 `owned` 取值下必须给出同一个「能不能隐藏」。
    #[test]
    fn narrow_path_matches_full_classify() {
        use super::{classify, flag_allows_hiding};
        for flag in [true, false] {
            for owned in [true, false] {
                assert_eq!(
                    flag_allows_hiding(flag),
                    classify(flag, owned).allows_hiding(),
                    "flag={flag} owned={owned} 时两个入口结论不一致"
                );
            }
        }
    }

    /// `apply_user_choice` 写完之后的 flag/owned 必须落在同一个「有主」结论上：
    /// visible=true → UserWantsVisible；visible=false → OwnedByUs。
    /// 落到 `Unclaimed` 就说明某个来源没跟上——那正是「同一条状态两个真相源」的起点。
    #[test]
    fn user_choice_lands_in_a_claimed_state() {
        use super::{classify, HideIntent};
        for visible in [true, false] {
            let after = classify(visible, !visible);
            assert_ne!(
                after,
                HideIntent::Unclaimed,
                "visible={visible} 写完之后不该是无人认领态"
            );
            assert_eq!(after.allows_hiding(), !visible);
        }
    }

    // ── 注册表输出的解析 ───────────────────────────────────────────────────

    #[test]
    fn parse_empty_is_none() {
        assert_eq!(parse_hide_icons(""), None);
    }

    #[test]
    fn parse_enabled() {
        let out = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced\r\n    HideIcons    REG_DWORD    0x1\r\n";
        assert_eq!(parse_hide_icons(out), Some(true));
    }

    #[test]
    fn parse_disabled() {
        let out = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced\r\n    HideIcons    REG_DWORD    0x0\r\n";
        assert_eq!(parse_hide_icons(out), Some(false));
    }

    #[test]
    fn parse_ignores_other_dword() {
        // 同一个 key 下还有别的 DWORD；必须只认 HideIcons 这一行
        let out = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced\r\n    HideFileExt    REG_DWORD    0x1\r\n";
        assert_eq!(parse_hide_icons(out), None);
    }

    /// 逃生口标志的读写契约。全程只碰临时目录，不碰真实的 icons-visible。
    #[test]
    fn flag_round_trip() {
        let dir = std::env::temp_dir().join(format!("desk-flag-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = dir.join("nested").join("icons-visible");

        // 缺省 = 没要求（连父目录都不存在时也必须安全返回 false）
        assert!(!flag_exists_at(&p));
        // 置位要顺手建父目录，否则首次点击会失败
        set_flag_at(&p, true).expect("set true");
        assert!(flag_exists_at(&p));
        set_flag_at(&p, false).expect("set false");
        assert!(!flag_exists_at(&p));
        // 幂等：重复清一个不存在的标志不算错（卸载/重复点击都会走到）
        set_flag_at(&p, false).expect("clear twice");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
