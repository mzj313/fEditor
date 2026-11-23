//! 离线英汉词典：构建期把裁剪后的 ECDICT 数据打包进二进制，运行时惰性解压查表。
//! 只支持英文单词到中文释义，不发起任何网络请求。

use std::collections::HashMap;
use std::io::Read;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// 由 scripts/build-dict.py 生成，内容为 [{ w, p, t }] 的 gzip JSON
static COMPRESSED: &[u8] = include_bytes!("../resources/dict-en-zh.json.gz");

#[derive(Deserialize)]
struct RawEntry {
    w: String,
    #[serde(default)]
    p: String,
    t: String,
}

#[derive(Serialize, Clone)]
pub struct DictEntry {
    word: String,
    phonetic: String,
    translation: String,
    /// 结果来源：local 本地词库 / online 在线查询
    source: &'static str,
}

fn table() -> &'static HashMap<String, DictEntry> {
    static TABLE: OnceLock<HashMap<String, DictEntry>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut json = String::new();
        if flate2::read::GzDecoder::new(COMPRESSED)
            .read_to_string(&mut json)
            .is_err()
        {
            return HashMap::new();
        }
        let raw: Vec<RawEntry> = match serde_json::from_str(&json) {
            Ok(value) => value,
            Err(_) => return HashMap::new(),
        };
        let mut map = HashMap::with_capacity(raw.len());
        for entry in raw {
            let key = normalize(&entry.w);
            if key.is_empty() {
                continue;
            }
            map.insert(
                key,
                DictEntry {
                    word: entry.w,
                    phonetic: entry.p,
                    translation: entry.t,
                    source: "local",
                },
            );
        }
        map
    })
}

fn normalize(word: &str) -> String {
    word.trim()
        .trim_matches(|c: char| !c.is_ascii_alphabetic() && c != '-' && c != '\'')
        .to_ascii_lowercase()
}

/// 常见词形回退：词库已收录大部分变化，这里只兜底漏网的复数与时态
fn candidates(word: &str) -> Vec<String> {
    let mut list = vec![word.to_string()];
    if let Some(stem) = word.strip_suffix("ies") {
        list.push(format!("{stem}y"));
    }
    for suffix in ["es", "s", "ed", "d", "ing", "ly", "er", "est"] {
        if let Some(stem) = word.strip_suffix(suffix) {
            if stem.len() >= 3 {
                list.push(stem.to_string());
                if suffix == "ing" || suffix == "ed" || suffix == "er" {
                    list.push(format!("{stem}e"));
                }
            }
        }
    }
    list
}

#[tauri::command]
pub fn dict_lookup(word: String) -> Option<DictEntry> {
    let key = normalize(&word);
    if key.is_empty() || key.len() > 64 {
        return None;
    }
    let map = table();
    for candidate in candidates(&key) {
        if let Some(entry) = map.get(&candidate) {
            return Some(entry.clone());
        }
    }
    None
}

/// 在线查询用的响应结构（只取需要的字段）
#[derive(Deserialize)]
struct MyMemoryResponse {
    #[serde(rename = "responseData")]
    data: Option<MyMemoryData>,
    #[serde(rename = "responseStatus")]
    status: serde_json::Value,
}

#[derive(Deserialize)]
struct MyMemoryData {
    #[serde(rename = "translatedText")]
    text: Option<String>,
}

/// 是否中日韩字符：用于判定在线翻译方向
fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff)
}

/// 英文按词典口径归一化；含中日韩字符时保留原文，走中译英
fn query_text(word: &str) -> String {
    let trimmed = word.trim();
    if trimmed.chars().any(is_cjk) {
        trimmed.to_string()
    } else {
        normalize(trimmed)
    }
}

/// 本地词典查不到时的可选回退：请求 MyMemory 免费接口。
/// 英文单词/词组英译中，含中文时自动中译英；超时 5 秒，任何失败都返回 None。
#[tauri::command]
pub fn dict_lookup_online(word: String) -> Option<DictEntry> {
    let key = query_text(&word);
    // MyMemory 单次查询上限 500 字符；按字符数而非字节数计算
    if key.is_empty() || key.chars().count() > 500 {
        return None;
    }
    let langpair = if key.chars().any(is_cjk) {
        "zh-CN|en"
    } else {
        "en|zh-CN"
    };

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;
    // 词组含空格等字符，必须走 query 参数自动 URL 编码，不能手动拼 URL
    let response: MyMemoryResponse = client
        .get("https://api.mymemory.translated.net/get")
        .query(&[("q", key.as_str()), ("langpair", langpair)])
        .send()
        .ok()?
        .text()
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())?;

    // responseStatus 可能是数字或字符串，统一按文本判断
    let status_ok = match &response.status {
        serde_json::Value::Number(n) => n.as_i64() == Some(200),
        serde_json::Value::String(s) => s == "200",
        _ => false,
    };
    let text = response.data?.text?.trim().to_string();
    if !status_ok || text.is_empty() {
        return None;
    }
    // 免费配额耗尽时接口仍返回 200，但译文里带警告文案，需要拦掉
    if text.contains("MYMEMORY WARNING") || text.contains("QUERY LENGTH LIMIT") {
        return None;
    }

    Some(DictEntry {
        word: key,
        phonetic: String::new(),
        translation: text,
        source: "online",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_bundled_dictionary() {
        assert!(table().len() > 10_000, "词库没有正确加载");
    }

    #[test]
    fn looks_up_words_and_inflections() {
        for word in ["hello", "configuration", "running", "studies"] {
            let entry = dict_lookup(word.to_string()).unwrap_or_else(|| panic!("{word} 未命中"));
            assert!(!entry.translation.is_empty());
        }
    }

    #[test]
    fn ignores_non_english() {
        assert!(dict_lookup("你好".to_string()).is_none());
        assert!(dict_lookup("   ".to_string()).is_none());
    }
}
