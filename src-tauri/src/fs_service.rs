use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use chardetng::EncodingDetector;
use encoding_rs::{GB18030, GBK, UTF_8};
use serde::Serialize;
use tauri::State;

const MAX_SIZE: u64 = 20 * 1024 * 1024;
// Markdown 内嵌图片只走内存传输，单独放宽上限，但仍设阈值避免超大文件卡死渲染
const MAX_BINARY_SIZE: u64 = 50 * 1024 * 1024;
const EXTERNAL_MODIFIED: &str = "EXTERNAL_MODIFIED";

/// 打开对话框的扩展名白名单：文本 + 所有只读预览格式。
/// macOS 的原生对话框会按过滤器把不在列表里的文件置灰，漏掉 pdf / mp4 就选不了。
const OPEN_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "text", "log", "sql", "json", "yaml", "yml", "csv", "ini", "xml",
    "toml", "rs", "ts", "js", "py", "java", "go", "c", "cpp", "h", "css", "html", "sh", "bat",
    "pdf", "docx", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "mp3", "m4a", "wav",
    "aac", "flac", "mp4", "webm",
];

/// 保存对话框只允许文本格式，二进制预览标签本来就不能保存
const TEXT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "text", "log", "sql", "json", "yaml", "yml", "csv", "ini", "xml",
    "toml", "rs", "ts", "js", "py", "java", "go", "c", "cpp", "h", "css", "html", "sh", "bat",
];

/// 目录树里忽略的目录名，避免把构建产物和缓存也展示出来
const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    ".idea",
    ".next",
    ".nuxt",
    "coverage",
];

/// 应用级状态：记录当前浏览的根目录，文件树命令只允许访问它内部
#[derive(Default)]
pub struct AppState {
    pub root: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootInfo {
    pub path: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    pub path: String,
    pub is_dir: bool,
    pub parent: Option<String>,
}

#[derive(Serialize)]
pub struct FilePayload {
    pub path: String,
    pub content: String,
    pub encoding: String,
    pub eol: String,
    pub has_bom: bool,
    pub mtime: u64,
    pub size: u64,
}

#[derive(Serialize)]
pub struct SaveResult {
    pub mtime: u64,
    pub size: u64,
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    // Windows 的 canonicalize 会给路径加上 \\?\ 前缀，展示与回传时去掉更符合直觉
    text.strip_prefix("//?/")
        .map(|s| s.to_string())
        .unwrap_or(text)
}

fn lock_root(state: &AppState) -> Result<PathBuf, String> {
    state
        .root
        .lock()
        .map_err(|_| "读取根目录状态失败".to_string())?
        .clone()
        .ok_or_else(|| "还没有打开文件夹".to_string())
}

/// 把树操作限定在当前根目录内，防止 ../ 或符号链接逃逸
fn resolve_inside_root(state: &AppState, path: &str) -> Result<PathBuf, String> {
    let root = lock_root(state)?;
    let raw = PathBuf::from(path);
    let absolute = if raw.is_absolute() { raw } else { root.join(raw) };
    let canonical = fs::canonicalize(&absolute)
        .map_err(|_| format!("路径不存在或无法访问：{}", absolute.display()))?;
    if !canonical.starts_with(&root) {
        return Err("禁止访问根目录之外的路径".to_string());
    }
    Ok(canonical)
}

/// 取出开头的连续数字，供自然排序做数值比较
fn take_digits(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut digits = String::new();
    while let Some(next) = chars.peek() {
        if next.is_ascii_digit() {
            digits.push(*next);
            chars.next();
        } else {
            break;
        }
    }
    digits
}

/// 自然排序：数字段按数值比较，避免 "10." 排在 "2." 前面
fn natural_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let left_lower = left.to_lowercase();
    let right_lower = right.to_lowercase();
    let mut left_chars = left_lower.chars().peekable();
    let mut right_chars = right_lower.chars().peekable();

