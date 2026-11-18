//! Markdown 打印预览：把渲染好的 HTML 交给一个离屏窗口，用 WKWebView 的
//! createPDF 生成 A4 分页的 PDF，再作为只读标签打开预览（也可交给系统打印）。

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// 离屏打印窗口的标签，前端靠它判断自己是不是打印模式
pub const PRINT_LABEL: &str = "print";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintJob {
    pub id: u64,
    pub title: String,
    pub html: String,
}

/// 只在 macOS 的 PDF 生成回调里构造，其它平台不需要这个结构
#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintResult {
    pub path: String,
    pub error: Option<String>,
}

/// 暂存待渲染任务；打印窗口通过拉取命令取走，避免大 HTML 走事件通道
#[derive(Default)]
pub struct PrintState {
    job: Mutex<Option<PrintJob>>,
}

/// 主窗口调用：暂存 HTML，确保打印窗口存在并通知它渲染
#[tauri::command]
pub fn print_markdown(
    app: AppHandle,
    state: State<'_, PrintState>,
    html: String,
    title: String,
) -> Result<(), String> {
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    *state.job.lock().map_err(|e| e.to_string())? = Some(PrintJob { id, title, html });
    ensure_print_window(&app)?;
    app.emit_to(PRINT_LABEL, "print-render", id)
        .map_err(|e| format!("通知打印窗口失败：{e}"))?;
    Ok(())
}

/// 打印窗口调用：取走待渲染任务。窗口启动时也会拉一次，
/// 避免「事件先于监听注册」导致首次渲染丢失。
#[tauri::command]
pub fn print_take_job(state: State<'_, PrintState>) -> Option<PrintJob> {
    state.job.lock().ok().and_then(|mut job| job.take())
}

/// 打印窗口调用：把当前渲染内容生成为 PDF，完成后向主窗口发 print-pdf-done 事件
#[tauri::command]
pub fn print_capture(app: AppHandle, title: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window(PRINT_LABEL)
            .ok_or("打印窗口不存在")?;
        window
            .with_webview(move |webview| unsafe {
                let wk = webview.inner() as *mut objc2_web_kit::WKWebView;
                let wk = &*wk;
                let app = app.clone();
                // createPDF 的回调在主线程异步执行，这里只把结果转发给主窗口
                let handler = block2::RcBlock::new(
                    move |data: *mut objc2_foundation::NSData,
                          error: *mut objc2_foundation::NSError| {
                        let result = if !error.is_null() {
                            let error = &*error;
                            Err(format!("PDF 生成失败：{}", error.localizedDescription()))
                        } else if data.is_null() {
                            Err("PDF 生成失败：未返回数据".to_string())
                        } else {
                            write_pdf(&*data, &title)
                        };
                        let payload = match result {
                            Ok(path) => PrintResult { path, error: None },
                            Err(error) => PrintResult {
                                path: String::new(),
                                error: Some(error),
                            },
                        };
                        let _ = app.emit("print-pdf-done", payload);
                    },
                );
                // configuration 传 nil = 整页内容按窗口尺寸分页
                wk.createPDFWithConfiguration_completionHandler(None, &handler);
            })
            .map_err(|e| format!("访问打印窗口失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &title);
        Err("打印预览暂不支持当前系统".to_string())
    }
}

#[cfg(target_os = "macos")]
fn write_pdf(data: &objc2_foundation::NSData, title: &str) -> Result<String, String> {
    use objc2_foundation::NSString;

    let path = std::env::temp_dir().join(pdf_filename(title));
    let path_str = path.to_string_lossy().to_string();
    let ok = data.writeToFile_atomically(&NSString::from_str(&path_str), true);
    if ok {
        Ok(path_str)
    } else {
        Err(format!("写入 PDF 失败：{path_str}"))
    }
}

/// 去掉 .md 扩展名并替换文件名非法字符，得到「xxx.print.pdf」
#[cfg(target_os = "macos")]
fn pdf_filename(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let base = cleaned
        .strip_suffix(".markdown")
        .or_else(|| cleaned.strip_suffix(".md"))
        .unwrap_or(&cleaned);
    format!("{base}.print.pdf")
}

/// 确保离屏打印窗口存在。放在屏幕外而不是 visible(false)，
/// 保证 WebKit 真正渲染内容，createPDF 才不会拿到空白页。
fn ensure_print_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(PRINT_LABEL).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        PRINT_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("fEditor 打印")
    // A4 竖版在 96dpi 下的像素尺寸，PDF 页面即按此分页
    .inner_size(794.0, 1123.0)
    .position(-32000.0, -32000.0)
    .decorations(false)
    .resizable(false)
    .focused(false)
    .build()
    .map_err(|e| format!("创建打印窗口失败：{e}"))?;
    Ok(())
}
