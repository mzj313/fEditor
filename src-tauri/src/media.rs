//! 本地媒体协议：`feditor-media://localhost/<编码后的绝对路径>`。
//!
//! 音频不走 asset 协议，也不整体读进前端内存：这里直接按 Range 请求从磁盘
//! 分段返回，播放和拖动进度条都由 WebView 自己发请求完成。

use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use tauri::http::{header, HeaderMap, Request, Response, StatusCode};

pub const SCHEME: &str = "feditor-media";

/// 视频按块返回：Range 请求单次最多回 4 MB，避免大文件整体读进内存
const MEDIA_CHUNK: u64 = 4 * 1024 * 1024;
/// 小音频一次返回完，超过这个体积才分片：给正常播放增加额外请求没有收益，
/// 但个别 WebView 拖动进度条失败后会退回整文件请求，大文件仍需兜住内存
const AUDIO_CHUNK_THRESHOLD: u64 = 16 * 1024 * 1024;

pub fn handle(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let uri_path = request.uri().path();
    let query = request.uri().query().unwrap_or("");
    // 交互 SVG 需要 HTML 外壳而不是原文件，用 query 标记区分
    let wrap = query.split('&').any(|pair| pair == "wrap=1");
    let raw = uri_path.strip_prefix('/').unwrap_or(uri_path);
    let decoded = percent_decode(raw);
    // WebView 有时会把 %2F 还原成 /，这里统一补回绝对路径前缀
    let path = if cfg!(windows) {
        decoded
    } else if decoded.starts_with('/') {
        decoded
    } else {
        format!("/{decoded}")
    };
    if path.is_empty() {
        return error(StatusCode::BAD_REQUEST, "缺少文件路径");
    }
    if wrap {
        return match svg_wrapper(&path) {
            Ok(response) => response,
            Err(message) => error(StatusCode::BAD_REQUEST, &message),
        };
    }
    match file_response(&path, request.headers()) {
        Ok(response) => response,
        Err(message) => error(StatusCode::NOT_FOUND, &message),
    }
}

/// 交互 SVG 的 HTML 外壳。
///
/// 主文档 CSP 是 `script-src 'self'` + `frame-src 'none'`，srcdoc / data: 里的内联脚本
/// 一律被拦。这里改成由独立协议的独立文档承载：它有自己的响应头（不带 CSP），
/// 脚本可以执行；同时与主文档不同源，拿不到应用页面与 Tauri 的 IPC。
fn svg_wrapper(path: &str) -> Result<Response<Cow<'static, [u8]>>, String> {
    if !path.to_ascii_lowercase().ends_with(".svg") {
        return Err("只有 SVG 支持交互外壳".to_string());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("无法读取文件：{e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    // 按 HTML 解析时 script 里的 CDATA 标记会变成代码开头，直接造成语法错误
    let cleaned = text.replace("<![CDATA[", "").replace("]]>", "");
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>\
html,body{{margin:0;height:100%;background:transparent;overflow:auto}}\
svg{{width:100%;height:auto;display:block}}\
</style></head><body>{cleaned}</body></html>"
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        // 文件改动后必须重新拉取，否则 WebView 会一直用旧图
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(html.into_bytes()))
        .map_err(|e| format!("构造响应失败：{e}"))
}

fn error(status: StatusCode, message: &str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Cow::Owned(message.as_bytes().to_vec()))
        .unwrap_or_else(|_| Response::new(Cow::Owned(Vec::new())))
}

fn file_response(
    path: &str,
    headers: &HeaderMap,
) -> Result<Response<Cow<'static, [u8]>>, String> {
    // 这个协议对渲染进程完全开放，任何路径都能请求到。
    // 只服务预览需要的媒体类型，否则恶意 Markdown 里的 <img src="feditor-media://...">
    // 就能把任意本地文件读进页面。
    let mime = mime_for(path).ok_or_else(|| "不是可预览的媒体文件".to_string())?;
    let mut file = File::open(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let length = file
        .metadata()
        .map_err(|e| format!("无法读取文件信息：{e}"))?
        .len();

    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_range(value, length));

    let (mut status, start, mut end) = match range {
        Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end),
        None => (StatusCode::OK, 0, length.saturating_sub(1)),
    };

    if let Some(chunk) = chunk_limit(path, length) {
        // 播放器通常先发 `bytes=0-`，这里只回第一块；后续分片由它继续请求
        if status == StatusCode::OK && length > chunk {
            status = StatusCode::PARTIAL_CONTENT;
        }
        end = end.min(start.saturating_add(chunk - 1));
    }

    let size = if length == 0 { 0 } else { end - start + 1 };
    let mut buffer = vec![0u8; size as usize];
    if size > 0 {
        file.seek(SeekFrom::Start(start))
            .map_err(|e| format!("定位失败：{e}"))?;
        file.read_exact(&mut buffer)
            .map_err(|e| format!("读取失败：{e}"))?;
    }

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, size)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{length}"),
        );
    }
    builder
        .body(Cow::Owned(buffer))
        .map_err(|e| format!("构造响应失败：{e}"))
}

