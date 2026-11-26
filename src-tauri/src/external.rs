//! 用系统默认程序打开外部链接。
//! WebView 里的 window.open 不会交给系统浏览器，Tauri 也没有默认处理，
//! 所以预览里的 http/https/mailto 链接统一走这个命令。

/// 允许的协议白名单：限制在这里，避免该命令被用来启动任意本地程序
fn allowed(url: &str) -> bool {
    let lower = url.trim().to_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !allowed(&url) {
        return Err("只支持打开网页链接".to_string());
    }
    open_url(url.trim())
}

#[cfg(target_os = "windows")]
fn open_url(url: &str) -> Result<(), String> {
    use std::ffi::c_void;

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> *mut c_void;
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let operation = wide("open");
    let target = wide(url);
    // SW_SHOWNORMAL = 1：交给系统默认浏览器
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    // ShellExecuteW 返回值 <= 32 表示失败
    if result as isize <= 32 {
        return Err("系统没有可打开该链接的程序".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_url(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .status()
        .map_err(|e| format!("无法打开链接：{e}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_url(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .status()
        .map_err(|e| format!("无法打开链接：{e}"))?;
    Ok(())
}
