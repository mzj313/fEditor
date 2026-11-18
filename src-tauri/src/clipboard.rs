// 自建右键菜单需要读写剪贴板。浏览器端 navigator.clipboard 在 WebView 下可能因权限被拒，
// 直接走系统剪贴板更可靠，也不依赖额外权限配置。

/// 读取剪贴板文本；内容不是文本或读取失败时返回空串，调用方按「无内容」处理
#[tauri::command]
pub fn clipboard_read() -> String {
    imp::read()
}

#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    imp::write(text)
}

#[cfg(windows)]
mod imp {
    use clipboard_win::{formats, get_clipboard, set_clipboard};

    pub fn read() -> String {
        get_clipboard::<String, _>(formats::Unicode).unwrap_or_default()
    }

    pub fn write(text: String) -> Result<(), String> {
        set_clipboard(formats::Unicode, text).map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::io::Write;
    use std::process::{Command, Stdio};

    pub fn read() -> String {
        Command::new("pbpaste")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
            .unwrap_or_default()
    }

    pub fn write(text: String) -> Result<(), String> {
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|error| error.to_string())?;
        }
        let status = child.wait().map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("pbcopy 退出码 {status}"))
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    pub fn read() -> String {
        String::new()
    }

    pub fn write(_text: String) -> Result<(), String> {
        Err("当前平台暂不支持剪贴板".into())
    }
}