/// 支持 `bytes=0-`、`bytes=100-200`、`bytes=-500` 三种写法
fn parse_range(value: &str, length: u64) -> Option<(u64, u64)> {
    if length == 0 {
        return None;
    }
    let spec = value.strip_prefix("bytes=")?;
    // 多区间（bytes=0-1,2-3）只取第一段：整段忽略会让客户端退回请求整个文件，
    // 对视频来说既破坏播放又撑爆内存
    let spec = spec.split(',').next()?.trim();
    let (start_text, end_text) = spec.split_once('-')?;
    let (start, end) = if start_text.is_empty() {
        let suffix: u64 = end_text.trim().parse().ok()?;
        let start = length.saturating_sub(suffix);
        (start, length - 1)
    } else {
        let start: u64 = start_text.trim().parse().ok()?;
        let end = if end_text.trim().is_empty() {
            length - 1
        } else {
            end_text.trim().parse::<u64>().ok()?.min(length - 1)
        };
        (start, end)
    };
    if start > end || start >= length {
        return None;
    }
    Some((start, end))
}

fn is_video(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".mp4") || lower.ends_with(".webm")
}

fn is_audio(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// 单次响应最多返回的字节数；`None` 表示整个文件一次返回。
///
/// PDF 特意不分片：pdf.js 只在 http(s) 下启用 Range 请求，自定义协议会被
/// 判定为不支持分段，此时截断响应会让它拿到残缺文件而解析失败。
fn chunk_limit(path: &str, length: u64) -> Option<u64> {
    if is_video(path) {
        Some(MEDIA_CHUNK)
    } else if is_audio(path) && length > AUDIO_CHUNK_THRESHOLD {
        Some(MEDIA_CHUNK)
    } else {
        None
    }
}

/// 只映射可预览的媒体类型；其余文件返回 None，由调用方拒绝请求。
fn mime_for(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    let mime = if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".m4a") {
        "audio/mp4"
    } else if lower.ends_with(".wav") {
        "audio/wav"
    } else if lower.ends_with(".aac") {
        "audio/aac"
    } else if lower.ends_with(".flac") {
        "audio/flac"
    } else if lower.ends_with(".ogg") {
        "audio/ogg"
    } else if lower.ends_with(".mp4") {
        "video/mp4"
    } else if lower.ends_with(".webm") {
        "video/webm"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".pdf") {
        // pdf.js 直接按此协议拉取整个文件，不再经 base64 走 IPC
        "application/pdf"
    } else {
        return None;
    };
    Some(mime)
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &raw[index + 1..index + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_and_closed_ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-20", 100), Some((10, 20)));
        // 结束位置超过文件长度时收敛到最后一字节
        assert_eq!(parse_range("bytes=90-9999", 100), Some((90, 99)));
    }

    #[test]
    fn parses_suffix_range() {
        assert_eq!(parse_range("bytes=-30", 100), Some((70, 99)));
        // 后缀比文件还长时从 0 开始
        assert_eq!(parse_range("bytes=-500", 100), Some((0, 99)));
    }

    #[test]
    fn rejects_invalid_ranges() {
        assert_eq!(parse_range("items=0-10", 100), None);
        assert_eq!(parse_range("bytes=20-10", 100), None);
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
    }

    #[test]
    fn multiple_ranges_take_first_segment() {
        // 不做多区间，但必须只回第一段而不是整文件
        assert_eq!(parse_range("bytes=0-1,2-3", 100), Some((0, 1)));
    }

    #[test]
    fn video_is_always_chunked() {
        assert_eq!(chunk_limit("a.mp4", 1024), Some(MEDIA_CHUNK));
        assert_eq!(chunk_limit("a.WEBM", 1024), Some(MEDIA_CHUNK));
    }

    #[test]
    fn only_large_audio_is_chunked() {
        assert_eq!(chunk_limit("a.mp3", 1024), None);
        assert_eq!(
            chunk_limit("a.mp3", AUDIO_CHUNK_THRESHOLD + 1),
            Some(MEDIA_CHUNK)
        );
        assert_eq!(chunk_limit("a.png", u64::MAX), None);
    }

    #[test]
    fn rejects_non_media_types() {
        assert_eq!(mime_for("a.mp4"), Some("video/mp4"));
        assert_eq!(mime_for("a.PNG"), Some("image/png"));
        // 任意文件不能借协议读出内容
        assert_eq!(mime_for("id_rsa"), None);
        assert_eq!(mime_for("a.txt"), None);
    }
}
