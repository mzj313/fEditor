//! HTTP 调试：在 Rust 侧发请求，绕过浏览器的 CORS 限制，支持自定义请求头、
//! 文本/JSON 请求体与 multipart 文件上传。响应统一截断到固定大小，避免大响应撑爆内存。

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// 响应体最多读取的字节数，超出部分丢弃并标记 truncated
const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
/// 最多从网络读取的总字节数；再大就直接断开，避免调试时卡在超大响应上
const MAX_DOWNLOAD_BYTES: u64 = 20 * 1024 * 1024;
/// 单个上传文件的大小上限
const MAX_UPLOAD_BYTES: u64 = 50 * 1024 * 1024;
const TIMEOUT_SECS: u64 = 30;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestInput {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    /// 文本/JSON 请求体；multipart 模式下忽略
    body: Option<String>,
    /// "text" | "json" | "multipart" | "none"
    body_type: Option<String>,
    form: Option<Vec<FormFieldInput>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormFieldInput {
    key: String,
    value: String,
    /// 有值表示按文件上传处理
    file_path: Option<String>,
    file_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponsePayload {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
    /// 重定向后的最终地址
    url: String,
    elapsed_ms: u64,
    size: u64,
    truncated: bool,
    /// 二进制响应不返回正文，只给大小
    binary: bool,
}

/// 判断响应是否需要按二进制处理（不往页面里塞乱码）
fn is_binary(content_type: &str) -> bool {
    let lower = content_type.to_ascii_lowercase();
    ["image/", "audio/", "video/", "font/", "application/octet-stream", "application/zip", "application/pdf"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

fn escape_multipart(text: &str) -> String {
    // 去掉换行并转义引号，避免破坏 multipart 头部结构
    text.replace(['\r', '\n'], " ").replace('"', "\\\"")
}

/// 手工拼 multipart 请求体：只依赖固定 boundary，避免引入额外特性
fn build_multipart(fields: &[FormFieldInput]) -> Result<(String, Vec<u8>), String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let boundary = format!("----fEditorBoundary{nanos}");
    let mut body: Vec<u8> = Vec::new();

    for field in fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match &field.file_path {
            Some(path) => {
                let meta = std::fs::metadata(path).map_err(|e| format!("无法读取文件信息：{e}"))?;
                if meta.len() > MAX_UPLOAD_BYTES {
                    return Err(format!("文件过大（上限 {} MB）：{path}", MAX_UPLOAD_BYTES / 1024 / 1024));
                }
                let name = field
                    .file_name
                    .clone()
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| {
                        std::path::Path::new(path)
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| "file".to_string())
                    });
                body.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n",
                        escape_multipart(&field.key),
                        escape_multipart(&name)
                    )
                    .as_bytes(),
                );
                body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
                let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败：{e}"))?;
                body.extend_from_slice(&bytes);
                body.extend_from_slice(b"\r\n");
            }
            None => {
                body.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{}\"\r\n\r\n",
                        escape_multipart(&field.key)
                    )
                    .as_bytes(),
                );
                body.extend_from_slice(field.value.as_bytes());
                body.extend_from_slice(b"\r\n");
            }
        }
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok((boundary, body))
}

#[tauri::command]
pub async fn http_send(input: HttpRequestInput) -> Result<HttpResponsePayload, String> {
    let url = reqwest::Url::parse(input.url.trim()).map_err(|e| format!("地址不合法：{e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只支持 http / https 地址".to_string());
    }

    let method = reqwest::Method::from_bytes(input.method.to_uppercase().as_bytes())
        .map_err(|_| format!("不支持的请求方法：{}", input.method))?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        // 最多跟随 10 次重定向，并在结果里回传最终地址
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("网络客户端创建失败：{e}"))?;

    let mut request = client.request(method, url);

    let mut has_user_agent = false;
    let mut has_content_type = false;
    for (key, value) in &input.headers {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        if key.eq_ignore_ascii_case("user-agent") {
            has_user_agent = true;
        }
        if key.eq_ignore_ascii_case("content-type") {
            has_content_type = true;
        }
        request = request.header(key, value);
    }
    if !has_user_agent {
        request = request.header("User-Agent", "fEditor/HTTP-Debug");
    }

    // 请求体：multipart 需要自己算 Content-Type，其余按文本发送
    let body_type = input.body_type.as_deref().unwrap_or("none");
    if body_type == "multipart" {
        let fields = input.form.unwrap_or_default();
        if !fields.is_empty() {
            let (boundary, body) = build_multipart(&fields)?;
            if !has_content_type {
                request = request.header(
                    "Content-Type",
                    format!("multipart/form-data; boundary={boundary}"),
                );
            }
            request = request.body(body);
        }
    } else if let Some(body) = input.body {
        if !body.is_empty() || matches!(body_type, "text" | "json") {
            // JSON 体没手写 Content-Type 时自动补上，省一步配置
            if body_type == "json" && !has_content_type {
                request = request.header("Content-Type", "application/json");
            }
            request = request.body(body);
        }
    }

    let started = Instant::now();
    let mut response = request.send().await.map_err(|e| format!("请求失败：{e}"))?;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let final_url = response.url().to_string();

    let headers: Vec<(String, String)> = {
        // 同名多值合并成一行，界面上按普通表格展示
        let mut map: Vec<(String, String)> = Vec::new();
        for (name, value) in response.headers() {
            let text = value.to_str().unwrap_or("<非文本值>").to_string();
            let name = name.as_str().to_string();
            if let Some(existing) = map.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case(&name)) {
                existing.1.push_str(", ");
                existing.1.push_str(&text);
            } else {
                map.push((name, text));
            }
        }
        map
    };

    let content_type = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let binary = is_binary(&content_type);

    // 逐块读取并截断，超大响应不会把内存吃满
    let mut collected: Vec<u8> = Vec::new();
    let mut size: u64 = 0;
    let mut truncated = false;
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("读取响应失败：{e}"))? {
        size += chunk.len() as u64;
        if binary {
            if size > MAX_DOWNLOAD_BYTES {
                truncated = true;
                break;
            }
            continue;
        }
        let remain = MAX_BODY_BYTES.saturating_sub(collected.len());
        if remain == 0 {
            truncated = true;
        } else if chunk.len() > remain {
            collected.extend_from_slice(&chunk[..remain]);
            truncated = true;
        } else {
            collected.extend_from_slice(&chunk);
        }
        if size > MAX_DOWNLOAD_BYTES {
            truncated = true;
            break;
        }
    }

    Ok(HttpResponsePayload {
        status: status.as_u16(),
        status_text,
        headers,
        // 非 UTF-8 响应按替换字符展示，避免整段不可读
        body: if binary {
            String::new()
        } else {
            String::from_utf8_lossy(&collected).to_string()
        },
        url: final_url,
        elapsed_ms,
        size,
        truncated,
        binary,
    })
}
