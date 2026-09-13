//! 两个纯字符串启发式：一个认「别碰自己的快捷方式」，一个猜「这东西该归到哪一栏」。
//!
//! ⚠️ `guess_fence` 只是**兜底**（`meta` 里有记录就用记录）。它的关键词表是**硬编码的
//! 中文游戏名**，改动它等于改默认分类 —— 已存在于用户 `fence.json` 的记录与新装机器会分叉。

/// Installer / manual setup may drop `desk.lnk` on the desktop — never vault it.
pub(super) fn is_self_desk_shortcut(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "desk.lnk" || lower == "desk.url" || lower == "desk.lnk.lnk"
}

/// 猜一个围栏名。**只在 `meta` 没有记录时用**（见文件头）。
pub(super) fn guess_fence(name: &str) -> &'static str {
    let n = name.to_lowercase();
    let game_keys = [
        "counter-strike",
        "cs2",
        "dota",
        "terraria",
        "yugioh",
        "yu-gi-oh",
        "chess",
        "pvz",
        "穿越火线",
        "英雄联盟",
        "饥荒",
        "黎明杀机",
        "wegame",
        "1.91",
    ];
    if game_keys.iter().any(|k| n.contains(k)) {
        return "游戏";
    }
    let work_keys = ["飞书", "文献", "office", "excel", "word", "outlook"];
    if work_keys.iter().any(|k| n.contains(k)) {
        return "工作";
    }
    "工具"
}
