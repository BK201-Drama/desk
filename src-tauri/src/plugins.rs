use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub slot: String,
    pub entry: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub order: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPluginInfo {
    pub id: String,
    pub dir: String,
    pub manifest_path: String,
    pub entry_path: String,
    pub css_path: Option<String>,
    pub manifest: PluginManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutScheme {
    pub id: String,
    pub name: String,
    pub disabled: Vec<String>,
    #[serde(default)]
    pub order: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginsConfig {
    #[serde(default = "default_preset")]
    pub active_preset: String,
    #[serde(default)]
    pub active_scheme_id: Option<String>,
    #[serde(default = "default_disabled")]
    pub disabled: Vec<String>,
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub schemes: Vec<LayoutScheme>,
    /// legacy — migrated into `schemes`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_disabled: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_name: Option<String>,
}

const MAX_SCHEMES: usize = 3;

fn default_preset() -> String {
    "coder".into()
}

fn default_disabled() -> Vec<String> {
    coder_disabled()
}

fn coder_disabled() -> Vec<String> {
    // Standalone clock stays off: GitHub panel already has the tuned clock+wall row.
    vec![
        "clock".into(),
        "hello".into(),
        "ops-hud".into(),
        "event-tape".into(),
        "qq-music".into(),
        "stock".into(),
    ]
}

fn minimal_disabled() -> Vec<String> {
    vec![
        "github".into(),
        "token-capsule".into(),
        "multica".into(),
        "remind".into(),
        "hello".into(),
        "ops-hud".into(),
        "event-tape".into(),
        "qq-music".into(),
        "stock".into(),
    ]
}

fn fence_only_disabled() -> Vec<String> {
    vec![
        "clock".into(),
        "github".into(),
        "token-capsule".into(),
        "multica".into(),
        "remind".into(),
        "hello".into(),
        "ops-hud".into(),
        "event-tape".into(),
        "qq-music".into(),
        "stock".into(),
    ]
}

fn preset_disabled(id: &str, _cfg: &PluginsConfig) -> Option<Vec<String>> {
    match id {
        "coder" => Some(coder_disabled()),
        "minimal" => Some(minimal_disabled()),
        "fence" => Some(fence_only_disabled()),
        _ => None,
    }
}

fn new_scheme_id() -> String {
    format!(
        "s{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    )
}

fn default_scheme_name(count: usize) -> String {
    format!("方案 {}", count + 1)
}

fn find_scheme<'a>(cfg: &'a PluginsConfig, id: &str) -> Option<&'a LayoutScheme> {
    cfg.schemes.iter().find(|s| s.id == id)
}

fn find_scheme_mut<'a>(cfg: &'a mut PluginsConfig, id: &str) -> Option<&'a mut LayoutScheme> {
    cfg.schemes.iter_mut().find(|s| s.id == id)
}

fn active_scheme_snapshot(cfg: &PluginsConfig) -> Option<(Vec<String>, Vec<String>)> {
    let id = cfg.active_scheme_id.as_ref()?;
    let s = find_scheme(cfg, id)?;
    Some((s.disabled.clone(), s.order.clone()))
}

fn has_scheme_draft(cfg: &PluginsConfig) -> bool {
    if cfg.active_preset != "scheme" {
        return false;
    }
    match active_scheme_snapshot(cfg) {
        Some((d, o)) => cfg.disabled != d || cfg.order != o,
        None => true,
    }
}

fn mark_scheme_draft(cfg: &mut PluginsConfig) {
    if cfg.active_preset != "scheme" {
        cfg.active_scheme_id = None;
    }
    cfg.active_preset = "scheme".into();
}

fn apply_coder_defaults(cfg: &mut PluginsConfig) {
    cfg.active_preset = "coder".into();
    cfg.active_scheme_id = None;
    cfg.disabled = coder_disabled();
    cfg.order.clear();
}

fn migrate_config(cfg: &mut PluginsConfig) {
    if cfg.schemes.is_empty() {
        if let Some(d) = cfg.custom_disabled.take() {
            let name = cfg
                .custom_name
                .take()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "方案 1".into());
            let order = cfg.custom_order.take().unwrap_or_default();
            let id = new_scheme_id();
            cfg.schemes.push(LayoutScheme {
                id: id.clone(),
                name,
                disabled: d,
                order,
            });
            if cfg.active_preset == "custom" {
                cfg.active_preset = "scheme".into();
                cfg.active_scheme_id = Some(id);
            }
        }
    }
    if cfg.active_preset == "custom" {
        if let Some(id) = cfg.schemes.first().map(|s| s.id.clone()) {
            cfg.active_preset = "scheme".into();
            cfg.active_scheme_id = Some(id);
        } else {
            cfg.active_preset = "coder".into();
        }
    }
    cfg.custom_disabled = None;
    cfg.custom_order = None;
    cfg.custom_name = None;
}