    loop {
        match (left_chars.peek().copied(), right_chars.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(left_char), Some(right_char)) => {
                if left_char.is_ascii_digit() && right_char.is_ascii_digit() {
                    let left_number = take_digits(&mut left_chars);
                    let right_number = take_digits(&mut right_chars);
                    // 去掉前导零后先比位数再比字面值，等价于比数值且不会溢出
                    let left_value = left_number.trim_start_matches('0');
                    let right_value = right_number.trim_start_matches('0');
                    let order = left_value
                        .len()
                        .cmp(&right_value.len())
                        .then_with(|| left_value.cmp(right_value));
                    if order != Ordering::Equal {
                        return order;
                    }
                } else {
                    if left_char != right_char {
                        return left_char.cmp(&right_char);
                    }
                    left_chars.next();
                    right_chars.next();
                }
            }
        }
    }
}

#[tauri::command]
pub fn set_root(state: State<'_, AppState>, path: String) -> Result<RootInfo, String> {
    let canonical = fs::canonicalize(&path).map_err(|_| "文件夹不存在或无法访问".to_string())?;
    if !canonical.is_dir() {
        return Err("请选择一个文件夹".to_string());
    }

    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名")
        .to_string();
    let display = display_path(&canonical);

    *state
        .root
        .lock()
        .map_err(|_| "保存根目录状态失败".to_string())? = Some(canonical);

    Ok(RootInfo {
        path: display,
        name,
    })
}

/// 拖拽进入时先判断是文件还是文件夹，再决定切换工作区还是打开文件
#[tauri::command]
pub fn inspect_path(path: String) -> Result<PathInfo, String> {
    let canonical = fs::canonicalize(&path).map_err(|_| "路径不存在或无法访问".to_string())?;
    let metadata = fs::metadata(&canonical).map_err(|e| format!("读取路径信息失败：{e}"))?;

    if !metadata.is_dir() && !metadata.is_file() {
        return Err("只支持文件和文件夹".to_string());
    }

    Ok(PathInfo {
        path: display_path(&canonical),
        is_dir: metadata.is_dir(),
        parent: canonical.parent().map(display_path),
    })
}

#[tauri::command]
pub fn read_tree(state: State<'_, AppState>, path: Option<String>) -> Result<Vec<Entry>, String> {
    let directory = match path {
        Some(value) => resolve_inside_root(&state, &value)?,
        None => lock_root(&state)?,
    };

    if !directory.is_dir() {
        return Err("目标不是文件夹".to_string());
    }

    let reader = fs::read_dir(&directory).map_err(|e| format!("读取目录失败：{e}"))?;
    let mut entries = Vec::new();

    for item in reader.flatten() {
        let file_type = match item.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        // 跳过符号链接，避免通过链接访问根目录之外的内容
        if file_type.is_symlink() {
            continue;
        }

        let name = item.file_name().to_string_lossy().to_string();
        if file_type.is_dir() && IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }

        let metadata = match item.metadata() {
            Ok(value) => value,
            Err(_) => continue,
        };

        entries.push(Entry {
            path: display_path(&item.path()),
            name,
            is_dir: file_type.is_dir(),
            size: metadata.len(),
            modified: mtime_ms(&metadata),
        });
    }

    entries.sort_by(|left, right| match (left.is_dir, right.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => natural_cmp(&left.name, &right.name).then_with(|| left.name.cmp(&right.name)),
    });

    Ok(entries)
}

/// 让用户在原生对话框里选择一个文件夹作为工作区
#[tauri::command]
pub async fn pick_open_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择要浏览的文件夹")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("对话框线程异常：{e}"))?;

    Ok(picked
        .and_then(|f| f.into_path().ok())
        .map(|p| display_path(&p)))
}

fn decode(bytes: &[u8]) -> Result<(String, String, bool), String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let text = String::from_utf8(bytes[3..].to_vec())
            .map_err(|_| "UTF-8 BOM 文件无法按 UTF-8 解码".to_string())?;
        return Ok((text, "UTF-8".to_string(), true));
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok((text.to_string(), "UTF-8".to_string(), false));
    }

    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let mut enc = detector.guess(None, true);
    if enc == encoding_rs::WINDOWS_1252 {
        enc = GBK;
    }

    let (text, _, _) = enc.decode(bytes);
    let name = if enc == GBK {
        "GBK"
    } else if enc == GB18030 {
        "GB18030"
    } else if enc == UTF_8 {
        "UTF-8"
    } else {
        enc.name()
    };
    Ok((text.into_owned(), name.to_string(), false))
}

