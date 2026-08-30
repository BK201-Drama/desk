//! 本机内存 / CPU + 按进程名合并的应用占用
use serde::Serialize;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::{ProcessesToUpdate, System};

#[derive(Debug, Clone, Serialize)]
pub struct SysResAppDto {
    pub name: String,
    pub mem_bytes: u64,
    pub cpu_pct: f32,
    pub process_count: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SysResSnapshotDto {
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
    pub cpu_pct: f32,
    pub apps: Vec<SysResAppDto>,
    pub fetched_at: u64,
}

#[derive(Debug, Clone)]
struct ProcRow {
    name: String,
    mem_bytes: u64,
    cpu_pct: f32,
}

fn display_name(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return "unknown".into();
    }
    // Windows: chrome.exe → chrome
    t.strip_suffix(".exe")
        .or_else(|| t.strip_suffix(".EXE"))
        .unwrap_or(t)
        .to_string()
}

fn aggregate_apps(rows: &[ProcRow]) -> Vec<SysResAppDto> {
    let mut map: HashMap<String, SysResAppDto> = HashMap::new();
    for r in rows {
        let e = map.entry(r.name.clone()).or_insert(SysResAppDto {
            name: r.name.clone(),
            mem_bytes: 0,
            cpu_pct: 0.0,
            process_count: 0,
        });
        e.mem_bytes = e.mem_bytes.saturating_add(r.mem_bytes);
        e.cpu_pct += r.cpu_pct;
        e.process_count += 1;
    }
    let mut apps: Vec<_> = map.into_values().collect();
    apps.sort_by(|a, b| b.mem_bytes.cmp(&a.mem_bytes));
    apps
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn take_snapshot() -> SysResSnapshotDto {
    let mut sys = System::new();
    sys.refresh_memory();
    // 双采样：CPU% 需要间隔
    sys.refresh_cpu_all();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    std::thread::sleep(std::time::Duration::from_millis(200));
    sys.refresh_cpu_all();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut rows = Vec::new();
    for (_pid, proc_) in sys.processes() {
        let name = display_name(&proc_.name().to_string_lossy());
        rows.push(ProcRow {
            name,
            mem_bytes: proc_.memory(),
            cpu_pct: proc_.cpu_usage(),
        });
    }
    let apps = aggregate_apps(&rows);

    SysResSnapshotDto {
        mem_used_bytes: sys.used_memory(),
        mem_total_bytes: sys.total_memory(),
        cpu_pct: sys.global_cpu_usage(),
        apps,
        fetched_at: now_secs(),
    }
}

#[tauri::command]
pub async fn sys_res_snapshot() -> Result<SysResSnapshotDto, String> {
    tauri::async_runtime::spawn_blocking(take_snapshot)
        .await
        .map_err(|e| format!("sys_res join: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_sums_same_name() {
        let rows = vec![
            ProcRow {
                name: "chrome".into(),
                mem_bytes: 100,
                cpu_pct: 1.0,
            },
            ProcRow {
                name: "chrome".into(),
                mem_bytes: 50,
                cpu_pct: 2.5,
            },
            ProcRow {
                name: "code".into(),
                mem_bytes: 200,
                cpu_pct: 0.5,
            },
        ];
        let apps = aggregate_apps(&rows);
        let chrome = apps.iter().find(|a| a.name == "chrome").unwrap();
        assert_eq!(chrome.mem_bytes, 150);
        assert!((chrome.cpu_pct - 3.5).abs() < 0.01);
        assert_eq!(chrome.process_count, 2);
        assert_eq!(apps[0].name, "code"); // sorted by mem
    }

    #[test]
    fn display_name_strips_exe() {
        assert_eq!(display_name("chrome.exe"), "chrome");
        assert_eq!(display_name("  "), "unknown");
    }
}
