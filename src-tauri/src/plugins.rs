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
pub struct PluginsConfig {
    #[serde(default = "default_preset")]
    pub active_preset: String,
    #[serde(default = "default_disabled")]
    pub disabled: Vec<String>,
    /// Snapshot when user saves「自定义」or diverges via toggles
    #[serde(default)]
    pub custom_disabled: Option<Vec<String>>,
    /// Display order of plugin ids (within each slot). Empty = manifest.order.
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub custom_order: Option<Vec<String>>,
}

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
    ]
}

fn minimal_disabled() -> Vec<String> {
    vec![
        "github".into(),
        "multica".into(),
        "remind".into(),
        "hello".into(),
        "ops-hud".into(),
        "event-tape".into(),
        "qq-music".into(),
    ]
}

fn fence_only_disabled() -> Vec<String> {
    vec![
        "clock".into(),
        "github".into(),
        "multica".into(),
        "remind".into(),
        "hello".into(),
        "ops-hud".into(),
        "event-tape".into(),
        "qq-music".into(),
    ]
}

fn preset_disabled(id: &str, cfg: &PluginsConfig) -> Option<Vec<String>> {
    match id {
        "coder" => Some(coder_disabled()),
        "minimal" => Some(minimal_disabled()),
        "fence" => Some(fence_only_disabled()),
        "custom" => Some(
            cfg.custom_disabled
                .clone()
                .unwrap_or_else(|| cfg.disabled.clone()),
        ),
        _ => None,
    }
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
            disabled: default_disabled(),
            custom_disabled: None,
            order: Vec::new(),
            custom_order: None,
        };
        write_config(&cfg)?;
        return Ok(cfg);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut cfg: PluginsConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    // migrate old files missing active_preset
    if cfg.active_preset.is_empty() {
        cfg.active_preset = default_preset();
        let _ = write_config(&cfg);
    }
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
    // individual tweak → custom
    cfg.active_preset = "custom".into();
    cfg.custom_disabled = Some(cfg.disabled.clone());
    cfg.custom_order = Some(cfg.order.clone());
    write_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub fn plugin_set_order(order: Vec<String>) -> Result<PluginsConfig, String> {
    let mut cfg = plugin_get_config()?;
    // de-dupe, drop empty
    let mut seen = std::collections::HashSet::new();
    cfg.order = order
        .into_iter()
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect();
    cfg.active_preset = "custom".into();
    cfg.custom_disabled = Some(cfg.disabled.clone());
    cfg.custom_order = Some(cfg.order.clone());
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
    if cfg.custom_disabled.is_some() || cfg.custom_order.is_some() {
        out.push(PresetInfo {
            id: "custom".into(),
            name: "自定义".into(),
            description: "你上次保存/微调的组合与顺序".into(),
            builtin: false,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn plugin_apply_preset(id: String) -> Result<PluginsConfig, String> {
    let mut cfg = plugin_get_config()?;
    let disabled = preset_disabled(&id, &cfg).ok_or_else(|| format!("未知布局: {id}"))?;
    if id == "custom" && cfg.custom_disabled.is_none() && cfg.custom_order.is_none() {
        return Err("还没有自定义布局，先微调插件或「保存当前为自定义」".into());
    }
    cfg.active_preset = id.clone();
    cfg.disabled = disabled;
    if id == "custom" {
        if let Some(o) = cfg.custom_order.clone() {
            cfg.order = o;
        }
    } else {
        // 内置布局回到 manifest 默认顺序
        cfg.order.clear();
    }
    write_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub fn plugin_save_custom() -> Result<PluginsConfig, String> {
    let mut cfg = plugin_get_config()?;
    cfg.custom_disabled = Some(cfg.disabled.clone());
    cfg.custom_order = Some(cfg.order.clone());
    cfg.active_preset = "custom".into();
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