#[tauri::command]
pub fn read_file(path: String) -> Result<FilePayload, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| format!("无法读取文件：{e}"))?;
    if meta.is_dir() {
        return Err("目标是目录，无法作为文本打开".to_string());
    }
    if meta.len() > MAX_SIZE {
        return Err(format!(
            "文件超过 {} MB，已拒绝打开",
            MAX_SIZE / 1024 / 1024
        ));
    }

    let bytes = fs::read(&p).map_err(|e| format!("无法读取文件：{e}"))?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err("二进制文件，无法以文本方式打开".to_string());
    }

    let (content, encoding, has_bom) = decode(&bytes)?;

    let crlf = content.matches("\r\n").count();
    let eol = if crlf > 0 { "CRLF" } else { "LF" };
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");

    Ok(FilePayload {
        path: display_path(&p),
        content: normalized,
        encoding,
        eol: eol.to_string(),
        has_bom,
        mtime: mtime_ms(&meta),
        size: meta.len(),
    })
}

#[tauri::command]
pub fn save_file(
    path: String,
    content: String,
    encoding: String,
    eol: String,
    has_bom: bool,
    expected_mtime: u64,
) -> Result<SaveResult, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| format!("无法写入目标文件：{e}"))?;

    if expected_mtime != 0 && mtime_ms(&meta) != expected_mtime {
        return Err(EXTERNAL_MODIFIED.to_string());
    }

    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let text = if eol == "CRLF" {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    };

    let mut bytes = match encoding.as_str() {
        "GBK" => GBK.encode(&text).0.into_owned(),
        "GB18030" => GB18030.encode(&text).0.into_owned(),
        _ => text.into_bytes(),
    };
    if has_bom && encoding == "UTF-8" {
        bytes.insert(0, 0xEF);
        bytes.insert(1, 0xBB);
        bytes.insert(2, 0xBF);
    }

    let dir = p
        .parent()
        .ok_or_else(|| "目标路径没有上级目录".to_string())?;

    let mut tmp = tempfile::Builder::new()
        .prefix(".file-editor-")
        .tempfile_in(dir)
        .map_err(|e| format!("无法创建临时文件：{e}"))?;
    tmp.write_all(&bytes)
        .map_err(|e| format!("写入临时文件失败：{e}"))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("落盘失败：{e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&p)
            .map(|m| m.permissions().mode())
            .unwrap_or(0o644);
        let _ = fs::set_permissions(tmp.path(), fs::Permissions::from_mode(mode));
    }

    tmp.persist(&p).map_err(|e| format!("原子替换失败：{e}"))?;

    let new_meta = fs::metadata(&p).map_err(|e| format!("写入后读取状态失败：{e}"))?;
    Ok(SaveResult {
        mtime: mtime_ms(&new_meta),
        size: new_meta.len(),
    })
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// 手写 base64 编码，避免为此新增 crate 依赖。
fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied();
        let b2 = chunk.get(2).copied();

        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[((b0 & 0b11) << 4 | b1.unwrap_or(0) >> 4) as usize] as char);
        out.push(match b1 {
            Some(v) => TABLE[((v & 0b1111) << 2 | b2.unwrap_or(0) >> 6) as usize] as char,
            None => '=',
        });
        out.push(match b2 {
            Some(v) => TABLE[(v & 0b111111) as usize] as char,
            None => '=',
        });
    }
    out
}

