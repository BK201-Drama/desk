//! 力扣中国 Hot 100：按北京时间每天固定抽一题
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LeetCodeDaily {
    pub date: String,
    pub frontend_id: String,
    pub title_cn: String,
    pub title_slug: String,
    pub difficulty: String,
}

const HOT100_LIST_ID: &str = "2cktkvj";

const QUERY: &str = r#"
query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
  problemsetQuestionList(
    categorySlug: $categorySlug
    limit: $limit
    skip: $skip
    filters: $filters
  ) {
    questions {
      frontendQuestionId
      titleSlug
      title
      titleCn
      difficulty
    }
  }
}
"#;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        )
        .build()
        .map_err(|e| e.to_string())
}

/// 北京时间（UTC+8，无夏令时）的日序号，从 Unix epoch 起算。
fn shanghai_day_ordinal(unix_secs: i64) -> i64 {
    (unix_secs + 8 * 3600).div_euclid(86_400)
}

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

fn format_shanghai_date(unix_secs: i64) -> String {
    let (y, m, d) = civil_from_days(shanghai_day_ordinal(unix_secs));
    format!("{y:04}-{m:02}-{d:02}")
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn id_sort_key(id: &str) -> (u32, String) {
    (id.parse::<u32>().unwrap_or(u32::MAX), id.to_string())
}

fn parse_hot100(text: &str) -> Result<Vec<LeetCodeDaily>, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if let Some(errs) = v.get("errors") {
        return Err(format!("graphql errors: {errs}"));
    }
    let questions = v
        .pointer("/data/problemsetQuestionList/questions")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "hot100 empty".to_string())?;
    let mut out = Vec::new();
    for q in questions {
        let title_slug = q
            .get("titleSlug")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if title_slug.is_empty() {
            continue;
        }
        let title_cn = q
            .get("titleCn")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| q.get("title").and_then(|x| x.as_str()))
            .unwrap_or("")
            .to_string();
        out.push(LeetCodeDaily {
            date: String::new(),
            frontend_id: q
                .get("frontendQuestionId")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            title_cn,
            title_slug,
            difficulty: q
                .get("difficulty")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    if out.is_empty() {
        return Err("hot100 empty".into());
    }
    out.sort_by(|a, b| id_sort_key(&a.frontend_id).cmp(&id_sort_key(&b.frontend_id)));
    Ok(out)
}

fn pick(list: &[LeetCodeDaily], unix_secs: i64) -> LeetCodeDaily {
    let idx = shanghai_day_ordinal(unix_secs).rem_euclid(list.len() as i64) as usize;
    let mut chosen = list[idx].clone();
    chosen.date = format_shanghai_date(unix_secs);
    chosen
}

async fn fetch_hot100(client: &reqwest::Client) -> Result<Vec<LeetCodeDaily>, String> {
    let body = serde_json::json!({
        "operationName": "problemsetQuestionList",
        "variables": {
            "categorySlug": "",
            "skip": 0,
            "limit": 100,
            "filters": { "listId": HOT100_LIST_ID }
        },
        "query": QUERY,
    });
    let text = client
        .post("https://leetcode.cn/graphql/")
        .header("Content-Type", "application/json")
        .header("Referer", "https://leetcode.cn/problem-list/2cktkvj/")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    parse_hot100(&text)
}

#[tauri::command]
pub fn leetcode_daily_cached() -> Option<LeetCodeDaily> {
    load_cache()
}

#[tauri::command]
pub async fn leetcode_daily() -> Result<LeetCodeDaily, String> {
    let client = client()?;
    match fetch_hot100(&client).await {
        Ok(list) => {
            let chosen = pick(&list, now_unix());
            let _ = save_cache(&chosen);
            Ok(chosen)
        }
        Err(e) => {
            if let Some(c) = load_cache() {
                return Ok(c);
            }
            Err(format!("Hot 100 拉取失败: {e}"))
        }
    }
}

fn cache_path() -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir()?.join("leetcode-daily-cache.json"))
}

fn load_cache() -> Option<LeetCodeDaily> {
    let s = fs::read_to_string(cache_path().ok()?).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_cache(daily: &LeetCodeDaily) -> Result<(), String> {
    let p = cache_path()?;
    let s = serde_json::to_string_pretty(daily).map_err(|e| e.to_string())?;
    fs::write(p, s).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "data": {
        "problemsetQuestionList": {
          "questions": [
            {
              "frontendQuestionId": "20",
              "titleSlug": "valid-parentheses",
              "title": "Valid Parentheses",
              "titleCn": "有效的括号",
              "difficulty": "EASY"
            },
            {
              "frontendQuestionId": "1",
              "titleSlug": "two-sum",
              "title": "Two Sum",
              "titleCn": "两数之和",
              "difficulty": "EASY"
            }
          ]
        }
      }
    }"#;

    #[test]
    fn parse_sorts_by_frontend_id() {
        let list = parse_hot100(SAMPLE).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].title_slug, "two-sum");
        assert_eq!(list[0].title_cn, "两数之和");
        assert_eq!(list[1].frontend_id, "20");
    }

    #[test]
    fn same_day_picks_same_problem() {
        let list = parse_hot100(SAMPLE).unwrap();
        let day = 1_758_432_000; // stable instant
        let a = pick(&list, day);
        let b = pick(&list, day + 3600);
        assert_eq!(a.title_slug, b.title_slug);
        assert_eq!(a.date, b.date);
        let next = pick(&list, day + 86_400);
        assert_ne!(a.title_slug, next.title_slug);
    }

    #[test]
    fn shanghai_date_crosses_utc_midnight() {
        // 1970-01-01 16:00 UTC == 1970-01-02 00:00 CST
        assert_eq!(format_shanghai_date(16 * 3600), "1970-01-02");
        assert_eq!(format_shanghai_date(0), "1970-01-01");
    }
}
