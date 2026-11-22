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
