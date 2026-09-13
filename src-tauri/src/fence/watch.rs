//! 真桌面的变化监听：目录一变就重扫，把最新的看板推给前端（spec §4.2 单一更新路径）。
//!
//! **为什么需要它**：切到真桌面当读源之后，桌面的变化来源全在 desk **外面** ——
//! 资源管理器里新建 / 删除 / 改名、别的程序往桌面丢文件、用户从别处拖进来。
//! 没有监听时看板只是**冷启动那一刻的快照**，实测症状（2026-09-13）：在资源管理器里
//! 新建文件夹，看板一直不出现，而当时全仓**没有任何**能救它的刷新入口 —— 唯二的
//! `fence_rescan` 调用点都跟在 `fence_restore` 后面，而它迁移完成后是空操作。
//!
//! 推送分**两拍**（见 `rescan_then_icons`）：先让「多了一项」立刻可见，再把图标补上。
//! 这是一个新文件夹第一次出现在看板上会依次经历的两件事。
//!
//! **这里刻意不做 `meta::prune`。** 计划原先把「真桌面删除 → `fence.json` 对应条目
//! 被清掉」挂在监听上，但本模块唯一能拿到的「还有哪些 key」来自 `scan_desktop()`，
//! 而它在 `read_dir` 失败时**静默返回空列表**。接上去的后果是：桌面一时读不到
//! （权限 / 被占用 / 网络盘重连）就把整份分类偏好清空 —— 那是 INV-4 明确禁止的
//! 「丢偏好」。删除引起的条目清理交给 Task 14 的 `fence_delete`：那里删的是谁
//! 是调用方自己刚做的，精确且不会误伤。

use super::{collect_fences, FenceDto};
use notify::{RecursiveMode, Watcher};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// 推送事件名。前端在 `bootstrap.ts` 桥到进程内总线，`useFences` 用 `ctx.on` 订阅。
pub(crate) const EVENT: &str = "fence:changed";

/// 静默窗口：一次文件操作会接连放出好几个 raw event（Create / Modify / Attrib…），
/// 收拢到「安静了这么久」再动手。250 ms 是「人感觉不到延迟」和「别扫三遍」的折中。
const QUIET: Duration = Duration::from_millis(250);

/// 静默窗口的封顶：持续写入（比如往桌面拷一个几 GB 的文件夹）会让静默窗口永远等不到。
/// 到点就扫一次，不等了。
const MAX_WAIT: Duration = Duration::from_secs(1);

/// 看板内容的**结构**指纹：`(围栏名, [项 id])`。
///
/// 只取结构、**不取图标** —— 图标是异步补的（第二拍），拿它进指纹会让
/// 「图标刚到」和「桌面真的变了」分不开，第二拍就永远被自己那道判据拦掉。
type Fingerprint = Vec<(String, Vec<String>)>;

fn fingerprint(fences: &[FenceDto]) -> Fingerprint {
    fences
        .iter()
        .map(|f| {
            (
                f.name.clone(),
                f.items.iter().map(|i| i.id.clone()).collect(),
            )
        })
        .collect()
}

/// 还没有图标缓存的桌面项 key。判据和 `index::ensure_icons` **完全一致**（就是「png 在不在」），
/// 免得出现「它认为要抽、我以为抽完了」这种两边打架。
/// 系统项（回收站 / 此电脑）不在这里 —— 它们不走这条抽取路径。
fn missing_icon_keys() -> HashSet<String> {
    super::scan_desktop()
        .unwrap_or_default()
        .into_iter()
        .filter(|it| {
            let p = super::index::icon_file(&it.key);
            p.as_os_str().is_empty() || !p.exists()
        })
        .map(|it| it.key)
        .collect()
}

/// 起监听。**失败不致命**：监听坏了看板退化成「只有冷启动那一次」，其余功能照常，
/// 所以调用方拿到 `Err` 只该 `eprintln!`，不该 panic / 退出。
pub(crate) fn start(app: AppHandle) -> Result<(), String> {
    let roots = super::paths::desktop_roots()?;
    if roots.is_empty() {
        return Err("没有可监听的桌面目录".into());
    }

    let (tx, rx) = mpsc::channel::<()>();

    // watcher 必须在整个进程寿命里活着 —— 一 drop 监听就停了。
    // 所以它们被 move 进下面那个线程，和接收循环同生共死。
    let mut watchers: Vec<notify::RecommendedWatcher> = Vec::new();
    for (origin, root) in &roots {
        let tx = tx.clone();
        let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Err(e) = res {
                // 单个事件报错（比如权限）不该把监听整个带走，记一笔继续。
                eprintln!("desk: watch event error: {e}");
                return;
            }
            // 收到什么事件、动的是谁都不重要 —— 看板是「重扫一遍」而不是「增量改」，
            // 所以这里只发一个「有动静」的信号，不搬运事件细节。
            let _ = tx.send(());
        })
        .map_err(|e| format!("建 watcher 失败：{e}"))?;

        // NonRecursive：围栏只看桌面**这一层**，子目录里翻天覆地不关看板的事。
        w.watch(root, RecursiveMode::NonRecursive)
            .map_err(|e| format!("监听 {origin} 桌面（{}）失败：{e}", root.display()))?;
        watchers.push(w);
    }

    let busy = Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || {
        // 只是为了让 watcher 活到线程结束。**不能写成 `let _ = watchers;`** ——
        // 那个形式会立刻 drop，监听当场停摆。
        let _keep_alive = watchers;
        let mut last: Option<Fingerprint> = None;
        while rx.recv().is_ok() {
            coalesce(&rx);
            rescan_then_icons(&app, &mut last, &busy);
        }
    });

    Ok(())
}

