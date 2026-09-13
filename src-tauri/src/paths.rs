//! desk 的本地数据目录。**唯一一份** —— 各域要往里放东西都从这里取。
//!
//! 原先 13 个调用点各自拼一遍 `dirs::data_local_dir().join("desk")`（形态还分裂成三种：
//! 建目录的、不建目录的、包一层 `desk_root()` 的）。收敛在这里之后，改目录名只改一处。

use std::path::PathBuf;

/// desk 的本地数据目录（`%LOCALAPPDATA%\desk`）。**顺手建出来**。
///
/// 只读一个标志文件的调用方也走这里，不再另开一条「不建目录」的路 —— 建它是幂等的，
/// 而「同一个东西两条路」是这一轮要消掉的病。代价认下来：一次纯查询也可能建一次目录。
pub(crate) fn app_data_dir() -> Result<PathBuf, String> {
    let dir = dirs::data_local_dir()
        .ok_or("no local app data")?
        .join("desk");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// ⚠️ 写成转义形式，是为了让**这个文件自己的源码**不含未转义的 `join("desk")` ——
    /// 否则扫描器扫到自己那行 `contains`，凭空多出一处命中（第一版就是这么炸的）。
    const NEEDLE: &str = "join(\"desk\")";

    fn collect(dir: &Path, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect(&p, out);
                continue;
            }
            if p.extension().and_then(|x| x.to_str()) != Some("rs") {
                continue;
            }
            let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
            // 真机测试的助手**刻意**独立拼一遍：生产的目录名一改，它就读不到文件、
            // 真机测试当场红。那是交叉守卫，不是这条要防的重复。
            if name == "real_machine.rs" {
                continue;
            }
            let text = std::fs::read_to_string(&p).unwrap_or_default();
            for (i, l) in text.lines().enumerate() {
                // 注释里也会出现这个片段（本文件的模块头就有一处），不算数。
                if l.trim_start().starts_with("//") {
                    continue;
                }
                if l.contains(NEEDLE) {
                    out.push(format!("{name}:{}", i + 1));
                }
            }
        }
    }

    /// `%LOCALAPPDATA%\desk` 的拼装**只许有一处**（本文件的 `app_data_dir`）。
    /// 收敛前它是 **13 处**（那个数字是数出来的，不是估的），形态还分裂成三种：
    /// 建目录的、不建目录的、包一层 `desk_root()` 的。
    ///
    /// 这条守卫让「第 14 处」不可能悄悄出现 —— 再写一份就会红。
    #[test]
    fn desk_data_dir_is_assembled_exactly_once() {
        let mut hits = Vec::new();
        collect(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut hits);
        // 只断「哪个文件、几处」，**不断行号** —— 行号写死的话，在本文件上方加一行注释
        // 就会让这条红，而红的理由跟「重复」毫无关系，报错还会骗人。
        assert_eq!(
            hits.len(),
            1,
            "`join(\"desk\")` 只该在 paths.rs 出现一次，实际命中：{hits:?}\n\
             要放 desk 的数据文件，用 `crate::paths::app_data_dir()`，不要自己拼。"
        );
        assert!(
            hits[0].starts_with("paths.rs:"),
            "唯一那处应当在 paths.rs，实际是 {}",
            hits[0]
        );
    }
}