fn desk_root() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|d| d.join("desk"))
        .ok_or_else(|| "no local data dir".into())
}

fn plugins_user_dir() -> Result<PathBuf, String> {
    let dir = desk_root()?.join("plugins");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn plugins_config_path() -> Result<PathBuf, String> {
    Ok(desk_root()?.join("plugins.json"))
}

fn plugin_storage_dir(plugin_id: &str) -> Result<PathBuf, String> {
    let dir = desk_root()?.join("plugin-data").join(plugin_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn write_config(cfg: &PluginsConfig) -> Result<(), String> {
    let path = plugins_config_path()?;
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn seed_hello_plugin(user_dir: &PathBuf) -> Result<(), String> {
    let hello = user_dir.join("hello");
    if hello.exists() {
        return Ok(());
    }
    fs::create_dir_all(&hello).map_err(|e| e.to_string())?;
    let manifest = r#"{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "slot": "left",
  "entry": "./panel.js",
  "permissions": ["host.log"],
  "order": 90
}"#;
    let panel = r#"export default {
  mount(el) {
    el.innerHTML = `<div class="hello-plugin" style="font-size:11px;opacity:.7;padding:6px 0;border-top:1px dashed rgba(26,35,50,.15);margin-top:6px;font-family:Cascadia Code,Consolas,monospace">
      <span style="color:#2d6a4f">▸</span> user plugin <b>hello</b> loaded
    </div>`;
  },
  unmount() {}
};
"#;
    fs::write(hello.join("manifest.json"), manifest).map_err(|e| e.to_string())?;
    fs::write(hello.join("panel.js"), panel).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn plugin_list_user() -> Result<Vec<UserPluginInfo>, String> {
    let user_dir = plugins_user_dir()?;
    let _ = seed_hello_plugin(&user_dir);
    let mut out = Vec::new();
    let entries = fs::read_dir(&user_dir).map_err(|e| e.to_string())?;
    for ent in entries.flatten() {
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let raw = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
        let manifest: PluginManifest =
            serde_json::from_str(&raw).map_err(|e| format!("manifest {}: {e}", path.display()))?;
        let entry_rel = manifest.entry.trim_start_matches("./");
        let entry_path = path.join(entry_rel);
        if !entry_path.exists() {
            continue;
        }
        let css_path = {
            let css = path.join("panel.css");
            if css.exists() {
                Some(css.to_string_lossy().to_string())
            } else {
                None
            }
        };
        out.push(UserPluginInfo {
            id: manifest.id.clone(),
            dir: path.to_string_lossy().to_string(),
            manifest_path: manifest_path.to_string_lossy().to_string(),
            entry_path: entry_path.to_string_lossy().to_string(),
            css_path,
            manifest,
        });
    }
    out.sort_by(|a, b| {
        a.manifest
            .order
            .unwrap_or(100)
            .cmp(&b.manifest.order.unwrap_or(100))
            .then(a.id.cmp(&b.id))
    });
    Ok(out)
}

#[tauri::command]
pub fn plugin_get_config() -> Result<PluginsConfig, String> {
    let path = plugins_config_path()?;
    if !path.exists() {
        let cfg = PluginsConfig {
            active_preset: default_preset(),
            active_scheme_id: None,
            disabled: default_disabled(),
            order: Vec::new(),
            schemes: Vec::new(),
            custom_disabled: None,
            custom_order: None,
            custom_name: None,
        };
        write_config(&cfg)?;
        return Ok(cfg);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut cfg: PluginsConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    migrate_config(&mut cfg);
    if cfg.active_preset.is_empty() {
        cfg.active_preset = default_preset();
    }
    let _ = write_config(&cfg);
    Ok(cfg)
}

#[tauri::command]
pub fn plugin_set_disabled(id: String, disabled: bool) -> Result<PluginsConfig, String> {
    let mut cfg = plugin_get_config()?;
    if id == "cmdk" && disabled {
        return Err("不能禁用命令面板 cmdk（否则无法切回布局）".into());
    }
    if disabled {
        if !cfg.disabled.iter().any(|x| x == &id) {
            cfg.disabled.push(id);
        }
    } else {
        cfg.disabled.retain(|x| x != &id);
    }
    mark_scheme_draft(&mut cfg);
    write_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub fn plugin_set_order(order: Vec<String>) -> Result<PluginsConfig, String> {
    let mut cfg = plugin_get_config()?;
    let mut seen = std::collections::HashSet::new();
    cfg.order = order
        .into_iter()
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect();
    mark_scheme_draft(&mut cfg);
    write_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub fn plugin_list_presets() -> Result<Vec<PresetInfo>, String> {
    let cfg = plugin_get_config()?;
    let mut out = vec![
        PresetInfo {
            id: "coder".into(),
            name: "程序员".into(),
            description: "时钟 + GitHub + Multica + 待办 + 围栏（你的默认）".into(),
            builtin: true,
        },
        PresetInfo {
            id: "minimal".into(),
            name: "极简".into(),
            description: "时钟 + 围栏".into(),
            builtin: true,
        },
        PresetInfo {
            id: "fence".into(),
            name: "仅围栏".into(),
            description: "只要桌面图标".into(),
            builtin: true,
        },
    ];
    for s in &cfg.schemes {
        let desc = if cfg.active_scheme_id.as_deref() == Some(s.id.as_str()) && has_scheme_draft(&cfg)
        {
            "当前方案 · 有未保存改动".into()
        } else {
            "已保存的自定义方案".into()
        };
        out.push(PresetInfo {
            id: format!("scheme:{}", s.id),
            name: s.name.clone(),
            description: desc,
            builtin: false,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn plugin_apply_preset(id: String) -> Result<PluginsConfig, String> {
    if id.starts_with("scheme:") {
        return plugin_apply_scheme(id.trim_start_matches("scheme:").into());
    }
    let mut cfg = plugin_get_config()?;
    let disabled = preset_disabled(&id, &cfg).ok_or_else(|| format!("未知布局: {id}"))?;
    cfg.active_preset = id.clone();
    cfg.active_scheme_id = None;
    cfg.disabled = disabled;
    cfg.order.clear();
    write_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub fn plugin_apply_scheme(id: String) -> Result<PluginsConfig, String> {
    let mut cfg = plugin_get_config()?;
    let scheme = find_scheme(&cfg, &id)
        .ok_or_else(|| format!("方案不存在: {id}"))?
        .clone();
    cfg.active_preset = "scheme".into();
    cfg.active_scheme_id = Some(scheme.id);
    cfg.disabled = scheme.disabled;
    cfg.order = scheme.order;
    write_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub fn plugin_create_scheme(name: Option<String>) -> Result<PluginsConfig, String> {
    let mut cfg = plugin_get_config()?;
    if cfg.schemes.len() >= MAX_SCHEMES {
        return Err(format!("最多保存 {MAX_SCHEMES} 个方案，请先删除一个"));
    }
    let label = name
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| default_scheme_name(cfg.schemes.len()));
    let scheme = LayoutScheme {
        id: new_scheme_id(),
        name: label,
        disabled: cfg.disabled.clone(),
        order: cfg.order.clone(),
    };
    let id = scheme.id.clone();
    cfg.schemes.push(scheme);
    cfg.active_preset = "scheme".into();
    cfg.active_scheme_id = Some(id);
    write_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub fn plugin_update_scheme(id: String, name: Option<String>) -> Result<PluginsConfig, String> {
    let mut cfg = plugin_get_config()?;
    let disabled = cfg.disabled.clone();
    let order = cfg.order.clone();
    let scheme = find_scheme_mut(&mut cfg, &id).ok_or_else(|| format!("方案不存在: {id}"))?;
    scheme.disabled = disabled;
    scheme.order = order;
    if let Some(n) = name.filter(|s| !s.trim().is_empty()) {
        scheme.name = n.trim().to_string();
    }
    cfg.active_preset = "scheme".into();
    cfg.active_scheme_id = Some(id);
    write_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub fn plugin_delete_scheme(id: String) -> Result<PluginsConfig, String> {
    let mut cfg = plugin_get_config()?;
    let was_active = cfg.active_scheme_id.as_deref() == Some(id.as_str());
    cfg.schemes.retain(|s| s.id != id);
    if was_active {
        if let Some(s) = cfg.schemes.first().cloned() {
            cfg.active_preset = "scheme".into();
            cfg.active_scheme_id = Some(s.id.clone());
            cfg.disabled = s.disabled;
            cfg.order = s.order;
        } else {
            apply_coder_defaults(&mut cfg);
        }
    }
    write_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub fn plugin_save_custom(name: Option<String>) -> Result<PluginsConfig, String> {
    let cfg = plugin_get_config()?;
    if let Some(id) = cfg.active_scheme_id.clone() {
        if find_scheme(&cfg, &id).is_some() {
            return plugin_update_scheme(id, name);
        }
    }
    plugin_create_scheme(name)
}

#[tauri::command]
pub fn plugin_discard_custom_draft() -> Result<PluginsConfig, String> {
    let mut cfg = plugin_get_config()?;
    if let Some((d, o)) = active_scheme_snapshot(&cfg) {
        cfg.disabled = d;
        cfg.order = o;
        write_config(&cfg)?;
        return Ok(cfg);
    }
    apply_coder_defaults(&mut cfg);
    write_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub fn plugin_storage_get(plugin_id: String, key: String) -> Result<Option<Value>, String> {
    let path = plugin_storage_dir(&plugin_id)?.join(format!("{key}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(Some(v))
}

#[tauri::command]
pub fn plugin_storage_set(plugin_id: String, key: String, value: Value) -> Result<(), String> {
    let path = plugin_storage_dir(&plugin_id)?.join(format!("{key}.json"));
    fs::write(
        &path,
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