/// 收拢「静默 QUIET」或「总共等够 MAX_WAIT」之间的连串事件。返回即代表该动手了。
fn coalesce(rx: &mpsc::Receiver<()>) {
    let started = Instant::now();
    loop {
        let left = MAX_WAIT.saturating_sub(started.elapsed());
        if left.is_zero() {
            return;
        }
        match rx.recv_timeout(QUIET.min(left)) {
            Ok(()) => continue, // 还有动静，窗口顺延
            Err(RecvTimeoutError::Timeout) => return,
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// 第一拍：结构变了就推（用户马上看到「多了一项」，方块暂时空的）。
/// 第二拍：图标补齐后再推一次（方块换成真图标）。
fn rescan_then_icons(app: &AppHandle, last: &mut Option<Fingerprint>, busy: &Arc<AtomicBool>) {
    let fences = match collect_fences() {
        Ok(f) => f,
        Err(e) => {
            eprintln!("desk: watch rescan failed: {e}");
            return;
        }
    };

    let fp = fingerprint(&fences);
    if last.as_ref() != Some(&fp) {
        *last = Some(fp);
        emit(app, &fences);
    }

    // 已经有一个人在抽图标了就不叠线程 —— 叠起来会变成几十个 PowerShell 同时跑。
    // 不用担心漏：正在跑的那一轮收尾时会自己重新数一遍还缺哪些（见下面的循环），
    // 期间新冒出来的项会被它接走。**这比一个 pending 标志结实** ——
    // 标志在「判完 pending、还没清 busy」那一瞬间会丢唤醒，缺图标不会。
    if busy.swap(true, Ordering::SeqCst) {
        return;
    }

    let app = app.clone();
    let busy = busy.clone();
    std::thread::spawn(move || {
        let mut want = missing_icon_keys();
        while !want.is_empty() {
            super::refresh_icons_once();

            // 第二拍**刻意不看指纹**：按定义它就是「图标变了、结构没变」，
            // 拿 fingerprint 判据去挡，它永远过不去。
            if let Ok(f) = collect_fences() {
                emit(&app, &f);
            }

            let now = missing_icon_keys();
            if !want.iter().any(|k| !now.contains(k)) {
                break; // 这一轮一个都没补上（抽不出来，比如文件已删），别再空转
            }
            want = now;
        }
        busy.store(false, Ordering::SeqCst);
    });
}

fn emit(app: &AppHandle, fences: &[FenceDto]) {
    if let Err(e) = app.emit(EVENT, fences) {
        eprintln!("desk: emit {EVENT} failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fence::FenceItemDto;

    fn item(id: &str, icon: Option<&str>) -> FenceItemDto {
        FenceItemDto {
            id: id.into(),
            label: id.into(),
            path: format!(r"C:\Desktop\{id}"),
            icon: icon.map(|s| s.to_string()),
            // 指纹/图标这些测试不关心目录属性，一律当文件。
            is_dir: false,
        }
    }

    fn board(name: &str, items: Vec<FenceItemDto>) -> FenceDto {
        FenceDto {
            name: name.into(),
            items,
            // 显示偏好（2026-09-13）**刻意不进指纹**：指纹判的是「桌面内容变没变」，
            // 而收起/高度是纯前端偏好，改它不该触发一次重扫推送 —— 前端自己就改了。
            // 真被推了也不会错（`collect_fences` 每拍重读 `meta`），只是白跑一趟。
            collapsed: false,
            rows: 0,
        }
    }

    #[test]
    fn fingerprint_ignores_icon_arrival() {
        // 这正是第二拍的情形：id 一个没变，只是 `icon` 从 None 变成 Some。
        // 两者必须同指纹，否则「桌面真变了」和「图标刚补上」就分不开。
        let before = vec![board("工具", vec![item("user:a.lnk", None)])];
        let after = vec![board(
            "工具",
            vec![item("user:a.lnk", Some(r"C:\icons\a.png"))],
        )];
        assert_eq!(fingerprint(&before), fingerprint(&after));
    }

    #[test]
    fn fingerprint_sees_new_item() {
        let before = vec![board("工具", vec![item("user:a.lnk", None)])];
        let after = vec![board(
            "工具",
            vec![item("user:a.lnk", None), item("user:b.lnk", None)],
        )];
        assert_ne!(fingerprint(&before), fingerprint(&after));
    }

    #[test]
    fn fingerprint_sees_removed_item_and_reorder() {
        let two = vec![board(
            "工具",
            vec![item("user:a.lnk", None), item("user:b.lnk", None)],
        )];
        let one = vec![board("工具", vec![item("user:a.lnk", None)])];
        assert_ne!(fingerprint(&two), fingerprint(&one));

        let swapped = vec![board(
            "工具",
            vec![item("user:b.lnk", None), item("user:a.lnk", None)],
        )];
        assert_ne!(
            fingerprint(&two),
            fingerprint(&swapped),
            "拖拽排序要能推给前端，顺序也是结构的一部分"
        );
    }

    #[test]
    fn fingerprint_sees_fence_rename() {
        let a = vec![board("工具", vec![item("user:a.lnk", None)])];
        let b = vec![board("工作", vec![item("user:a.lnk", None)])];
        assert_ne!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn fingerprint_of_empty_board_is_empty() {
        assert!(fingerprint(&[]).is_empty());
    }
}