/// 读取二进制文件并返回 base64，供前端拼 data URI 展示本地图片，
/// 以及把 PDF / Word 交给前端库解析。`limit` 允许调用方放宽体积上限。
///
/// `root` 用于 Markdown 内嵌资源：路径来自文档内容而非用户选择，
/// 传了 root 就只允许读取该目录内的文件，防止恶意文档把任意本地文件
/// 用 `../` 或绝对路径读进页面。
#[tauri::command]
pub fn read_file_base64(
    path: String,
    limit: Option<u64>,
    root: Option<String>,
) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let p = match root {
        Some(base) => {
            let base =
                fs::canonicalize(&base).map_err(|_| "基准目录不存在或无法访问".to_string())?;
            let target =
                fs::canonicalize(&p).map_err(|e| format!("无法读取文件：{e}"))?;
            if !target.starts_with(&base) {
                return Err("禁止读取文档目录之外的文件".to_string());
            }
            target
        }
        None => p,
    };
    let meta = fs::metadata(&p).map_err(|e| format!("无法读取文件：{e}"))?;
    if meta.is_dir() {
        return Err("目标是目录，无法读取".to_string());
    }
    let max = limit.unwrap_or(MAX_BINARY_SIZE).min(200 * 1024 * 1024);
    if meta.len() > max {
        return Err(format!(
            "文件超过 {} MB，已拒绝读取",
            max / (1024 * 1024)
        ));
    }

    let bytes = fs::read(&p).map_err(|e| format!("无法读取文件：{e}"))?;
    Ok(encode_base64(&bytes))
}

#[tauri::command]
pub fn cli_files() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| Path::new(arg).is_file())
        .map(|arg| arg.replace('\\', "/"))
        .collect()
}

/// 右键菜单传入的目录：资源管理器在文件夹/空白处右键时用 `%1` / `%V`
/// 传入点击位置，启动时用它作为工作区根目录，而不是回到上次的文件夹。
#[tauri::command]
pub fn cli_dir() -> Option<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .find_map(|arg| {
            let path = Path::new(&arg);
            if !path.is_dir() {
                return None;
            }
            let canonical = fs::canonicalize(path).ok()?;
            Some(display_path(&canonical))
        })
}

#[tauri::command]
pub async fn pick_open_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("支持的格式", OPEN_EXTENSIONS)
            .add_filter("所有文件", &["*"])
            .blocking_pick_files()
    })
    .await
    .map_err(|e| format!("对话框线程异常：{e}"))?;

    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| display_path(&p))
        .collect())
}

#[tauri::command]
pub async fn pick_save_path(
    app: tauri::AppHandle,
    default_name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(&default_name)
            .add_filter("文本文件", TEXT_EXTENSIONS)
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("对话框线程异常：{e}"))?;

    Ok(picked
        .and_then(|f| f.into_path().ok())
        .map(|p| display_path(&p)))
}

/// 把前端采集的启动分段计时写到本地缓存目录，供排查启动性能时查看
#[tauri::command]
pub fn write_startup_log(content: String) -> Result<String, String> {
    // Windows 用 LOCALAPPDATA；macOS / Linux 没有这个变量，退回系统临时目录，
    // 否则非 Windows 平台每次启动都会静默失败
    let dir = match std::env::var("LOCALAPPDATA") {
        Ok(base) => Path::new(&base).join("fEditor"),
        Err(_) => std::env::temp_dir().join("fEditor"),
    };
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
    let path = dir.join("startup.log");
    fs::write(&path, content).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(display_path(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(names: &[&str]) -> Vec<String> {
        let mut list: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        list.sort_by(|a, b| natural_cmp(a, b));
        list
    }

    #[test]
    fn natural_order_compares_numbers_by_value() {
        assert_eq!(
            sorted(&["10.md", "2.md", "1.md"]),
            vec!["1.md", "2.md", "10.md"]
        );
        assert_eq!(
            sorted(&["第10章.md", "第2章.md", "第1章.md"]),
            vec!["第1章.md", "第2章.md", "第10章.md"]
        );
    }

    #[test]
    fn natural_order_ignores_case_and_leading_zeros() {
        assert_eq!(sorted(&["b.md", "A.md"]), vec!["A.md", "b.md"]);
        assert_eq!(sorted(&["007.md", "8.md"]), vec!["007.md", "8.md"]);
    }
}
