//! A 股简易行情（东财 delay / 腾讯备用）
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockQuote {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub change_pct: f64,
    pub market: String,
}

fn default_secids() -> Vec<&'static str> {
    vec![
        "1.518880", // 黄金ETF（华安黄金）
        "0.000066", // 中国长城
        "1.605378", // 野马电池
    ]
}

fn parse_secid(code: &str) -> String {
    let c = code.trim().to_lowercase();
    if c.contains('.') {
        return c;
    }
    if let Some(rest) = c.strip_prefix("sh") {
        return format!("1.{rest}");
    }
    if let Some(rest) = c.strip_prefix("sz") {
        return format!("0.{rest}");
    }
    if c == "000001" {
        return "1.000001".into();
    }
    if c.starts_with('6') || c.starts_with('5') {
        return format!("1.{c}");
    }
    if c.starts_with('0') || c.starts_with('3') {
        return format!("0.{c}");
    }
    format!("1.{c}")
}

fn secid_to_tx(secid: &str) -> Option<String> {
    let (m, code) = secid.split_once('.')?;
    match m {
        "1" => Some(format!("sh{code}")),
        "0" => Some(format!("sz{code}")),
        _ => None,
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        )
        .build()
        .map_err(|e| e.to_string())
}

fn parse_eastmoney(text: &str) -> Result<Vec<StockQuote>, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let diff = v
        .pointer("/data/diff")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for row in diff {
        let code = row
            .get("f12")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let name = row
            .get("f14")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let price = row.get("f2").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let change_pct = row.get("f3").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let market = match row.get("f13").and_then(|x| x.as_i64()).unwrap_or(1) {
            0 => "sz",
            _ => "sh",
        }
        .to_string();
        if code.is_empty() {
            continue;
        }
        out.push(StockQuote {
            code,
            name,
            price,
            change_pct,
            market,
        });
    }
    if out.is_empty() {
        return Err("eastmoney empty".into());
    }
    Ok(out)
}

/// 腾讯行情：`v_sh518880="1~名~代码~现价~...~涨跌幅~"`
fn parse_tencent(text: &str) -> Result<Vec<StockQuote>, String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((_, rest)) = line.split_once('=') else {
            continue;
        };
        let body = rest.trim().trim_matches(';').trim_matches('"');
        let parts: Vec<&str> = body.split('~').collect();
        if parts.len() < 33 {
            continue;
        }
        let name = parts[1].to_string();
        let code = parts[2].to_string();
        let price: f64 = parts[3].parse().unwrap_or(0.0);
        let change_pct: f64 = parts[32].parse().unwrap_or(0.0);
        let market = if line.contains("v_sz") { "sz" } else { "sh" }.to_string();
        if code.is_empty() {
            continue;
        }
        out.push(StockQuote {
            code,
            name,
            price,
            change_pct,
            market,
        });
    }
    if out.is_empty() {
        return Err("tencent empty".into());
    }
    Ok(out)
}

async fn fetch_eastmoney(
    client: &reqwest::Client,
    secids: &[String],
) -> Result<Vec<StockQuote>, String> {
    let joined = secids.join(",");
    // push2 在部分网络/ rustls 下会断；delay 更稳
    let urls = [
        format!(
            "https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f13,f14,f2,f3&secids={joined}"
        ),
        format!(
            "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f13,f14,f2,f3&secids={joined}"
        ),
    ];
    let mut last = "eastmoney failed".to_string();
    for url in urls {
        match client.get(&url).send().await {
            Ok(res) => {
                let text = res.text().await.map_err(|e| e.to_string())?;
                match parse_eastmoney(&text) {
                    Ok(v) => return Ok(v),
                    Err(e) => last = e,
                }
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

async fn fetch_tencent(
    client: &reqwest::Client,
    secids: &[String],
) -> Result<Vec<StockQuote>, String> {
    let list: Vec<String> = secids.iter().filter_map(|s| secid_to_tx(s)).collect();
    if list.is_empty() {
        return Err("no tencent symbols".into());
    }
    let url = format!("https://qt.gtimg.cn/q={}", list.join(","));
    let text = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    parse_tencent(&text)
}

#[tauri::command]
pub fn stock_cached() -> Option<Vec<StockQuote>> {
    load_cache()
}

#[tauri::command]
pub async fn stock_quotes(codes: Option<Vec<String>>) -> Result<Vec<StockQuote>, String> {
    let secids: Vec<String> = match codes {
        Some(list) if !list.is_empty() => list.iter().map(|c| parse_secid(c)).collect(),
        _ => default_secids().into_iter().map(String::from).collect(),
    };
    let client = client()?;
    match fetch_eastmoney(&client, &secids).await {
        Ok(v) => {
            let _ = save_cache(&v);
            Ok(v)
        }
        Err(e1) => match fetch_tencent(&client, &secids).await {
            Ok(v) => {
                let _ = save_cache(&v);
                Ok(v)
            }
            Err(e2) => {
                if let Some(c) = load_cache() {
                    return Ok(c);
                }
                Err(format!("行情失败: {e1}; 备用: {e2}"))
            }
        },
    }
}

fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("no local app data")?;
    let dir = base.join("desk");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn cache_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("stock-cache.json"))
}

fn load_cache() -> Option<Vec<StockQuote>> {
    let s = fs::read_to_string(cache_path().ok()?).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_cache(quotes: &[StockQuote]) -> Result<(), String> {
    let p = cache_path()?;
    let s = serde_json::to_string_pretty(quotes).map_err(|e| e.to_string())?;
    fs::write(p, s).map_err(|e| e.to_string())
}
