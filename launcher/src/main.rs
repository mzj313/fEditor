// 单文件启动器：把真正的程序与 WebView2Loader.dll 内嵌在本 exe 中，
// 运行时解压到本地缓存目录再启动，避免要求用户同时携带两个文件。
#![windows_subsystem = "windows"]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 主程序二进制，在编译期直接嵌入
const APP_EXE: &[u8] = include_bytes!("../../src-tauri/target/release/file-editor.exe");
/// WebView2 加载器，主程序启动时必须能同目录找到它
const WEBVIEW_DLL: &[u8] = include_bytes!("../../src-tauri/target/release/WebView2Loader.dll");

fn main() {
    if let Err(err) = run() {
        show_error(&err);
    }
}

fn run() -> Result<(), String> {
    set_app_user_model_id();
    let dir = runtime_dir().ok_or_else(|| "无法获取 LOCALAPPDATA 环境变量".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建运行目录失败：{e}"))?;

    let app_path = dir.join("file-editor.exe");
    let dll_path = dir.join("WebView2Loader.dll");
    ensure_current(&dir, &app_path, &dll_path)?;

    let mut command = Command::new(&app_path);
    command.current_dir(&dir);
    // 告知主程序启动器自身位置：设置里的右键菜单必须注册启动器，
    // 注册解包出来的主程序会让更新后仍打开旧副本
    if let Ok(exe) = std::env::current_exe() {
        command.env("FEDITOR_LAUNCHER", exe);
    }
    // 作为「打开方式」的目标程序时，文件路径是通过命令行传进来的，
    // 必须原样转交主程序，否则双击文件只会打开一个空窗口
    for arg in forwarded_args() {
        command.arg(arg);
    }
    command
        .spawn()
        .map_err(|e| format!("启动主程序失败：{e}"))?;
    Ok(())
}

/// 转交命令行参数；相对路径先基于启动器自身的工作目录展开，
/// 因为子进程的工作目录被换成了缓存目录，相对路径在那里会解析错
fn forwarded_args() -> Vec<std::ffi::OsString> {
    let cwd = std::env::current_dir().ok();
    std::env::args_os()
        .skip(1)
        .map(|arg| {
            let path = Path::new(&arg);
            match &cwd {
                Some(dir) if path.is_relative() && dir.join(path).exists() => {
                    dir.join(path).into_os_string()
                }
                _ => arg,
            }
        })
        .collect()
}

/// 运行目录使用固定名字：任务栏固定项记录的是这里的 exe 路径，
/// 目录名随指纹变化时，旧固定项会一直指向过期版本。
fn runtime_dir() -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    Some(Path::new(&base).join("fEditor").join("rt"))
}

/// FNV-1a 64 位指纹，用于判断缓存是否需要更新。
/// 只比文件大小不可靠：两次构建很容易得到相同字节数。
fn fingerprint(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 确保固定目录里的副本是最新版本：指纹一致就直接复用，
/// 否则按「主程序 → DLL → 指纹文件」顺序重写。
/// 指纹文件最后写，中途失败下次启动会自动重试。
fn ensure_current(dir: &Path, app_path: &Path, dll_path: &Path) -> Result<(), String> {
    let stamp_path = dir.join(".fingerprint");
    let expected = format!("{:016x}", fingerprint(APP_EXE));

    if let Ok(saved) = fs::read_to_string(&stamp_path) {
        if saved.trim() == expected {
            return Ok(());
        }
    }

    // 程序正在运行时旧 exe 被占用，写入会失败，这里给出可操作的提示
    fs::write(app_path, APP_EXE)
        .map_err(|e| format!("写入主程序失败，请先关闭正在运行的 fEditor：{e}"))?;
    fs::write(dll_path, WEBVIEW_DLL)
        .map_err(|e| format!("写入 {} 失败：{e}", dll_path.display()))?;
    fs::write(&stamp_path, expected)
        .map_err(|e| format!("写入版本标记失败：{e}"))?;
    Ok(())
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: *mut u8, text: *const u16, caption: *const u16, flags: u32) -> i32;
}

#[link(name = "shell32")]
extern "system" {
    fn SetCurrentProcessExplicitAppUserModelID(app_id: *const u16) -> i32;
}

/// 任务栏按 AppUserModelID 归组；不显式指定时按 exe 路径归组。
/// 主程序每次打包都会解包到新的 rt-<指纹> 目录，路径一变任务栏就会
/// 认为是另一个程序，出现第二个图标。启动器与主程序共用同一个 ID
/// 可以保证固定项始终只有一份。
const APP_USER_MODEL_ID: &str = "com.mzj.file-editor";

fn set_app_user_model_id() {
    let id = to_wide(APP_USER_MODEL_ID);
    unsafe {
        SetCurrentProcessExplicitAppUserModelID(id.as_ptr());
    }
}

fn show_error(msg: &str) {
    let text = to_wide(msg);
    let caption = to_wide("fEditor 启动失败");
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            0x10,
        );
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
